// .PILMU 多轨音乐工程格式(COMMIX 主格式,后续软件通用)
// 容器 = ZIP 无损压缩(可用 WinRAR/7zip 打开查看),内容:
//   manifest.json — 工程清单(节拍/轨道列表:类型/名称/音量/声像/偏移)
//   资源文件 — 每条轨道一个文件(.plspmid 超高密度 / .mid 标准 / .wav / .mp3 原字节)
// 轨道类型:plspmid(32 轨高密度,自带音色)/ mid(标准,程序变更切音色)/ wav / mp3(播放时解码)
// 兼容性:.plspmid/.mid/.wav/.mp3 单文件功能不变,工程只是把它们打包在一起

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};

pub const PILMU_FORMAT: &str = "PILMU";
pub const PILMU_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PilmuTrack {
    pub id: u32,
    pub name: String,
    pub kind: String,        // plspmid | mid | wav | mp3(JSON 键与前端一致)
    pub file: String,        // 资源文件名(容器内)
    pub volume: f32,         // 0..2
    pub pan: f32,            // -1..1
    pub offset_ms: u32,      // 轨道时间偏移(毫秒)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PilmuManifest {
    pub format: String,
    pub version: u32,
    pub bpm: f32,
    pub beats_per_bar: u8,
    pub tracks: Vec<PilmuTrack>,
}

impl Default for PilmuManifest {
    fn default() -> Self {
        Self { format: PILMU_FORMAT.into(), version: PILMU_VERSION, bpm: 120.0, beats_per_bar: 4, tracks: Vec::new() }
    }
}

/// 打包工程:manifest + 资源(文件名, 字节)→ .PILMU 字节(ZIP 容器)
pub fn build_pilmu(manifest: &PilmuManifest, resources: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut zipw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let manifest_json = serde_json::to_string_pretty(manifest).map_err(|e| format!("清单序列化失败: {e}"))?;
        zipw.start_file("manifest.json", opts).map_err(|e| format!("ZIP 写入失败: {e}"))?;
        zipw.write_all(manifest_json.as_bytes()).map_err(|e| format!("ZIP 写入失败: {e}"))?;
        for (name, data) in resources {
            zipw.start_file(name, opts).map_err(|e| format!("ZIP 写入失败: {e}"))?;
            zipw.write_all(data).map_err(|e| format!("ZIP 写入失败: {e}"))?;
        }
        zipw.finish().map_err(|e| format!("ZIP 封口失败: {e}"))?;
    }
    Ok(buf)
}

/// 解包工程:返回 (manifest, 资源列表)
pub fn parse_pilmu(bytes: &[u8]) -> Result<(PilmuManifest, Vec<(String, Vec<u8>)>), String> {
    let mut zipr = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("不是有效 ZIP 容器: {e}"))?;
    let mut manifest: Option<PilmuManifest> = None;
    let mut resources: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zipr.len() {
        let mut f = zipr.by_index(i).map_err(|e| format!("ZIP 读取失败: {e}"))?;
        let name = f.name().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| format!("ZIP 读取失败: {e}"))?;
        if name == "manifest.json" {
            manifest = Some(serde_json::from_slice(&data).map_err(|e| format!("清单解析失败: {e}"))?);
        } else {
            resources.push((name, data));
        }
    }
    let m = manifest.ok_or("缺少 manifest.json,不是 PILMU 工程")?;
    if m.format != PILMU_FORMAT { return Err("清单格式标识不符,不是 PILMU 工程".into()); }
    if m.version > PILMU_VERSION { return Err(format!("工程版本({})高于当前支持({})", m.version, PILMU_VERSION)); }
    // 校验轨道资源齐全
    let names: HashMap<&str, &Vec<u8>> = resources.iter().map(|(n, d)| (n.as_str(), d)).collect();
    for t in &m.tracks {
        if !names.contains_key(t.file.as_str()) {
            return Err(format!("轨道 {} 资源缺失: {}", t.name, t.file));
        }
    }
    Ok((m, resources))
}

/// 程序号 → 音色(与前端内置预设一致;mid 轨播放时无前端解析,这里直接映射)
pub fn program_to_tone(prog: u8) -> (String, Vec<(String, f32)>) {
    let wt = match prog {
        0..=7 => "piano",
        8..=15 => "clar",
        16..=23 => "dx7",
        24..=31 => "saw",
        32..=39 => "saw",
        40..=47 => "saw",
        48..=55 => "wt",
        56..=63 => "saw",
        64..=70 => "saw",
        71 => "clar",
        72 => "clar",
        73 => "sine",
        80 => "square",
        81 => "saw",
        85 => "saw",
        99 => "dx7",
        108 => "dx7",
        113 => "drip",
        _ => "saw",
    };
    (wt.to_string(), super::tone_match::params_for(wt))
}

/// 构建 EngineParams 用的音色参数(供 Tone 事件消费与 plspmid/mid 灌音色共用)
pub fn build_params(wave_type: &str, params: &[(String, f32)]) -> super::engine::EngineParams {
    let mut ep = super::engine::EngineParams::default();
    ep.wave_type = wave_type.to_string();
    for (k, v) in params {
        match k.as_str() {
            "attack" => ep.attack = *v,
            "decay" => ep.decay = *v,
            "sustain" => ep.sustain = *v,
            "release" => ep.release = *v,
            "cutoffHz" => ep.cutoff_hz = *v,
            "resonanceQ" => ep.resonance_q = *v,
            "harmonics" => ep.harmonics = *v as u16,
            "volume" => ep.volume = *v,
            "gain" => ep.gain = *v,
            "pan" => ep.pan = *v,
            _ => {}
        }
    }
    ep
}

/// 工程播放规划:解析所有轨道 → 音频轨(混合数据)+ MIDI 事件流(通道分配/音色灌入)
/// 通道分配:plspmid 轨占 32 通道;mid 轨按实际通道数;总量 ≤ N_CHANNELS
pub struct ProjectPlayback {
    pub events: Vec<(u64, super::AudioEvent)>,
    pub end_sample: u64,
    /// 音频轨:(mono, sample_rate, gain, pan, offset_samples)
    pub audio_tracks: Vec<(Vec<f32>, u32, f32, f32, u64)>,
    pub used_channels: usize,
}

pub fn plan_playback(
    manifest: &PilmuManifest,
    resources: &std::collections::HashMap<String, Vec<u8>>,
    start_sample: u64,
) -> Result<ProjectPlayback, String> {
    let sr = super::dsp::sr() as f64;
    let mut events: Vec<(u64, super::AudioEvent)> = Vec::new();
    let mut audio_tracks: Vec<(Vec<f32>, u32, f32, f32, u64)> = Vec::new();
    let mut end_sample: u64 = 0;
    let mut used = 0usize;
    for t in &manifest.tracks {
        match t.kind.as_str() {
            "wav" | "mp3" | "ogg" => {
                let data = resources.get(&t.file).ok_or_else(|| format!("轨道 {} 资源缺失", t.name))?;
                let w = super::audio_to_mono(data)?;
                let offset_samples = t.offset_ms as u64 * super::dsp::sr() as u64 / 1000;
                let track_end = start_sample + offset_samples + (w.mono.len() as f64 / w.sample_rate as f64 * sr) as u64;
                end_sample = end_sample.max(track_end);
                audio_tracks.push((w.mono, w.sample_rate, t.volume.clamp(0.0, 2.0), t.pan.clamp(-1.0, 1.0), offset_samples));
            }
            "plspmid" => {
                let data = resources.get(&t.file).ok_or_else(|| format!("轨道 {} 资源缺失", t.name))?;
                let plsp = super::plspmid::decode(data)?;
                let base = used;
                used += 32;
                if used > super::N_CHANNELS {
                    return Err(format!("MIDI 通道不足:工程需要 {used} 通道,引擎上限 {}", super::N_CHANNELS));
                }
                let sec_per_tick = (plsp.us_per_quarter as f64 / 1e6) / plsp.division as f64;
                let offset_s = t.offset_ms as f64 / 1000.0;
                // plspmid 自带音色 → Tone 事件(起始时刻灌入对应通道引擎)
                for tone in &plsp.tones {
                    let idx = base + tone.track as usize;
                    if idx < super::N_CHANNELS {
                        events.push((start_sample, super::AudioEvent::Tone {
                            ch: idx, wave_type: tone.wave_type.clone(), params: tone.params.clone(),
                        }));
                    }
                }
                for n in &plsp.notes {
                    let t0 = start_sample + ((n.tick as f64 * sec_per_tick + offset_s) * sr) as u64;
                    let t1 = start_sample + (((n.tick + n.dur) as f64 * sec_per_tick + offset_s) * sr) as u64;
                    end_sample = end_sample.max(t1);
                    events.push((t0, super::AudioEvent::NoteOn { ch: base + n.track as usize, midi: n.midi, vel: n.vel as f32 / 127.0 }));
                    events.push((t1, super::AudioEvent::NoteOff { ch: base + n.track as usize, midi: n.midi }));
                }
            }
            "mid" => {
                let data = resources.get(&t.file).ok_or_else(|| format!("轨道 {} 资源缺失", t.name))?;
                let smf = super::smf::parse_smf(data)?;
                let mut chs: Vec<usize> = smf.notes.iter().map(|n| n.ch as usize).collect();
                chs.extend(smf.program_changes.iter().map(|p| p.ch as usize));
                chs.sort_unstable();
                chs.dedup();
                let nch = chs.len().max(1);
                let base = used;
                used += nch;
                if used > super::N_CHANNELS {
                    return Err(format!("MIDI 通道不足:工程需要 {used} 通道,引擎上限 {}", super::N_CHANNELS));
                }
                let sec_per_tick = (smf.us_per_quarter as f64 / 1e6) / smf.division as f64;
                let offset_s = t.offset_ms as f64 / 1000.0;
                let mut prog_seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
                for pc in &smf.program_changes {
                    let ch_abs = base + pc.ch as usize;
                    if ch_abs >= super::N_CHANNELS { continue; }
                    let (wt, params) = program_to_tone(pc.program);
                    prog_seen.insert(pc.ch as usize);
                    let ts = start_sample + ((pc.tick as f64 * sec_per_tick + offset_s) * sr) as u64;
                    events.push((ts, super::AudioEvent::Tone { ch: ch_abs, wave_type: wt, params }));
                }
                for &ch in &chs {
                    if !prog_seen.contains(&ch) {
                        let (wt, params) = program_to_tone(0);
                        events.push((start_sample, super::AudioEvent::Tone { ch: base + ch, wave_type: wt, params }));
                    }
                }
                for n in &smf.notes {
                    let ch_abs = base + n.ch as usize;
                    if ch_abs >= super::N_CHANNELS { continue; }
                    let t0 = start_sample + ((n.tick as f64 * sec_per_tick + offset_s) * sr) as u64;
                    let t1 = start_sample + (((n.tick + n.dur) as f64 * sec_per_tick + offset_s) * sr) as u64;
                    end_sample = end_sample.max(t1);
                    events.push((t0, super::AudioEvent::NoteOn { ch: ch_abs, midi: n.note, vel: n.vel as f32 / 127.0 }));
                    events.push((t1, super::AudioEvent::NoteOff { ch: ch_abs, midi: n.note }));
                }
            }
            "code" => {
                // mcode 音乐编程轨:代码定义音乐(use/tempo/音符+时值/和弦/repeat/track)
                let data = resources.get(&t.file).ok_or_else(|| format!("轨道 {} 资源缺失", t.name))?;
                let src = String::from_utf8(data.clone()).map_err(|_| format!("轨道 {} 不是文本代码", t.name))?;
                let result = super::code_music::compile_code(&src)?;
                let n = result.tracks.len();
                let base = used;
                used += n;
                if used > super::N_CHANNELS {
                    return Err(format!("MIDI 通道不足:工程需要 {used} 通道,引擎上限 {}", super::N_CHANNELS));
                }
                let sec_per_tick = 60.0f64 / result.bpm.max(1.0) as f64 / super::code_music::CODE_DIVISION as f64;
                let offset_s = t.offset_ms as f64 / 1000.0;
                for (i, ct) in result.tracks.iter().enumerate() {
                    let ch = base + i;
                    let wt = if ct.wave_type.is_empty() { "saw".to_string() } else { ct.wave_type.clone() };
                    let params = super::tone_match::params_for(&wt);
                    events.push((start_sample, super::AudioEvent::Tone { ch, wave_type: wt, params }));
                    for (tick, dur, midi, vel) in &ct.notes {
                        let t0 = start_sample + ((*tick as f64 * sec_per_tick + offset_s) * sr) as u64;
                        let t1 = start_sample + (((*tick + *dur) as f64 * sec_per_tick + offset_s) * sr) as u64;
                        end_sample = end_sample.max(t1);
                        events.push((t0, super::AudioEvent::NoteOn { ch, midi: *midi, vel: *vel as f32 / 127.0 }));
                        events.push((t1, super::AudioEvent::NoteOff { ch, midi: *midi }));
                    }
                }
            }
            other => return Err(format!("不支持的轨道类型: {other}")),
        }
    }
    for ch in 0..used.max(1) {
        events.push((end_sample + super::BLOCK as u64, super::AudioEvent::AllOff { ch }));
    }
    Ok(ProjectPlayback { events, end_sample: end_sample + super::BLOCK as u64, audio_tracks, used_channels: used })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_manifest_and_resources() {
        let mut m = PilmuManifest::default();
        m.bpm = 96.0;
        m.beats_per_bar = 3;
        m.tracks = vec![
            PilmuTrack { id: 0, name: "主旋律".into(), kind: "plspmid".into(), file: "t0.plspmid".into(), volume: 0.8, pan: 0.0, offset_ms: 0 },
            PilmuTrack { id: 1, name: "人声".into(), kind: "mp3".into(), file: "t1.mp3".into(), volume: 1.0, pan: -0.3, offset_ms: 500 },
            PilmuTrack { id: 2, name: "采样".into(), kind: "wav".into(), file: "t2.wav".into(), volume: 0.6, pan: 0.4, offset_ms: 0 },
        ];
        let resources = vec![
            ("t0.plspmid".to_string(), vec![1u8, 2, 3]),
            ("t1.mp3".to_string(), vec![9, 8, 7]),
            ("t2.wav".to_string(), vec![4, 5, 6]),
        ];
        let bytes = build_pilmu(&m, &resources).expect("build");
        assert!(bytes.len() > 0);
        let (m2, res2) = parse_pilmu(&bytes).expect("parse");
        assert_eq!(m2.format, PILMU_FORMAT);
        assert_eq!(m2.bpm, 96.0);
        assert_eq!(m2.tracks.len(), 3);
        assert_eq!(m2.tracks[1].kind, "mp3");
        assert_eq!(m2.tracks[1].offset_ms, 500);
        let map: HashMap<&str, &Vec<u8>> = res2.iter().map(|(n, d)| (n.as_str(), d)).collect();
        assert_eq!(map["t0.plspmid"], &vec![1u8, 2, 3]);
        assert_eq!(map["t2.wav"], &vec![4u8, 5, 6]);
    }

    #[test]
    fn rejects_non_pilmu() {
        assert!(parse_pilmu(b"not a zip at all......").is_err());
    }

    #[test]
    fn missing_resource_reported() {
        let mut m = PilmuManifest::default();
        m.tracks = vec![PilmuTrack { id: 0, name: "x".into(), kind: "wav".into(), file: "missing.wav".into(), volume: 1.0, pan: 0.0, offset_ms: 0 }];
        let bytes = build_pilmu(&m, &[]).expect("build");
        assert!(parse_pilmu(&bytes).is_err(), "缺失资源必须报错");
    }

    #[test]
    fn program_mapping_known_tone() {
        let (wt, params) = program_to_tone(0);
        assert_eq!(wt, "piano");
        assert!(params.iter().any(|(k, _)| k == "attack"));
        let (wt2, _) = program_to_tone(73);
        assert_eq!(wt2, "sine");
    }

    // ---------- plan_playback:工程播放规划 ----------
    fn make_wav_bytes(sr: u32, secs: u32) -> Vec<u8> {
        let n = (sr * secs) as usize;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&((36 + n * 2) as u32).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&((n * 2) as u32).to_le_bytes());
        for i in 0..n {
            let v = ((i as f32 / sr as f32 * 440.0 * 2.0 * std::f32::consts::PI).sin() * 0.3 * 32767.0) as i16;
            b.extend_from_slice(&v.to_le_bytes());
        }
        b
    }

    fn make_smf_bytes(program: u8, note: u8) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"MThd");
        b.extend_from_slice(&6u32.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&480u16.to_be_bytes());
        let mut trk = Vec::new();
        trk.extend_from_slice(&[0x00, 0xC0, program]);          // t0: 程序变更 ch0
        trk.extend_from_slice(&[0x00, 0x90, note, 0x64]);       // t0: note on
        trk.extend_from_slice(&[0x83, 0x60, 0x80, note, 0x00]); // t480: note off(480=0x83 0x60)
        trk.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);       // end of track
        b.extend_from_slice(b"MTrk");
        b.extend_from_slice(&(trk.len() as u32).to_be_bytes());
        b.extend_from_slice(&trk);
        b
    }

    #[test]
    fn manifest_parses_from_frontend_json() {
        // 前端 pilmu.ts buildManifest 的 JSON.stringify 输出(真实 pilmu_build 命令入口)
        let json = r#"{
            "format": "PILMU",
            "version": 1,
            "bpm": 96,
            "beatsPerBar": 3,
            "tracks": [
                {"id":0,"name":"高密度","kind":"plspmid","file":"t1.plspmid","volume":0.8,"pan":0,"offsetMs":0},
                {"id":1,"name":"人声","kind":"mp3","file":"t2.mp3","volume":1,"pan":-0.3,"offsetMs":500},
                {"id":2,"name":"采样","kind":"wav","file":"t3.wav","volume":0.6,"pan":0.4,"offsetMs":0}
            ]
        }"#;
        let m: PilmuManifest = serde_json::from_str(json).expect("前端 JSON 必须能反序列化(pilmu_build 入口)");
        assert_eq!(m.format, PILMU_FORMAT);
        assert_eq!(m.version, 1);
        assert_eq!(m.bpm, 96.0);
        assert_eq!(m.beats_per_bar, 3);
        assert_eq!(m.tracks.len(), 3);
        assert_eq!(m.tracks[0].kind, "plspmid");
        assert_eq!(m.tracks[1].kind, "mp3");
        assert_eq!(m.tracks[1].offset_ms, 500);
        assert_eq!(m.tracks[1].pan, -0.3);
        assert_eq!(m.tracks[2].volume, 0.6);
    }

    #[test]
    fn plan_mixes_audio_and_allocates_midi_channels() {
        // 工程:plspmid(32 通道)+ wav + mid(1 通道)
        let mut plsp = crate::audio::plspmid::PlspMid::default();
        plsp.notes = vec![crate::audio::plspmid::PlspNote { tick: 0, dur: 480, midi: 60, vel: 100, track: 0 }];
        plsp.tones = vec![crate::audio::plspmid::PlspTone { track: 0, wave_type: "piano".into(), params: vec![("attack".into(), 0.003)] }];
        let plsp_bytes = crate::audio::plspmid::encode(&plsp);
        let wav_bytes = make_wav_bytes(44100, 1);
        let smf_bytes = make_smf_bytes(64, 67);

        let mut m = PilmuManifest::default();
        m.tracks = vec![
            PilmuTrack { id: 0, name: "高密度".into(), kind: "plspmid".into(), file: "a.plspmid".into(), volume: 0.8, pan: 0.0, offset_ms: 0 },
            PilmuTrack { id: 1, name: "伴奏".into(), kind: "mid".into(), file: "b.mid".into(), volume: 1.0, pan: 0.0, offset_ms: 200 },
            PilmuTrack { id: 2, name: "人声".into(), kind: "wav".into(), file: "c.wav".into(), volume: 0.6, pan: -0.4, offset_ms: 0 },
        ];
        let res: std::collections::HashMap<String, Vec<u8>> = [
            ("a.plspmid".to_string(), plsp_bytes),
            ("b.mid".to_string(), smf_bytes),
            ("c.wav".to_string(), wav_bytes),
        ].into_iter().collect();

        let plan = match plan_playback(&m, &res, 100_000) {
            Ok(p) => p,
            Err(e) => panic!("plan failed: {e}"),
        };
        // 通道分配:plspmid 占 0-31,mid 占 32
        assert_eq!(plan.used_channels, 33);
        // 音频轨 1 条
        assert_eq!(plan.audio_tracks.len(), 1);
        assert_eq!(plan.audio_tracks[0].0.len(), 44100, "1s wav");
        assert!((plan.audio_tracks[0].2 - 0.6).abs() < 1e-4, "volume from manifest");
        assert!((plan.audio_tracks[0].3 - -0.4).abs() < 1e-4, "pan from manifest");
        // mid 轨 offset 200ms
        assert_eq!(plan.audio_tracks[0].4, 0u64);   // wav offset 0
        // 事件:plspmid note on ch0 / mid note on ch32 / Tone 事件(plspmid piano + mid program)
        let note_chs: std::collections::HashSet<usize> = plan.events.iter()
            .filter_map(|(_, ev)| match ev {
                crate::audio::AudioEvent::NoteOn { ch, .. } => Some(*ch),
                _ => None,
            }).collect();
        assert!(note_chs.contains(&0), "plspmid note on ch0");
        assert!(note_chs.contains(&32), "mid note on ch32 (after plspmid 0-31)");
        let tone_chs: std::collections::HashSet<usize> = plan.events.iter()
            .filter_map(|(_, ev)| match ev {
                crate::audio::AudioEvent::Tone { ch, .. } => Some(*ch),
                _ => None,
            }).collect();
        assert!(tone_chs.contains(&0), "plspmid tone ch0 (piano)");
        assert!(tone_chs.contains(&32), "mid tone ch32 (program 64)");
        // AllOff 覆盖全部 used 通道
        let alloff = plan.events.iter().filter(|(_, ev)| matches!(ev, crate::audio::AudioEvent::AllOff { .. })).count();
        assert_eq!(alloff, 33);
    }

    #[test]
    fn plan_rejects_channel_overflow() {
        // 2 条 plspmid = 64 通道 > 64?64 正好。3 条 = 96 > 64 → 报错
        let mut plsp = crate::audio::plspmid::PlspMid::default();
        plsp.notes = vec![crate::audio::plspmid::PlspNote { tick: 0, dur: 10, midi: 60, vel: 100, track: 0 }];
        let plsp_bytes = crate::audio::plspmid::encode(&plsp);
        let mut m = PilmuManifest::default();
        for i in 0..3 {
            m.tracks.push(PilmuTrack { id: i, name: format!("t{i}"), kind: "plspmid".into(), file: format!("t{i}.plspmid"), volume: 1.0, pan: 0.0, offset_ms: 0 });
        }
        let res: std::collections::HashMap<String, Vec<u8>> =
            (0..3).map(|i| (format!("t{i}.plspmid"), plsp_bytes.clone())).collect();
        let r = plan_playback(&m, &res, 0);
        assert!(r.is_err(), "3 plspmid 轨(96 通道)必须报通道不足");
    }

    #[test]
    fn plan_compiles_mcode_track() {
        // 代码轨:mcode 源码(use/音符/和弦/repeat/track 多音轨)→ 事件流
        let src = "use piano\nc4 1/4  e4 1/4\ntrack 贝斯 {\n  use saw\n  c2 1/2  repeat 2 { d2 1/8 }\n}\n[c4 e4 g4] 1/2";
        let mut m = PilmuManifest::default();
        m.tracks = vec![PilmuTrack { id: 0, name: "代码".into(), kind: "code".into(), file: "a.mcode".into(), volume: 1.0, pan: 0.0, offset_ms: 0 }];
        let res: std::collections::HashMap<String, Vec<u8>> =
            [("a.mcode".to_string(), src.as_bytes().to_vec())].into_iter().collect();
        let plan = plan_playback(&m, &res, 0).expect("code track plan ok");
        // 主轨 2 音符(c4,e4)+ 和弦 3 + 贝斯 1 + repeat 2 = 8 note-on
        let note_ons: Vec<(usize, u8)> = plan.events.iter()
            .filter_map(|(_, ev)| match ev {
                crate::audio::AudioEvent::NoteOn { ch, midi, .. } => Some((*ch, *midi)),
                _ => None,
            }).collect();
        assert_eq!(note_ons.len(), 8, "主轨 2 + 和弦 3 + 贝斯 1 + repeat 2, got {:?}", note_ons.len());
        assert!(note_ons.contains(&(0, 60)), "c4 on ch0");
        assert!(note_ons.contains(&(1, 36)), "贝斯 c2 on ch1");
        assert!(note_ons.contains(&(0, 64)) && note_ons.contains(&(0, 67)), "和弦 e4/g4");
        // Tone 事件:ch0 piano,ch1 saw
        let tones: Vec<(usize, String)> = plan.events.iter()
            .filter_map(|(_, ev)| match ev {
                crate::audio::AudioEvent::Tone { ch, wave_type, .. } => Some((*ch, wave_type.clone())),
                _ => None,
            }).collect();
        assert!(tones.contains(&(0, "piano".to_string())));
        assert!(tones.contains(&(1, "saw".to_string())));
        assert_eq!(plan.used_channels, 2, "code 轨 2 个 mcode-track 占 2 通道");
    }
}
