use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// 打开指定输入端(按索引),消息以 "midi-in" 事件(载荷 Vec<u8>)发到前端
#[tauri::command]
fn midi_start_input(app: AppHandle, state: State<MidiState>, port: usize) -> Result<String, String> {
    let mut mi = midir::MidiInput::new("COMMIX In").map_err(|e| e.to_string())?;
    let ports = mi.ports();
    let p = ports.get(port).ok_or("端口不存在")?.clone();
    let name = mi.port_name(&p).map_err(|e| e.to_string())?;
    let conn = mi
        .connect(&p, "COMMIX", move |_stamp, data, _| {
            let _ = app.emit("midi-in", data.to_vec());
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
/// 持久连接复用:首次或端口切换时重建,其余直接 send(winmm 消息可靠)
#[tauri::command]
fn midi_send(state: State<MidiState>, port: usize, data: Vec<u8>) -> Result<(), String> {
    let mut conn_guard = state.output_conn.lock().unwrap();
    let mut port_guard = state.output_port.lock().unwrap();
    if let Some(conn) = conn_guard.as_mut() {
        if *port_guard == Some(port) {
            conn.send(&data).map_err(|e| e.to_string())?;
            return Ok(());
        }
        // 端口已切换:丢弃旧连接,重建
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
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {}", e))?;
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
            std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {}", e))?;
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
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
            let b64 = base64_encode(&bytes);
            Ok((b64, path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        }
        None => Err("已取消".to_string()),
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MidiState::default())
        .invoke_handler(tauri::generate_handler![
            midi_list_devices,
            midi_start_input,
            midi_stop_input,
            midi_send,
            save_recording,
            save_midi,
            open_midi
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
