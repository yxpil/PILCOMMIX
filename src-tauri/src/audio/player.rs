// SMF 播放调度线程:解析 → 采样级事件注入音频总线(音频回调按采样偏移消费)
use super::{AudioBus, AudioEvent, BLOCK, PendingEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct PlayerHandle {
    pub stop_flag: Arc<AtomicBool>,
    pub thread: Option<std::thread::JoinHandle<()>>,
}

/// 启动播放:把 SMF 事件按采样时刻分批注入总线
/// program 参数(通道 → 程序号)由前端在播放前/中通过 set_engine_params 下发,
/// 此处只负责音符时序(与 TS 播放器分工一致:前端解析音色,Rust 负责采样级调度)
/// on_note:音符事件回调(前端琴键高亮),在事件注入时触发
pub fn play_smf(
    bus: Arc<std::sync::Mutex<AudioBus>>,
    smf: super::smf::Smf,
    start_delay_ms: u64,
    on_note: Option<Arc<dyn Fn(bool, u8) + Send + Sync>>,
) -> Result<PlayerHandle, String> {
    let start_sample = {
        let b = bus.lock().map_err(|e| e.to_string())?;
        b.sample_clock + (start_delay_ms * super::dsp::sr() as u64) / 1000
    };
    let mut events = smf.to_events(start_sample);
    let end_sample = start_sample + (smf.duration_sec() * super::dsp::sr() as f64) as u64;
    for ch in 0..super::N_CHANNELS {
        events.push((end_sample, AudioEvent::AllOff { ch }));
    }
    spawn_player(bus, events, end_sample, on_note)
}

/// 启动 .plspmid 播放:32 轨超高密度事件流(音色已由调用方灌入各通道引擎)
pub fn play_plspmid(
    bus: Arc<std::sync::Mutex<AudioBus>>,
    plsp: super::plspmid::PlspMid,
    start_delay_ms: u64,
    on_note: Option<Arc<dyn Fn(bool, u8) + Send + Sync>>,
) -> Result<PlayerHandle, String> {
    let start_sample = {
        let b = bus.lock().map_err(|e| e.to_string())?;
        b.sample_clock + (start_delay_ms * super::dsp::sr() as u64) / 1000
    };
    let sec_per_tick = (plsp.us_per_quarter as f64 / 1e6) / plsp.division as f64;
    let sr = super::dsp::sr() as f64;
    let mut events: Vec<(u64, AudioEvent)> = Vec::with_capacity(plsp.notes.len() * 2);
    for n in &plsp.notes {
        let t0 = start_sample + (n.tick as f64 * sec_per_tick * sr) as u64;
        let t1 = start_sample + ((n.tick + n.dur) as f64 * sec_per_tick * sr) as u64;
        events.push((t0, AudioEvent::NoteOn { ch: n.track as usize, midi: n.midi, vel: n.vel as f32 / 127.0 }));
        events.push((t1, AudioEvent::NoteOff { ch: n.track as usize, midi: n.midi }));
    }
    let end_sample = start_sample + (super::plspmid::duration_sec(&plsp) as f64 * sr) as u64;
    for ch in 0..super::N_CHANNELS {
        events.push((end_sample, AudioEvent::AllOff { ch }));
    }
    events.sort_by_key(|(t, _)| *t);
    spawn_player(bus, events, end_sample, on_note)
}

/// 播放外部事件流(.PILMU 工程播放:多轨合并后直接注入)
pub fn spawn_player_events(
    bus: Arc<std::sync::Mutex<AudioBus>>,
    events: Vec<(u64, AudioEvent)>,
    end_sample: u64,
    on_note: Option<Arc<dyn Fn(bool, u8) + Send + Sync>>,
) -> Result<PlayerHandle, String> {
    spawn_player(bus, events, end_sample, on_note)
}

/// 公共播放线程:按采样时刻分批注入事件,结束后自动退出
fn spawn_player(
    bus: Arc<std::sync::Mutex<AudioBus>>,
    mut events: Vec<(u64, AudioEvent)>,
    end_sample: u64,
    on_note: Option<Arc<dyn Fn(bool, u8) + Send + Sync>>,
) -> Result<PlayerHandle, String> {
    events.sort_by_key(|(t, _)| *t);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let flag = stop_flag.clone();
    let bus2 = bus.clone();
    let thread = std::thread::spawn(move || {
        let mut idx = 0usize;
        // 前瞻窗口:每 12ms 注入一批(音频回调在渲染时消费,采样级精确)
        let window = (12 * super::dsp::sr() as u64) / 1000;
        loop {
            if flag.load(Ordering::Relaxed) { break; }
            let now = bus2.lock().map(|b| b.sample_clock).unwrap_or(0);
            let horizon = now + window;
            let mut batch = Vec::new();
            while idx < events.len() && events[idx].0 <= horizon {
                batch.push(PendingEvent { sample: events[idx].0, ev: events[idx].1.clone() });
                idx += 1;
            }
            if !batch.is_empty() {
                // 音符事件回调(前端琴键高亮,与采样级调度同步)
                if let Some(cb) = &on_note {
                    for pe in batch.iter() {
                        match &pe.ev {
                            AudioEvent::NoteOn { midi, .. } => cb(true, *midi),
                            AudioEvent::NoteOff { midi, .. } => cb(false, *midi),
                            _ => {}
                        }
                    }
                }
                if let Ok(mut b) = bus2.lock() {
                    b.pending.extend(batch);
                }
            }
            if idx >= events.len() {
                // 全部事件已入队,等待播放完成(最后 AllOff 被消费后退出)
                std::thread::sleep(std::time::Duration::from_millis(50));
                let done = bus2.lock().map(|b| b.sample_clock >= end_sample + BLOCK as u64).unwrap_or(false);
                if done { break; }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(4));
            }
        }
    });
    Ok(PlayerHandle { stop_flag, thread: Some(thread) })
}

impl Drop for PlayerHandle {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}
