// 波形数学:内置波形/合成器预设波形的逐点采样 + 波表构建(纯计算)
// 与 TS src/core/wave.ts 的 wtSlotFnAt / presetWaveAt / builtinWaveAt 逻辑 1:1 对齐
pub const WAVE_LEN: usize = 2048;         // 波表周期采样数
pub const MAX_HARMONICS: usize = 32;

// 钢琴泛音表 [泛音序数, 相对幅度, 衰减时间 s]
pub const PIANO_HARMONICS: [(f32, f32, f32); 8] = [
    (1.0, 1.0, 3.2), (2.0, 0.75, 2.1), (3.0, 0.55, 1.4), (4.0, 0.4, 1.0),
    (5.0, 0.28, 0.75), (6.0, 0.19, 0.55), (7.0, 0.12, 0.42), (8.0, 0.08, 0.32),
];
pub const INHARMONICITY: f32 = 0.00035;

// 竖琴/古筝泛音表
pub fn pluck_harmonics(guzheng: bool) -> &'static [(f32, f32)] {
    if guzheng {
        &[(1.0, 1.0), (2.0, 0.55), (3.0, 0.35), (4.0, 0.18), (5.0, 0.1), (6.0, 0.06)]
    } else {
        &[(1.0, 1.0), (2.0, 0.7), (3.0, 0.5), (4.0, 0.38), (5.0, 0.28),
          (6.0, 0.2), (7.0, 0.13), (8.0, 0.09), (9.0, 0.06), (10.0, 0.04)]
    }
}

// DX7 FM 波形(波表槽位/预览用静态快照;发声走逐样本 FM)
pub fn dx7_fm_wave(p: f32) -> f32 {
    0.6 * (2.0 * std::f32::consts::PI * p + 3.0 * (2.0 * std::f32::consts::PI * p).sin()).sin()
        + 0.4 * (2.0 * std::f32::consts::PI * p + 2.0 * (4.0 * std::f32::consts::PI * p).sin()).sin()
}

// 合成器预设波形快照(与 TS presetWaveAt 对齐)
pub fn preset_wave_at(t: &str, p: f32) -> f32 {
    let pi2 = 2.0 * std::f32::consts::PI;
    match t {
        "dx7" => dx7_fm_wave(p),
        "drip" => {
            let k = 4.0 + (1.0 - 4.0) * p.powf(0.6);
            (pi2 * k * p * 2.0).sin()
        }
        "acc" | "clar" => if p < 0.5 { 1.0 } else { -1.0 },
        "harp" | "guzheng" => {
            let mut v = 0.0;
            for (n, amp) in pluck_harmonics(t == "guzheng") {
                v += amp * (pi2 * n * (1.0 + INHARMONICITY * n * n) * p).sin();
            }
            (v / 3.2).clamp(-1.0, 1.0)
        }
        "piano" => {
            let mut v = 0.0;
            for (n, amp, _) in PIANO_HARMONICS {
                v += amp * (pi2 * n * (1.0 + INHARMONICITY * n * n) * p).sin();
            }
            (v / 3.2).clamp(-1.0, 1.0)
        }
        // moog 等:基础振荡器波形
        "moog" | "saw" => 2.0 * p - 1.0,
        "square" => if p < 0.5 { 1.0 } else { -1.0 },
        "triangle" => if p < 0.5 { 4.0 * p - 1.0 } else { 3.0 - 4.0 * p },
        "sine" => (pi2 * p).sin(),
        _ => 0.0,
    }
}

// 内置波形逐点采样(发声 wavetable 用)
pub fn builtin_wave_at(t: &str, p: f32) -> f32 {
    match t {
        "sine" => (2.0 * std::f32::consts::PI * p).sin(),
        "square" => if p < 0.5 { 1.0 } else { -1.0 },
        "saw" => 2.0 * p - 1.0,
        "triangle" => if p < 0.5 { 4.0 * p - 1.0 } else { 3.0 - 4.0 * p },
        _ => preset_wave_at(t, p),
    }
}

// 波表槽位波形(与 TS wtSlotFnAt 一致:内置 4 波形 + 合成器预设)
pub fn wt_slot_at(slot: &str, p: f32) -> f32 {
    match slot {
        "sine" => (2.0 * std::f32::consts::PI * p).sin(),
        "triangle" => if p < 0.5 { 4.0 * p - 1.0 } else { 3.0 - 4.0 * p },
        "square" => if p < 0.5 { 1.0 } else { -1.0 },
        "saw" => 2.0 * p - 1.0,
        _ => preset_wave_at(slot, p),   // dx7/harp/guzheng/piano/drip/acc/clar
    }
}

/// 构建波表(2048 点):内置波形按谐波截断求和(与 TS buildWave 谐波路径一致),
/// 合成器预设直接逐点采样(TS 的 DFT 路径等价于直接采样——PeriodicWave 重建无损失)
pub fn build_wavetable(kind: &str, harmonics: usize) -> Vec<f32> {
    let n = harmonics.clamp(1, MAX_HARMONICS);
    let pi2 = 2.0 * std::f32::consts::PI;
    let mut table = Vec::with_capacity(WAVE_LEN);
    match kind {
        "sine" => {
            for i in 0..WAVE_LEN {
                table.push((pi2 * i as f32 / WAVE_LEN as f32).sin());
            }
        }
        "grain" => {
            // 粒子纹理:64 个随机短脉冲叠加(确定性 LCG),静态近似粒子云
            // (真正的粒子合成是动态粒子流渲染;槽位/表机制用静态纹理近似)
            let mut st = 0x9E3779B9u32;
            let mut rnd = move || {
                st = st.wrapping_mul(1664525).wrapping_add(1013904223);
                (st >> 8) as f32 / 16777216.0
            };
            let mut pulses = Vec::with_capacity(64);
            for _ in 0..64 {
                let ph = rnd();
                let w = 0.008 + rnd() * 0.04;
                let amp = 0.25 + rnd() * 0.75;
                pulses.push((ph, w, amp));
            }
            for i in 0..WAVE_LEN {
                let p = i as f32 / WAVE_LEN as f32;
                let mut v = 0.0;
                for &(ph, w, amp) in &pulses {
                    let d = (p - ph).rem_euclid(1.0);
                    if d < w {
                        v += amp * (d / w * pi2 * 0.5).sin();   // 短脉冲窗
                    }
                }
                table.push(v * 0.5);
            }
        }
        "square" | "saw" | "triangle" => {
            for i in 0..WAVE_LEN {
                let p = i as f32 / WAVE_LEN as f32;
                let mut v = 0.0;
                for k in 1..=n {
                    let kf = k as f32;
                    let amp = match kind {
                        "square" => if k % 2 == 1 { 1.0 / kf } else { 0.0 },
                        "saw" => 1.0 / kf,
                        _ => if k % 2 == 1 { (if k % 4 == 1 { 1.0 } else { -1.0 }) / (kf * kf) } else { 0.0 },
                    };
                    v += amp * (pi2 * kf * p).sin();
                }
                table.push(v);
            }
        }
        _ => {
            // 合成器预设/自定义:逐点采样
            for i in 0..WAVE_LEN {
                table.push(preset_wave_at(kind, i as f32 / WAVE_LEN as f32));
            }
        }
    }
    table
}

// 锚点线性插值(自定义波形)
pub fn interp_anchors(anchors: &[(f32, f32)], px: f32) -> f32 {
    if anchors.is_empty() { return 0.0; }
    if anchors.len() == 1 { return anchors[0].1; }
    let mut lo = anchors[0];
    let mut hi = anchors[anchors.len() - 1];
    for i in 0..anchors.len() - 1 {
        if px >= anchors[i].0 && px <= anchors[i + 1].0 { lo = anchors[i]; hi = anchors[i + 1]; break; }
    }
    let span = (hi.0 - lo.0).abs().max(1e-6);
    let k = ((px - lo.0) / span).clamp(0.0, 1.0);
    lo.1 + (hi.1 - lo.1) * k
}

/// 平滑锚点插值(Catmull-Rom,粒子源波形用:消除折线感,曲线圆滑)
/// 与前端 smoothInterp 逻辑一致;边界用最近点
pub fn smooth_interp_anchors(anchors: &[(f32, f32)], px: f32) -> f32 {
    if anchors.is_empty() { return 0.0; }
    if anchors.len() == 1 { return anchors[0].1; }
    let a = anchors;
    if px <= a[0].0 { return a[0].1; }
    if px >= a[a.len() - 1].0 { return a[a.len() - 1].1; }
    let mut i = 0usize;
    while i + 2 < a.len() && px > a[i + 1].0 { i += 1; }
    let p0 = a[i.saturating_sub(1)];
    let p1 = a[i];
    let p2 = a[i + 1];
    let p3 = a[(i + 2).min(a.len() - 1)];
    let t = (px - p1.0) / (p2.0 - p1.0).max(1e-6);
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    let m1 = (p2.1 - p0.1) * 0.5;
    let m2 = (p3.1 - p1.1) * 0.5;
    h00 * p1.1 + h10 * m1 + h01 * p2.1 + h11 * m2
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wavetable_shapes() {
        let sin = build_wavetable("sine", 8);
        let sq = build_wavetable("square", 32);
        let saw = build_wavetable("saw", 32);
        let tri = build_wavetable("triangle", 32);
        assert_eq!(sin.len(), WAVE_LEN);
        // 谐波截断值(与 TS PeriodicWave 一致,非理想波形):32 谐波
        let rms = |t: &[f32]| (t.iter().map(|x| x * x).sum::<f32>() / t.len() as f32).sqrt();
        assert!((rms(&sq) - 0.785).abs() < 0.02, "square rms ~0.785, got {}", rms(&sq));
        assert!((rms(&saw) - 0.898).abs() < 0.02, "saw rms ~0.898, got {}", rms(&saw));
        assert!((rms(&tri) - 0.713).abs() < 0.02, "tri rms ~0.713, got {}", rms(&tri));
    }
    #[test]
    fn preset_waves_finite() {
        for t in ["dx7", "drip", "acc", "clar", "harp", "guzheng", "piano"] {
            for i in 0..64 {
                let v = preset_wave_at(t, i as f32 / 64.0);
                assert!(v.is_finite() && v >= -1.5 && v <= 1.5, "{t} out of range: {v}");
            }
        }
    }
    #[test]
    fn interp_linear() {
        let a = vec![(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)];
        assert!((interp_anchors(&a, 0.25) - 0.5).abs() < 1e-4);
        assert!((interp_anchors(&a, 0.75) - 0.5).abs() < 1e-4);
        assert!((interp_anchors(&a, 0.0)).abs() < 1e-4);
    }
}

#[cfg(test)]
mod grain_table_tests {
    use super::*;
    #[test]
    fn grain_texture_nonzero() {
        let t = build_wavetable("grain", 32);
        let peak = t.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.1, "粒子纹理表应非零,峰值 {peak}");
        assert_eq!(t.len(), WAVE_LEN);
    }
}
