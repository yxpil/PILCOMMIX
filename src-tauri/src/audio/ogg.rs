// OGG(Vorbis)解码:lewton 纯 Rust 解码 → 单声道 f32(与 mp3.rs 同构,统一成 wav::WavData)

use lewton::inside_ogg::OggStreamReader;
use lewton::samples::InterleavedSamples;

pub fn ogg_to_wav(bytes: &[u8]) -> Result<super::wav::WavData, String> {
    let mut reader = OggStreamReader::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("OGG 解析失败: {e}"))?;
    let sample_rate = reader.ident_hdr.audio_sample_rate;
    let channels = reader.ident_hdr.audio_channels.max(1) as usize;
    let mut raw: Vec<i16> = Vec::new();
    loop {
        match reader.read_dec_packet_generic::<InterleavedSamples<i16>>() {
            Ok(Some(pkt)) => raw.extend_from_slice(&pkt.samples),
            Ok(None) => break, // EOS
            Err(e) => return Err(format!("OGG 解码失败: {e}")),
        }
    }
    if raw.is_empty() {
        return Err("OGG 中没有可解码的音频数据".into());
    }
    let frames = raw.len() / channels;
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
        // 非法 OGG 只要求不 panic(解析或解码报错均可)
        let r = ogg_to_wav(b"OggS\x00\x02 definitely not a real vorbis stream........");
        assert!(r.is_err(), "garbage ogg should error, got ok with {} samples", r.ok().map(|w| w.mono.len()).unwrap_or(0));
    }

    #[test]
    fn empty_input_errors() {
        assert!(ogg_to_wav(b"").is_err());
    }
}
