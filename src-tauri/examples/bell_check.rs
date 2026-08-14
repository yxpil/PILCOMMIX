// 金属钟音量验证(新旧 dx_tls 对比)
use commix::audio::engine::{EngineParams, SynthEngine};
fn peak(p: &EngineParams) -> f32 {
    let mut e = SynthEngine::new(p.clone());
    e.note_on(72, 1.0, 0.0);
    let n = 44100usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    e.render_block(&mut l, &mut r, n, 0.0);
    let seg = &l[4410..22050];
    let sum: f32 = seg.iter().map(|x| x * x).sum();
    (sum / seg.len() as f32).sqrt()
}
fn main() {
    let mut old = EngineParams::default();
    old.wave_type = "dx7".into();
    old.dx_pm = true; old.dx_lut_size = 4096; old.dx_quant_bits = 16; old.dx_aa = true;
    old.dx_algorithm = 1; old.dx_feedback = 3;
    old.dx_ratios = [1.0, 2.73, 1.41, 3.0, 2.01, 1.0];
    old.dx_tls = [82.0, 52.0, 56.0, 64.0, 68.0, 72.0];
    let mut new = old.clone();
    new.dx_tls = [58.0, 34.0, 38.0, 46.0, 50.0, 52.0];
    new.gain = 2.0;
    println!("金属钟旧参数 RMS={:.4}", peak(&old));
    println!("金属钟新参数 RMS={:.4}", peak(&new));
}
