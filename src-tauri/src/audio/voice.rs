// 单音符发声(逐样本渲染,与 TS engine.ts noteOnVoice 各分支 1:1 对齐)
use super::dsp::{sr, rand01, Adsr, Biquad, ShLfo};
use super::engine::EngineParams;
use super::waves::{build_wavetable, interp_anchors, PIANO_HARMONICS, pluck_harmonics, WAVE_LEN};

// 等功率声像
#[inline]
fn pan_gains(pan: f32) -> (f32, f32) {
    let a = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
    (a.cos(), a.sin())
}

// 键位/力度跟踪截止
pub fn cutoff_eff(p: &EngineParams, midi: u8, vel: f32) -> f32 {
    let kt = 2f32.powf(((midi as f32 - 60.0) / 12.0) * p.key_track);
    let vt = 1.0 + (vel - 0.5) * p.vel_track * 2.0;
    (p.cutoff_hz * kt * vt).clamp(30.0, 18000.0)
}

// 加法泛音
struct Partial {
    n: f32,
    amp: f32,
    decay_t: f32,   // 衰减到 0.0001 的时间
    phase: f64,
}

// drip 回声(0.22s / 0.44s 触发)
struct EchoState {
    trigger_at: f32,
    amp: f32,
    freq_start: f32,
    freq_end: f32,
    slide_t: f32,
    decay_t: f32,
    phase: f64,
    freq: f32,
    triggered: bool,
    t: f32,
}

struct DripState {
    ratio: f32,
    slide_t: f32,       // 下滑时间 s(drip_time_ms/1000)
    star_slide_t: f32,  // 星光下滑时间(slide_t/1.5)
    main_phase: f64,
    star_phase: f64,
    star_gain: f32,
    echoes: [EchoState; 2],
}

struct FmState {
    carrier_phase: f64,
    mod1_phase: f64,
    mod2_phase: f64,
    mod1_peak: f32, // 峰值调制深度 Hz
    mod1_sus: f32,
    mod2_peak: f32,
    mod2_sus: f32,
    decay_t: f32,
}

struct WtState {
    phase: f64,
    slot_gains: Vec<f32>,
    lfo_phase: f64,
    lfo_t0: f32,
}

// ============ DX7 硬件模拟:4R4L EG + 算子 ============
// 每个算子独立 4Rate+4Level 包络(DX7 原生,非 ADSR)
struct DxEg {
    r: [f32; 4],   // 速率 0-99(99=最快)
    l: [f32; 4],   // 电平 0-99(99=最大)
    stage: u8,     // 0=R1段 1=R2段 2=R3段 3=R4释放段
    val: f32,      // 当前电平 0-99
    t: f32,
    off: bool,     // 已 key_off
}
impl DxEg {
    fn new(eg: &[f32]) -> Self {
        Self {
            r: [eg[0], eg[2], eg[4], eg[6]],
            l: [eg[1], eg[3], eg[5], eg[7]],
            stage: 0, val: eg[1], t: 0.0, off: false,
        }
    }
    fn key_off(&mut self) { if !self.off { self.off = true; self.stage = 3; self.t = 0.0; } }
    // 速率 → 段时长(二次近似:rate 99→1ms,rate 0→4s)
    fn seg_time(rate: f32) -> f32 {
        let r = rate.clamp(0.0, 99.0);
        (99.0 - r) * (99.0 - r) / 9801.0 * 4.0 + 0.001
    }
    /// 逐样本推进,返回当前电平 0-99
    fn next(&mut self, dt: f32) -> f32 {
        self.t += dt;
        match self.stage {
            0 => { // L1→L2 @R1
                let t = DxEg::seg_time(self.r[0]);
                let frac = (self.t / t).min(1.0);
                self.val = self.l[0] + (self.l[1] - self.l[0]) * frac;
                if frac >= 1.0 { self.stage = 1; self.t = 0.0; }
            }
            1 => { // L2→L3 @R2
                let t = DxEg::seg_time(self.r[1]);
                let frac = (self.t / t).min(1.0);
                self.val = self.l[1] + (self.l[2] - self.l[1]) * frac;
                if frac >= 1.0 { self.stage = 2; self.t = 0.0; }
            }
            2 => { // L3→L4 @R3 后保持
                let t = DxEg::seg_time(self.r[2]);
                let frac = (self.t / t).min(1.0);
                self.val = self.l[2] + (self.l[3] - self.l[2]) * frac;
                if frac >= 1.0 { self.val = self.l[3]; }
            }
            _ => { // key_off:R4 → 0
                let t = DxEg::seg_time(self.r[3]);
                let frac = (self.t / t).min(1.0);
                self.val = self.l[3] * (1.0 - frac);
            }
        }
        self.val
    }
    fn done(&self) -> bool { self.off && self.val < 0.5 }
}

struct DxOp {
    ratio: f32,
    tl: f32,       // 0-99
    detune: f32,   // 0-7(音分偏移)
    eg: DxEg,
    phase: f64,
}

// 算法拓扑表:mod_by[i] = 调制 OP i 的算子索引(OP1=0),-1=无输入,-2=OP6 自反馈
// carriers[i] = OP i 是否载波(输出进混音)
pub const DX_ALGS: &[([i8; 6], [bool; 6])] = &[
    // 1 六级串联堆栈(经典钟/电钢)
    ([1, 2, 3, 4, 5, -2], [true, false, false, false, false, false]),
    // 2 双链并行 6-5-4 | 3-2-1
    ([1, 2, -1, 4, 5, -2], [true, false, false, true, false, false]),
    // 3 三链并行 6-5 | 4-3 | 2-1
    ([1, -1, 3, -1, 5, -2], [true, false, true, false, true, false]),
    // 4 大链 6-5-4-3-2 + OP1 独立载波
    ([-1, 2, 3, 4, 5, -2], [true, true, false, false, false, false]),
    // 5 三组混合 6-5-4 | 3-2 | 1 独立
    ([-1, 2, -1, 4, 5, -2], [true, true, false, true, false, false]),
    // 6 星型:OP6(反馈)调制 OP1-5,全载波
    ([5, 5, 5, 5, 5, -2], [true, true, true, true, true, false]),
    // 32 六载波并行(风琴/铺底)
    ([-1, -1, -1, -1, -1, -1], [true, true, true, true, true, true]),
];

pub struct DxVoice {
    ops: [DxOp; 6],     // OP1..OP6(OP6 = 顶层调制器)
    fb_gain: f32,       // OP6 反馈量(弧度,DX 非线性曲线)
    fb_prev: f32,       // OP6 上一采样输出
    pub mod_by: [i8; 6],    // 算法拓扑
    pub carriers: [bool; 6],
    aa_z: f32,          // 抗混叠一阶低通
    done: bool,
    lut_size: u32,      // 正弦查表尺寸(0=浮点 sin;1024/2048/4096/8192)
    quant_bits: u8,     // 相位定点截断位数(0=关)
    dac: bool,          // DAC 输出量化
    bits: u32,          // DAC 量化位数 8/12/16
    aa: bool,           // 抗混叠平滑
}
impl DxVoice {
    fn new(p: &EngineParams) -> Self {
        let mut ops: [DxOp; 6] = unsafe { std::mem::zeroed() };
        for i in 0..6 {
            let eg = &p.dx_egs[i * 8..(i * 8 + 8).min(p.dx_egs.len())];
            ops[i] = DxOp {
                ratio: p.dx_ratios[i],
                tl: p.dx_tls[i],
                detune: p.dx_dets[i],
                eg: DxEg::new(eg),
                phase: 0.0,
            };
        }
        let fb = (p.dx_feedback as usize).min(7);
        let alg_idx = match p.dx_algorithm {
            1 => 0usize, 2 => 1, 3 => 2, 4 => 3, 5 => 4, 6 => 5, 7 | 32 => 6, _ => 0,
        };
        let (mod_by, carriers) = DX_ALGS[alg_idx.min(DX_ALGS.len() - 1)];
        Self {
            ops, fb_gain: super::dsp::DX_FB_TABLE[fb],
            fb_prev: 0.0, mod_by, carriers, aa_z: 0.0, done: false,
            lut_size: p.dx_lut_size, quant_bits: p.dx_quant_bits, dac: p.dx_dac,
            bits: p.dx_bits as u32, aa: p.dx_aa,
        }
    }
    fn key_off(&mut self) {
        for op in self.ops.iter_mut() { op.eg.key_off(); }
    }
    fn finished(&mut self) -> bool {
        if self.done { return true; }
        if self.ops.iter().all(|o| o.eg.done()) { self.done = true; }
        self.done
    }
}

pub struct Voice {
    pub wave_type: String,
    pub midi: u8,
    pub vel: f32,
    pub t: f32,
    pub on_t: f32,
    pub freq: f32,
    pub pan: f32,
    pub env: Adsr,
    pub pedaled: bool,
    pub sostened: bool,
    pub releasing: bool,
    // 通用波形路径
    pub phases: Vec<f64>,
    pub spreads: Vec<f32>,
    pub vibrato_phase: f64,
    pub sub_phase: f64,
    pub sub_level: f32,
    pub vibrato_rate: f32,
    pub vibrato_depth: f32,
    // 滤波器 + 滤波包络
    pub filter: Option<Biquad>,
    pub filter_env: Option<Adsr>,
    pub filter_base: f32,
    pub filter_env_hz: f32,
    pub filter_env_r: f32,
    // 调制 LFO
    pub mod_lfo_phase: f64,
    pub sh_lfo: ShLfo,
    pub mod_wave_osc: bool,   // true=振荡器类,false=s&h
    pub mod_target: u8,       // 0=off 1=cutoff 2=volume 3=pan
    pub mod_depth: f32,
    pub mod_range: f32,       // cutoff 目标的基准范围
    // 加法(钢琴/拨弦)
    pub partials: Vec<Partial>,
    pub detune_phase: f64,
    pub noise_left: usize,
    pub noise_level: f32,
    pub noise_hp: Option<Biquad>,
    pub noise_bright: f32,    // piano 泛音明亮度
    pub detune_str: f32,      // 双弦失谐音分
    pub piano_scale: f32,
    pub pluck_decay_base: f32,
    // drip
    pub drip: Option<DripState>,
    // FM
    pub fm: Option<FmState>,
    // DX7 硬件模拟(PM + 6 算子 + 4R4L EG)
    pub dx: Option<DxVoice>,
    // wt
    pub wt: Option<WtState>,
    /// 白噪声 LCG 状态(每 voice 独立,音高派生种子)
    pub noise_state: u32,
    /// 粒子合成状态(波形表粒子流)
    pub grain: Option<GrainState>,
    pub wt_bank: Vec<Vec<f32>>,
    pub wt_pos: f32,
    pub wt_lfo_rate: f32,
    pub wt_lfo_depth: f32,
    pub wt_lfo_t0: f32,
}

impl Voice {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        wave_type: &str, midi: u8, vel: f32, t: f32,
        p: &EngineParams, wt_bank: Vec<Vec<f32>>,
    ) -> Self {
        let freq = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
        let mut v = Self {
            wave_type: wave_type.to_string(),
            midi, vel, t, on_t: t,
            freq, pan: p.pan,
            env: Adsr::new(p.attack, p.decay, p.sustain, p.release),
            pedaled: false, sostened: false, releasing: false,
            phases: Vec::new(), spreads: Vec::new(),
            vibrato_phase: 0.0, sub_phase: 0.0,
            sub_level: p.sub_level, vibrato_rate: p.vibrato_rate, vibrato_depth: p.vibrato_depth,
            filter: None, filter_env: None, filter_base: 0.0,
            filter_env_hz: p.filter_env_hz, filter_env_r: p.filter_env_r,
            mod_lfo_phase: 0.0,
            sh_lfo: ShLfo::new(p.mod_lfo_rate, p.mod_lfo_depth),
            mod_wave_osc: p.mod_lfo_wave != "s&h",
            mod_target: match p.mod_lfo_target.as_str() { "cutoff" => 1, "volume" => 2, "pan" => 3, _ => 0 },
            mod_depth: p.mod_lfo_depth,
            mod_range: 0.0,
            partials: Vec::new(), detune_phase: 0.0,
            noise_left: 0, noise_level: 0.0, noise_hp: None,
            noise_bright: 1.0, detune_str: 0.0, piano_scale: 1.0,
            pluck_decay_base: 1.5,
            drip: None, fm: None, dx: None, wt: None,
            noise_state: 0x9E3779B9u32.wrapping_add((midi as u32).wrapping_mul(2654435761)),
            grain: None,
            wt_bank, wt_pos: p.wt_pos, wt_lfo_rate: p.wt_lfo_rate,
            wt_lfo_depth: p.wt_lfo_depth, wt_lfo_t0: t,
        };
        v.build_voice(p);
        v.env.trigger(v.vel);   // 包络起音
        v
    }

    fn build_voice(&mut self, p: &EngineParams) {
        let ctx_t = self.t;
        if self.wave_type == "grain" {
            // 粒子合成初始化(粒子源表在 render_grain 里懒构建)
            self.grain = Some(GrainState {
                next_in: 0.0,
                grains: Vec::with_capacity(8),
                size: (p.grain_size_ms / 1000.0 * sr()).max(32.0),
                density: p.grain_density,
                spread_cents: p.grain_spread,
                random: p.grain_random,
            });
        }
        match self.wave_type.as_str() {
            "piano" => {
                for (n, amp, decay_t) in PIANO_HARMONICS {
                    let bright = 1.0 + (p.piano_bright - 1.0) * ((n - 1.0) / 7.0);
                    self.partials.push(Partial {
                        n, amp: amp * bright, decay_t: decay_t * p.piano_decay_scale, phase: 0.0,
                    });
                }
                self.detune_str = p.piano_detune_cents;
                self.piano_scale = p.piano_decay_scale;
                self.noise_level = p.piano_noise_level * self.vel;
                self.noise_left = if p.piano_noise_level > 0.0 { (0.045 * sr()) as usize } else { 0 };
                let mut hp = Biquad::new(1, 1200.0, 0.7);
                hp.reset();
                self.noise_hp = Some(hp);
                // 钢琴包络:4ms 起音 + 4.5*scale 指数衰减
                self.env = Adsr::new(0.004, 4.5 * p.piano_decay_scale, 0.0001, p.release);
            }
            "drip" => {
                let ratio = p.drip_ratio;
                let slide = p.drip_time_ms / 1000.0;
                let decay = p.drip_decay_ms / 1000.0;
                self.drip = Some(DripState {
                    ratio,
                    slide_t: slide,
                    star_slide_t: slide / 1.5,
                    main_phase: 0.0, star_phase: 0.0,
                    star_gain: 0.35 * self.vel,
                    echoes: [
                        EchoState { trigger_at: 0.22, amp: 0.3 * self.vel, freq_start: self.freq * (ratio * 0.7 + 0.3), freq_end: self.freq, slide_t: slide / 2.0, decay_t: decay, phase: 0.0, freq: 0.0, triggered: false, t: 0.0 },
                        EchoState { trigger_at: 0.44, amp: 0.12 * self.vel, freq_start: self.freq * (ratio * 0.7 + 0.3), freq_end: self.freq, slide_t: slide / 2.0, decay_t: decay, phase: 0.0, freq: 0.0, triggered: false, t: 0.0 },
                    ],
                });
                // 主包络:10ms 起音 + 指数衰减
                self.env = Adsr::new(0.01, decay, 0.0001, p.release);
            }
            "dx7" => {
                if p.dx_pm {
                    // DX7 硬件模拟:PM 相位调制,6 算子 + 4R4L EG,主包络旁路
                    self.dx = Some(DxVoice::new(p));
                    self.env = Adsr::new(0.001, 0.01, 1.0, 0.02);
                } else {
                    self.fm = Some(FmState {
                        carrier_phase: 0.0,
                        mod1_phase: 0.0, mod2_phase: 0.0,
                        mod1_peak: 3.0 * 1.0 * self.freq,
                        mod1_sus: 0.8 * 1.0 * self.freq,
                        mod2_peak: 2.0 * 2.0 * self.freq,
                        mod2_sus: 0.5 * 2.0 * self.freq,
                        decay_t: 0.45,
                    });
                }
            }
            "acc" => {
                // 双簧片方波失谐 ±11 音分 → 低通
                let mut flt = Biquad::new(0, (self.freq * 3.5 + 800.0).min(3000.0), 1.4);
                flt.reset();
                self.filter = Some(flt);
                self.phases = vec![0.0, 0.0];
                self.spreads = vec![-11.0, 11.0];
                // 包络:30ms 起音 → 0.9 延音
                self.env = Adsr::new(0.03, 0.1, 0.9, p.release);
            }
            "clar" => {
                let mut flt = Biquad::new(0, (self.freq * 3.0 + 700.0).min(2600.0), 1.1);
                flt.reset();
                self.filter = Some(flt);
                self.phases = vec![0.0];
                self.spreads = vec![0.0];
                self.vibrato_rate = 5.5;
                self.vibrato_depth = 0.004;   // 频率比例微颤
                self.env = Adsr::new(0.06, 0.2, 0.92, p.release);
            }
            "harp" | "guzheng" => {
                let gz = self.wave_type == "guzheng";
                for (n, amp) in pluck_harmonics(gz) {
                    let base = if gz { 3.0 } else { 1.2 };
                    self.partials.push(Partial {
                        n: *n, amp: *amp, decay_t: base / n.powf(0.8), phase: 0.0,
                    });
                }
                self.pluck_decay_base = if gz { 3.5 } else { 1.5 };
                if p.piano_noise_level > 0.0 {
                    let lvl = if gz { 0.22 } else { 0.16 } * self.vel * (p.piano_noise_level / 0.3);
                    if lvl > 0.001 {
                        self.noise_level = lvl;
                        self.noise_left = (0.03 * sr()) as usize;
                        let mut hp = Biquad::new(1, 2500.0, 0.7);
                        hp.reset();
                        self.noise_hp = Some(hp);
                    }
                }
                self.env = Adsr::new(0.004, self.pluck_decay_base, 0.0001, p.release);
            }
            "wt" => {
                let mut flt = Biquad::new(filter_kind_id(&p.filter_kind), cutoff_eff(p, self.midi, self.vel), p.resonance_q);
                flt.reset();
                self.filter = Some(flt);
                let n = self.wt_bank.len().max(2);
                self.wt = Some(WtState { phase: 0.0, slot_gains: vec![0.0; n], lfo_phase: 0.0, lfo_t0: ctx_t });
                self.init_wt_weights(p, ctx_t);
            }
            _ => {
                // 通用波形路径:sine/square/saw/triangle/moog/custom
                let use_native = self.wave_type == "moog";
                let n = p.osc_count.clamp(1, 8) as usize;
                self.phases = vec![0.0; n];
                self.spreads = Vec::with_capacity(n);
                for i in 0..n {
                    let spread = if n > 1 {
                        let ratio = if n == 2 { if i == 0 { -1.0 } else { 1.0 } } else { (i as f32 / (n - 1) as f32) * 2.0 - 1.0 };
                        ratio * p.detune_cents
                    } else { 0.0 };
                    self.spreads.push(spread);
                }
                if !use_native {
                    // 主波形波表由引擎构建后填入 self.wt_bank[0]
                }
                let mut flt = Biquad::new(filter_kind_id(&p.filter_kind), cutoff_eff(p, self.midi, self.vel), p.resonance_q);
                flt.reset();
                self.filter = Some(flt);
                self.filter_base = cutoff_eff(p, self.midi, self.vel);
                if p.filter_env_hz > 0.0 {
                    let mut fe = Adsr::new(p.filter_env_a, p.filter_env_d, p.filter_env_s, p.filter_env_r);
                    fe.trigger(p.filter_env_hz);
                    self.filter_env = Some(fe);
                }
                // 调制 LFO 范围
                if self.mod_target == 1 { self.mod_range = self.filter_base * 0.8; }
            }
        }
        // 通用:调制 LFO 范围
        if self.mod_target == 2 { self.mod_range = self.vel; }
        if self.mod_target == 3 { self.mod_range = 1.0; }
    }

    fn init_wt_weights(&mut self, p: &EngineParams, t: f32) {
        let pos = self.wt_current_pos(p, t);
        let wt = self.wt.as_mut().unwrap();
        let n = wt.slot_gains.len();
        let scaled = pos.min(0.9999).max(0.0) * (n - 1) as f32;
        let i = scaled.floor() as usize;
        let frac = scaled - i as f32;
        let w0 = (frac * std::f32::consts::FRAC_PI_2).cos();
        let w1 = (frac * std::f32::consts::FRAC_PI_2).sin();
        for s in 0..n {
            wt.slot_gains[s] = if s == i { w0 } else if s == i + 1 { w1 } else { 0.0 };
        }
    }

    fn wt_current_pos(&self, p: &EngineParams, t: f32) -> f32 {
        if p.wt_lfo_depth <= 0.0 || p.wt_lfo_rate <= 0.0 { return self.wt_pos; }
        let phase = 2.0 * std::f32::consts::PI * p.wt_lfo_rate * (t - self.wt_lfo_t0);
        let lfo = 0.5 + 0.5 * phase.sin();
        (self.wt_pos + p.wt_lfo_depth * (lfo - 0.5) * 2.0).clamp(0.0, 1.0)
    }

    /// 释放:快速释放(steal)或正常(含延音踏板挂起逻辑由引擎处理)
    pub fn release(&mut self, fast: bool) {
        self.releasing = true;
        let r = if fast { 0.02 } else { self.env.r };
        let age = self.t - self.on_t;
        // 音龄短:先补起音再释放(TS releaseVoice 语义)
        if !fast && age < self.env.a + 0.03 {
            let cur = self.env.value().max(0.02);
            self.env.set_release(r);
            self.env.release_at(cur.min(self.vel * 0.9));
        } else {
            self.env.set_release(r);
            self.env.release();
        }
        // 滤波包络释放回落
        if let Some(fe) = self.filter_env.as_mut() {
            fe.release();
        }
        // DX7 模式:算子 EG 进入 R4 释放
        if let Some(dx) = self.dx.as_mut() {
            dx.key_off();
        }
    }

    /// NoteOn 随机扰动(一次性,模拟硬件不稳定):初始相位/失谐/电平微偏
    pub fn apply_jitter(&mut self, amount: f32) {
        let r = |lo: f32, hi: f32| lo + (hi - lo) * rand01();
        for ph in self.phases.iter_mut() { *ph += (r(0.0, 1.0) * amount) as f64; }
        for pt in self.partials.iter_mut() { pt.phase += (r(0.0, 1.0) * amount) as f64; }
        if let Some(wt) = self.wt.as_mut() { wt.phase += (r(0.0, 1.0) * amount) as f64; }
        if let Some(fm) = self.fm.as_mut() {
            fm.carrier_phase += (r(0.0, 1.0) * amount) as f64;
            fm.mod1_phase += (r(0.0, 1.0) * amount) as f64;
            fm.mod2_phase += (r(0.0, 1.0) * amount) as f64;
        }
        if let Some(drip) = self.drip.as_mut() {
            drip.main_phase += (r(0.0, 1.0) * amount) as f64;
            drip.star_phase += (r(0.0, 1.0) * amount) as f64;
        }
        if let Some(dx) = self.dx.as_mut() {
            for op in dx.ops.iter_mut() {
                op.phase += (r(0.0, 1.0) * amount) as f64;
                op.tl = (op.tl + r(-3.0, 3.0) * amount).clamp(0.0, 99.0);
                op.detune = (op.detune + r(-0.5, 0.5) * amount).clamp(0.0, 7.0);
            }
        }
    }

    // ============ 硬件模拟渲染(PM 相位调制,通用算法拓扑) ============
    fn render_dx(&mut self, dt: f32) -> f32 {
        let sr = sr();
        let dx = self.dx.as_mut().unwrap();
        let mut eg_vals = [0.0f32; 6];
        // 相位推进(ratio × detune,可选定点量化)
        // 查表尺寸 ≠ 只截断查值:硬件查表合成器的相位累加器本身量化到表分辨率
        // (相位寄存器位数 = log2(表长)),每采样把相位量子化到 1/表长:
        //   1024 点 → 相位步进 1/1024 圈,量化噪声明显(砂感/毛刺)
        //   8192 点 → 步进 1/8192 圈,接近干净
        // 若不量化相位,浮点累积会把表间误差平均掉,换表尺寸听感无差异。
        for (i, op) in dx.ops.iter_mut().enumerate() {
            let det = 2f32.powf(op.detune * 3.5 / 1200.0);   // 每档 ≈ 3.5 音分
            let inc = (self.freq * op.ratio * det / sr) as f64;
            op.phase += if dx.quant_bits > 0 { super::dsp::qbits(inc as f32, dx.quant_bits as u32) as f64 } else { inc };
            if dx.lut_size > 0 {
                // 相位寄存器量化到表分辨率(硬件行为)
                let q = dx.lut_size as f64;
                op.phase = op.phase.floor() + (op.phase.fract() * q).round() / q;
            }
            eg_vals[i] = op.eg.next(dt);
        }
        let sinv = |ph: f64| {
            let v = if dx.lut_size > 0 {
                super::dsp::sine_lut(ph.fract(), dx.lut_size as usize)
            } else {
                (ph.fract() * std::f32::consts::TAU as f64).sin() as f32
            };
            if dx.quant_bits > 0 { super::dsp::qbits(v, dx.quant_bits as u32) } else { v }
        };
        // 拓扑排序渲染:调制源先算(链从上游到下游);-2 = OP6 自反馈
        let mut ys = [0.0f32; 6];
        let mut done = [false; 6];
        let mut remaining = 6;
        let mut guard = 0;
        while remaining > 0 && guard < 36 {
            guard += 1;
            for i in 0..6 {
                if done[i] { continue; }
                let src = dx.mod_by[i];
                let ready = match src {
                    -2 => true,
                    -1 => true,
                    s => done[s as usize],
                };
                if !ready { continue; }
                // 调制输入(弧度):反馈 = fb_gain × 上一采样输出;上游 = 输出 × EG 电平
                let mod_turns = match src {
                    -2 => (dx.fb_gain * dx.fb_prev) as f64 / std::f32::consts::TAU as f64,
                    -1 => 0.0,
                    s => (ys[s as usize] * (eg_vals[s as usize] / 99.0) * 1.5) as f64 / std::f32::consts::TAU as f64,
                };
                let y = sinv(dx.ops[i].phase + mod_turns);
                ys[i] = y;
                if src == -2 { dx.fb_prev = y; }
                done[i] = true;
                remaining -= 1;
            }
        }
        // 载波输出(TL + EG 电平)
        let mut out = 0.0;
        let mut n_car = 0;
        for i in 0..6 {
            if dx.carriers[i] {
                let amp = ((99.0 - dx.ops[i].tl) / 99.0) * (eg_vals[i] / 99.0) * 0.9;
                out += ys[i] * amp * self.vel;
                n_car += 1;
            }
        }
        if n_car > 1 { out /= n_car as f32; }
        // 抗混叠:true=低通软化;false=允许混叠(保留金属颗粒,默认)
        if dx.aa {
            let a = (-2.0 * std::f32::consts::PI * 12000.0 / sr).exp();
            dx.aa_z += (out - dx.aa_z) * a;
            out = dx.aa_z;
        }
        // DAC 输出量化(初代 DX7 12bit;位数 8/12/16 可调)
        if dx.dac { out = super::dsp::qbits(out, dx.bits); }
        out
    }

    /// 逐样本渲染,输出叠加到 out;返回 true 表示发声结束
    pub fn render(&mut self, dt: f32, p: &EngineParams, noise: &[f32], out: &mut [f32; 2]) -> bool {
        self.t += dt;
        let mono = match self.wave_type.as_str() {
            "piano" => self.render_piano(dt, p, noise),
            "drip" => self.render_drip(dt),
            "dx7" => if self.dx.is_some() { self.render_dx(dt) } else { self.render_fm(dt) },
            "acc" => self.render_acc(dt, p),
            "clar" => self.render_clar(dt),
            "harp" | "guzheng" => self.render_pluck(noise),
            "wt" => self.render_wt(dt, p),
            "noise" => self.render_noise(dt, p),
            "grain" => self.render_grain(dt, p),
            _ => self.render_table(dt, p),
        };
        // 调制 LFO → volume(叠加到包络,与 TS 一致:additive)
        let mut g = self.env.next(dt);
        if self.mod_target == 2 && self.mod_depth > 0.0 {
            g += self.mod_lfo_val(dt) * self.mod_range * self.mod_depth;
        }
        // 调制 LFO → 声像(左右全摆幅)
        let mut pan = self.pan;
        if self.mod_target == 3 && self.mod_depth > 0.0 {
            pan = (self.pan + self.mod_lfo_val(dt) * self.mod_depth).clamp(-1.0, 1.0);
        }
        let (l, r) = pan_gains(pan);
        out[0] += mono * g * l;
        out[1] += mono * g * r;
        // DX7 模式:发声结束由算子 EG 决定(主包络旁路)
        if self.dx.is_some() {
            return self.dx.as_mut().unwrap().finished();
        }
        self.env.done()
    }

    fn mod_lfo_val(&mut self, dt: f32) -> f32 {
        match self.mod_target {
            0 => 0.0,
            1 if !self.mod_wave_osc => self.sh_lfo.next(dt),   // s&h 仅 cutoff
            _ => {
                self.mod_lfo_phase += (self.sh_lfo.rate.max(0.01) * dt) as f64;
                let ph = (self.mod_lfo_phase * std::f32::consts::TAU as f64).sin() as f32;
                ph
            }
        }
    }

    // ============ 通用波形路径(sine/square/saw/triangle/moog/custom) ============
    /// 粒子合成:从当前波形表取粒子流
    /// - 按密度触发新粒子(相位随机 + 音高散布,随机量控制散布强度)
    /// - 每个粒子 Hann 窗包络(平滑起落,无爆音)
    /// - 8 个粒子同时叠加;主包络控制整体(按键/松键)
    fn render_grain(&mut self, dt: f32, p: &EngineParams) -> f32 {
        let gs = match self.grain.as_mut() { Some(g) => g, None => return 0.0 };
        let sr_f = sr();
        // 更新参数(实时调节生效)
        // 粒子参数包络:时长/密度随时间从起始值滑向终点值
        //   env_ms=0 或 终点=起点 → 直线(恒定);指数控制滑行形状
        let env_t = (self.t * 1000.0 / p.grain_env_ms.max(1.0)).min(1.0);
        let k = if p.grain_env_exp.abs() > 0.01 {
            if p.grain_env_exp > 0.0 { env_t.powf(p.grain_env_exp.max(0.1)) } else { 1.0 - (1.0 - env_t).powf((-p.grain_env_exp).max(0.1)) }
        } else { env_t };
        let size_ms = p.grain_size_ms + (p.grain_size_end - p.grain_size_ms) * k;
        let density = p.grain_density + (p.grain_density_end - p.grain_density) * k;
        gs.size = (size_ms / 1000.0 * sr_f).clamp(16.0, sr_f * 0.5);
        gs.density = density;
        gs.spread_cents = p.grain_spread;
        gs.random = p.grain_random;
        // 触发新粒子
        gs.next_in -= 1.0;
        if gs.next_in <= 0.0 && gs.grains.len() < 8 {
            let size = gs.size * (1.0 + (rand01() - 0.5) * 0.4 * gs.random);
            let jitter_cents = (rand01() - 0.5) * 2.0 * gs.spread_cents;
            let phase0 = rand01() * gs.random;   // 随机起始相位
            let inc = self.freq * 2f32.powf(jitter_cents / 1200.0) / sr_f;
            gs.grains.push(Grain { pos: 0.0, size, phase: phase0 as f64, inc: inc as f64 });
            gs.next_in = sr_f / gs.density;
        }
        // 渲染活跃粒子(Hann 窗)
        // 粒子源:当前波形表;为空时(粒子音色默认)用锯齿表(颗粒感强)
        let bank: Vec<f32> = if self.wt_bank.is_empty() {
            super::waves::build_wavetable("saw", 32)
        } else {
            self.wt_bank[0].clone()
        };
        let table = &bank;
        let n = table.len() as f32;
        let mut out = 0.0f32;
        let mut i = 0usize;
        while i < gs.grains.len() {
            let g = &mut gs.grains[i];
            g.pos += 1.0;
            if g.pos >= g.size {
                gs.grains.swap_remove(i);   // 粒子结束
                continue;
            }
            let prog = g.pos / g.size;
            let win = (std::f32::consts::PI * prog).sin();   // Hann 窗
            let idx = (((g.phase * n as f64) as usize) & (n as usize - 1)) as usize;
            let s = table[idx] * win * 0.5;
            g.phase += g.inc;
            out += s;
            i += 1;
        }
        out
    }

    /// 白噪声合成:LCG 伪随机 × 包络,经滤波塑形
    /// (打击乐/风声/扫频;滤波类型+截止决定音色,高通=沙锤类,带通=哔哔声)
    fn render_noise(&mut self, dt: f32, p: &EngineParams) -> f32 {
        // 确定性 LCG(每 voice 独立种子,从音高派生)
        self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
        let white = (self.noise_state as f32 / u32::MAX as f32) * 2.0 - 1.0;
        let cutoff = cutoff_eff(p, self.midi, self.vel).clamp(40.0, 20000.0);
        let mut flt = Biquad::new(filter_kind_id(&p.filter_kind), cutoff, p.resonance_q);
        flt.next(white)
    }

    fn render_table(&mut self, dt: f32, p: &EngineParams) -> f32 {
        let use_native = self.wave_type == "moog";
        let table = if use_native { None } else { Some(&self.wt_bank[0]) };
        // 颤音
        self.vibrato_phase += self.vibrato_rate as f64 * dt as f64;
        let vib = if self.vibrato_depth > 0.0 {
            (self.vibrato_phase * std::f32::consts::TAU as f64).sin() as f32 * self.vibrato_depth * self.freq * 0.05
        } else { 0.0 };
        let base_f = self.freq + vib;
        // 振荡器组
        let mut sum = 0.0;
        for i in 0..self.phases.len() {
            let det = 2f32.powf((self.spreads[i] + p.bend_cents) / 1200.0);
            self.phases[i] += (base_f * det / sr()) as f64;
            let ph = self.phases[i].fract();
            sum += match &table {
                Some(tab) => {
                    let x = ph * WAVE_LEN as f64;
                    let i0 = (x as usize) % WAVE_LEN;
                    let i1 = (i0 + 1) % WAVE_LEN;
                    let frac = (x - i0 as f64) as f32;
                    tab[i0] * (1.0 - frac) + tab[i1] * frac
                }
                None => {
                    // moog 原生振荡器
                    match p.osc_wave.as_str() {
                        "sine" => (ph * std::f32::consts::TAU as f64).sin() as f32,
                        "square" => if ph < 0.5 { 1.0 } else { -1.0 },
                        "triangle" => if ph < 0.5 { 4.0 * ph as f32 - 1.0 } else { 3.0 - 4.0 * ph as f32 },
                        _ => 2.0 * ph as f32 - 1.0,  // sawtooth
                    }
                }
            };
        }
        sum /= self.phases.len().max(1) as f32;
        // 滤波器(含键位/力度跟踪 + 滤波包络 + 调制 LFO cutoff)
        let lfo_cut = if self.mod_target == 1 {
            self.mod_lfo_val(dt) * self.mod_range * self.mod_depth
        } else { 0.0 };
        let mut out = if let Some(f) = self.filter.as_mut() {
            let mut cutoff = self.filter_base;
            if let Some(fe) = self.filter_env.as_mut() {
                cutoff += fe.next(dt);
            }
            f.update(cutoff + lfo_cut, p.resonance_q);
            f.next(sum)
        } else { sum };
        // 副振荡器(基频下方八度)
        if self.sub_level > 0.0 {
            self.sub_phase += (self.freq / 2.0 / sr()) as f64;
            let sub = (self.sub_phase * std::f32::consts::TAU as f64).sin() as f32;
            out += sub * self.sub_level * 0.6;
        }
        out
    }

    // ============ 钢琴(加法) ============
    fn render_piano(&mut self, dt: f32, p: &EngineParams, noise: &[f32]) -> f32 {
        let mut sum = 0.0;
        for pt in self.partials.iter_mut() {
            let f = self.freq * pt.n * (1.0 + super::waves::INHARMONICITY * pt.n * pt.n);
            pt.phase += (f / sr()) as f64;
            let frac = (pt.phase * std::f32::consts::TAU as f64).sin() as f32;
            let g = pt.amp * self.vel * (0.0001 / (pt.amp * self.vel)).powf((self.t / pt.decay_t).min(1.0));
            sum += frac * g;
        }
        // 双弦失谐
        self.detune_phase += (self.freq * 2f32.powf(self.detune_str / 1200.0) / sr()) as f64;
        let det = (self.detune_phase * std::f32::consts::TAU as f64).sin() as f32;
        sum += det * 0.6 * self.vel * (0.0001 / (0.6 * self.vel)).powf((self.t / (2.4 * self.piano_scale)).min(1.0));
        // 锤击噪声瞬态(高通 1200)
        if self.noise_left > 0 {
            self.noise_left -= 1;
            let idx = ((self.t * sr()) as usize) % noise.len();
            let raw = noise[idx];
            let hp = self.noise_hp.as_mut().unwrap();
            let n = hp.next(raw);
            sum += n * self.noise_level;
        }
        sum
    }

    // ============ 水滴(频率下滑) ============
    fn render_drip(&mut self, dt: f32) -> f32 {
        let drip = self.drip.as_mut().unwrap();
        // 主滴:ratio*freq → freq 指数下滑(Web Audio exponentialRamp 语义)
        let slide = drip.slide_t.max(1e-4);
        let frac = (self.t / slide).min(1.0);
        let main_f = self.freq * drip.ratio * (1.0 / drip.ratio).powf(frac);
        drip.main_phase += (main_f / sr()) as f64;
        let main = (drip.main_phase * std::f32::consts::TAU as f64).sin() as f32;
        // 星光层:高八度长尾
        let sfrac = (self.t / drip.star_slide_t.max(1e-4)).min(1.0);
        let f2_start = self.freq * 2.0 * (1.0 + (drip.ratio - 1.0) * 0.25);
        let star_f = f2_start * (self.freq * 2.0 / f2_start).powf(sfrac);
        drip.star_phase += (star_f / sr()) as f64;
        let star = (drip.star_phase * std::f32::consts::TAU as f64).sin() as f32 * drip.star_gain;
        let mut out = main + star;
        // 回声涟漪
        for e in drip.echoes.iter_mut() {
            if !e.triggered {
                if self.t >= e.trigger_at { e.triggered = true; e.freq = e.freq_start; }
            }
            if e.triggered {
                e.t += dt;
                let frac = (e.t / e.slide_t).min(1.0);
                e.freq = e.freq_start + (e.freq_end - e.freq_start) * (1.0 - (1.0 - frac).powi(2));
                e.phase += (e.freq / sr()) as f64;
                let g = e.amp * (0.0001 / e.amp).powf((e.t / e.decay_t).min(1.0));
                out += (e.phase * std::f32::consts::TAU as f64).sin() as f32 * g;
            }
        }
        out
    }

    // ============ FM(dx7) ============
    fn render_fm(&mut self, dt: f32) -> f32 {
        let fm = self.fm.as_mut().unwrap();
        // 调制指数包络:peak → sus 指数衰减(Web Audio exponentialRamp 语义)
        let frac = (self.t / fm.decay_t).min(1.0);
        let i1 = fm.mod1_peak * (fm.mod1_sus / fm.mod1_peak).powf(frac);
        let i2 = fm.mod2_peak * (fm.mod2_sus / fm.mod2_peak).powf(frac);
        fm.mod1_phase += (self.freq / sr()) as f64;
        fm.mod2_phase += (self.freq * 2.0 / sr()) as f64;
        let m1 = (fm.mod1_phase * std::f32::consts::TAU as f64).sin() as f32;
        let m2 = (fm.mod2_phase * std::f32::consts::TAU as f64).sin() as f32;
        // 频率调制(TS:mod → carrier.frequency)
        let c_freq = self.freq + i1 * m1 + i2 * m2;
        fm.carrier_phase += (c_freq / sr()) as f64;
        (fm.carrier_phase * std::f32::consts::TAU as f64).sin() as f32
    }

    // ============ 手风琴(双簧片) ============
    fn render_acc(&mut self, _dt: f32, p: &EngineParams) -> f32 {
        let mut sum = 0.0;
        for i in 0..self.phases.len() {
            self.phases[i] += (self.freq * 2f32.powf((self.spreads[i] + p.bend_cents) / 1200.0) / sr()) as f64;
            let ph = self.phases[i].fract();
            sum += if ph < 0.5 { 1.0 } else { -1.0 };
        }
        sum /= self.phases.len().max(1) as f32;
        if let Some(f) = self.filter.as_mut() { f.next(sum) } else { sum }
    }

    // ============ 单簧管(闭管) ============
    fn render_clar(&mut self, _dt: f32) -> f32 {
        self.vibrato_phase += self.vibrato_rate as f64 * 1.0 / sr() as f64;
        let vib = (self.vibrato_phase * std::f32::consts::TAU as f64).sin() as f32 * self.freq * self.vibrato_depth;
        self.phases[0] += ((self.freq + vib) / sr()) as f64;
        let ph = self.phases[0].fract();
        let sq = if ph < 0.5 { 1.0 } else { -1.0 };
        // 3 次谐波(单簧管特征)
        self.sub_phase += (self.freq * 3.0 / sr()) as f64;
        let h3 = (self.sub_phase * std::f32::consts::TAU as f64).sin() as f32 * 0.18;
        let sum = sq + h3;
        if let Some(f) = self.filter.as_mut() { f.next(sum) } else { sum }
    }

    // ============ 竖琴/古筝(拨弦) ============
    fn render_pluck(&mut self, noise: &[f32]) -> f32 {
        let mut sum = 0.0;
        for pt in self.partials.iter_mut() {
            let f = self.freq * pt.n * (1.0 + super::waves::INHARMONICITY * pt.n * pt.n);
            pt.phase += (f / sr()) as f64;
            let frac = (pt.phase * std::f32::consts::TAU as f64).sin() as f32;
            let g = pt.amp * self.vel * (0.0001 / (pt.amp * self.vel)).powf((self.t / pt.decay_t).min(1.0));
            sum += frac * g;
        }
        if self.noise_left > 0 {
            self.noise_left -= 1;
            let idx = ((self.t * sr()) as usize) % noise.len();
            let hp = self.noise_hp.as_mut().unwrap();
            sum += hp.next(noise[idx]) * self.noise_level;
        }
        sum
    }

    // ============ 波表(形态渐变) ============
    fn render_wt(&mut self, dt: f32, p: &EngineParams) -> f32 {
        // 颤音
        self.vibrato_phase += self.vibrato_rate as f64 * dt as f64;
        let vib = if self.vibrato_depth > 0.0 {
            (self.vibrato_phase * std::f32::consts::TAU as f64).sin() as f32 * self.vibrato_depth * self.freq * 0.05
        } else { 0.0 };
        let base_f = self.freq + vib;
        // 形态位置(静态或 LFO)+ 槽位权重平滑
        let pos = self.wt_current_pos(p, self.t);
        let lfo_cut = if self.mod_target == 1 {
            self.mod_lfo_val(dt) * self.mod_depth
        } else { 0.0 };
        let wt = self.wt.as_mut().unwrap();
        let n = wt.slot_gains.len();
        let scaled = pos.min(0.9999).max(0.0) * (n - 1) as f32;
        let i = scaled.floor() as usize;
        let frac = scaled - i as f32;
        let w0 = (frac * std::f32::consts::FRAC_PI_2).cos();
        let w1 = (frac * std::f32::consts::FRAC_PI_2).sin();
        let k = 0.01;   // 平滑系数(≈ setTargetAtTime 0.02)
        for s in 0..n {
            let target = if s == i { w0 } else if s == i + 1 { w1 } else { 0.0 };
            wt.slot_gains[s] += (target - wt.slot_gains[s]) * k;
        }
        // 相位推进 + 槽位混音
        wt.phase += (base_f / sr()) as f64;
        let ph = wt.phase.fract() * WAVE_LEN as f64;
        let i0 = (ph as usize) % WAVE_LEN;
        let i1 = (i0 + 1) % WAVE_LEN;
        let frac2 = (ph - i0 as f64) as f32;
        let mut sum = 0.0;
        for s in 0..n {
            let tab = &self.wt_bank[s];
            let v = tab[i0] * (1.0 - frac2) + tab[i1] * frac2;
            sum += v * wt.slot_gains[s];
        }
        // 滤波器(键位/力度跟踪 + 滤波包络 + 调制 LFO)
        let mut out = if let Some(f) = self.filter.as_mut() {
            let mut cutoff = cutoff_eff(p, self.midi, self.vel);
            if let Some(fe) = self.filter_env.as_mut() {
                cutoff += fe.next(dt);
            }
            f.update(cutoff + lfo_cut * cutoff * 0.8, p.resonance_q);
            f.next(sum)
        } else { sum };
        // 副振荡器
        if self.sub_level > 0.0 {
            self.sub_phase += (self.freq / 2.0 / sr()) as f64;
            out += (self.sub_phase * std::f32::consts::TAU as f64).sin() as f32 * self.sub_level * 0.6;
        }
        out
    }

    pub fn set_bend(&mut self, cents: f32) {
        // 弯音由引擎在渲染时叠加(p.bend_cents),无需逐音状态
        let _ = cents;
    }
}

/// 引擎级工具:由槽位名构建波表组(槽位为内置波形名;preset: 前缀按 TS 现状回退正弦)
/// 粒子合成状态:波形表粒子流(粒子采样器)
/// 粒子源 = 当前波形表(wt_bank[0]);粒子按密度触发,带随机相位/音高散布,
/// 每个粒子用 Hann 窗包络,输出叠加 → 颗粒感/云状音色。
pub struct GrainState {
    /// 距下一个粒子触发的采样计数
    next_in: f32,
    /// 活跃粒子槽(8 个同时上限)
    pub grains: Vec<Grain>,
    /// 粒子尺寸(采样数,由 grain_size_ms 换算)
    pub size: f32,
    /// 粒子密度(个/秒)
    pub density: f32,
    /// 音高散布(音分)
    pub spread_cents: f32,
    /// 随机量(相位/位置)0-1
    pub random: f32,
}
pub struct Grain {
    /// 粒子内采样进度(0..size)
    pub pos: f32,
    /// 粒子时长(采样)
    pub size: f32,
    /// 波形表相位(累积,带音高散布)
    pub phase: f64,
    /// 相位步进(基频 × (1 + 散布偏移)/ sr)
    pub inc: f64,
}

/// 滤波类型 → Biquad kind(0=低通 1=高通 2=峰值 3=带通 4=带阻)
fn filter_kind_id(k: &str) -> u8 {
    match k {
        "highpass" => 1,
        "bandpass" => 3,
        "notch" => 4,
        _ => 0,
    }
}

pub fn build_wt_bank(slots: &[String], harmonics: usize, custom_table: Option<&Vec<f32>>) -> Vec<Vec<f32>> {
    let mut bank = Vec::with_capacity(slots.len().max(2));
    for slot in slots {
        if slot == "custom" {
            bank.push(custom_table.cloned().unwrap_or_else(|| build_wavetable("sine", harmonics)));
        } else if slot.starts_with("preset:") {
            bank.push(build_wavetable("sine", harmonics));   // 与 TS 现状一致(resolver 未注入)
        } else {
            bank.push(build_wavetable(slot, harmonics));
        }
    }
    while bank.len() < 2 { bank.push(build_wavetable("sine", harmonics)); }
    bank
}

/// 自定义波形:锚点 → 2048 采样(与 TS setCustomWave 一致)
pub fn custom_table_from_anchors(anchors: &[(f32, f32)]) -> Vec<f32> {
    (0..WAVE_LEN).map(|i| interp_anchors(anchors, i as f32 / WAVE_LEN as f32)).collect()
}

#[cfg(test)]
mod mod_pan_tests {
    use super::*;
    #[test]
    fn pan_mod_swings_lr() {
        // 调制目标=声像:左右通道能量应周期性交替(半周期内 L 大 R 小,另一半反之)
        let mut p = EngineParams::default();
        p.wave_type = "saw".into();
        p.cutoff_hz = 3000.0;
        p.mod_lfo_target = "pan".into();
        p.mod_lfo_depth = 1.0;
        p.mod_lfo_rate = 4.0;
        let mut e = super::super::engine::SynthEngine::new(p);
        e.note_on(60, 1.0, 0.0);
        let n = 22050usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        e.render_block(&mut l, &mut r, n, 0.0);
        // 前半段 vs 后半段(4Hz LFO → 250ms 半周期;0.5s 内应有摆向变化)
        let el1: f32 = l[0..n / 4].iter().map(|x| x * x).sum();
        let er1: f32 = r[0..n / 4].iter().map(|x| x * x).sum();
        let el2: f32 = l[n * 3 / 8..n / 2].iter().map(|x| x * x).sum();
        let er2: f32 = r[n * 3 / 8..n / 2].iter().map(|x| x * x).sum();
        println!("pan test: L1={el1:.2} R1={er1:.2} L2={el2:.2} R2={er2:.2}");
        // 两个窗口的左右差应反向(声像在摆)
        let d1 = el1 - er1;
        let d2 = el2 - er2;
        assert!(d1.abs() > 0.01 && d2.abs() > 0.01, "声像应摆动: d1={d1} d2={d2}");
        assert!(d1 * d2 < 0.0, "两个窗口左右差应反向: d1={d1} d2={d2}");
    }
}
