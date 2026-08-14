// 多通道渲染演示:3 个通道引擎(钢琴/锯齿/wt)同时发声,经主效果链混音输出 WAV
// 运行:cargo run --example render_demo  →  target/render_demo.wav
use commix::audio::engine::EngineParams;
use commix::audio::{AudioBus, dsp, BLOCK};
use std::sync::mpsc::channel;

fn main() {
    let (tx, _rx) = channel::<Vec<f32>>();
    let mut bus = AudioBus::new(tx, std::sync::mpsc::channel().0);

    // ch0:钢琴(低音区伴奏)
    let mut p0 = EngineParams::default();
    p0.wave_type = "piano".into();
    p0.volume = 0.8;
    bus.engines[0].set_params(p0);

    // ch1:锯齿波主旋律(滤波扫频)
    let mut p1 = EngineParams::default();
    p1.wave_type = "saw".into();
    p1.osc_count = 2;
    p1.detune_cents = 8.0;
    p1.cutoff_hz = 1500.0;
    p1.filter_env_hz = 1500.0;
    p1.filter_env_d = 0.25;
    p1.filter_env_s = 0.2;
    p1.release = 0.4;
    p1.volume = 0.7;
    bus.engines[1].set_params(p1);

    // ch2:波表(正弦→锯齿渐变)
    let mut p2 = EngineParams::default();
    p2.wave_type = "wt".into();
    p2.wt_slots = vec!["sine".into(), "triangle".into(), "square".into(), "saw".into()];
    p2.wt_lfo_rate = 0.4;
    p2.wt_lfo_depth = 0.8;
    p2.wt_pos = 0.2;
    p2.release = 0.5;
    p2.volume = 0.7;
    bus.engines[2].set_params(p2);

    // 主效果链:轻微混响 + 延迟
    bus.set_master("reverb", 0.35);
    bus.set_master("delay_mix", 0.15);
    bus.set_master("volume", 0.9);

    // 乐谱:4 拍 × 0.5s
    let sr = dsp::sr() as f32;
    let beat = 0.5f32;
    // ch0 钢琴:和弦根音 C3 E3 G3
    let piano_notes: [(u8, f32); 3] = [(48, 0.0), (52, 0.0), (55, 0.0)];
    for (m, t) in piano_notes { bus.engines[0].note_on(m, 0.9, t); }
    // ch1 旋律:C5 D5 E5 G5 A5
    let mel: [(u8, f32); 5] = [(72, 0.0), (74, 0.5), (76, 1.0), (79, 1.5), (81, 2.0)];
    for (m, t) in mel { bus.engines[1].note_on(m, 0.95, t); }
    // ch2 波表:低音长音 C3
    bus.engines[2].note_on(48, 0.9, 0.0);

    let total_sec = 3.5f32;
    let n = (sr * total_sec) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    // 分块渲染(与音频回调一致)
    let mut done = 0;
    while done < n {
        let block = BLOCK.min(n - done);
        bus.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
        done += block;
    }
    // 释放尾部
    let tail_n = (sr * 1.5) as usize;
    let mut tl = vec![0.0f32; tail_n];
    let mut tr = vec![0.0f32; tail_n];
    for i in 0..tail_n {
        bus.render_block(&mut tl[i..i + 1], &mut tr[i..i + 1], 1);
    }
    l.extend(tl);
    r.extend(tr);

    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: dsp::sr() as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/render_demo.wav");
    let mut w = hound::WavWriter::create(&path, spec).expect("wav create");
    for i in 0..l.len() {
        let clamp = |x: f32| (x.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.write_sample(clamp(l[i])).unwrap();
        w.write_sample(clamp(r[i])).unwrap();
    }
    w.finalize().unwrap();
    let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
    println!("已写出 {} ({} 样本, 峰值 {:.3})", path.display(), l.len(), peak);
}
