// .plspmid 超高密度 MIDI 格式:音色数据 + 音符数据一体保存
// 相对标准 MIDI(SMF):密度 4 倍(division 480→1920 ticks/四分音符)、轨道 2 倍(16→32)
// 二进制布局(全部小端):
//   magic "PLSPMID1" | version u8 | division u32 | us_per_quarter u32 | beats_per_bar u8
//   n_tones u16 | n_notes u32
//   [tone]: track u8 | wt_len u8 | wt bytes | n_params u16 | (key_len u8 | key | f32)*
//   [note]: tick u32 | dur u32 | midi u8 | vel u8 | track u8

pub const PLSP_MAGIC: &[u8; 8] = b"PLSPMID1";
pub const PLSP_TRACKS: usize = 32;
pub const PLSP_DIVISION: u32 = 1920;   // 4× 标准 MIDI 的 480

#[derive(Clone, Debug, PartialEq)]
pub struct PlspTone {
    pub track: u8,
    pub wave_type: String,
    pub params: Vec<(String, f32)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlspNote {
    pub tick: u32,
    pub dur: u32,
    pub midi: u8,
    pub vel: u8,
    pub track: u8,
}

#[derive(Clone, Debug)]
pub struct PlspMid {
    pub division: u32,
    pub us_per_quarter: u32,
    pub beats_per_bar: u8,
    pub tones: Vec<PlspTone>,
    pub notes: Vec<PlspNote>,
}

impl Default for PlspMid {
    fn default() -> Self {
        Self { division: PLSP_DIVISION, us_per_quarter: 500_000, beats_per_bar: 4, tones: Vec::new(), notes: Vec::new() }
    }
}

pub fn encode(p: &PlspMid) -> Vec<u8> {
    let mut b: Vec<u8> = Vec::with_capacity(64 + p.tones.len() * 64 + p.notes.len() * 8);
    b.extend_from_slice(PLSP_MAGIC);
    b.push(1);   // version
    b.extend_from_slice(&p.division.to_le_bytes());
    b.extend_from_slice(&p.us_per_quarter.to_le_bytes());
    b.push(p.beats_per_bar);
    b.extend_from_slice(&(p.tones.len() as u16).to_le_bytes());
    b.extend_from_slice(&(p.notes.len() as u32).to_le_bytes());
    for t in &p.tones {
        b.push(t.track);
        b.push(t.wave_type.len() as u8);
        b.extend_from_slice(t.wave_type.as_bytes());
        b.extend_from_slice(&(t.params.len() as u16).to_le_bytes());
        for (k, v) in &t.params {
            b.push(k.len() as u8);
            b.extend_from_slice(k.as_bytes());
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    for n in &p.notes {
        b.extend_from_slice(&n.tick.to_le_bytes());
        b.extend_from_slice(&n.dur.to_le_bytes());
        b.push(n.midi);
        b.push(n.vel);
        b.push(n.track);
    }
    b
}

pub fn decode(bytes: &[u8]) -> Result<PlspMid, String> {
    let mut p = PlspMid::default();
    if bytes.len() < 24 { return Err(".plspmid 文件过短".into()); }
    if &bytes[0..8] != PLSP_MAGIC { return Err("不是 .plspmid 文件(魔数缺失)".into()); }
    let mut pos = 8usize;
    let _version = bytes[pos]; pos += 1;
    let rd_u32 = |pos: &mut usize| -> u32 {
        let v = u32::from_le_bytes([bytes[*pos], bytes[*pos + 1], bytes[*pos + 2], bytes[*pos + 3]]);
        *pos += 4; v
    };
    p.division = rd_u32(&mut pos);
    p.us_per_quarter = rd_u32(&mut pos);
    p.beats_per_bar = bytes[pos]; pos += 1;
    let n_tones = u16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as usize; pos += 2;
    let n_notes = rd_u32(&mut pos) as usize;
    if p.division == 0 { return Err("division 非法".into()); }

    for _ in 0..n_tones {
        if pos + 1 > bytes.len() { return Err("音色段截断".into()); }
        let track = bytes[pos]; pos += 1;
        let wt_len = bytes[pos] as usize; pos += 1;
        if pos + wt_len > bytes.len() { return Err("音色名截断".into()); }
        let wave_type = String::from_utf8_lossy(&bytes[pos..pos + wt_len]).to_string();
        pos += wt_len;
        if pos + 2 > bytes.len() { return Err("音色参数截断".into()); }
        let n_params = u16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as usize; pos += 2;
        let mut params = Vec::with_capacity(n_params);
        for _ in 0..n_params {
            if pos >= bytes.len() { return Err("参数键截断".into()); }
            let kl = bytes[pos] as usize; pos += 1;
            if pos + kl + 4 > bytes.len() { return Err("参数值截断".into()); }
            let key = String::from_utf8_lossy(&bytes[pos..pos + kl]).to_string();
            pos += kl;
            let v = f32::from_le_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]);
            pos += 4;
            params.push((key, v));
        }
        p.tones.push(PlspTone { track, wave_type, params });
    }
    for _ in 0..n_notes {
        if pos + 11 > bytes.len() { return Err("音符段截断".into()); }
        let tick = rd_u32(&mut pos);
        let dur = rd_u32(&mut pos);
        let midi = bytes[pos]; pos += 1;
        let vel = bytes[pos]; pos += 1;
        let track = bytes[pos]; pos += 1;
        if track as usize >= PLSP_TRACKS { return Err(format!("轨道号越界: {track}")); }
        p.notes.push(PlspNote { tick, dur, midi, vel, track });
    }
    if pos != bytes.len() { return Err("文件末尾有多余数据".into()); }
    Ok(p)
}

/// 时值换算工具:秒 → tick(以 division 与 us_per_quarter 换算)
pub fn sec_to_tick(sec: f32, division: u32, us_per_quarter: u32) -> u32 {
    (sec.max(0.0) * 1_000_000.0 / us_per_quarter.max(1) as f32 * division as f32).round() as u32
}

/// tick → 秒
pub fn tick_to_sec(tick: u32, division: u32, us_per_quarter: u32) -> f32 {
    tick as f32 * (us_per_quarter as f32 / 1e6) / division as f32
}

pub fn duration_sec(p: &PlspMid) -> f32 {
    let end = p.notes.iter().map(|n| n.tick + n.dur).max().unwrap_or(0);
    tick_to_sec(end, p.division, p.us_per_quarter)
}

/// 从前端 JSON 数据编码 .plspmid(analyze_wav 输出的 notes/tones 数组)。
/// 独立成 pub 函数以便直接测试前端 JSON 链路(tauri 命令只是薄壳)。
pub fn encode_from_json(
    notes_json: &str,
    tones_json: &str,
    bpm: f32,
    beats_per_bar: u8,
) -> Result<Vec<u8>, String> {
    let notes: Vec<serde_json::Value> = serde_json::from_str(notes_json).map_err(|e| format!("音符数据解析失败: {e}"))?;
    let tones: Vec<serde_json::Value> = serde_json::from_str(tones_json).map_err(|e| format!("音色数据解析失败: {e}"))?;
    let mut plsp = PlspMid::default();
    plsp.division = PLSP_DIVISION;   // 1920:密度 4 倍
    plsp.us_per_quarter = if bpm > 1.0 { (60_000_000.0 / bpm) as u32 } else { 500_000 };
    plsp.beats_per_bar = beats_per_bar.max(1).min(16);
    for t in tones {
        let track = t["track"].as_u64().unwrap_or(0) as u8;
        let wave_type = t["waveType"].as_str().unwrap_or("saw").to_string();
        let mut params = Vec::new();
        if let Some(pm) = t["params"].as_object() {
            for (k, v) in pm {
                if let Some(f) = v.as_f64() { params.push((k.clone(), f as f32)); }
            }
        }
        plsp.tones.push(PlspTone { track, wave_type, params });
    }
    for n in notes {
        let t_sec = n["t"].as_f64().unwrap_or(0.0) as f32;
        let dur_sec = n["dur"].as_f64().unwrap_or(0.0) as f32;
        let tick = sec_to_tick(t_sec, plsp.division, plsp.us_per_quarter);
        let dur = sec_to_tick(dur_sec, plsp.division, plsp.us_per_quarter).max(1);
        // 力度:0..1 小数 → 0..127(先乘后取整,严禁先 as u8 截断成 0)
        let vel = ((n["vel"].as_f64().unwrap_or(0.8) * 127.0).round() as i32).clamp(0, 127) as u8;
        plsp.notes.push(PlspNote {
            tick, dur,
            midi: n["midi"].as_u64().unwrap_or(60) as u8,
            vel,
            track: n["track"].as_u64().unwrap_or(0) as u8,
        });
    }
    Ok(encode(&plsp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_all_data() {
        let mut p = PlspMid::default();
        p.division = PLSP_DIVISION;
        p.us_per_quarter = 500_000;
        p.beats_per_bar = 3;
        p.tones = vec![
            PlspTone { track: 0, wave_type: "piano".into(), params: vec![("attack".into(), 0.003), ("cutoff_hz".into(), 9000.0)] },
            PlspTone { track: 7, wave_type: "saw".into(), params: vec![("harmonics".into(), 24.0)] },
        ];
        p.notes = vec![
            PlspNote { tick: 0, dur: 480, midi: 60, vel: 100, track: 0 },
            PlspNote { tick: 480, dur: 960, midi: 67, vel: 80, track: 7 },
            PlspNote { tick: 12345, dur: 120, midi: 100, vel: 64, track: 31 },
        ];
        let bytes = encode(&p);
        let d = decode(&bytes).expect("decode ok");
        assert_eq!(d.division, PLSP_DIVISION);
        assert_eq!(d.beats_per_bar, 3);
        assert_eq!(d.tones, p.tones, "tones roundtrip");
        assert_eq!(d.notes, p.notes, "notes roundtrip");
        assert!(d.notes[2].track == 31, "high track preserved");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode(b"NOTPLSPMID..........").is_err());
        assert!(decode(b"PLSPMID1xx").is_err(), "truncated header rejected");
    }

    #[test]
    fn tick_conversion_roundtrip() {
        let t = sec_to_tick(1.234, PLSP_DIVISION, 500_000);
        let s = tick_to_sec(t, PLSP_DIVISION, 500_000);
        assert!((s - 1.234).abs() < 0.002, "sec->tick->sec, got {s}");
    }

    #[test]
    fn encode_from_json_frontend_contract() {
        // 模拟 analyze_wav 返回的前端 JSON(与 transcribe.ts 使用一致)
        let notes = r#"[{"t":0.0,"dur":0.5,"midi":60,"vel":0.85,"track":0,"bright":0.35,"attackMs":5},
                        {"t":0.5,"dur":0.25,"midi":67,"vel":0.5,"track":4,"bright":0.55,"attackMs":3}]"#;
        let tones = r#"[{"track":0,"waveType":"piano","params":{"attack":0.003,"decay":1.2,"cutoffHz":9000}},
                       {"track":4,"waveType":"saw","params":{"harmonics":24}}]"#;
        let bytes = encode_from_json(notes, tones, 120.0, 4).expect("encode ok");
        let d = decode(&bytes).expect("decode ok");
        assert_eq!(d.division, PLSP_DIVISION, "density x4");
        assert_eq!(d.us_per_quarter, 500_000, "120bpm -> 500000us");
        assert_eq!(d.notes.len(), 2);
        assert_eq!(d.notes[0].midi, 60);
        assert_eq!(d.notes[0].vel, 108, "vel 0.85 -> 108 (round, not truncate)");
        assert_eq!(d.notes[1].vel, 64, "vel 0.5 -> 64");
        assert_eq!(d.notes[0].tick, 0);
        // 0.5s @120bpm(0.5s/拍)= 1 拍 @1920 ticks = 1920
        assert_eq!(d.notes[1].tick, 1920, "t=0.5s -> 1920 ticks");
        assert_eq!(d.notes[1].track, 4, "track preserved");
        assert_eq!(d.tones.len(), 2);
        assert_eq!(d.tones[0].wave_type, "piano");
        assert!(d.tones[0].params.iter().any(|(k, v)| k == "cutoffHz" && *v == 9000.0));
    }

    #[test]
    fn encode_from_json_rejects_bad_json() {
        assert!(encode_from_json("not-json", "[]", 120.0, 4).is_err());
    }
}
