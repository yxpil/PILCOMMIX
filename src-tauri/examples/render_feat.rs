// 综合功能演示:琶音器(采样级) + 节拍器 + 双通道 + 力度曲线 + 限制器
// cargo run --example render_feat → target/render_feat.wav
use commix::audio::engine::EngineParams;
use commix::audio::{AudioBus, BLOCK};
use std::sync::mpsc::channel;

fn main() {
    let mut bus = AudioBus::new(channel().0, channel().0);
    // ch0:锯齿琶音底(up 方向)
    let mut p0 = EngineParams::default();
    p0.wave_type = "saw".into();
    p0.osc_count = 2;
    p0.cutoff_hz = 1800.0;
    p0.filter_env_hz = 1200.0;
    p0.release = 0.25;
    bus.engines[0].set_params(p0);
    // ch1:钢琴根音长音
    let mut p1 = EngineParams::default();
    p1.wave_type = "piano".into();
    bus.engines[1].set_params(p1);
    bus.engines[1].note_on(48, 1.0, 0.0);
    // 琶音器:按住 C4 E4 G4,120BPM,up
    bus.arp_set(true, vec![60, 64, 67], 120.0, 0, 2);
    // 节拍器 100BPM 音量 0.4(不进录音)
    bus.metro_set(true, 100.0, 0.4);
    // 力度曲线:轻按更灵敏
    bus.set_vel_curve(vec![(0.0, 0.0), (0.3, 0.5), (0.6, 0.8), (1.0, 1.0)], 0.15, 1.0);
    // 限制器保持
    bus.set_limiter(true);
    // ch1 音量 0.7
    bus.set_channel(1, 0.7, false);

    let sr = commix::audio::dsp::sr() as u32;
    let n = (sr * 4) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut done = 0;
    while done < n {
        let block = BLOCK.min(n - done);
        bus.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
        done += block;
    }
    // 尾音
    let tail = (sr * 1) as usize;
    let mut tl = vec![0.0f32; tail];
    let mut tr = vec![0.0f32; tail];
    for i in 0..tail {
        bus.render_block(&mut tl[i..i + 1], &mut tr[i..i + 1], 1);
    }
    l.extend(tl);
    r.extend(tr);

    let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/render_feat.wav");
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
