// mcode 音乐编程语言编译器:代码定义音乐,编译为采样级事件
// 语法(中文友好,注释用 //):
//   use piano            设置音色(piano/saw/sine/clar/dx7/wt/square/drip)
//   tempo 120            速度 BPM(默认 120)
//   beat 1/4             每拍时值(默认 1/4,影响时值换算)
//   c4 1/4  e4 1/8       音符 + 时值(音名+八度,或纯数字 midi 60)
//   [c4 e4 g4] 1/2       和弦(同起始,时值在 ] 后)
//   r 1/4                休止
//   c4 1/4 v100          力度后缀 0-127(默认 80)
//   repeat 3 { ... }     重复块(块内相对时间,整块循环)
//   track 名字 { ... }   独立音轨(各自游标/音色)
// 时值:x/y 或 x/y.(附点,×1.5);缺省用上次时值,初始为 beat
// 输出 tick 基准:PLSP_DIVISION(1920)/四分音符

pub const CODE_DIVISION: u32 = crate::audio::plspmid::PLSP_DIVISION;
const NOTE_NAMES: [(&str, u8); 7] = [("c", 0), ("d", 2), ("e", 4), ("f", 5), ("g", 7), ("a", 9), ("b", 11)];

#[derive(Clone, Debug)]
pub struct CodeTrack {
    pub name: String,
    pub wave_type: String,
    pub notes: Vec<(u32, u32, u8, u8)>,   // (tick, dur, midi, vel)
}

#[derive(Clone, Debug)]
pub struct CodeMusicResult {
    pub tracks: Vec<CodeTrack>,
    pub bpm: f32,
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Word(String),
    LBrace,
    RBrace,
    LBracket,
    RBracket,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let mut toks = Vec::new();
    for raw_line in src.lines() {
        let line = match raw_line.find("//") {
            Some(i) => &raw_line[..i],
            None => raw_line,
        };
        let line = line.trim();
        if line.is_empty() { continue; }
        let mut cur = String::new();
        let flush = |cur: &mut String, toks: &mut Vec<Tok>| {
            if !cur.is_empty() {
                toks.push(Tok::Word(std::mem::take(cur)));
            }
        };
        for ch in line.chars() {
            match ch {
                '{' => { flush(&mut cur, &mut toks); toks.push(Tok::LBrace); }
                '}' => { flush(&mut cur, &mut toks); toks.push(Tok::RBrace); }
                '[' => { flush(&mut cur, &mut toks); toks.push(Tok::LBracket); }
                ']' => { flush(&mut cur, &mut toks); toks.push(Tok::RBracket); }
                ' ' | '\t' => flush(&mut cur, &mut toks),
                _ => cur.push(ch),
            }
        }
        flush(&mut cur, &mut toks);
    }
    if toks.is_empty() { return Err("代码为空".into()); }
    Ok(toks)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    bpm: f32,
    beat_num: u32,      // 每拍时值(分子/分母),默认 1/4
    beat_den: u32,
    vel: u8,
    tracks: Vec<CodeTrack>,
    cur_track: usize,
    cur_wave: String,
    cur_tick: u32,      // 当前轨游标(含块 base)
    last_dur: u32,
}

/// 时值 token "1/4" / "1/8." → ticks(CODE_DIVISION=1920 即四分音符;附点 ×1.5)
fn parse_dur_ticks(w: &str) -> Option<u32> {
    let (body, dotted) = match w.strip_suffix('.') {
        Some(b) => (b, true),
        None => (w, false),
    };
    let (num, den) = body.split_once('/')?;
    let n: u32 = num.parse().ok()?;
    let d: u32 = den.parse().ok()?;
    if n == 0 || d == 0 { return None; }
    let mut t = CODE_DIVISION * n / d;   // 相对四分音符(1920 ticks)
    if dotted { t += t / 2; }
    Some(t)
}

/// 音符 token:"c4" "c#5" "bb3" "60"(midi)→ midi 号
fn parse_note_token(w: &str) -> Option<u8> {
    if let Ok(m) = w.parse::<u8>() {
        if m <= 127 { return Some(m); }
        return None;
    }
    let bytes = w.as_bytes();
    let name = (bytes[0].to_ascii_lowercase()) as char;
    let Some((_, pc)) = NOTE_NAMES.iter().find(|(n, _)| n.chars().next() == Some(name)) else { return None; };
    let mut idx = 1;
    let mut acc = 0i32;
    while idx < bytes.len() {
        match bytes[idx] as char {
            '#' => acc += 1,
            'b' => acc -= 1,
            _ => break,
        }
        idx += 1;
    }
    let oct: i32 = if idx < bytes.len() {
        match w[idx..].parse::<i32>() { Ok(o) => o, Err(_) => return None }
    } else { 4 };
    let midi = (oct + 1) * 12 + *pc as i32 + acc;
    if midi < 0 || midi > 127 { return None; }
    Some(midi as u8)
}

impl Parser {
    fn expect_word(&mut self, msg: &str) -> Result<String, String> {
        match self.toks.get(self.pos).cloned() {
            Some(Tok::Word(w)) => { self.pos += 1; Ok(w) }
            _ => Err(msg.into()),
        }
    }
    fn expect_tok(&mut self, t: Tok, msg: &str) -> Result<(), String> {
        if self.toks.get(self.pos) == Some(&t) { self.pos += 1; Ok(()) } else { Err(msg.into()) }
    }

    /// 解析一个块(顶层 / track 块 / repeat 块体),返回块内相对音符
    /// base:块起点游标。音符 tick = 相对 base。
    fn parse_block(&mut self, base: u32) -> Result<Vec<(u32, u32, u8, u8)>, String> {
    let mut out: Vec<(u32, u32, u8, u8)> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();      // 等待时值的音符(单音或和弦)
    let mut pending_vel: u8 = self.vel;         // 待落地音符的力度(vN 可中途修改)
    let mut pending_r = false;
    loop {
        let tok = self.toks.get(self.pos).cloned();
        match tok {
            None => break,
            Some(Tok::RBrace) => break,
            Some(Tok::Word(w)) => {
                self.pos += 1;
                match w.as_str() {
                    "use" => {
                        let name = self.expect_word("use 后需要音色名")?;
                        self.cur_wave = name;
                        // 同步到当前轨(顶层轨 / track 块内轨)
                        if let Some(t) = self.tracks.get_mut(self.cur_track) {
                            t.wave_type = self.cur_wave.clone();
                        }
                    }
                    "tempo" => {
                        let n = self.expect_word("tempo 后需要数字")?;
                        self.bpm = n.parse::<f32>().map_err(|_| format!("tempo 非法: {n}"))?.clamp(20.0, 300.0);
                    }
                    "beat" => {
                        let d = self.expect_word("beat 后需要时值如 1/4")?;
                        let (n, den) = d.split_once('/').ok_or_else(|| format!("beat 非法: {d}"))?;
                        self.beat_num = n.parse().map_err(|_| format!("beat 非法: {d}"))?;
                        self.beat_den = den.parse().map_err(|_| format!("beat 非法: {d}"))?;
                        self.last_dur = parse_dur_ticks(&d).ok_or_else(|| format!("beat 非法: {d}"))?;
                    }
                    "repeat" => {
                        let n = self.expect_word("repeat 后需要次数")?;
                        let count = n.parse::<u32>().map_err(|_| format!("repeat 次数非法: {n}"))?;
                        if count == 0 || count > 64 { return Err(format!("repeat 次数非法: {n}(1-64)")); }
                        self.expect_tok(Tok::LBrace, "repeat 后需要 {{")?;
                        let block = self.parse_block(self.cur_tick)?;
                        self.expect_tok(Tok::RBrace, "repeat 块缺 }}")?;
                        let len = self.cur_tick - base;
                        if len == 0 { return Err("repeat 块为空".into()); }
                        for i in 0..count {
                            for (t, d, m, v) in &block {
                                out.push((t + i * len, *d, *m, *v));
                            }
                        }
                    }
                    "track" => {
                        let name = self.expect_word("track 后需要名字")?;
                        self.expect_tok(Tok::LBrace, "track 后需要 {{")?;
                        // 切换游标到新轨,解析块(相对 0),再切回
                        let save = (self.cur_track, self.cur_wave.clone(), self.cur_tick);
                        self.cur_track = self.tracks.len();
                        self.cur_wave = String::new();
                        self.cur_tick = 0;
                        self.tracks.push(CodeTrack { name: name.clone(), wave_type: String::new(), notes: Vec::new() });
                        let block = self.parse_block(0)?;
                        self.expect_tok(Tok::RBrace, "track 块缺 }}")?;
                        let wave = self.tracks[self.cur_track].wave_type.clone();
                        if wave.is_empty() { return Err(format!("track「{name}」未指定音色(use ...)")); }
                        let idx = self.cur_track;
                        self.tracks[idx].notes = block;
                        (self.cur_track, self.cur_wave, self.cur_tick) = save;
                    }
                    "r" | "rest" => {
                        pending_r = true;
                        pending.clear();
                    }
                    _ => {
                        // 音符 / 时值 / 力度
                        if let Some(midi) = parse_note_token(&w) {
                            flush_pending(&mut out, &mut pending, pending_r, self.cur_tick.saturating_sub(base), self.last_dur, pending_vel);
                            pending_r = false;
                            pending_vel = self.vel;
                            pending.push(midi);
                        } else if let Some(ticks) = parse_dur_ticks(&w) {
                            self.last_dur = ticks;
                            flush_pending(&mut out, &mut pending, pending_r, self.cur_tick.saturating_sub(base), ticks, pending_vel);
                            pending_r = false;
                            self.cur_tick = self.cur_tick.saturating_add(ticks);
                        } else if let Some(v) = w.strip_prefix('v') {
                            let nv = v.parse::<u8>().map_err(|_| format!("力度非法: {w}"))?.min(127);
                            if !pending.is_empty() {
                                // 作用于等待时值的音符(前缀式:c4 v100 1/4)
                                pending_vel = nv;
                            } else if let Some(last) = out.last_mut() {
                                if last.0 + last.1 == self.cur_tick {
                                    last.3 = nv;   // 后缀式:c4 1/4 v100 → 回写刚落地的音符
                                } else {
                                    self.vel = nv;
                                }
                            } else {
                                self.vel = nv;
                            }
                        } else {
                            return Err(format!("无法识别的记号: {w}"));
                        }
                    }
                }
            }
            Some(Tok::LBracket) => {
                // 和弦:[n1 n2 ...] 时值
                self.pos += 1;
                let mut chord: Vec<u8> = Vec::new();
                loop {
                    match self.toks.get(self.pos).cloned() {
                        Some(Tok::RBracket) => { self.pos += 1; break; }
                        Some(Tok::Word(w)) => {
                            if w == "r" || w == "rest" { self.pos += 1; continue; }
                            let midi = parse_note_token(&w).ok_or_else(|| format!("和弦内记号非法: {w}"))?;
                            chord.push(midi);
                            self.pos += 1;
                        }
                        _ => return Err("和弦缺 ]".into()),
                    }
                }
                if chord.is_empty() { return Err("空和弦 []".into()); }
                let dur = match self.toks.get(self.pos).cloned() {
                    Some(Tok::Word(w)) if parse_dur_ticks(&w).is_some() => {
                        let d = parse_dur_ticks(&w).unwrap();
                        self.pos += 1;
                        d
                    }
                    _ => self.last_dur,
                };
                self.last_dur = dur;
                for m in chord { out.push((self.cur_tick - base, dur, m, self.vel)); }
                self.cur_tick = self.cur_tick.saturating_add(dur);
            }
            Some(Tok::LBrace) => return Err("多余的 {".into()),
            Some(Tok::RBracket) => return Err("多余的 ]".into()),
        }
    }
    // 结尾未落地音符(无时值,用 last_dur);tick 相对块基准
    flush_pending(&mut out, &mut pending, pending_r, self.cur_tick.saturating_sub(base), self.last_dur, pending_vel);
    Ok(out)
    }
}

fn flush_pending(out: &mut Vec<(u32, u32, u8, u8)>, pending: &mut Vec<u8>, is_rest: bool, tick: u32, dur: u32, vel: u8) {
    if pending.is_empty() && !is_rest { return; }
    if is_rest {
        pending.clear();
    } else {
        for m in pending.drain(..) { out.push((tick, dur, m, vel)); }
    }
}

/// 编译 mcode 源码 → 多轨音符 + 音色
pub fn compile_code(src: &str) -> Result<CodeMusicResult, String> {
    let toks = tokenize(src)?;
    let mut p = Parser {
        toks,
        pos: 0,
        bpm: 120.0,
        beat_num: 1,
        beat_den: 4,
        vel: 80,
        tracks: Vec::new(),
        cur_track: 0,
        cur_wave: String::new(),
        cur_tick: 0,
        last_dur: 480,   // 1/4 @1920
    };
    p.tracks.push(CodeTrack { name: "主轨".into(), wave_type: String::new(), notes: Vec::new() });
    let block = p.parse_block(0)?;
    if p.pos < p.toks.len() { return Err("多余的 }".into()); }
    p.tracks[0].notes = block;
    if p.tracks[0].wave_type.is_empty() {
        return Err("未指定音色(use piano/saw/sine/clar/dx7/wt/square/drip)".into());
    }
    // 移除无音符的空轨
    p.tracks.retain(|t| !t.notes.is_empty());
    if p.tracks.is_empty() { return Err("没有生成任何音符".into()); }
    Ok(CodeMusicResult { tracks: p.tracks, bpm: p.bpm })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_melody_with_durations() {
        let r = compile_code("use piano\ntempo 120\nc4 1/4  e4 1/4  g4 1/2").expect("compile");
        assert_eq!(r.tracks.len(), 1);
        assert_eq!(r.tracks[0].wave_type, "piano");
        let n = &r.tracks[0].notes;
        assert_eq!(n.len(), 3);
        assert_eq!(n[0], (0, 480, 60, 80), "C4 1/4");
        assert_eq!(n[1], (480, 480, 64, 80), "E4 1/4");
        assert_eq!(n[2], (960, 960, 67, 80), "G4 1/2");
        assert_eq!(r.bpm, 120.0);
    }

    #[test]
    fn chord_and_rest() {
        let r = compile_code("use saw\n[c4 e4 g4] 1/2  r 1/4  c5 1/4").expect("compile");
        let n = &r.tracks[0].notes;
        assert_eq!(n.len(), 4);
        assert_eq!(n[0], (0, 960, 60, 80));
        assert_eq!(n[1], (0, 960, 64, 80));
        assert_eq!(n[2], (0, 960, 67, 80));
        assert_eq!(n[3], (1440, 480, 72, 80), "休止后 1/4 处");
    }

    #[test]
    fn repeat_block_loops() {
        let r = compile_code("use sine\nrepeat 3 { c4 1/8  d4 1/8 }").expect("compile");
        let n = &r.tracks[0].notes;
        assert_eq!(n.len(), 6);
        assert_eq!(n[0], (0, 240, 60, 80));
        assert_eq!(n[1], (240, 240, 62, 80));
        assert_eq!(n[2], (480, 240, 60, 80), "第二次重复偏移 480");
        assert_eq!(n[4], (960, 240, 60, 80), "第三次重复偏移 960");
    }

    #[test]
    fn multi_track_with_tone_and_velocity() {
        let r = compile_code("use piano\nc4 1/4 v100\n\ntrack 贝斯 {\n  use saw\n  c2 1/2  d2 1/4 v60\n}\n\ntrack 弦乐 {\n  use sine\n  e4 1/1\n}").expect("compile");
        assert_eq!(r.tracks.len(), 3);
        assert_eq!(r.tracks[0].name, "主轨");
        assert_eq!(r.tracks[0].wave_type, "piano");
        assert_eq!(r.tracks[0].notes[0], (0, 480, 60, 100));
        assert_eq!(r.tracks[1].name, "贝斯");
        assert_eq!(r.tracks[1].wave_type, "saw");
        assert_eq!(r.tracks[1].notes[0], (0, 960, 36, 80));
        assert_eq!(r.tracks[1].notes[1], (960, 480, 38, 60));
        assert_eq!(r.tracks[2].name, "弦乐");
        assert_eq!(r.tracks[2].wave_type, "sine");
        assert_eq!(r.tracks[2].notes[0], (0, 1920, 64, 80), "全音符");
    }

    #[test]
    fn midi_numbers_and_sharps() {
        let r = compile_code("use clar\n60 1/4  c#4 1/4  bb3 1/4").expect("compile");
        let n = &r.tracks[0].notes;
        assert_eq!(n[0], (0, 480, 60, 80));
        assert_eq!(n[1], (480, 480, 61, 80), "C#4");
        assert_eq!(n[2], (960, 480, 58, 80), "Bb3");
    }

    #[test]
    fn dotted_and_beat() {
        let r = compile_code("use sine\nbeat 1/8\nc4 1/4.  d4 1/8").expect("compile");
        let n = &r.tracks[0].notes;
        // beat 1/8 → 1/8 = 240 ticks;1/4 附点 = 480×1.5 = 720
        assert_eq!(n[0], (0, 720, 60, 80));
        assert_eq!(n[1], (720, 240, 62, 80));
    }

    #[test]
    fn syntax_errors_reported() {
        assert!(compile_code("use piano\nc4 nonsense").is_err());
        assert!(compile_code("use piano\nrepeat 3 { c4 1/4").is_err(), "缺 }}");
        assert!(compile_code("c4 1/4").is_err(), "缺音色");
        assert!(compile_code("use piano\ntrack x { c4 1/4 }").is_err(), "track 缺音色");
    }
}
