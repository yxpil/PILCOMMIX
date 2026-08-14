// 主效果链:tanh 驱动 + Schroeder 混响(4 comb + 2 allpass)+ 反馈延迟
// 混响为 TS ConvolverNode(2.2s 噪声 IR)的逐样本替代,听感同类
use super::dsp::sr;

// ============ 失真驱动(tanh 软削波,与 TS makeDriveCurve 一致) ============
pub struct Drive {
    k: f32,
    norm: f32,
}
impl Drive {
    pub fn new(drive: f32) -> Self {
        let mut d = Self { k: 1.0, norm: 1.0 };
        d.set(drive);
        d
    }
    pub fn set(&mut self, drive: f32) {
        let dv = drive.clamp(0.0, 1.0);
        self.k = 1.0 + dv * 15.0;
        self.norm = self.k.tanh().max(0.001);
    }
    #[inline]
    pub fn process(&self, x: f32) -> f32 {
        (x * self.k).tanh() / self.norm
    }
}

// ============ 一阶低通(comb damping) ============
#[derive(Clone)]
struct OnePole {
    a: f32,
    z: f32,
}
impl OnePole {
    fn new(a: f32) -> Self { Self { a, z: 0.0 } }
    #[inline]
    fn next(&mut self, x: f32) -> f32 {
        self.z = x * (1.0 - self.a) + self.z * self.a;
        self.z
    }
}

// ============ Comb 梳状滤波器(Freeverb 参数) ============
struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
    damp: OnePole,
}
impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len], idx: 0, feedback: 0.77, damp: OnePole::new(0.3) }
    }
    #[inline]
    fn next(&mut self, x: f32) -> f32 {
        let out = self.buf[self.idx];
        let filtered = self.damp.next(out);
        self.buf[self.idx] = x + filtered * self.feedback;
        self.idx += 1;
        if self.idx >= self.buf.len() { self.idx = 0; }
        out
    }
}

// ============ Allpass 全通(Freeverb 参数) ============
struct Allpass {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
}
impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len], idx: 0, feedback: 0.5 }
    }
    #[inline]
    fn next(&mut self, x: f32) -> f32 {
        let out = self.buf[self.idx] - x;
        self.buf[self.idx] = x + out * self.feedback;
        self.idx += 1;
        if self.idx >= self.buf.len() { self.idx = 0; }
        out
    }
}

// ============ Schroeder 混响(mono in, stereo out) ============
pub struct Reverb {
    comb_l: [Comb; 4],
    comb_r: [Comb; 4],
    allpass_l: [Allpass; 2],
    allpass_r: [Allpass; 2],
    wet: f32,
}
impl Reverb {
    pub fn new() -> Self {
        // Freeverb 经典长度(44.1k)
        let l1: [usize; 4] = [1116, 1188, 1277, 1356];
        let l2: [usize; 4] = [1116 + 23, 1188 + 23, 1277 + 23, 1356 + 23];
        let mk_combs = |lens: [usize; 4]| -> [Comb; 4] {
            let c = |l: usize| Comb::new(l);
            [c(lens[0]), c(lens[1]), c(lens[2]), c(lens[3])]
        };
        let a = |l: usize| Allpass::new(l);
        Self {
            comb_l: mk_combs(l1),
            comb_r: mk_combs(l2),
            allpass_l: [a(556), a(441)],
            allpass_r: [a(556 + 13), a(441 + 13)],
            wet: 0.9,
        }
    }
    #[inline]
    pub fn process(&mut self, x: f32, out_l: &mut f32, out_r: &mut f32) {
        let run = |combs: &mut [Comb; 4], allpasses: &mut [Allpass; 2]| -> f32 {
            let mut acc = 0.0;
            for c in combs.iter_mut() { acc += c.next(x); }
            acc *= 0.25;
            for a in allpasses.iter_mut() { acc = a.next(acc); }
            acc
        };
        *out_l += run(&mut self.comb_l, &mut self.allpass_l) * self.wet;
        *out_r += run(&mut self.comb_r, &mut self.allpass_r) * self.wet;
    }
}

// ============ 反馈延迟(stereo) ============
pub struct DelayLine {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    len: usize,
    idx: usize,
    pub time_s: f32,
    pub feedback: f32,
    pub mix: f32,
}
impl DelayLine {
    pub fn new() -> Self {
        let len = (2.0 * sr()) as usize;   // 2s 上限
        Self { buf_l: vec![0.0; len], buf_r: vec![0.0; len], len, idx: 0, time_s: 0.35, feedback: 0.4, mix: 0.2 }
    }
    #[inline]
    pub fn process(&mut self, xl: f32, xr: f32, out_l: &mut f32, out_r: &mut f32) {
        let delay = ((self.time_s * sr()) as usize).min(self.len - 1);
        let read = (self.idx + self.len - delay) % self.len;
        let dl = self.buf_l[read];
        let dr = self.buf_r[read];
        self.buf_l[self.idx] = xl + dl * self.feedback;
        self.buf_r[self.idx] = xr + dr * self.feedback;
        self.idx += 1;
        if self.idx >= self.len { self.idx = 0; }
        *out_l += dl * self.mix;
        *out_r += dr * self.mix;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drive_matches_tanh_curve() {
        // 与 TS makeDriveCurve 一致:y = tanh(x*k)/tanh(k),k=1+drive*15
        let d = Drive::new(0.8);
        let k: f32 = 1.0 + 0.8 * 15.0;
        let norm = k.tanh();
        for x in [-0.9f32, -0.3, 0.0, 0.01, 0.4, 1.0] {
            let expect = (x * k).tanh() / norm;
            assert!((d.process(x) - expect).abs() < 1e-4, "x={x}: {} vs {expect}", d.process(x));
        }
    }
    #[test]
    fn reverb_impulse_decays() {
        let mut r = Reverb::new();
        let mut l = 0.0f32; let mut rl = 0.0f32;
        // 冲激
        r.process(1.0, &mut l, &mut rl);
        let mut energy = 0.0f64;
        for _ in 0..(sr() as usize) {
            let before = l;
            r.process(0.0, &mut l, &mut rl);
            energy += ((l - before) as f64).powi(2);   // 零均值响应,用能量衡量
        }
        // 1s 内冲激响应有能量
        assert!(energy > 1e-3, "reverb should ring after impulse, energy={energy}");
        // 再等 3s 应衰减殆尽
        let mut l2 = 0.0f32; let mut r2 = 0.0f32;
        let mut e2 = 0.0f64;
        for _ in 0..(sr() as usize * 3) {
            let before = l2;
            r.process(0.0, &mut l2, &mut r2);
            e2 += ((l2 - before) as f64).powi(2);
        }
        assert!(e2 < energy * 0.01, "reverb tail decays, e2={e2} vs energy={energy}");
    }
    #[test]
    fn delay_echoes_after_time() {
        let mut d = DelayLine::new();
        d.time_s = 0.05;
        d.feedback = 0.0;
        d.mix = 1.0;
        let mut out = 0.0f32; let mut r = 0.0f32;
        // 打一个冲激,延时期间输出应为 0
        for _ in 0..(0.05 * sr()) as usize - 1 {
            d.process(0.0, 0.0, &mut out, &mut r);
        }
        assert!(out.abs() < 1e-6, "no echo before delay time, got {out}");
        d.process(1.0, 0.0, &mut out, &mut r);
        for _ in 0..(0.05 * sr()) as usize {
            d.process(0.0, 0.0, &mut out, &mut r);
        }
        assert!(out.abs() > 0.5, "echo arrives after delay time, got {out}");
    }
}



// ============ 三频段 EQ(200Hz / 1kHz / 5kHz,peaking,±12dB) ============
pub struct ThreeBandEq {
    pub bass_db: f32,
    pub mid_db: f32,
    pub treble_db: f32,
    f: [crate::audio::dsp::Biquad; 3],
}

impl ThreeBandEq {
    pub fn new() -> Self {
        Self {
            bass_db: 0.0, mid_db: 0.0, treble_db: 0.0,
            f: [crate::audio::dsp::Biquad::new(2, 200.0, 0.7),
                crate::audio::dsp::Biquad::new(2, 1000.0, 0.7),
                crate::audio::dsp::Biquad::new(2, 5000.0, 0.7)],
        }
    }
    pub fn set(&mut self, bass: f32, mid: f32, treble: f32) {
        self.bass_db = bass.clamp(-12.0, 12.0);
        self.mid_db = mid.clamp(-12.0, 12.0);
        self.treble_db = treble.clamp(-12.0, 12.0);
        self.f[0].gain_db = self.bass_db; self.f[0].update(200.0, 0.7);
        self.f[1].gain_db = self.mid_db; self.f[1].update(1000.0, 0.7);
        self.f[2].gain_db = self.treble_db; self.f[2].update(5000.0, 0.7);
    }
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let mut y = self.f[0].next(x);
        y = self.f[1].next(y);
        self.f[2].next(y)
    }
}

#[cfg(test)]
mod eq_tests {
    use super::*;

    #[test]
    fn eq_boosts_band_and_passes_at_zero() {
        let sr = crate::audio::dsp::sr();
        // 1kHz 正弦 0.5s
        let n = (sr * 0.5) as usize;
        let mut ph = 0.0f64;
        let dph = std::f64::consts::TAU * 1000.0 / sr as f64;
        let sig: Vec<f32> = (0..n).map(|_| { let x = (ph.sin() * 0.5) as f32; ph += dph; x }).collect();
        // 0dB 直通(稳态)
        let mut eq0 = ThreeBandEq::new();
        let out0: Vec<f32> = sig.iter().map(|&x| eq0.process(x)).collect();
        // 中频 +6dB:1kHz 处应接近 2 倍(峰值 ~1.0)
        let mut eq6 = ThreeBandEq::new();
        eq6.set(0.0, 6.0, 0.0);
        let out6: Vec<f32> = sig.iter().map(|&x| eq6.process(x)).collect();
        let tail = |v: &[f32]| -> f32 {
            let s = &v[v.len() * 3 / 4..];
            s.iter().fold(0.0f32, |a, &x| a.max(x.abs()))
        };
        let p0 = tail(&out0);
        let p6 = tail(&out6);
        assert!((p0 - 0.5).abs() < 0.05, "0dB EQ should pass ~0.5, got {p0}");
        assert!(p6 > 0.85, "+6dB @1kHz should boost to ~1.0, got {p6}");
        // 低频 -12dB:200Hz 信号应大幅衰减
        let mut ph2 = 0.0f64;
        let dph2 = std::f64::consts::TAU * 200.0 / sr as f64;
        let low: Vec<f32> = (0..n).map(|_| { let x = (ph2.sin() * 0.5) as f32; ph2 += dph2; x }).collect();
        let mut eqm12 = ThreeBandEq::new();
        eqm12.set(-12.0, 0.0, 0.0);
        let ol: Vec<f32> = low.iter().map(|&x| eqm12.process(x)).collect();
        let pl = tail(&ol);
        assert!(pl < 0.2, "-12dB @200Hz should cut, got {pl}");
    }
}

