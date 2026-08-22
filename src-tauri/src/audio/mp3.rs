// MP3 解码:minimp3 → 单声道 f32(供工程音频轨播放与后续扒谱)
// minimp3 输出 16-bit 交错 PCM;这里统一转成 wav::WavData(多声道平均)

use minimp3::{Decoder, Frame};

pub fn mp3_to_wav(bytes: &[u8]) -> Result<super::wav::WavData, String> {
    let mut dec = Decoder::new(bytes);
    let mut raw: Vec<i16> = Vec::new();
    let mut sample_rate = 44100u32;
    let mut channels = 1usize;
    loop {
        match dec.next_frame() {
            Ok(Frame { data, sample_rate: sr, channels: ch, .. }) => {
                sample_rate = sr as u32;
                channels = ch as usize;
                raw.extend_from_slice(&data);
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => return Err(format!("MP3 解码失败: {e}")),
        }
    }
    if raw.is_empty() { return Err("MP3 中没有可解码的音频数据".into()); }
    let frames = raw.len() / channels.max(1);
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut acc = 0i64;
        for c in 0..channels {
            acc += raw[f * channels + c] as i64;
        }
        mono.push(acc as f32 / (channels as f32 * 32768.0));
    }
    Ok(super::wav::WavData {
        duration_sec: frames as f32 / sample_rate as f32,
        mono, sample_rate, channels: channels as u16, bits: 16,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_input_does_not_panic() {
        // 解码器对随机字节宽容,只要求不 panic、可解码内容时长合理
        let r = mp3_to_wav(b"this is definitely not mp3 data, but minimp3 is lenient...");
        match r {
            Ok(w) => assert!(w.mono.len() < 4096, "garbage should not produce huge audio, got {}", w.mono.len()),
            Err(_) => { /* 报错也可接受 */ }
        }
    }

    #[test]
    fn empty_input_errors() {
        assert!(mp3_to_wav(b"").is_err());
    }
}
