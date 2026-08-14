// 验证:wt_pos 变化确实改变声音频谱(修复前固定 0.3)
use commix::audio::engine::EngineParams;
use commix::audio::{AudioBus, BLOCK};
use std::sync::mpsc::channel;

fn main() {
    let sr = commix::audio::dsp::sr() as usize;
    // 槽位:sine + sawtooth + square,wt_pos 0 与 1 应差别巨大
    for pos in [0.0f32, 1.0] {
        let mut p = EngineParams::default();
        p.wave_type = "wt".into();
        p.wt_slots = vec!["sine".into(), "sawtooth".into(), "square".into()];
        p.wt_pos = pos;
        let mut bus = AudioBus::new(channel().0, channel().0);
        bus.engines[0].set_params(p);
        bus.engines[0].note_on(60, 1.0, 0.0);
        let n = sr * 1;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        let mut done = 0;
        while done < n {
            let block = BLOCK.min(n - done);
            bus.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
            done += block;
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("target/wt_pos_{}.wav", pos as i32));
        let spec2 = hound::WavSpec { channels: 2, sample_rate: sr as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&path, spec2).unwrap();
        for i in 0..n {
            w.write_sample((l[i].clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
            w.write_sample((r[i].clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
}
