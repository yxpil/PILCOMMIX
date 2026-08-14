// 排除法:逐步加环节,定位导致前段静音的环节
// 1. 仅 set_params(前端参数)
// 2. + set_channel(0.5)
// 3. + 程序变更
// 渲染 0-35s 分段 RMS 对比
use commix::audio::engine::{EngineParams, SynthEngine};
use commix::audio::player::play_smf;
use commix::audio::smf::parse_smf;
use commix::audio::{AudioBus, BLOCK, dsp};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

fn front_params() -> EngineParams {
    let mut p = EngineParams::default();
    p.wave_type = "sine".into();
    p.osc_count = 2;
    p.cutoff_hz = 2000.0;
    p.wt_slots = vec![
        "square".into(), "saw".into(), "dx7".into(),
        "preset:糖果世界".into(), "preset:糖果世界".into(),
        "preset:糖果世界".into(), "preset:糖果世界".into(),
    ];
    p
}

fn run(mode: u8, path: &str) {
    let bytes = std::fs::read(path).expect("read");
    let smf = parse_smf(&bytes).expect("parse");
    let (tx, _rx) = channel::<Vec<f32>>();
    let (tx2, _rx2) = channel::<bool>();
    let bus = Arc::new(Mutex::new(AudioBus::new(tx, tx2)));

    // 环节 1:set_params
    for ch in 0..10usize {
        if let Ok(mut b) = bus.lock() {
            b.engines[ch].set_params(front_params());
        }
    }
    // 环节 2:set_channel
    if mode >= 2 {
        let mut b = bus.lock().unwrap();
        for ch in 0..10 { b.set_channel(ch, 0.5, false); }
    }
    // 环节 3:smfPlay + 程序变更
    let handle = play_smf(bus.clone(), smf, 300, None).expect("play_smf");
    if mode >= 3 {
        let mut b = bus.lock().unwrap();
        let apply = |e: &mut SynthEngine, wave: &str| {
            let mut p = EngineParams::default();
            p.wave_type = wave.into();
            if wave == "wt" { p.wt_slots = vec!["sine".into(), "triangle".into()]; p.cutoff_hz = 1400.0; }
            if wave == "triangle" { p.osc_count = 2; p.cutoff_hz = 500.0; }
            e.set_params(p);
        };
        for (ch, w) in [(0usize, "piano"), (1, "piano"), (2, "guzheng"), (3, "clar"), (4, "wt"), (5, "sine"), (6, "triangle")] {
            apply(&mut b.engines[ch], w);
        }
    }

    // 渲染 0-35s
    let sr = dsp::sr() as usize;
    let seg = sr * 5;
    let mut l = vec![0.0f32; BLOCK];
    let mut r = vec![0.0f32; BLOCK];
    let mut seg_sum = 0.0f64;
    let mut seg_cnt = 0usize;
    let mut seg_peak = 0.0f32;
    let mut rendered = 0usize;
    let mut seg_mark = 0usize;
    let total = sr * 35;
    println!("=== mode {mode} ===");
    while rendered < total {
        l.fill(0.0); r.fill(0.0);
        {
            let mut b = bus.lock().unwrap();
            b.render_block(&mut l, &mut r, BLOCK);
        }
        for &x in l.iter().chain(r.iter()) {
            seg_sum += (x as f64) * (x as f64);
            seg_cnt += 1;
            seg_peak = seg_peak.max(x.abs());
        }
        rendered += BLOCK;
        if rendered - seg_mark >= seg {
            let rms = (seg_sum / seg_cnt as f64).sqrt();
            println!("  [{:>4.0}s-{:>4.0}s] 峰值={seg_peak:.4} RMS={rms:.4}",
                (rendered - seg) as f32 / sr as f32, rendered as f32 / sr as f32);
            seg_sum = 0.0; seg_cnt = 0; seg_peak = 0.0; seg_mark = rendered;
        }
        std::thread::sleep(std::time::Duration::from_micros(200));
    }
    handle.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn main() {
    let path = std::env::args().nth(1).expect("usage");
    run(1, &path);
    run(2, &path);
    run(3, &path);
}
