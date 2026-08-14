// 检查"指拨贝斯/33"和"moog"按播放合并参数渲染是否出声
use commix::audio::engine::{EngineParams, SynthEngine};
fn probe(name: &str, p: EngineParams) {
    let mut e = SynthEngine::new(p);
    e.note_on(45, 1.0, 0.0);   // A2 贝斯音域
    let n = 44100usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    e.render_block(&mut l, &mut r, n, 0.0);
    let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
    println!("{name}: peak={peak:.4}");
}
fn main() {
    // 指拨贝斯(库预设 33)
    let mut p = EngineParams::default();
    p.wave_type = "triangle".into();
    p.osc_count = 2; p.detune_cents = 4.0; p.cutoff_hz = 500.0;
    p.attack = 0.01; p.decay = 0.3; p.sustain = 0.6; p.release = 0.2;
    probe("指拨贝斯(33)", p);
    // moog(环形 5)
    let mut p = EngineParams::default();
    p.wave_type = "moog".into();
    p.osc_wave = "sawtooth".into();
    probe("moog", p);
    // 纯默认(反序列化失败时的兜底)
    probe("默认default", EngineParams::default());
}
