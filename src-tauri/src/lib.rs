use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::dsp;

pub mod audio;

/// MIDI 原生层(midir,绕过 WebView2 Web MIDI 的实例/分发问题)
struct MidiState {
    input_conn: Mutex<Option<midir::MidiInputConnection<()>>>,
    output_conn: Mutex<Option<midir::MidiOutputConnection>>,
    output_port: Mutex<Option<usize>>,
}

impl Default for MidiState {
    fn default() -> Self {
        Self {
            input_conn: Mutex::new(None),
            output_conn: Mutex::new(None),
            output_port: Mutex::new(None),
        }
    }
}

/// 音频状态:共享总线 + cpal 流 + 播放线程
struct AudioState {
    bus: Arc<Mutex<audio::AudioBus>>,
    stream: Mutex<Option<audio::AudioStream>>,
    player: Mutex<Option<audio::player::PlayerHandle>>,
}

/// 枚举 MIDI 输入/输出设备,返回 (输入名列表, 输出名列表)
#[tauri::command]
fn midi_list_devices() -> Result<(Vec<String>, Vec<String>), String> {
    let mut mi = midir::MidiInput::new("COMMIX In").map_err(|e| e.to_string())?;
    let mut mo = midir::MidiOutput::new("COMMIX Out").map_err(|e| e.to_string())?;
    let inputs: Vec<String> = mi.ports().iter()
        .filter_map(|p| mi.port_name(p).ok())
        .collect();
    let outputs: Vec<String> = mo.ports().iter()
        .filter_map(|p| mo.port_name(p).ok())
        .collect();
    Ok((inputs, outputs))
}

/// 打开指定输入端(按索引):消息直接喂音频总线(按通道分发,低延迟),
/// 同时发 "midi-in" 事件给前端做状态/指示灯显示
#[tauri::command]
fn midi_start_input(app: AppHandle, state: State<MidiState>, audio: State<AudioState>, port: usize) -> Result<String, String> {
    let mut mi = midir::MidiInput::new("COMMIX In").map_err(|e| e.to_string())?;
    let ports = mi.ports();
    let p = ports.get(port).ok_or("端口不存在")?.clone();
    let name = mi.port_name(&p).map_err(|e| e.to_string())?;
    let bus = audio.bus.clone();
    let conn = mi
        .connect(&p, "COMMIX", move |_stamp, data, _| {
            if data.len() >= 2 {
                let status = data[0];
                let typ = status & 0xf0;
                let d1 = data[1];
                let d2 = *data.get(2).unwrap_or(&0);
                let mut b = match bus.lock() {
                    Ok(b) => b,
                    Err(_) => return,
                };
                if typ == 0x90 && d2 > 0 {
                    let vel = b.apply_vel(d2 as f32 / 127.0);
                    // 实时演奏统一主通道(与鼠标/电脑键盘音色一致;SMF 播放仍按通道分身)
                    b.engines[0].note_on(d1, vel, 0.0);
                } else if typ == 0x80 || (typ == 0x90 && d2 == 0) {
                    b.engines[0].note_off(d1, false);
                } else if typ == 0xe0 {
                    // 弯音:14 位中心 8192,±2 半音
                    let v14 = (d1 as i32 | ((d2 as i32) << 7)) - 8192;
                    b.engines[0].set_bend((v14 as f32 / 8192.0) * 2.0);
                } else if typ == 0xb0 && d1 == 64 {
                    b.engines[0].set_sustain(d2 >= 64);
                } else if typ == 0xb0 && d1 == 66 {
                    b.engines[0].set_sostenuto(d2 >= 64);
                } else if typ == 0xb0 && d1 == 67 {
                    b.engines[0].set_soft(d2 >= 64);
                } else if typ == 0xb0 && d1 == 11 {
                    // 表情踏板:主音量 0-100%
                    b.master.volume = (d2 as f32 / 127.0).max(0.0).min(1.0);
                }
                // MIDI 键盘走带按钮(播放/暂停/录制):MMC 与通用 CC 双识别
                if typ == 0xb0 {
                    let action = if d1 == 94 || d1 == 114 { Some("play") }
                        else if d1 == 93 || d1 == 115 { Some("stop") }
                        else if d1 == 95 || d1 == 116 { Some("record") }
                        else { None };
                    if let Some(a) = action { let _ = app.emit("midi-transport", a); }
                } else if typ == 0xf0 && data.len() >= 6 && data[2] == 0x06 {
                    // MMC: F0 7F <id> 06 <cmd> F7,cmd 01=play 02=stop 06=record
                    let action = match data[3] { 1 => Some("play"), 2 => Some("stop"), 6 => Some("record"), _ => None };
                    if let Some(a) = action { let _ = app.emit("midi-transport", a); }
                }
                let _ = app.emit("midi-in", data.to_vec());
            }
        }, ())
        .map_err(|e| e.to_string())?;
    let mut guard = state.input_conn.lock().unwrap();
    *guard = Some(conn);
    Ok(name)
}

/// 关闭当前 MIDI 输入连接
#[tauri::command]
fn midi_stop_input(state: State<MidiState>) {
    *state.input_conn.lock().unwrap() = None;
}

/// 发送 MIDI 消息到指定输出端口(bytes: [status, d1, d2])
#[tauri::command]
fn midi_send(state: State<MidiState>, port: usize, data: Vec<u8>) -> Result<(), String> {
    let mut conn_guard = state.output_conn.lock().unwrap();
    let mut port_guard = state.output_port.lock().unwrap();
    if let Some(conn) = conn_guard.as_mut() {
        if *port_guard == Some(port) {
            conn.send(&data).map_err(|e| e.to_string())?;
            return Ok(());
        }
        *conn_guard = None;
    }
    let mut mo = midir::MidiOutput::new("COMMIX Out").map_err(|e| e.to_string())?;
    let ports = mo.ports();
    let p = ports.get(port).ok_or("端口不存在")?.clone();
    let mut conn = mo.connect(&p, "COMMIX").map_err(|e| e.to_string())?;
    conn.send(&data).map_err(|e| e.to_string())?;
    *conn_guard = Some(conn);
    *port_guard = Some(port);
    Ok(())
}

// ============ 音频引擎命令 ============

/// 启动音频输出流(cpal)
#[tauri::command]
fn audio_start(audio: State<AudioState>) -> Result<(), String> {
    let mut s = audio.stream.lock().unwrap();
    if s.is_some() { return Ok(()); }
    let (tx, _rx) = std::sync::mpsc::channel();
    let stream = audio::start_stream(audio.bus.clone(), tx).map_err(|e| e.to_string())?;
    *s = Some(stream);
    Ok(())
}

/// 停止音频流
#[tauri::command]
fn audio_stop(audio: State<AudioState>) {
    *audio.stream.lock().unwrap() = None;
}

/// 音频健康检查:返回总线采样时钟(由音频回调推进)。
/// 前端定时轮询,若时钟长期停滞 = 音频流失效(如系统待机/睡眠唤醒后 cpal 流挂起),
/// 前端据此执行 audio_stop + audio_start 重建流,自动恢复声音。
#[tauri::command]
fn audio_health(audio: State<AudioState>) -> u64 {
    audio.bus.lock().map(|b| b.sample_clock).unwrap_or(0)
}

/// 音符开(ch 0-15;0 = 主演奏通道;力度曲线在 Rust 统一应用)
#[tauri::command]
fn note_on(audio: State<AudioState>, ch: usize, midi: u8, vel: f32) {
    if let Ok(mut b) = audio.bus.lock() {
        let v = b.apply_vel(vel);
        if let Some(e) = b.engines.get_mut(ch) { e.note_on(midi, v, 0.0); }
    }
}

#[tauri::command]
fn note_off(audio: State<AudioState>, ch: usize, midi: u8) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.note_off(midi, false); }
    }
}

/// 整组音色参数灌入指定通道引擎(预设/程序变更;字段与前端 captureParams 对齐)
#[tauri::command]
fn set_engine_params(audio: State<AudioState>, ch: usize, params: audio::engine::EngineParams) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_params(params); }
    }
}

/// 单参数实时更新(滑块)
#[tauri::command]
fn set_param(audio: State<AudioState>, ch: usize, key: String, value: f64) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_param(&key, value); }
    }
}

/// 渐变槽位更换
#[tauri::command]
fn set_wt_slots(audio: State<AudioState>, ch: usize, slots: Vec<String>) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_wt_slots(slots); }
    }
}

/// 自定义波形锚点(→ 2048 采样)
#[tauri::command]
fn set_custom_anchors(audio: State<AudioState>, ch: usize, anchors: Vec<(f32, f32)>) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_custom_anchors(anchors); }
    }
}

/// 弯音(半音)
#[tauri::command]
fn set_bend(audio: State<AudioState>, ch: usize, semitones: f32) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_bend(semitones); }
    }
}

/// 延音踏板
#[tauri::command]
fn set_sustain(audio: State<AudioState>, ch: usize, on: bool) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_sustain(on); }
    }
}

/// 持音踏板(CC66)
#[tauri::command]
fn set_sostenuto(audio: State<AudioState>, ch: usize, on: bool) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_sostenuto(on); }
    }
}

/// 弱音踏板(CC67)
#[tauri::command]
fn set_soft(audio: State<AudioState>, ch: usize, on: bool) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.set_soft(on); }
    }
}

/// 全部音符快速释放(通道)
#[tauri::command]
fn all_notes_off(audio: State<AudioState>, ch: usize) {
    if let Ok(mut b) = audio.bus.lock() {
        if let Some(e) = b.engines.get_mut(ch) { e.all_off(); }
    }
}

/// 主效果链参数(volume/reverb/delay_time_ms/delay_feedback/delay_mix/drive)
#[tauri::command]
fn set_master(audio: State<AudioState>, key: String, value: f64) {
    if let Ok(mut b) = audio.bus.lock() {
        b.set_master(&key, value);
    }
}

/// 开始录音(捕获主效果链后输出)
#[tauri::command]
fn record_start(audio: State<AudioState>) {
    if let Ok(mut b) = audio.bus.lock() {
        b.recording.clear();
        b.recording_on = true;
    }
}

/// 停止录音,返回 WAV 字节
#[tauri::command]
fn record_stop(audio: State<AudioState>) -> Result<Vec<u8>, String> {
    let samples: Vec<f32> = {
        let mut b = audio.bus.lock().map_err(|e| e.to_string())?;
        b.recording_on = false;
        std::mem::take(&mut b.recording)
    };
    if samples.is_empty() { return Err("没有录到音频".into()); }
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: audio::dsp::sr() as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut w = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for s in samples.iter() {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            w.write_sample(v).map_err(|e| e.to_string())?;
        }
        w.finalize().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// SMF 播放(base64 字节;采样级调度,多通道多音色由各通道引擎承担)
#[tauri::command]
fn smf_play(app: tauri::AppHandle, audio: State<AudioState>, bytes_base64: String) -> Result<(), String> {
    let bytes = base64_decode(&bytes_base64)?;
    let smf = audio::smf::parse_smf(&bytes)?;
    // 音符事件 → 前端琴键高亮(与采样级调度同步)
    let h = app.clone();
    let on_note: Option<std::sync::Arc<dyn Fn(bool, u8) + Send + Sync>> =
        Some(std::sync::Arc::new(move |on, midi| {
            let _ = h.emit("trans-note", (on, midi));
        }));
    let handle = audio::player::play_smf(audio.bus.clone(), smf, 300, on_note)?;
    let mut p = audio.player.lock().unwrap();
    if let Some(old) = p.take() { old.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed); }
    *p = Some(handle);
    Ok(())
}

/// 停止 SMF 播放
#[tauri::command]
fn smf_stop(audio: State<AudioState>) {
    if let Ok(mut b) = audio.bus.lock() {
        b.pending.clear();
        for e in b.engines.iter_mut() { e.all_off(); }
        b.stop_fade = (dsp::sr() * 5.0 / 1000.0) as u32;   // 5ms 淡出,消除停止"吱"声
    }
    let mut p = audio.player.lock().unwrap();
    if let Some(old) = p.take() { old.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed); }
}

/// 保存录音文件(通过系统保存对话框选路径)
#[tauri::command]
fn save_recording(bytes: Vec<u8>, suggested_name: String) -> Result<String, String> {
    let file = rfd::FileDialog::new()
        .set_title("保存录音")
        .set_file_name(&suggested_name)
        .add_filter("WAV 音频", &["wav"])
        .save_file();
    match file {
        Some(path) => {
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
        None => Err("已取消".to_string()),
    }
}

/// 保存 MIDI 录制(标准 MIDI 文件 .mid)
#[tauri::command]
fn save_midi(bytes: Vec<u8>, suggested_name: String) -> Result<String, String> {
    let file = rfd::FileDialog::new()
        .set_title("保存 MIDI")
        .set_file_name(&suggested_name)
        .add_filter("MIDI 文件", &["mid"])
        .save_file();
    match file {
        Some(path) => {
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
        None => Err("已取消".to_string()),
    }
}

/// 打开 MIDI 文件(对话框 + 读取),返回 base64 编码的字节供前端解析 SMF
#[tauri::command]
fn open_midi() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .set_title("打开 MIDI 文件")
        .add_filter("MIDI 文件", &["mid", "midi"])
        .pick_file();
    match file {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
}

// ============ WAV 导入 / 自动扒谱 / 音色匹配 / .plspmid 超高密度格式 ============

/// 打开 WAV 文件(对话框 + 读取),返回 base64 与文件名
#[tauri::command]
fn open_wav() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .set_title("打开音频文件(WAV/MP3/OGG)")
        .add_filter("音频文件", &["wav", "mp3", "ogg"])
        .pick_file();
    match file {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
}

/// WAV → 自定义波形锚点:提取稳定单周期 + 去 DC + 归一化,返回 [[x,y],...]
#[tauri::command]
fn wav_to_wave(bytes_base64: String, points: usize) -> Result<Vec<Vec<f32>>, String> {
    let bytes = base64_decode(&bytes_base64).map_err(|e| format!("解码失败: {e}"))?;
    let w = audio::audio_to_mono(&bytes).map_err(|e| format!("音频解析失败: {e}"))?;
    Ok(audio::wav::wav_to_anchors(&w.mono, w.sample_rate, points))
}

/// 试听音频(WAV/MP3/OGG,重采样叠加到输出总线)
#[tauri::command]
fn wav_play(audio: State<AudioState>, bytes_base64: String) -> Result<(), String> {
    let bytes = base64_decode(&bytes_base64)?;
    let w = audio::audio_to_mono(&bytes)?;
    let mut b = audio.bus.lock().map_err(|e| e.to_string())?;
    b.wav = Some(audio::WavPlayback { mono: w.mono, pos: 0.0, sample_rate: w.sample_rate, gain: 0.8 });
    Ok(())
}

/// 停止 WAV 试听
#[tauri::command]
fn wav_stop(audio: State<AudioState>) {
    if let Ok(mut b) = audio.bus.lock() { b.wav = None; }
}

/// 自动扒谱 + 音色匹配:解析 WAV → 音符检测(多音高/时值/力度)→ 音区自动分轨 → 每轨音色匹配
/// 返回 JSON:{ bpm, duration, notes:[{t,dur,midi,vel,track,bright,attackMs}], tones:[{track,waveType,params:{}}] }
#[tauri::command]
fn analyze_wav(bytes_base64: String) -> Result<String, String> {
    let bytes = base64_decode(&bytes_base64)?;
    let w = audio::audio_to_mono(&bytes)?;
    let r = audio::analyze::transcribe(&w.mono, w.sample_rate);
    // 按音区轨分组 → 每轨音色匹配
    use std::collections::BTreeMap;
    let mut by_track: BTreeMap<u8, Vec<audio::analyze::DetectedNote>> = BTreeMap::new();
    for n in &r.notes { by_track.entry(n.track).or_default().push(n.clone()); }
    let notes_json: Vec<serde_json::Value> = r.notes.iter().map(|n| serde_json::json!({
        "t": (n.t * 1000.0).round() / 1000.0,
        "dur": (n.dur * 1000.0).round() / 1000.0,
        "midi": n.midi,
        "vel": (n.vel * 100.0).round() / 100.0,
        "track": n.track,
        "bright": (n.bright * 1000.0).round() / 1000.0,
        "attackMs": (n.attack_ms * 10.0).round() / 10.0,
    })).collect();
    let tones_json: Vec<serde_json::Value> = by_track.iter().map(|(&track, ns)| {
        let t = audio::tone_match::match_tone(ns);
        let params: serde_json::Map<String, serde_json::Value> = t.params.iter()
            .map(|(k, v)| (k.clone(), serde_json::json!(v))).collect();
        serde_json::json!({ "track": track, "waveType": t.wave_type, "params": params })
    }).collect();
    Ok(serde_json::json!({
        "bpm": (r.bpm * 10.0).round() / 10.0,
        "duration": (r.duration_sec * 100.0).round() / 100.0,
        "sampleRate": w.sample_rate,
        "notes": notes_json,
        "tones": tones_json,
    }).to_string())
}

/// 编码 .plspmid(notes/tones 为 analyze_wav 返回的 JSON 数组字符串;bpm 换算 us_per_quarter)
#[tauri::command]
fn plspmid_encode(notes_json: String, tones_json: String, bpm: f32, beats_per_bar: u8) -> Result<String, String> {
    let bytes = audio::plspmid::encode_from_json(&notes_json, &tones_json, bpm, beats_per_bar)?;
    Ok(base64_encode(&bytes))
}

/// 打开 .plspmid 文件(对话框),返回 base64 与文件名
#[tauri::command]
fn plspmid_open() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .set_title("打开 .plspmid 文件")
        .add_filter("PLSPMID 超高密度 MIDI", &["plspmid"])
        .pick_file();
    match file {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
}

/// 保存 .plspmid(对话框 + 写文件),返回是否成功
#[tauri::command]
fn plspmid_save(bytes_base64: String) -> Result<(), String> {
    let file = rfd::FileDialog::new()
        .set_title("保存 .plspmid")
        .set_file_name("untitled.plspmid")
        .add_filter("PLSPMID 超高密度 MIDI", &["plspmid"])
        .save_file();
    match file {
        Some(path) => {
            let bytes = base64_decode(&bytes_base64)?;
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
            Ok(())
        }
        None => Err("已取消".to_string()),
    }
}

/// 播放 .plspmid:解码 → 每轨音色灌入对应通道引擎(32 轨)→ 采样级调度
#[tauri::command]
fn plspmid_play(app: tauri::AppHandle, audio: State<AudioState>, bytes_base64: String) -> Result<(), String> {
    let bytes = base64_decode(&bytes_base64)?;
    let plsp = audio::plspmid::decode(&bytes)?;
    // 灌音色:wave_type + 参数(键名 camelCase)应用到 32 轨通道
    {
        let mut b = audio.bus.lock().map_err(|e| e.to_string())?;
        for t in &plsp.tones {
            let idx = t.track as usize;
            if idx >= b.engines.len() { continue; }
            let ep = audio::pilmu::build_params(&t.wave_type, &t.params);
            b.engines[idx].set_params(ep);
        }
    }
    // 音符事件 → 前端琴键高亮
    let h = app.clone();
    let on_note: Option<std::sync::Arc<dyn Fn(bool, u8) + Send + Sync>> =
        Some(std::sync::Arc::new(move |on, midi| {
            let _ = h.emit("trans-note", (on, midi));
        }));
    let handle = audio::player::play_plspmid(audio.bus.clone(), plsp, 300, on_note)?;
    let mut p = audio.player.lock().unwrap();
    if let Some(old) = p.take() { old.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed); }
    *p = Some(handle);
    Ok(())
}

// ============ .PILMU 多轨音乐工程格式(COMMIX 主格式) ============

/// 打开 MP3 文件(工程音频轨导入)
#[tauri::command]
fn open_mp3() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .set_title("打开 MP3 文件")
        .add_filter("MP3 音频", &["mp3"])
        .pick_file();
    match file {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
}

/// 打开 .PILMU 工程文件,返回 (base64, 文件名)
#[tauri::command]
fn pilmu_open() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .set_title("打开 PILMU 工程")
        .add_filter("PILMU 音乐工程", &["pilmu"])
        .pick_file();
    match file {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
}

/// 保存 .PILMU 工程(对话框 + 写文件)
#[tauri::command]
fn pilmu_save(bytes_base64: String) -> Result<(), String> {
    let file = rfd::FileDialog::new()
        .set_title("保存 PILMU 工程")
        .set_file_name("untitled.pilmu")
        .add_filter("PILMU 音乐工程", &["pilmu"])
        .save_file();
    match file {
        Some(path) => {
            let bytes = base64_decode(&bytes_base64)?;
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
            Ok(())
        }
        None => Err("已取消".to_string()),
    }
}

/// 打包 .PILMU:manifest JSON + 资源(name, base64)列表 → 工程字节
#[tauri::command]
fn pilmu_build(manifest_json: String, resources: Vec<(String, String)>) -> Result<String, String> {
    let manifest: audio::pilmu::PilmuManifest = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("工程清单解析失败: {e}"))?;
    let mut res: Vec<(String, Vec<u8>)> = Vec::with_capacity(resources.len());
    for (name, b64) in resources {
        res.push((name, base64_decode(&b64)?));
    }
    let bytes = audio::pilmu::build_pilmu(&manifest, &res)?;
    Ok(base64_encode(&bytes))
}

/// 解包 .PILMU:返回 (manifest_json, 资源列表[(name, base64)])
#[tauri::command]
fn pilmu_extract(bytes_base64: String) -> Result<(String, Vec<(String, String)>), String> {
    let bytes = base64_decode(&bytes_base64)?;
    let (manifest, resources) = audio::pilmu::parse_pilmu(&bytes)?;
    let manifest_json = serde_json::to_string(&manifest).map_err(|e| format!("清单序列化失败: {e}"))?;
    let res = resources.into_iter().map(|(n, d)| (n, base64_encode(&d))).collect();
    Ok((manifest_json, res))
}

/// 播放 .PILMU 工程:音频轨(WAV/MP3)混合 + MIDI 轨(plspmid 32 轨 / mid 程序变更切音色)
#[tauri::command]
fn pilmu_play(app: tauri::AppHandle, audio: State<AudioState>, bytes_base64: String) -> Result<(), String> {
    let bytes = base64_decode(&bytes_base64)?;
    let (manifest, resources) = audio::pilmu::parse_pilmu(&bytes)?;
    let res: std::collections::HashMap<String, Vec<u8>> = resources.into_iter().collect();
    let start_sample = {
        let b = audio.bus.lock().map_err(|e| e.to_string())?;
        b.sample_clock + (300 * audio::dsp::sr() as u64) / 1000
    };
    let plan = audio::pilmu::plan_playback(&manifest, &res, start_sample)?;
    {
        let mut b = audio.bus.lock().map_err(|e| e.to_string())?;
        b.audio_tracks.clear();
        for (mono, sample_rate, gain, pan, offset_samples) in plan.audio_tracks {
            b.audio_tracks.push(audio::AudioTrackPlayback { mono, pos: 0.0, sample_rate, gain, pan, offset_samples });
        }
    }
    let h = app.clone();
    let on_note: Option<std::sync::Arc<dyn Fn(bool, u8) + Send + Sync>> =
        Some(std::sync::Arc::new(move |on, midi| {
            let _ = h.emit("trans-note", (on, midi));
        }));
    let handle = audio::player::spawn_player_events(audio.bus.clone(), plan.events, plan.end_sample, on_note)?;
    let mut p = audio.player.lock().unwrap();
    if let Some(old) = p.take() { old.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed); }
    *p = Some(handle);
    Ok(())
}

/// 简易 base64 编码(零依赖)
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 简易 base64 解码(零依赖)
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' { continue; }
        let v = T.iter().position(|&t| t == c).ok_or("base64 字符无效")? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// 简易 HTTP GET:调系统自带 curl.exe(Windows 10+ 自带),绕过 WebView CORS 限制
/// CREATE_NO_WINDOW:不弹黑色命令框
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("curl.exe");
            c.creation_flags(0x0800_0000);   // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new("curl");
        let out = cmd
            .args(["-s", "--max-time", "10", "-L"])
            .arg(&url)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("curl exit {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用系统默认浏览器打开外部 URL(更新下载/帮助链接,零依赖;不弹命令框)
#[tauri::command]
fn open_external(url: String) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x0800_0000)   // CREATE_NO_WINDOW
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
}

/// 节拍器(Rust 采样级 click,不进录音)
#[tauri::command]
fn metro_set(audio: State<AudioState>, running: bool, bpm: f64, volume: f64) {
    if let Ok(mut b) = audio.bus.lock() {
        b.metro_set(running, bpm as f32, volume as f32);
    }
}

/// 琶音器(Rust 采样级调度,notes = 按住音符)
#[tauri::command]
fn arp_set(audio: State<AudioState>, running: bool, notes: Vec<u8>, bpm: f64, direction: String, octaves: u8) {
    if let Ok(mut b) = audio.bus.lock() {
        let dir = match direction.as_str() { "down" => 1, "updown" => 2, "random" => 3, _ => 0 };
        b.arp_set(running, notes, bpm as f32, dir, octaves);
    }
}

/// 通道音量/静音(多轨混音)
#[tauri::command]
fn set_channel(audio: State<AudioState>, ch: usize, gain: f64, mute: bool) {
    if let Ok(mut b) = audio.bus.lock() {
        b.set_channel(ch, gain as f32, mute);
    }
}

/// 力度曲线(输入力度映射,Rust 统一应用)
#[tauri::command]
fn set_vel_curve(audio: State<AudioState>, anchors: Vec<(f32, f32)>, vel_min: f64, vel_power: f64) {
    if let Ok(mut b) = audio.bus.lock() {
        b.set_vel_curve(anchors, vel_min as f32, vel_power as f32);
    }
}

/// 智能优化(自动频谱整形:过载频段自动衰减)
#[tauri::command]
fn set_smart_opt(audio: State<AudioState>, enabled: bool, strength: f64) {
    if let Ok(mut b) = audio.bus.lock() {
        b.smart.set(enabled, strength as f32);
    }
}

/// 响度探针(补齐音量差距):干跑渲染指定通道音色,返回稳态 RMS
#[tauri::command]
fn probe_loudness(audio: State<AudioState>, ch: usize) -> f32 {
    if let Ok(b) = audio.bus.lock() {
        b.probe_loudness(ch)
    } else { 0.0 }
}

/// 设置采样率(44100/48000/49096…):重建音频总线并重启输出流
#[tauri::command]
fn set_sample_rate(audio: State<AudioState>, hz: u32) -> Result<(), String> {
    audio::dsp::set_sr(hz);
    if let Ok(mut b) = audio.bus.lock() { b.recreate(); }
    let mut s = audio.stream.lock().unwrap();
    *s = None;
    let (tx, _rx) = std::sync::mpsc::channel();
    *s = Some(audio::start_stream(audio.bus.clone(), tx)?);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 作用域数据通道:音频回调 → 专用线程 → 前端 "scope" 事件
    let (scope_tx, scope_rx) = std::sync::mpsc::channel::<Vec<f32>>();
    // 节拍器拍点通道:音频回调 → 前端 "metro-beat" 事件(LED 闪烁)
    let (beat_tx, beat_rx) = std::sync::mpsc::channel::<bool>();
    let bus = Arc::new(Mutex::new(audio::AudioBus::new(scope_tx, beat_tx)));

    tauri::Builder::default()
        .manage(MidiState::default())
        .manage(AudioState { bus: bus.clone(), stream: Mutex::new(None), player: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            midi_list_devices,
            midi_start_input,
            midi_stop_input,
            midi_send,
            audio_start,
            audio_stop,
            audio_health,
            note_on,
            note_off,
            set_engine_params,
            set_param,
            set_wt_slots,
            set_custom_anchors,
            set_bend,
            set_sustain,
            set_sostenuto,
            set_soft,
            all_notes_off,
            set_master,
            set_sample_rate,
            metro_set,
            arp_set,
            set_channel,
            set_vel_curve,
            set_smart_opt,
            probe_loudness,
            record_start,
            record_stop,
            smf_play,
            smf_stop,
            save_recording,
            save_midi,
            open_midi,
            open_wav,
            wav_to_wave,
            open_mp3,
            wav_play,
            wav_stop,
            analyze_wav,
            plspmid_encode,
            plspmid_open,
            plspmid_save,
            plspmid_play,
            pilmu_open,
            pilmu_save,
            pilmu_build,
            pilmu_extract,
            pilmu_play,
            open_external,
            http_get
        ])
        .setup(|app| {
            // 作用域发射线程
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(samples) = scope_rx.recv() {
                    let _ = handle.emit("scope", samples);
                }
            });
            // 节拍器拍点发射线程(LED 同步)
            let handle2 = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(accent) = beat_rx.recv() {
                    let _ = handle2.emit("metro-beat", accent);
                }
            });
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
