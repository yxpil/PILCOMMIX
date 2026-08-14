// 新预设试听:金属钟(Alg1 反馈3 抗混叠)+ 风琴(Alg32 音栓混合)+ 电钢(Alg2 双链)
// cargo run --example render_presets → target/render_presets.wav
use commix::audio::engine::EngineParams;
use commix::audio::{AudioBus, BLOCK};
use std::sync::mpsc::channel;

fn dx_preset(alg: u8, fb: u8, ratios: [f32; 6], tls: [f32; 6], egs: [f32; 48]) -> EngineParams {
    let mut p = EngineParams::default();
    p.wave_type = "dx7".into();
    p.dx_pm = true; p.dx_lut_size = 4096; p.dx_quant_bits = 16; p.dx_aa = true; p.dx_dac = false;
    p.dx_algorithm = alg; p.dx_feedback = fb;
    p.dx_ratios = ratios; p.dx_tls = tls; p.dx_egs = egs.to_vec();
    p.gain = 1.5;
    p
}

fn main() {
    let mut bus = AudioBus::new(channel().0, channel().0);
    let sr = commix::audio::dsp::sr() as usize;
    // 金属钟(豆包参考表,反馈 3)
    let bell = dx_preset(1, 3,
        [1.0, 2.73, 1.41, 3.0, 2.01, 1.0],
        [82.0, 52.0, 56.0, 64.0, 68.0, 72.0],
        [95.0,99.0,70.0,10.0,50.0,0.0,60.0,0.0, 90.0,99.0,60.0,15.0,45.0,0.0,55.0,0.0, 85.0,99.0,55.0,20.0,40.0,0.0,50.0,0.0,
         88.0,99.0,60.0,10.0,45.0,0.0,55.0,0.0, 70.0,99.0,25.0,30.0,15.0,0.0,40.0,0.0, 99.0,99.0,10.0,50.0,5.0,50.0,25.0,0.0]);
    // 风琴(音栓混合)
    let organ = dx_preset(32, 0,
        [1.0, 2.0, 3.0, 4.0, 0.5, 1.5],
        [55.0, 60.0, 65.0, 62.0, 58.0, 66.0],
        [95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0, 95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0, 95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0,
         95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0, 95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0, 95.0,99.0,8.0,80.0,5.0,80.0,50.0,0.0]);
    // 电钢(Alg2 双链,调制 14)
    let ep = dx_preset(2, 1,
        [1.0, 1.0, 14.0, 1.0, 1.0, 14.0],
        [80.0, 70.0, 60.0, 76.0, 70.0, 60.0],
        [99.0,99.0,30.0,20.0,20.0,10.0,40.0,0.0, 99.0,99.0,60.0,10.0,40.0,0.0,50.0,0.0, 90.0,99.0,70.0,5.0,50.0,0.0,60.0,0.0,
         99.0,99.0,30.0,20.0,20.0,10.0,40.0,0.0, 99.0,99.0,60.0,10.0,40.0,0.0,50.0,0.0, 90.0,99.0,70.0,5.0,50.0,0.0,60.0,0.0]);

    let mut l = Vec::new();
    let mut r = Vec::new();
    // 金属钟:2s(1.5s 后停音听尾音)
    bus.engines[0].set_params(bell);
    bus.engines[0].note_on(67, 1.0, 0.0);
    let n1 = sr * 2;
    let mut buf = vec![0.0f32; n1];
    let mut buf2 = vec![0.0f32; n1];
    let mut done = 0;
    while done < n1 {
        let block = BLOCK.min(n1 - done);
        if done == sr * 3 / 2 { bus.engines[0].note_off(67, true); }
        bus.render_block(&mut buf[done..done + block], &mut buf2[done..done + block], block);
        done += block;
    }
    l.extend(buf); r.extend(buf2);
    // 风琴:1.5s 和弦
    bus.engines[0].set_params(organ);
    bus.engines[0].note_on(60, 1.0, 0.0);
    bus.engines[0].note_on(64, 1.0, 0.0);
    bus.engines[0].note_on(67, 1.0, 0.0);
    let n2 = sr * 3 / 2;
    let mut buf = vec![0.0f32; n2];
    let mut buf2 = vec![0.0f32; n2];
    let mut done = 0;
    while done < n2 {
        let block = BLOCK.min(n2 - done);
        bus.render_block(&mut buf[done..done + block], &mut buf2[done..done + block], block);
        done += block;
    }
    l.extend(buf); r.extend(buf2);
    // 电钢:2s(1.5s 后停)
    bus.engines[0].set_params(ep);
    bus.engines[0].note_on(64, 1.0, 0.0);
    let n3 = sr * 2;
    let mut buf = vec![0.0f32; n3];
    let mut buf2 = vec![0.0f32; n3];
    let mut done = 0;
    while done < n3 {
        let block = BLOCK.min(n3 - done);
        if done == sr * 3 / 2 { bus.engines[0].note_off(64, true); }
        bus.render_block(&mut buf[done..done + block], &mut buf2[done..done + block], block);
        done += block;
    }
    l.extend(buf); r.extend(buf2);

    let spec = hound::WavSpec { channels: 2, sample_rate: sr as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/render_presets.wav");
    let mut w = hound::WavWriter::create(&path, spec).expect("wav");
    for i in 0..l.len() {
        let c = |x: f32| (x.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.write_sample(c(l[i])).unwrap();
        w.write_sample(c(r[i])).unwrap();
    }
    w.finalize().unwrap();
    let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
    println!("已写出 {} ({} 样本, 峰值 {:.3})", path.display(), l.len(), peak);
}
