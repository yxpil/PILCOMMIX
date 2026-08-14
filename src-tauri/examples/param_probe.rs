// 参数对比:同一音符,不同参数组合的渲染 RMS(定位导致静音的参数)
use commix::audio::engine::{EngineParams, SynthEngine};

fn probe_rms(p: EngineParams, note: u8) -> f32 {
    let mut e = SynthEngine::new(p);
    e.note_on(note, 1.0, 0.0);
    let n = 44100usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    e.render_block(&mut l, &mut r, n, 0.0);
    let seg = &l[4410..44100];
    let sum: f32 = seg.iter().map(|x| x * x).sum();
    (sum / seg.len() as f32).sqrt()
}

fn main() {
    let notes = [36u8, 48, 60, 72];
    // A. 默认参数
    println!("--- 默认参数 ---");
    for n in notes {
        println!("  音符{n}: RMS={:.4}", probe_rms(EngineParams::default(), n));
    }
    // B. 前端参数:wave=sine + osc2 + cutoff2000 + wtSlots(含 preset:)
    println!("--- 前端参数(sine+osc2+cutoff2000+preset槽位) ---");
    for n in notes {
        let mut p = EngineParams::default();
        p.wave_type = "sine".into();
        p.osc_count = 2;
        p.cutoff_hz = 2000.0;
        p.wt_slots = vec!["square".into(), "saw".into(), "dx7".into(),
            "preset:糖果世界".into(), "preset:糖果世界".into(),
            "preset:糖果世界".into(), "preset:糖果世界".into()];
        println!("  音符{n}: RMS={:.4}", probe_rms(p, n));
    }
    // C. 逐步排除:wt_slots 的影响
    println!("--- 前端参数但 wt_slots 空 ---");
    for n in notes {
        let mut p = EngineParams::default();
        p.wave_type = "sine".into();
        p.osc_count = 2;
        p.cutoff_hz = 2000.0;
        println!("  音符{n}: RMS={:.4}", probe_rms(p, n));
    }
    // D. 只有 wave=sine
    println!("--- 仅 wave=sine(其余默认) ---");
    for n in notes {
        let mut p = EngineParams::default();
        p.wave_type = "sine".into();
        println!("  音符{n}: RMS={:.4}", probe_rms(p, n));
    }
}
