// 标准 MIDI 文件(SMF)解析与生成 + 简谱工具(纯逻辑)
export interface SmfNote { tick: number; dur: number; note: number; vel: number; ch: number; track: number; }

export function readVLQ(bytes: Uint8Array, pos: { i: number }): number {
  let v = 0, b = 0;
  do {
    b = bytes[pos.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return v;
}
export function parseSmf(bytes: Uint8Array): { notes: SmfNote[]; division: number; ntrks: number; usPerQuarter: number; beatsPerBar: number; programChanges: { track: number; tick: number; program: number }[] } {
  const pos = { i: 0 };
  const rd = (n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 8) | bytes[pos.i++];
    return v;
  };
  if (rd(4) !== 0x4d546864) throw new Error("不是标准 MIDI 文件(MThd 缺失)");
  rd(4);                       // header len
  rd(2);                       // format(0/1/2,解析时不依赖)
  const ntrks = rd(2);
  const division = rd(2);      // ticks per quarter(bit15=1 为 SMPTE,少见)
  if (division & 0x8000) throw new Error("SMPTE 时间码 MIDI 暂不支持");

  let usPerQuarter = 500000;   // 默认 120 BPM
  let beatsPerBar = 4;         // 默认 4/4

  const rawEvents: { track: number; tick: number; ch: number; note: number; vel: number; on: boolean }[] = [];
  const programChanges: { track: number; tick: number; program: number }[] = [];
  for (let tr = 0; tr < ntrks; tr++) {
    if (rd(4) !== 0x4d54726b) throw new Error("轨道头 MTrk 缺失");
    const len = rd(4);
    const end = pos.i + len;
    let tick = 0;
    let running = 0;
    while (pos.i < end) {
      tick += readVLQ(bytes, pos);
      let status = bytes[pos.i];
      if (status >= 0x80) { pos.i++; if (status < 0xf0) running = status; }
      else status = running;
      if (status >= 0xf0) {
        if (status === 0xff) {
          // Meta 事件:tempo(51)与拍号(58)需要解析
          const mtype = bytes[pos.i++];
          const mlen = readVLQ(bytes, pos);
          if (mtype === 0x51 && mlen >= 3) {
            // Set Tempo:3 字节 µs/四分音符
            const us = (bytes[pos.i] << 16) | (bytes[pos.i + 1] << 8) | bytes[pos.i + 2];
            usPerQuarter = us;
          } else if (mtype === 0x58 && mlen >= 2) {
            // 拍号:nn dd cc bb(nn=每小节拍数,dd=分母幂)
            beatsPerBar = bytes[pos.i];
          }
          pos.i += mlen;
        } else {
          // Sysex F0/F7:跳过
          const slen = readVLQ(bytes, pos);
          pos.i += slen;
        }
        continue;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      if (kind === 0xc0) { programChanges.push({ track: tr, tick, program: bytes[pos.i++] }); continue; }   // 程序变更(播放时切音色)
      if (kind === 0xd0) { pos.i += 1; continue; }   // 通道压力
      const d1 = bytes[pos.i++];
      const d2 = bytes[pos.i++];
      if (kind === 0x90 && d2 > 0) rawEvents.push({ track: tr, tick, ch, note: d1, vel: d2, on: true });
      else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) rawEvents.push({ track: tr, tick, ch, note: d1, vel: 0, on: false });
    }
    pos.i = end;
  }

  // note on/off 组装:同 (track,ch,note) 匹配最近未闭合的 on
  const open = new Map<string, { tick: number; vel: number }>();
  const notes: SmfNote[] = [];
  for (const e of rawEvents) {
    const key = e.track + ":" + e.ch + ":" + e.note;
    if (e.on) {
      open.set(key, { tick: e.tick, vel: e.vel });
    } else {
      const s = open.get(key);
      if (s) {
        notes.push({ tick: s.tick, dur: Math.max(1, e.tick - s.tick), note: e.note, vel: s.vel, ch: e.ch, track: e.track });
        open.delete(key);
      }
    }
  }
  return { notes, division, ntrks, usPerQuarter, beatsPerBar, programChanges };
}

// ============ MIDI 文件保存(SMF format 0, division 480) ============
export function buildSmf(events: { t: number; on: boolean; note: number; vel: number }[]): ArrayBuffer {
  const DIV = 480;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const track: number[] = [];
  let prevT = 0;
  const pushVar = (v: number) => {
    let val = Math.max(0, Math.round(v));
    const bytes = [val & 0x7f];
    while ((val >>= 7) > 0) bytes.unshift((val & 0x7f) | 0x80);
    track.push(...bytes);
  };
  for (const ev of sorted) {
    const dt = Math.round(((ev.t - prevT) / 1000) * DIV);
    pushVar(dt);
    track.push(ev.on ? 0x90 : 0x80, ev.note, ev.on ? Math.max(1, Math.round(ev.vel * 127)) : 0);
    prevT = ev.t;
  }
  pushVar(0); track.push(0xff, 0x2f, 0x00);
  // SMF 标准:所有头字段均为大端序
  const hdr = new ArrayBuffer(14);
  const dv = new DataView(hdr);
  const wstr = (o: number, str: string, dvw: DataView) => { for (let i = 0; i < str.length; i++) dvw.setUint8(o + i, str.charCodeAt(i)); };
  wstr(0, "MThd", dv); dv.setUint32(4, 6, false); dv.setUint16(8, 0, false);
  dv.setUint16(10, 1, false); dv.setUint16(12, DIV, false);
  const trk = new ArrayBuffer(8 + track.length);
  const dv2 = new DataView(trk);
  wstr(0, "MTrk", dv2); dv2.setUint32(4, track.length, false);
  new Uint8Array(trk, 8).set(track);
  const out = new Uint8Array(hdr.byteLength + trk.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(trk), hdr.byteLength);
  return out.buffer;
}
