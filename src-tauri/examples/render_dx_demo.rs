// DX7 硬件模拟试听:Alg1 金属钟 + Alg32 并行,PM + 4096 表 + 反馈 + 12bit DAC + 扰动
// 运行:cargo run --example render_dx_demo → target/render_dx.wav
use commix::audio::engine::EngineParams;
use commix::audio::{AudioBus, dsp, BLOCK};
use std::sync::mpsc::channel;

fn bell(p: &mut EngineParams) {
    p.wave_type = "dx7".into();
    p.dx_pm = true;
    p.dx_lut_size = 4096;
    p.dx_quant_bits = 16;
    p.dx_dac = true;
    p.dx_algorithm = 1;
    p.dx_feedback = 5;
    p.dx_ratios = [1.0, 2.73, 1.41, 3.0, 2.01, 1.0];
    p.dx_tls = [82.0, 52.0, 56.0, 64.0, 68.0, 72.0];
    p.dx_egs = vec![
        90.0, 99.0, 50.0, 60.0, 30.0, 50.0, 20.0, 20.0,
        95.0, 99.0, 60.0, 70.0, 40.0, 60.0, 30.0, 10.0,
        95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
        95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
        95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
        99.0, 99.0, 80.0, 50.0, 60.0, 30.0, 50.0, 5.0,
    ];
    p.gain = 2.0;
    p.note_jitter = 0.4;
}

fn main() {
    let (tx, _rx) = channel::<Vec<f32>>();
    let mut bus = AudioBus::new(tx, std::sync::mpsc::channel().0);
    // ch0:金属钟(Alg1 + 反馈 5)
    let mut p0 = EngineParams::default();
    bell(&mut p0);
    bus.engines[0].set_params(p0);
    // ch1:并行六载波(Alg32 风琴感)
    let mut p1 = EngineParams::default();
    bell(&mut p1);
    p1.dx_algorithm = 32;
    p1.dx_feedback = 0;
    p1.dx_tls = [60.0; 6];
    bus.engines[1].set_params(p1);
    // ch2:标准 FM(对照,无硬件模拟)
    let mut p2 = EngineParams::default();
    p2.wave_type = "dx7".into();
    p2.dx_pm = false;
    p2.gain = 1.5;
    bus.engines[2].set_params(p2);

    bus.set_master("reverb", 0.3);
    bus.set_master("volume", 0.9);

    // 钟音琶音 C6 E6 G6 C7(金属钟特色) + 风琴和弦 + FM 对照
    bus.engines[0].note_on(84, 0.9, 0.0);
    bus.engines[0].note_on(76, 0.8, 0.6);
    bus.engines[0].note_on(88, 0.8, 1.2);
    bus.engines[0].note_on(91, 0.9, 1.8);
    bus.engines[1].note_on(60, 0.7, 0.0);
    bus.engines[1].note_on(64, 0.7, 0.0);
    bus.engines[1].note_on(67, 0.7, 0.0);
    bus.engines[2].note_on(69, 0.9, 0.0);

    let sr = dsp::sr() as u32;
    let n = (sr * 4) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut done = 0;
    while done < n {
        let block = BLOCK.min(n - done);
        bus.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
        done += block;
    }
    // 释放尾音
    let tail = (sr * 2) as usize;
    let mut tl = vec![0.0f32; tail];
    let mut tr = vec![0.0f32; tail];
    for i in 0..tail {
        bus.render_block(&mut tl[i..i + 1], &mut tr[i..i + 1], 1);
    }
    l.extend(tl);
    r.extend(tr);

    let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/render_dx.wav");
    let mut w = hound::WavWriter::create(&path, spec).expect("wav");
    for i in 0..l.len() {
        let c = |x: f32| (x.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.write_sample(c(l[i])).unwrap();
        w.write_sample(c(r[i])).unwrap();
    }
    w.finalize().unwrap();
    println!("已写出 {} ({} 样本, {} Hz)", path.display(), l.len(), sr);
}
