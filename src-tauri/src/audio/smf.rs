// 标准 MIDI 文件(SMF)解析 —— 与 TS src/core/smf.ts parseSmf 逻辑对齐
use super::AudioEvent;

#[derive(Clone, Debug)]
pub struct SmfNote {
    pub tick: u32,
    pub dur: u32,
    pub note: u8,
    pub vel: u8,
    pub ch: u8,
    pub track: u16,
}

#[derive(Clone, Debug)]
pub struct ProgramChange {
    pub tick: u32,
    pub program: u8,
    pub ch: u8,
}

#[derive(Clone, Debug)]
pub struct Smf {
    pub notes: Vec<SmfNote>,
    pub division: u32,
    pub ntrks: u16,
    pub us_per_quarter: u32,
    pub beats_per_bar: u8,
    pub program_changes: Vec<ProgramChange>,
}

pub struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self { Self { bytes, pos: 0 } }
    fn rd(&mut self, n: usize) -> u32 {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 8) | self.bytes.get(self.pos).copied().unwrap_or(0) as u32;
            self.pos += 1;
        }
        v
    }
    fn vlq(&mut self) -> u32 {
        let mut v = 0u32;
        loop {
            let b = self.bytes.get(self.pos).copied().unwrap_or(0);
            self.pos += 1;
            v = (v << 7) | (b & 0x7f) as u32;
            if b & 0x80 == 0 { break; }
        }
        v
    }
}

pub fn parse_smf(bytes: &[u8]) -> Result<Smf, String> {
    let mut p = Parser::new(bytes);
    if p.rd(4) != 0x4D546864 { return Err("不是标准 MIDI 文件(MThd 缺失)".into()); }
    p.rd(4);                       // header len
    p.rd(2);                       // format
    let ntrks = p.rd(2) as u16;
    let division = p.rd(2);
    if division & 0x8000 != 0 { return Err("SMPTE 时间码 MIDI 暂不支持".into()); }

    let mut us_per_quarter = 500000u32;
    let mut beats_per_bar = 4u8;

    let mut raw: Vec<(u16, u32, u8, u8, u8, bool)> = Vec::new();   // (track, tick, ch, note, vel, on)
    let mut pcs: Vec<ProgramChange> = Vec::new();

    for tr in 0..ntrks {
        if p.rd(4) != 0x4D54726B { return Err("轨道头 MTrk 缺失".into()); }
        let len = p.rd(4) as usize;
        let end = p.pos + len;
        let mut tick = 0u32;
        let mut running = 0u8;
        while p.pos < end {
            tick += p.vlq();
            let mut status = p.bytes.get(p.pos).copied().unwrap_or(0);
            if status >= 0x80 {
                p.pos += 1;
                if status < 0xf0 { running = status; }
            } else {
                status = running;
            }
            if status >= 0xf0 {
                if status == 0xff {
                    // Meta 事件
                    let mtype = p.rd(1) as u8;
                    let mlen = p.vlq() as usize;
                    if mtype == 0x51 && mlen >= 3 {
                        us_per_quarter = p.rd(3);
                        p.rd(mlen - 3);
                    } else if mtype == 0x58 && mlen >= 2 {
                        beats_per_bar = p.rd(1) as u8;
                        p.rd(mlen - 1);
                    } else {
                        p.rd(mlen);
                    }
                } else {
                    // Sysex F0/F7
                    let slen = p.vlq() as usize;
                    p.rd(slen);
                }
                continue;
            }
            let kind = status & 0xf0;
            let ch = status & 0x0f;
            if kind == 0xc0 {
                let program = p.rd(1) as u8;
                pcs.push(ProgramChange { tick, program, ch });
                continue;
            }
            if kind == 0xd0 { p.rd(1); continue; }
            let d1 = p.rd(1) as u8;
            let d2 = p.rd(1) as u8;
            if kind == 0x90 && d2 > 0 {
                raw.push((tr, tick, ch, d1, d2, true));
            } else if kind == 0x80 || (kind == 0x90 && d2 == 0) {
                raw.push((tr, tick, ch, d1, 0, false));
            }
        }
        p.pos = end;
    }

    // note on/off 配对
    let mut open: std::collections::HashMap<(u16, u8, u8), (u32, u8)> = std::collections::HashMap::new();
    let mut notes = Vec::new();
    for (tr, tick, ch, note, vel, on) in raw {
        let key = (tr, ch, note);
        if on {
            open.insert(key, (tick, vel));
        } else if let Some((s_tick, s_vel)) = open.remove(&key) {
            notes.push(SmfNote {
                tick: s_tick,
                dur: (tick.saturating_sub(s_tick)).max(1),
                note,
                vel: s_vel,
                ch,
                track: tr,
            });
        }
    }
    Ok(Smf { notes, division, ntrks, us_per_quarter, beats_per_bar, program_changes: pcs })
}

impl Smf {
    /// 采样级事件流(播放调度用):程序变更在前端解析为参数后另行下发
    pub fn to_events(&self, start_sample: u64) -> Vec<(u64, AudioEvent)> {
        let sec_per_tick = (self.us_per_quarter as f64 / 1e6) / self.division as f64;
        let mut evs = Vec::new();
        for n in &self.notes {
            let t_on = start_sample + (n.tick as f64 * sec_per_tick * super::dsp::sr() as f64) as u64;
            let t_off = start_sample + ((n.tick + n.dur) as f64 * sec_per_tick * super::dsp::sr() as f64) as u64;
            evs.push((t_on, AudioEvent::NoteOn { ch: n.ch as usize, midi: n.note, vel: (n.vel as f32 / 127.0).clamp(0.0, 1.0) }));
            evs.push((t_off, AudioEvent::NoteOff { ch: n.ch as usize, midi: n.note }));
        }
        evs.sort_by_key(|(t, _)| *t);
        evs
    }

    pub fn duration_sec(&self) -> f64 {
        let end = self.notes.iter().map(|n| n.tick + n.dur).max().unwrap_or(0) as f64;
        end * (self.us_per_quarter as f64 / 1e6) / self.division as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vlq(v: u32) -> Vec<u8> {
        let mut b = vec![(v & 0x7f) as u8];
        let mut v = v >> 7;
        while v > 0 {
            b.insert(0, (v & 0x7f) as u8 | 0x80);
            v >>= 7;
        }
        b
    }
    fn track(events: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (dt, bytes) in events {
            body.extend(vlq(*dt));
            body.extend(bytes);
        }
        body.extend([0, 0xff, 0x2f, 0x00]);
        let mut out = vec![0x4d, 0x54, 0x72, 0x6b];
        out.extend((body.len() as u32).to_be_bytes());
        out.extend(body);
        out
    }

    #[test]
    fn parses_multi_channel() {
        let tr0 = track(&[
            (0, vec![0xc0, 0x00]),
            (0, vec![0x90, 60, 100]), (480, vec![0x80, 60, 0]),
        ]);
        let tr1 = track(&[
            (0, vec![0xc1, 0x07]),
            (0, vec![0x91, 48, 110]), (960, vec![0x81, 48, 0]),
        ]);
        let mut bytes = vec![0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0x01, 0xe0];
        bytes.extend(tr0);
        bytes.extend(tr1);
        let smf = parse_smf(&bytes).unwrap();
        assert_eq!(smf.ntrks, 2);
        assert_eq!(smf.notes.len(), 2);
        assert_eq!(smf.program_changes.len(), 2);
        assert_eq!(smf.program_changes[0].ch, 0);
        assert_eq!(smf.program_changes[1].ch, 1);
        assert_eq!(smf.notes[0].ch, 0);
        assert_eq!(smf.notes[1].ch, 1);
        let evs = smf.to_events(0);
        assert_eq!(evs.len(), 4);
    }
}
