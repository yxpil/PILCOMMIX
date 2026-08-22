// WAV 解析:RIFF/WAVE 容器 → f32 单声道样本(任意位深/声道数,立体声取平均)
// 供扒谱分析(analyze.rs)与 WAV 试听播放(wav_play)使用

#[derive(Clone, Debug)]
pub struct WavData {
    pub mono: Vec<f32>,        // 单声道,归一化到 [-1, 1]
    pub sample_rate: u32,
    pub channels: u16,
    pub bits: u16,
    pub duration_sec: f32,
}

/// 解析 WAV 字节。支持 PCM(8/16/24/32 位)与 IEEE float(32 位)。
/// 失败返回中文错误信息(前端直接展示)。
pub fn parse_wav(bytes: &[u8]) -> Result<WavData, String> {
    if bytes.len() < 44 { return Err("文件太小,不是有效 WAV".into()); }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("不是标准 WAV 文件(RIFF/WAVE 缺失)".into());
    }
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, sample_rate, bits)
    let mut data: Option<(usize, usize)> = None;       // (offset, len)
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body = pos + 8;
        if body + len > bytes.len() { break; }   // 截断的块直接忽略
        match id {
            b"fmt " => {
                if len < 16 { return Err("fmt 块过短".into()); }
                let format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
                let channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
                let sample_rate = u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]);
                let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
                fmt = Some((format, channels, sample_rate, bits));
            }
            b"data" => { data = Some((body, len)); }
            _ => {}
        }
        pos = body + len + (len & 1);   // 块按 2 字节对齐
    }
    let (format, channels, sample_rate, bits) = fmt.ok_or("缺少 fmt 块")?;
    let (data_off, data_len) = data.ok_or("缺少 data 块")?;
    if channels == 0 || sample_rate == 0 { return Err("WAV 参数非法".into()); }

    let bytes_per_sample = (bits as usize / 8).max(1);
    let frames = data_len / (bytes_per_sample * channels as usize);
    let mut mono = Vec::with_capacity(frames);
    // 逐帧:多声道平均
    for f in 0..frames {
        let base = data_off + f * bytes_per_sample * channels as usize;
        let mut acc = 0.0f64;
        let mut acc_n = 0usize;
        for c in 0..channels as usize {
            let p = base + c * bytes_per_sample;
            let v = match (format, bits) {
                (1, 8) => (bytes[p] as f32 - 128.0) / 128.0,
                (1, 16) => i16::from_le_bytes([bytes[p], bytes[p + 1]]) as f32 / 32768.0,
                (1, 24) => {
                    let raw = (bytes[p] as i32) | ((bytes[p + 1] as i32) << 8) | ((bytes[p + 2] as i32) << 16);
                    // 24 位有符号(符号扩展)
                    let signed = if raw & 0x800000 != 0 { raw | !0xFFFFFF } else { raw };
                    signed as f32 / 8388608.0
                }
                (1, 32) => i32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]) as f32 / 2147483648.0,
                (3, 32) => f32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]),
                _ => return Err(format!("不支持的位深/格式: {}bit fmt={}", bits, format)),
            };
            acc += v as f64;
            acc_n += 1;
        }
        mono.push((acc / acc_n as f64) as f32);
    }
    if mono.is_empty() { return Err("WAV 中没有音频数据".into()); }
    Ok(WavData {
        duration_sec: frames as f32 / sample_rate as f32,
        mono, sample_rate, channels, bits,
    })
}

/// WAV → 自定义波形锚点:提取稳定单周期,重采样到 n 点,去 DC + 归一化 [-1,1]
/// 输出 [(x, y), ...] x ∈ [0,1] 等分
pub fn wav_to_anchors(mono: &[f32], sr: u32, n: usize) -> Vec<Vec<f32>> {
    let n = n.clamp(8, 512);
    let downsample = |src: &[f32]| -> Vec<f32> {
        let len = src.len().max(2);
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let pos = i as f32 / (n - 1) as f32 * (len - 1) as f32;
            let i0 = pos as usize;
            let i1 = (i0 + 1).min(len - 1);
            let f = pos - i0 as f32;
            out.push(src[i0] * (1.0 - f) + src[i1] * f);
        }
        out
    };
    // 跳过开头 10%(避开瞬态),至少留 50ms
    let skip = (mono.len() / 10).min(mono.len().saturating_sub(sr as usize / 20));
    let seg = &mono[skip..];
    if seg.len() < sr as usize / 50 {
        return normalize_anchors(downsample(mono), n);
    }
    // 自相关周期估计(30Hz-2kHz);选显著峰值的**最小**周期(基频优先,避免倍频:正弦 4 倍周期处相关同样≈1)
    let min_p = (sr as usize / 2000).max(8);
    let max_p = (sr as usize / 30).min(seg.len() / 2);
    if max_p <= min_p {
        return normalize_anchors(downsample(seg), n);
    }
    let mut best_c = -1.0f32;
    for p in min_p..=max_p {
        let lim = (seg.len() - p).min(sr as usize);
        if lim == 0 { continue; }
        let mut c = 0.0f32;
        for i in 0..lim { c += seg[i] * seg[i + p]; }
        c /= lim as f32;
        if c > best_c { best_c = c; }
    }
    // 正向扫描:第一个达到峰值 95% 的周期(最短显著周期 = 基频)
    let mut best_p = min_p;
    for p in min_p..=max_p {
        let lim = (seg.len() - p).min(sr as usize);
        if lim == 0 { continue; }
        let mut c = 0.0f32;
        for i in 0..lim { c += seg[i] * seg[i + p]; }
        c /= lim as f32;
        if c >= best_c * 0.95 { best_p = p; break; }
    }
    // 从升沿过零开始取 2 个周期;终点对齐到最近的升沿过零(整数周期,首尾闭合,波形无跳变)
    let mut z = 0usize;
    for i in 1..seg.len() {
        if seg[i - 1] < 0.0 && seg[i] >= 0.0 { z = i; break; }
    }
    let target = z + best_p * 2;
    let mut end = target.min(seg.len());
    if end > z + 2 {
        let lo = target.saturating_sub(best_p / 4);
        let hi = (target + best_p / 4).min(seg.len().saturating_sub(1));
        let mut best_d = usize::MAX;
        for i in lo..hi {
            if seg[i - 1] < 0.0 && seg[i] >= 0.0 {
                let d = i.abs_diff(target);
                if d < best_d { best_d = d; end = i; }
            }
        }
        return normalize_anchors(downsample(&seg[z..end]), n);
    }
    normalize_anchors(downsample(seg), n)
}

fn normalize_anchors(mut pts: Vec<f32>, n: usize) -> Vec<Vec<f32>> {
    let dc = pts.iter().sum::<f32>() / pts.len().max(1) as f32;
    for v in pts.iter_mut() { *v -= dc; }
    let peak = pts.iter().fold(0.0f32, |a, v| a.max(v.abs())).max(1e-6);
    pts.iter().enumerate()
        .map(|(i, v)| vec![i as f32 / (n - 1) as f32, (v / peak).clamp(-1.0, 1.0)])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth(freq: f32, sr: u32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        (0..n).map(|i| ((i as f32 / sr as f32) * freq * 2.0 * std::f32::consts::PI).sin()).collect()
    }

    #[test]
    fn wav_to_anchors_sine_cycle() {
        // 440Hz 正弦,0.2s → 88 个周期;提取 1 周期应接近正弦且幅度归一 [-1,1]
        let sr = 44100u32;
        let mono = synth(440.0, sr, 0.2);
        let a = wav_to_anchors(&mono, sr, 64);
        assert_eq!(a.len(), 64);
        // 首尾接近 0(整周期)
        assert!(a[0][1].abs() < 0.15, "起点应近零, got {}", a[0][1]);
        assert!(a[63][1].abs() < 0.2, "终点应近零, got {}", a[63][1]);
        // 峰值约 ±1(归一化)
        let peak: f32 = a.iter().map(|p| p[1].abs()).fold(0.0, f32::max);
        assert!((peak - 1.0).abs() < 0.05, "峰值应≈1, got {peak}");
        // x 严格递增 0..1
        assert_eq!(a[0][0], 0.0);
        assert!((a[63][0] - 1.0).abs() < 1e-4);
        // 形状为正弦(中间区域应有正→负过零;64 点采样可能恰好跳过零点,用符号变化检测)
        let mid_pts: Vec<f32> = a.iter().filter(|p| p[0] > 0.4 && p[0] < 0.6).map(|p| p[1]).collect();
        let has_cross = mid_pts.windows(2).any(|w| w[0] * w[1] <= 0.0);
        assert!(has_cross, "中间应过零, got {mid_pts:?}");
        // 提取应恰为 ~2 个周期(基频优先,防倍频):440Hz@44.1k → 周期≈100 样本 → 提取≈200 样本
        // 通过过零次数验证:2 个完整正弦周期 = 4 次符号变化(0 值样本不重复计数)
        let mut zc = 0usize;
        for i in 0..a.len() - 1 {
            let (p, q) = (a[i][1], a[i + 1][1]);
            if (p < 0.0 && q >= 0.0) || (p > 0.0 && q <= 0.0) { zc += 1; }
        }
        assert!((3..=6).contains(&zc), "应≈4 次过零(2 周期), got {zc}");
    }

    #[test]
    fn wav_to_anchors_noise_still_normalized() {
        // 噪声(无稳定周期)→ 降级为整段下采样,仍归一化
        let sr = 44100u32;
        let mut mono: Vec<f32> = (0..sr as usize).map(|i| ((i * 7919) % 1000) as f32 / 500.0 - 1.0).collect();
        let a = wav_to_anchors(&mono, sr, 32);
        assert_eq!(a.len(), 32);
        let peak: f32 = a.iter().map(|p| p[1].abs()).fold(0.0, f32::max);
        assert!((peak - 1.0).abs() < 0.05);
    }

    fn make_pcm16_wav(samples: &[i16], sr: u32, channels: u16) -> Vec<u8> {
        let data_len = samples.len() * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());   // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * channels as u32 * 2).to_le_bytes());
        b.extend_from_slice(&(channels * 2).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data_len as u32).to_le_bytes());
        for s in samples { b.extend_from_slice(&s.to_le_bytes()); }
        b
    }

    #[test]
    fn parses_pcm16_mono() {
        let sr = 44100u32;
        let mut samples = Vec::new();
        for i in 0..4410 {
            let v = ((i as f32 / sr as f32 * 440.0 * 2.0 * std::f32::consts::PI).sin() * 0.5 * 32767.0) as i16;
            samples.push(v);
        }
        let bytes = make_pcm16_wav(&samples, sr, 1);
        let w = parse_wav(&bytes).expect("parse ok");
        assert_eq!(w.sample_rate, sr);
        assert_eq!(w.channels, 1);
        assert_eq!(w.mono.len(), 4410);
        assert!((w.duration_sec - 0.1).abs() < 1e-3);
        let peak = w.mono.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.02, "amplitude preserved, peak={peak}");
    }

    #[test]
    fn stereo_averages_to_mono() {
        // 左 0.4 右 0.6 → 单声道逐样本 = 0.5 × 信号
        let mut samples = Vec::new();
        for i in 0..200 {
            let v = (i as f32 / 200.0 * std::f32::consts::TAU * 4.0).sin();
            samples.push((0.4 * 32767.0 * v) as i16);
            samples.push((0.6 * 32767.0 * v) as i16);
        }
        let bytes = make_pcm16_wav(&samples, 44100, 2);
        let w = parse_wav(&bytes).expect("parse ok");
        assert_eq!(w.channels, 2);
        assert_eq!(w.mono.len(), 200);
        for i in 0..200 {
            let want = 0.5 * (i as f32 / 200.0 * std::f32::consts::TAU * 4.0).sin();
            assert!((w.mono[i] - want).abs() < 1e-3, "sample {i}: got {} want {want}", w.mono[i]);
        }
    }

    #[test]
    fn rejects_non_wav() {
        assert!(parse_wav(b"NOTWAVE....................").is_err());
    }

    #[test]
    fn full_pipeline_wav_to_plspmid() {
        // 端到端:真实 PCM16 WAV 字节 → parse_wav → transcribe(扒谱)→ match_tone(音色)
        // → encode_from_json(.plspmid 编码)→ decode(验证音色+音符+力度完整)
        let sr = 44100u32;
        let n = sr as usize;
        let mut samples: Vec<i16> = vec![0; n];
        // C4(60) 0-0.4s,随后 E4(64) 0.5-0.9s(与旋律测试同构)
        for (midi, t0) in [(60u8, 0.0f32), (64, 0.5)] {
            let f = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
            let start = (t0 * sr as f32) as usize;
            let dur = (0.4 * sr as f32) as usize;
            for i in start..(start + dur).min(n) {
                let t = (i - start) as f32 / sr as f32;
                let env = if t < 0.005 { t / 0.005 } else { (-(t - 0.005) / 0.5).exp() };
                samples[i] += ((std::f32::consts::TAU * f * t).sin() * 0.4 * env * 32767.0) as i16;
            }
        }
        let wav_bytes = make_pcm16_wav(&samples, sr, 1);
        let w = parse_wav(&wav_bytes).expect("wav parse");
        assert_eq!(w.mono.len(), n);

        // 扒谱
        let r = crate::audio::analyze::transcribe(&w.mono, w.sample_rate);
        assert!(r.notes.iter().any(|x| x.midi == 60), "C4 detected");
        assert!(r.notes.iter().any(|x| x.midi == 64), "E4 detected");
        assert!(r.bpm > 0.0, "bpm estimated");

        // 音色匹配(按轨,与 analyze_wav 命令一致)
        use std::collections::BTreeMap;
        let mut by_track: BTreeMap<u8, Vec<crate::audio::analyze::DetectedNote>> = BTreeMap::new();
        for x in &r.notes { by_track.entry(x.track).or_default().push(x.clone()); }
        let notes_json = serde_json::to_string(&r.notes.iter().map(|x| serde_json::json!({
            "t": x.t, "dur": x.dur, "midi": x.midi, "vel": x.vel, "track": x.track,
        })).collect::<Vec<_>>()).unwrap();
        let tones_json = serde_json::to_string(&by_track.iter().map(|(&track, ns)| {
            let tm = crate::audio::tone_match::match_tone(ns);
            serde_json::json!({ "track": track, "waveType": tm.wave_type, "params": tm.params })
        }).collect::<Vec<_>>()).unwrap();

        // 编码 .plspmid → 解码验证
        let plsp_bytes = crate::audio::plspmid::encode_from_json(&notes_json, &tones_json, r.bpm.max(60.0), 4).expect("encode");
        let d = crate::audio::plspmid::decode(&plsp_bytes).expect("decode");
        assert_eq!(d.notes.len(), r.notes.len(), "all notes preserved");
        assert!(d.notes.iter().any(|x| x.midi == 64), "E4 in plspmid");
        assert!(d.notes.iter().all(|x| x.vel > 0), "velocities non-zero (no truncation bug)");
        assert!(d.notes.iter().all(|x| x.track < 32), "track within 32");
        assert!(!d.tones.is_empty(), "tones embedded");
        // 每轨音色都有 wave_type
        assert!(d.tones.iter().all(|t| !t.wave_type.is_empty()));
        // tick 递增(时间顺序保留)
        let mut prev = 0u32;
        for x in d.notes.iter() {
            assert!(x.tick >= prev, "notes sorted by time");
            prev = x.tick;
        }
    }
}
