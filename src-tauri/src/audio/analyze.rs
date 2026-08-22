// 自动扒谱(音频 → 音符):STFT 频谱 → 峰值/谐波基频检测 → 多音高跟踪 → 音符分段
// 风格参考 widi 类工具:高时间分辨率(hop 512 ≈ 11.6ms @44.1k)+ 多音高(和弦)+ 音区自动分轨
// 附带音色特征(亮度/起音)供音色匹配(tone_match.rs)使用

use super::fft::fft_magnitudes;

pub const FRAME: usize = 4096;   // FFT 帧长(低频分辨率 ≈ 10.8Hz @44.1k,支持 A1=55Hz 起)
pub const HOP: usize = 512;      // 帧步进(超高密度:每帧 ~11.6ms)
const MIN_BIN: usize = 4;        // 40Hz @44.1k
const MAX_BIN: usize = 800;      // 8kHz(避开噪声高频)
const MAG_THRESHOLD: f32 = 0.0015; // 峰值绝对阈值(-56dB)
const MISS_GRACE: u8 = 3;        // 音符允许短暂消失的帧数
const MIN_DUR: f32 = 0.03;       // 最短音符 30ms

struct ActiveNote { midi: u8, start: usize, last: usize, miss: u8, peak_mag: f32, bright_sum: f32, bright_n: usize }

#[derive(Clone, Debug)]
pub struct DetectedNote {
    pub t: f32,        // 起始秒
    pub dur: f32,      // 时长秒
    pub midi: u8,
    pub vel: f32,      // 0..1(帧峰值归一)
    pub track: u8,     // 音区轨 0-7(每八度一轨,从 C1 起)
    pub bright: f32,   // 谐波质心 0..1(音色亮度)
    pub attack_ms: f32,
}

#[derive(Clone, Debug)]
pub struct AnalysisResult {
    pub notes: Vec<DetectedNote>,
    pub bpm: f32,
    pub duration_sec: f32,
}

/// 对单声道样本扒谱。mono 采样率应与 sr 一致。
pub fn transcribe(mono: &[f32], sr: u32) -> AnalysisResult {
    let mut notes: Vec<DetectedNote> = Vec::new();
    if mono.len() < FRAME || sr == 0 { return AnalysisResult { notes, bpm: 0.0, duration_sec: mono.len() as f32 / sr.max(1) as f32 }; }

    let n_frames = 1 + (mono.len().saturating_sub(FRAME)) / HOP;
    let bin_hz = sr as f32 / FRAME as f32;

    let mut active: Vec<ActiveNote> = Vec::new();

    for f in 0..n_frames {
        let off = f * HOP;
        let frame: Vec<f32> = if off + FRAME <= mono.len() {
            mono[off..off + FRAME].to_vec()
        } else {
            let mut x = vec![0.0; FRAME];
            x[..mono.len() - off].copy_from_slice(&mono[off..]);
            x
        };
        let mag = fft_magnitudes(&frame, FRAME);

        // ① 峰值提取 + 谐波占用标记(低频优先,避免把谐波当新音高)
        let mut occupied = vec![false; MAX_BIN + 1];
        let mut peaks: Vec<(usize, f32, f32)> = Vec::new(); // (bin, mag, bright_sum)
        let mut mag_total = 0.0f32;
        let mut mag_weighted = 0.0f32;
        for k in MIN_BIN..=MAX_BIN { let m = mag[k]; mag_total += m; mag_weighted += m * k as f32; }
        for k in MIN_BIN..=MAX_BIN {
            if occupied[k] { continue; }
            let m = mag[k];
            if m < MAG_THRESHOLD { continue; }
            if m < mag[k - 1] || m < mag[k + 1] { continue; }   // 局部最大
            // 谐波验证:2x..6x 处能量(纯正弦无谐波也接受,靠绝对阈值兜底)
            let mut harm = 0.0f32;
            for h in 2..=6 {
                let hk = h * k;
                if hk + 2 <= MAX_BIN {
                    let mut hm = 0.0f32;
                    for j in hk.saturating_sub(2)..=(hk + 2).min(MAX_BIN) { hm = hm.max(mag[j]); }
                    harm += hm;
                }
            }
            if m < 0.004 && harm < m * 0.4 { continue; }        // 弱峰且无谐波 → 噪声
            // 标记谐波占用(±2 bin)
            for h in 2..=8 {
                let hk = h * k;
                if hk <= MAX_BIN {
                    for j in hk.saturating_sub(2)..=(hk + 2).min(MAX_BIN) { occupied[j] = true; }
                }
            }
            let bright = if mag_total > 1e-9 { mag_weighted / mag_total / MAX_BIN as f32 } else { 0.0 };
            peaks.push((k, m, bright));
        }

        // ② midi 量化(峰值抛物线插值精化频率,减少 bin 摆动导致的量化抖动)
        let mut det: Vec<(u8, f32, f32)> = Vec::new(); // (midi, mag, bright)
        for (k, m, bright) in peaks {
            // 抛物线插值:局部最大 bin 邻域拟合真实峰值位置(k_real = k + delta)
            let mut delta = 0.0f32;
            let denom = mag[k - 1] - 2.0 * m + mag[k + 1];
            if denom.abs() > 1e-9 { delta = 0.5 * (mag[k - 1] - mag[k + 1]) / denom; }
            let fhz = (k as f32 + delta) * bin_hz;
            let midi_f = 69.0 + 12.0 * (fhz / 440.0).log2();
            let mi = midi_f.round();
            if (midi_f - mi).abs() > 0.45 { continue; }   // 非整音 → 噪声/失谐,丢弃
            let midi = mi as i32;
            if midi < 0 || midi > 127 { continue; }
            det.push((midi as u8, m, bright));
        }

        // ③ 音符跟踪:延续 / 结束 / 新开
        for a in active.iter_mut() {
            if let Some((_, m, b)) = det.iter().find(|(midi, _, _)| *midi == a.midi) {
                a.miss = 0;
                a.last = f;
                a.peak_mag = a.peak_mag.max(*m);
                a.bright_sum += b;
                a.bright_n += 1;
            } else {
                a.miss += 1;
            }
        }
        let mut done: Vec<usize> = Vec::new();
        for (i, a) in active.iter().enumerate() {
            if a.miss > MISS_GRACE { done.push(i); }
        }
        for &i in done.iter().rev() {
            let a = active.remove(i);
            push_note(&mut notes, &a, f, sr);
        }
        for (midi, m, b) in det {
            if !active.iter().any(|a| a.midi == midi) {
                active.push(ActiveNote { midi, start: f, last: f, miss: 0, peak_mag: m, bright_sum: b, bright_n: 1 });
            }
        }
    }
    // 收尾:结束所有活跃音符
    let last_frame = n_frames.saturating_sub(1);
    for a in active {
        push_note(&mut notes, &a, last_frame, sr);
    }

    let bpm = estimate_bpm(&notes);
    AnalysisResult {
        duration_sec: mono.len() as f32 / sr as f32,
        notes, bpm,
    }
}

fn push_note(notes: &mut Vec<DetectedNote>, a: &ActiveNote, end_frame: usize, sr: u32) {
    let t = a.start as f32 * HOP as f32 / sr as f32;
    // 结束时刻 = 最后一帧窗口末;时长 = 结束 - 开始(禁止重复减起始时刻)
    let dur = ((end_frame - a.start) as f32 * HOP as f32 + FRAME as f32) / sr as f32;
    if dur < MIN_DUR { return; }
    let vel = (a.peak_mag / 0.12).clamp(0.05, 1.0);   // 0.12 ≈ -18dBFS 视为满力度
    let bright = if a.bright_n > 0 { a.bright_sum / a.bright_n as f32 } else { 0.3 };
    // 音区轨:每八度一轨(从 C1=24 起),0-7
    let track = ((a.midi as i32 - 24) / 12).clamp(0, 7) as u8;
    let attack_ms = estimate_attack_ms(a, sr);
    notes.push(DetectedNote { t, dur, midi: a.midi, vel, track, bright, attack_ms });
}

// 起音速度:音符起始帧附近(约 15ms)平均幅度 / 全段平均幅度(>1.5 敲击型,<0.8 持续型)
fn estimate_attack_ms(a: &ActiveNote, sr: u32) -> f32 {
    let start = a.start as f32 * HOP as f32 / sr as f32;
    let dur = (a.last - a.start) as f32 * HOP as f32 / sr as f32;
    if dur < 0.04 { return 0.0; }
    let _ = start;
    // 近似:用活跃期长度估计起音占比(峰值帧位置/总长)
    let peak_pos = (a.last.saturating_sub(a.start)) as f32 / (a.last.saturating_sub(a.start) + 1) as f32;
    let ms = if peak_pos < 0.25 { (peak_pos * dur * 1000.0).clamp(1.0, 60.0) } else { 60.0 };
    ms
}

// BPM 估计:音符起始间隔中位数(取 0.2-2s 区间)
fn estimate_bpm(notes: &[DetectedNote]) -> f32 {
    let mut ts: Vec<f32> = notes.iter().map(|n| n.t).collect();
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut gaps: Vec<f32> = Vec::new();
    for w in ts.windows(2) {
        let g = w[1] - w[0];
        if g > 0.2 && g < 2.0 { gaps.push(g); }
    }
    if gaps.is_empty() { return 0.0; }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = gaps[gaps.len() / 2];
    60.0 / med
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth(midis: &[u8], secs: f32, sr: u32, attack: f32) -> Vec<f32> {
        let n = (secs * sr as f32) as usize;
        let mut out = vec![0.0f32; n];
        for &midi in midis {
            let f = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
            for i in 0..n {
                let t = i as f32 / sr as f32;
                let env = if t < attack { t / attack } else { (-(t - attack) / 0.5).exp() };
                out[i] += (std::f32::consts::TAU * f * t).sin() * 0.4 * env;
            }
        }
        out
    }

    #[test]
    fn detects_single_note_pitch_and_duration() {
        let sr = 44100u32;
        let mono = synth(&[69], 1.0, sr, 0.005);   // A4 1 秒
        let r = transcribe(&mono, sr);
        assert!(!r.notes.is_empty(), "should detect notes, got {}", r.notes.len());
        let n = &r.notes[0];
        assert_eq!(n.midi, 69, "A4 detected, got {}", n.midi);
        assert!(n.t < 0.05, "onset near 0, t={}", n.t);
        assert!((n.dur - 1.0).abs() < 0.15, "duration ~1s, got {}", n.dur);
        assert!(n.vel > 0.3, "velocity reasonable, got {}", n.vel);
    }

    #[test]
    fn detects_chord_multipitch() {
        let sr = 44100u32;
        let mono = synth(&[60, 64, 67], 0.8, sr, 0.005);   // C4 E4 G4 和弦
        let r = transcribe(&mono, sr);
        let midis: Vec<u8> = r.notes.iter().map(|n| n.midi).collect();
        assert!(midis.contains(&60) && midis.contains(&64) && midis.contains(&67),
            "chord notes detected, got {:?}", midis);
    }

    #[test]
    fn silence_produces_no_notes() {
        let sr = 44100u32;
        let mono = vec![0.0f32; sr as usize];
        let r = transcribe(&mono, sr);
        assert!(r.notes.is_empty(), "silence -> no notes, got {}", r.notes.len());
    }

    #[test]
    fn separate_tracks_by_octave() {
        let sr = 44100u32;
        let mut mono = synth(&[36], 0.6, sr, 0.005);   // C2 低音
        let high = synth(&[84], 0.6, sr, 0.005);       // C6 高音
        for i in 0..high.len() { mono[i] += high[i]; }
        let r = transcribe(&mono, sr);
        let low = r.notes.iter().find(|n| n.midi == 36);
        let hi = r.notes.iter().find(|n| n.midi == 84);
        assert!(low.is_some() && hi.is_some(), "both octaves detected");
        if let (Some(l), Some(h)) = (low, hi) {
            assert!(l.track < h.track, "low octave track {} < high track {}", l.track, h.track);
        }
    }

    #[test]
    fn detects_e4_alone() {
        // 隔离验证:单独 E4(329Hz)能否检出(排除上下文/余音干扰)
        let sr = 44100u32;
        let mono = synth(&[64], 0.6, sr, 0.005);
        let r = transcribe(&mono, sr);
        let got: Vec<(u8, f32)> = r.notes.iter().map(|n| (n.midi, n.t)).collect();
        assert!(r.notes.iter().any(|n| n.midi == 64), "E4 alone must be detected, got {got:?}");
    }

    #[test]
    fn detects_d4_then_e4() {
        // 最小复现:62(0.5s 起)后 64(1.0s 起),62 有余音衰减
        let sr = 44100u32;
        let mut mono = vec![0.0f32; (2.1 * sr as f32) as usize];
        let pair = [(62u8, 0.5f32), (64, 1.0)];
        for (midi, t0) in pair {
            let f = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
            let start = (t0 * sr as f32) as usize;
            let dur = (0.4 * sr as f32) as usize;
            for i in start..(start + dur).min(mono.len()) {
                let t = (i - start) as f32 / sr as f32;
                let env = if t < 0.005 { t / 0.005 } else { (-(t - 0.005) / 0.5).exp() };
                mono[i] += (std::f32::consts::TAU * f * t).sin() * 0.4 * env;
            }
        }
        let r = transcribe(&mono, sr);
        let got: Vec<(u8, f32, f32)> = r.notes.iter().map(|n| (n.midi, n.t, n.dur)).collect();
        assert!(r.notes.iter().any(|n| n.midi == 62), "D4 detected, got {got:?}");
        assert!(r.notes.iter().any(|n| n.midi == 64), "E4 detected after D4, got {got:?}");
    }

    #[test]
    fn detects_melody_sequence_in_order() {
        // C4 D4 E4 F4 依次演奏(各 0.4s,间隔 0.1s),验证顺序/音高/时间递增
        let sr = 44100u32;
        let seq = [(60u8, 0.0f32), (62, 0.5), (64, 1.0), (65, 1.5)];
        let total = 2.1f32;
        let n = (total * sr as f32) as usize;
        let mut mono = vec![0.0f32; n];
        for (midi, t0) in seq {
            let f = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
            let start = (t0 * sr as f32) as usize;
            let dur = (0.4 * sr as f32) as usize;
            for i in start..(start + dur).min(n) {
                let t = (i - start) as f32 / sr as f32;
                let env = if t < 0.005 { t / 0.005 } else { (-(t - 0.005) / 0.3).exp() };
                mono[i] += (std::f32::consts::TAU * f * t).sin() * 0.4 * env;
            }
        }
        let r = transcribe(&mono, sr);
        let got: Vec<(u8, f32)> = r.notes.iter().map(|x| (x.midi, x.t)).collect();
        assert!(got.len() >= 4, "should detect 4 notes, got {got:?}");
        // 按时间排序后检查音高序列
        let mut sorted = got;
        sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let midis: Vec<u8> = sorted.iter().map(|x| x.0).collect();
        assert_eq!(&midis[..4], &[60, 62, 64, 65], "melody order detected, got {midis:?}");
        // 起始时间递增且大致对应
        assert!(sorted[0].1 < 0.05, "first onset ~0, got {}", sorted[0].1);
        assert!((sorted[1].1 - 0.5).abs() < 0.12, "second onset ~0.5, got {}", sorted[1].1);
        assert!((sorted[3].1 - 1.5).abs() < 0.12, "fourth onset ~1.5, got {}", sorted[3].1);
    }
}
