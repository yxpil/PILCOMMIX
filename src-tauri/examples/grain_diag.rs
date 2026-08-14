// 粒子合成诊断:逐步检查状态
use commix::audio::engine::{EngineParams, SynthEngine};
fn main() {
    let t = commix::audio::waves::build_wavetable("sawtooth", 32);
    println!("sawtable len={} b10={} b100={} b500={}", t.len(), t[10], t[100], t[500]);
    let mut p = EngineParams::default();
    p.wave_type = "grain".into();
    p.grain_size_ms = 80.0;
    p.grain_density = 40.0;
    let mut e = SynthEngine::new(p);
    e.note_on(60, 1.0, 0.0);
    let mut l = vec![0.0f32; 4410];
    let mut r = vec![0.0f32; 4410];
    e.render_block(&mut l, &mut r, 4410, 0.0);
    let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, x| m.max(x.abs()));
    let sum: f32 = l.iter().chain(r.iter()).map(|x| x * x).sum();
    println!("峰值={peak:.4} 能量={sum:.4}");
}
