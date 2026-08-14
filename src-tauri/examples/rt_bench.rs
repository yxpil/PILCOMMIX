// 音频实时性基准:debug 构建渲染一个 block(256 采样 × 10 通道)耗时 vs 5.8ms 预算
use commix::audio::engine::{EngineParams, SynthEngine};
use std::time::Instant;

fn main() {
    // 10 个通道引擎 + 和弦
    let mut engines: Vec<SynthEngine> = (0..10)
        .map(|_| {
            let mut p = EngineParams::default();
            p.wave_type = "sine".into();
            p.osc_count = 2;
            SynthEngine::new(p)
        })
        .collect();
    // 每个通道 6 个音符(复音压力)
    for (i, e) in engines.iter_mut().enumerate() {
        for k in 0..6 { e.note_on(48 + (i + k) as u8, 0.9, 0.0); }
    }
    let block = 256usize;
    let mut l = vec![0.0f32; block];
    let mut r = vec![0.0f32; block];

    // 预热
    for e in engines.iter_mut() { e.render_block(&mut l, &mut r, block, 0.0); }

    // 计时 2000 个 block
    let n = 2000usize;
    let t0 = Instant::now();
    for _ in 0..n {
        l.fill(0.0); r.fill(0.0);
        for e in engines.iter_mut() { e.render_block(&mut l, &mut r, block, 0.0); }
    }
    let el = t0.elapsed();
    let per_block = el.as_secs_f64() / n as f64;
    let budget = block as f64 / 44100.0;   // 5.8ms
    println!("平均每 block: {:.3}ms (预算 {:.3}ms) 占用率 {:.1}%",
        per_block * 1000.0, budget * 1000.0, per_block / budget * 100.0);
    if per_block > budget {
        println!("=> 超时!音频线程会丢块/静音(debug 构建)");
    } else {
        println!("=> 实时性 OK");
    }
}
