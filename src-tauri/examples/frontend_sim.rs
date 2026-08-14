// 完整前端流程模拟:SEP 日志真实参数(用户主音色 sine+osc2+preset 槽位)
// + 探针归一 + 程序变更(日志的 wave 值)+ 渲染 90s 分段 RMS
use commix::audio::engine::{EngineParams, SynthEngine};
use commix::audio::player::play_smf;
use commix::audio::smf::parse_smf;
use commix::audio::{AudioBus, BLOCK, dsp};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

fn main() {
    let path = std::env::args().nth(1).expect("usage");
    let bytes = std::fs::read(&path).expect("read");
    let smf = parse_smf(&bytes).expect("parse");

    let (tx, _rx) = channel::<Vec<f32>>();
    let (tx2, _rx2) = channel::<bool>();
    let bus = Arc::new(Mutex::new(AudioBus::new(tx, tx2)));

    // ===== 模拟前端:set_engine_params(captureParams = SEP 日志真实值)=====
    // 用户主音色:sine + osc2 + cutoff 2000 + wtSlots 含 preset:糖果世界
    for ch in 0..10usize {
        let mut p = EngineParams::default();
        p.wave_type = "sine".into();
        p.osc_count = 2;
        p.cutoff_hz = 2000.0;
        p.wt_slots = vec![
            "square".into(), "saw".into(), "dx7".into(),
            "preset:糖果世界".into(), "preset:糖果世界".into(),
            "preset:糖果世界".into(), "preset:糖果世界".into(),
        ];
        if let Ok(mut b) = bus.lock() {
            b.engines[ch].set_params(p);
        }
    }
    // ===== 模拟前端:探针(通道 RMS)→ 归一 setChannel(全 sine 相同 → 0.5)=====
    {
        let b = bus.lock().unwrap();
        let r0 = b.probe_loudness(0);
        println!("探针 RMS(ch0)={r0:.4}");
        drop(b);
    }
    {
        let mut b = bus.lock().unwrap();
        for ch in 0..10 { b.set_channel(ch, 0.5, false); }
    }

    // ===== 模拟前端:smfPlay(播放)=====
    let handle = play_smf(bus.clone(), smf, 300, None).expect("play_smf");

    // ===== 模拟前端 pcTimers:程序变更(SEP 日志的真实 wave 值,前 2s 内)=====
    {
        let mut b = bus.lock().unwrap();
        // ch0/ch1 → piano, ch2 → guzheng, ch3 → clar, ch4 → wt, ch5 → sine, ch6 → triangle
        let apply = |e: &mut SynthEngine, wave: &str| {
            let mut p = EngineParams::default();
            p.wave_type = wave.into();
            if wave == "wt" { p.wt_slots = vec!["sine".into(), "triangle".into()]; p.cutoff_hz = 1400.0; }
            if wave == "triangle" { p.osc_count = 2; p.cutoff_hz = 500.0; }
            if wave == "guzheng" || wave == "clar" { p.cutoff_hz = 2000.0; }
            e.set_params(p);
        };
        // 注意:set_params 在播放线程注入的事件消费之前(播放 300ms 延迟)执行即可
        // 这里在 smfPlay 后立即执行,等效前端 0.3-2s 的 pcTimers
        for (ch, w) in [(0usize, "piano"), (1, "piano"), (2, "guzheng"), (3, "clar"), (4, "wt"), (5, "sine"), (6, "triangle")] {
            apply(&mut b.engines[ch], w);
        }
    }

    // ===== 渲染 90s 分段 RMS =====
    let sr = dsp::sr() as usize;
    let seg = sr * 5;
    let mut l = vec![0.0f32; BLOCK];
    let mut r = vec![0.0f32; BLOCK];
    let mut seg_sum = 0.0f64;
    let mut seg_cnt = 0usize;
    let mut seg_peak = 0.0f32;
    let mut rendered = 0usize;
    let mut seg_mark = 0usize;
    let total = sr * 90;
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
            let (voices, pending) = {
                let b = bus.lock().unwrap();
                (b.engines.iter().map(|e| e.voices.len()).sum::<usize>(), b.pending.len())
            };
            println!("  [{:>4.0}s-{:>4.0}s] 峰值={seg_peak:.4} RMS={rms:.4} voices={voices} pending={pending}",
                (rendered - seg) as f32 / sr as f32, rendered as f32 / sr as f32);
            seg_sum = 0.0; seg_cnt = 0; seg_peak = 0.0; seg_mark = rendered;
        }
        std::thread::sleep(std::time::Duration::from_micros(200));
    }
    handle.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    println!("完成");
}
