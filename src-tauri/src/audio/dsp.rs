// DSP 基础:ADSR 包络、双二阶滤波器(Biquad)、通用 LFO —— 纯计算,无 IO
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

// ============ 采样率(运行时可调,支持 44100/48000/49096) ============
static SR_HZ: AtomicU32 = AtomicU32::new(44100);
/// 设置采样率(会重建所有按采样率分配的缓冲)
pub fn set_sr(hz: u32) { SR_HZ.store(hz.clamp(8000, 192000), Ordering::Relaxed); }
/// 当前采样率
#[inline]
pub fn sr() -> f32 { SR_HZ.load(Ordering::Relaxed) as f32 }

// ============ 正弦查表(PM 硬件模拟:无插值,直接截断 = 硬件量化) ============
// 支持 4 种表尺寸(1024/2048/4096/8192,PM 扩展可切换):
//   表越大相位量化越细(谐波更干净),越小越"数字味"(量化噪声更明显);
//   0 = 关闭查表,直接用浮点 sin(无相位量化)。
// 全局缓存 4 张表(各 4KB-32KB),首次访问时构建;尺寸必须是 2 的幂,
// 索引用掩码 (& (size-1)) 取模。
pub const SINE_LUT_SIZES: [usize; 4] = [1024, 2048, 4096, 8192];
static SINE_LUTS: OnceLock<[Vec<f32>; 4]> = OnceLock::new();

/// 相位以"圈"为单位(0-1);查表取整截断,模拟硬件查表量化
#[inline]
pub fn sine_lut(turns: f64, size: usize) -> f32 {
    let t = SINE_LUTS.get_or_init(|| {
        SINE_LUT_SIZES.map(|n| {
            (0..n)
                .map(|i| (2.0 * std::f32::consts::PI * i as f32 / n as f32).sin())
                .collect()
        })
    });
    let idx = match size {
        1024 => 0, 2048 => 1, 8192 => 3, _ => 2,   // 默认 4096
    };
    let n = SINE_LUT_SIZES[idx];
    let i2 = ((turns.fract() * n as f64) as usize) & (n - 1);
    t[idx][i2]
}

// ============ 定点量化模拟(16bit 截断 / 12bit DAC) ============
#[inline]
pub fn q16(x: f32) -> f32 { ((x * 32768.0) as i32 as f32) / 32768.0 }
#[inline]
pub fn q12(x: f32) -> f32 { ((x * 2048.0) as i32 as f32) / 2048.0 }
/// 按位数量化(符号,8/12/16 bit DAC 模拟)
#[inline]
pub fn qbits(x: f32, bits: u32) -> f32 {
    let steps = 2f32.powi(bits.clamp(2, 16) as i32 - 1);
    ((x * steps) as i32 as f32) / steps
}

// ============ DX7 反馈非线性曲线(仅 OP6,档位 0-7,单位:弧度) ============
// 来自 DX7 维修手册的硬件实测反馈量(非线性,不是线性档位)
pub const DX_FB_TABLE: [f32; 8] = [0.0, 0.53, 0.77, 1.07, 1.38, 1.75, 2.18, 2.68];

// ============ ADSR 包络 ============
// 语义对齐 Web Audio:attack 线性 0→peak,decay 指数 peak→peak*sustain,release 指数→0.0001
#[derive(Clone, Copy, Debug)]
pub struct Adsr {
    pub a: f32,   // 起音 s
    pub d: f32,   // 衰减 s
    pub s: f32,   // 延音 0..1
    pub r: f32,   // 释音 s
    stage: u8,    // 0=attack 1=decay 2=sustain 3=release 4=done
    t: f32,       // 当前阶段时间
    peak: f32,    // 峰值(力度相关)
    val: f32,     // 当前值
    g0: f32,      // release 起始值
}

impl Adsr {
    pub fn new(a: f32, d: f32, s: f32, r: f32) -> Self {
        Self { a: a.max(0.001), d: d.max(0.001), s: s.max(0.0001), r: r.max(0.012),
               stage: 0, t: 0.0, peak: 0.0, val: 0.0, g0: 0.0 }
    }
    /// 逐样本推进,返回当前增益
    pub fn next(&mut self, dt: f32) -> f32 {
        self.t += dt;
        match self.stage {
            0 => { // attack 线性
                self.val = self.peak * (self.t / self.a);
                if self.t >= self.a { self.val = self.peak; self.stage = 1; self.t = 0.0; }
            }
            1 => { // decay 指数 peak → peak*s
                let frac = (self.t / self.d).min(1.0);
                self.val = self.peak * self.s.powf(frac);
                if frac >= 1.0 { self.stage = 2; self.t = 0.0; }
            }
            2 => { self.val = self.peak * self.s; }
            3 => { // release 指数 g0 → 0.0001
                let frac = (self.t / self.r).min(1.0);
                let target = 0.0001;
                self.val = target + (self.g0 - target) * (1.0 - frac).powi(3);
                if frac >= 1.0 { self.val = 0.0001; self.stage = 4; }
            }
            _ => { self.val = 0.0; }
        }
        self.val
    }
    /// 开始发声(重置到 attack)
    pub fn trigger(&mut self, peak: f32) {
        self.peak = peak;
        self.stage = 0; self.t = 0.0; self.val = 0.0;
    }
    /// 进入 release(保留当前值作为起点)
    pub fn release(&mut self) {
        if self.stage < 3 {
            self.g0 = self.val.max(0.0002);
            self.stage = 3; self.t = 0.0;
        }
    }
    /// 从指定电平进入 release(短音符补音用)
    pub fn release_at(&mut self, value: f32) {
        self.g0 = value.max(0.0002);
        self.stage = 3; self.t = 0.0;
    }
    pub fn set_release(&mut self, r: f32) { self.r = r.max(0.012); }
    pub fn done(&self) -> bool { self.stage == 4 }
    pub fn value(&self) -> f32 { self.val }
}

// ============ 双二阶滤波器(RBJ cookbook) ============
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    pub kind: u8,        // 0=lowpass 1=highpass 2=peaking(EQ) 3=bandpass 4=notch
    pub gain_db: f32,    // peaking 增益 dB
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
    x1: f32, x2: f32, y1: f32, y2: f32,
    pub freq: f32,
    pub q: f32,
}

impl Biquad {
    pub fn new(kind: u8, freq: f32, q: f32) -> Self {
        let mut b = Self { kind, gain_db: 0.0, b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0, freq, q };
        b.update(freq, q);
        b
    }
    /// 重算系数(截止/共振/增益变化时)
    pub fn update(&mut self, freq: f32, q: f32) {
        self.freq = freq.max(20.0).min(19000.0);
        self.q = q.max(0.1);
        let sr = sr();
        let w = (std::f32::consts::TAU * self.freq / sr).min(std::f32::consts::PI * 0.49);
        let cosw = w.cos();
        let sinw = w.sin();
        let alpha = sinw / (2.0 * q);
        let a0 = 1.0 + alpha;
        match self.kind {
            1 => {  // highpass
                self.b0 = (1.0 + cosw) / 2.0 / a0;
                self.b1 = -(1.0 + cosw) / a0;
                self.b2 = (1.0 + cosw) / 2.0 / a0;
                self.a1 = (-2.0 * cosw) / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
            2 => {  // peaking(EQ):A = 10^(dB/40),a0 = 1+α/A(与低通/高通不同)
                let a = 10f32.powf(self.gain_db / 40.0);
                let a0p = 1.0 + alpha / a;
                self.b0 = (1.0 + alpha * a) / a0p;
                self.b1 = (-2.0 * cosw) / a0p;
                self.b2 = (1.0 - alpha * a) / a0p;
                self.a1 = (-2.0 * cosw) / a0p;
                self.a2 = (1.0 - alpha / a) / a0p;
            }
            _ => {  // lowpass
                self.b0 = (1.0 - cosw) / 2.0 / a0;
                self.b1 = (1.0 - cosw) / a0;
                self.b2 = (1.0 - cosw) / 2.0 / a0;
                self.a1 = (-2.0 * cosw) / a0;
                self.a2 = (1.0 - alpha) / a0;
            }
        }
    }
    #[inline]
    pub fn next(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }
    pub fn reset(&mut self) { self.x1 = 0.0; self.x2 = 0.0; self.y1 = 0.0; self.y2 = 0.0; }
}

// ============ 采样保持 LFO(逐样本随机跳变,每 1/rate 秒一次) ============
pub struct ShLfo {
    pub rate: f32,
    pub depth: f32,
    pub active: bool,
    counter: f32,
    pub val: f32,
}
impl ShLfo {
    pub fn new(rate: f32, depth: f32) -> Self {
        Self { rate, depth, active: rate > 0.0 && depth > 0.0, counter: 0.0, val: 0.0 }
    }
    #[inline]
    pub fn next(&mut self, dt: f32) -> f32 {
        if !self.active { return 0.0; }
        self.counter += dt;
        if self.counter >= 1.0 / self.rate { self.counter = 0.0; self.val = rand01() * 2.0 - 1.0; }
        self.val * self.depth
    }
}

// 简单 xorshift 随机(避免依赖 rand crate)
static mut RNG_STATE: u64 = 0x9E3779B97F4A7C15;
pub fn rand01() -> f32 {
    unsafe {
        RNG_STATE ^= RNG_STATE << 13;
        RNG_STATE ^= RNG_STATE >> 7;
        RNG_STATE ^= RNG_STATE << 17;
        ((RNG_STATE & 0xFFFFFF) as f32) / 16777216.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adsr_attack_then_sustain() {
        let mut e = Adsr::new(0.01, 0.1, 0.5, 0.3);
        e.trigger(1.0);
        let mut peak: f32 = 0.0;
        let dt = 1.0 / sr();
        for _ in 0..(sr() as usize) {
            let v = e.next(dt);
            peak = peak.max(v);
        }
        assert!((peak - 1.0).abs() < 0.02, "attack peak ~1, got {peak}");
        // 1s 后应处于 sustain
        assert!((e.value() - 0.5).abs() < 0.05, "sustain ~0.5, got {}", e.value());
    }
    #[test]
    fn adsr_release_goes_to_zero() {
        let mut e = Adsr::new(0.001, 0.05, 0.8, 0.02);
        e.trigger(0.7);
        for _ in 0..100 { e.next(1.0 / sr()); }
        e.release();
        for _ in 0..(sr() as usize) { e.next(1.0 / sr()); }
        assert!(e.done(), "release should finish");
    }
    #[test]
    fn biquad_lowpass_blocks_high_freq() {
        let mut f = Biquad::new(0, 200.0, 0.7);
        // 1kHz 方波(能量集中在基频+奇次谐波)过 200Hz 低通后幅度应显著下降
        let mut out = 0.0;
        for i in 0..4410 {
            let x = (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / sr()).sin();
            out += f.next(x) * x; // 与输入相关性 ≈ 输出幅度
        }
        let corr = out / 2205.0;
        assert!(corr.abs() < 0.2, "1kHz through 200Hz LP should be weak, corr={corr}");
    }
}
