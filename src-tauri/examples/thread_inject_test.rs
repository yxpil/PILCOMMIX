// 完整复现:真实 play_smf 线程注入 + 主线程渲染,分段 RMS(与 midi_diag 同步注入对比)
use commix::audio::smf::parse_smf;
use commix::audio::player::play_smf;
use commix::audio::{AudioBus, BLOCK, dsp};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

fn main() {
    let path = std::env::args().nth(1).expect("usage: thread_inject_test <file.mid>");
    let bytes = std::fs::read(&path).expect("read file");
    let smf = parse_smf(&bytes).expect("parse smf");

    let (tx, _rx) = channel::<Vec<f32>>();
    let (tx2, _rx2) = channel::<bool>();
    let bus = Arc::new(Mutex::new(AudioBus::new(tx, tx2)));
    let handle = play_smf(bus.clone(), smf, 300, None).expect("play_smf");

    let sr = dsp::sr() as usize;
    let seg = sr * 5;   // 5 秒一段
    let mut l = vec![0.0f32; BLOCK];
    let mut r = vec![0.0f32; BLOCK];
    let mut seg_sum = 0.0f64;
    let mut seg_cnt = 0usize;
    let mut seg_peak = 0.0f32;
    let mut rendered = 0usize;
    let mut seg_cnt_progress = 0usize;
    let total = sr * 90;   // 渲染 90 秒

    while rendered < total {
        l.fill(0.0); r.fill(0.0);
        let mut b = bus.lock().unwrap();
        b.render_block(&mut l, &mut r, BLOCK);
        drop(b);
        for &x in l.iter().chain(r.iter()) {
            seg_sum += (x as f64) * (x as f64);
            seg_cnt += 1;
            seg_peak = seg_peak.max(x.abs());
        }
        rendered += BLOCK;
        if rendered - seg_cnt_progress >= seg {
            let rms = (seg_sum / seg_cnt as f64).sqrt();
            println!("  [{:>4.0}s-{:>4.0}s] 峰值={seg_peak:.4} RMS={rms:.4}",
                (rendered - seg) as f32 / sr as f32, rendered as f32 / sr as f32);
            seg_sum = 0.0; seg_cnt = 0; seg_peak = 0.0;
            seg_cnt_progress = rendered;
        }
        std::thread::sleep(std::time::Duration::from_micros(200));  // 模拟实时节流
    }
    handle.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    println!("完成");
}
