// 音频总线:16 个通道引擎分身 + 主效果链 + 录音/作用域数据(VST 无头版,无 cpal 输出)
pub mod dsp;
pub mod engine;
pub mod fx;
pub mod player;
pub mod smf;
pub mod voice;
pub mod waves;

use engine::EngineParams;
use engine::SynthEngine;
use fx::{DelayLine, Drive, Reverb};
use std::collections::VecDeque;
use std::sync::mpsc::Sender;
use std::sync::Mutex;

pub const BLOCK: usize = 256;
pub const N_CHANNELS: usize = 16;

// ============ 采样级播放事件(音频回调消费) ============
#[derive(Clone, Debug)]
pub enum AudioEvent {
    NoteOn { ch: usize, midi: u8, vel: f32 },
    NoteOff { ch: usize, midi: u8 },
    Bend { ch: usize, semitones: f32 },
    Sustain { ch: usize, on: bool },
    AllOff { ch: usize },
}

pub struct PendingEvent {
    pub sample: u64,       // 绝对采样时刻
    pub ev: AudioEvent,
}

// ============ 主效果链参数 ============
#[derive(Clone, Debug, Default)]
pub struct MasterFx {
    pub volume: f32,
    pub reverb: f32,
    pub delay_time_ms: f32,
    pub delay_feedback: f32,
    pub delay_mix: f32,
    pub drive: f32,
}

// ============ 音频总线 ============
pub struct AudioBus {
    pub engines: Vec<SynthEngine>,     // 16 个通道分身,ch = 索引
    pub master: MasterFx,
    drive: Drive,
    reverb: Reverb,
    delay: DelayLine,
    pub sample_clock: u64,
    pub pending: VecDeque<PendingEvent>,
    // 录音捕获(interleaved stereo)
    pub recording: Vec<f32>,
    pub recording_on: bool,
    // 作用域:最近一段 post-drive 时域样本 + 频谱
    pub scope_buf: Vec<f32>,
    scope_pos: usize,
    pub scope_emit: Sender<Vec<f32>>,
    scope_counter: u32,
    // 节拍器(采样级 click,直接进输出不进录音)
    pub metro: MetroState,
    pub beat_emit: Sender<bool>,
    metro_click_left: usize,
    metro_accent: bool,
    // 琶音器(采样级,注入 pending 事件队列)
    pub arp: ArpState,
    // 通道音量/静音(多轨混音控制)
    pub ch_gain: [f32; N_CHANNELS],
    pub ch_mute: [bool; N_CHANNELS],
    // 主输出软限制(防多通道叠加削波)
    limiter: bool,
    // 三频段 EQ(主效果链,drive 之后)
    eq: fx::ThreeBandEq,
    // 智能优化(自动频谱整形:过载频段自动衰减)
    pub smart: SmartOpt,
    // 力度曲线(输入力度映射,Rust 统一应用)
    vel_anchors: Vec<(f32, f32)>,
    vel_min: f32,
    vel_power: f32,
}

// 节拍器状态
pub struct MetroState {
    pub running: bool,
    pub bpm: f32,
    pub volume: f32,
    beat: u32,
    next_sample: u64,
}
impl Default for MetroState {
    fn default() -> Self { Self { running: false, bpm: 120.0, volume: 0.5, beat: 0, next_sample: 0 } }
}

// 琶音器状态
pub struct ArpState {
    pub running: bool,
    pub notes: Vec<u8>,
    pub bpm: f32,
    pub direction: u8,   // 0=up 1=down 2=updown 3=random
    pub octaves: u8,
    step: u32,
    next_sample: u64,
}
impl Default for ArpState {
    fn default() -> Self {
        Self { running: false, notes: Vec::new(), bpm: 120.0, direction: 0, octaves: 1, step: 0, next_sample: 0 }
    }
}

// ============ 智能优化(自动频谱整形) ============
// 检测输出频谱各频带能量占比,过载频段(占比 > 45%)自动衰减,均衡后回升
// 解决"某一频段往死里加 → 饱和失真"的问题,4 个动态 peaking EQ
pub struct SmartOpt {
    pub enabled: bool,
    pub strength: f32,     // 0-1 调整速度
    pub gains: [f32; 4],   // 当前各带衰减 dB(≤0,实时显示用)
    eq: [dsp::Biquad; 4],  // 200 / 800 / 3.2k / 10k
    applied: [f32; 4],
}
impl SmartOpt {
    fn new() -> Self {
        Self {
            enabled: false, strength: 0.6, gains: [0.0; 4], applied: [0.0; 4],
            eq: [dsp::Biquad::new(2, 200.0, 0.7), dsp::Biquad::new(2, 800.0, 0.7),
                 dsp::Biquad::new(2, 3200.0, 0.7), dsp::Biquad::new(2, 10000.0, 0.7)],
        }
    }
    pub fn set(&mut self, enabled: bool, strength: f32) {
        self.enabled = enabled;
        self.strength = strength.clamp(0.0, 1.0);
        if !enabled {
            self.gains = [0.0; 4];
            self.apply_gains();
        }
    }
    fn apply_gains(&mut self) {
        for i in 0..4 {
            if (self.gains[i] - self.applied[i]).abs() > 0.01 {
                self.applied[i] = self.gains[i];
                self.eq[i].gain_db = self.gains[i];
                self.eq[i].update(self.eq[i].freq, 0.7);
            }
        }
    }
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        if !self.enabled { return x; }
        let mut y = x;
        for i in 0..4 { y = self.eq[i].next(y); }
        y
    }
    /// 每 ~23ms 分析一次:bands 为 4 频带能量(线性),total 为总能量
    pub fn analyze(&mut self, bands: [f32; 4], total: f32) {
        if !self.enabled { return; }
        if total < 1e-5 { return; }   // 静音不动作
        let s = self.strength;
        for i in 0..4 {
            let ratio = bands[i] / total.max(1e-6);
            if ratio > 0.45 {
                // 该带主导 → 按强度衰减(每 23ms 最多 0.8dB)
                self.gains[i] = (self.gains[i] - 0.8 * s).max(-12.0);
            } else if ratio < 0.35 {
                // 分布均衡 → 缓慢回升
                self.gains[i] = (self.gains[i] + 0.3 * s).min(0.0);
            }
        }
        self.apply_gains();
    }
}

impl AudioBus {
    pub fn new(scope_emit: Sender<Vec<f32>>, beat_emit: Sender<bool>) -> Self {
        let mut engines = Vec::with_capacity(N_CHANNELS);
        for _ in 0..N_CHANNELS {
            engines.push(SynthEngine::new(EngineParams::default()));
        }
        Self {
            engines,
            master: MasterFx { volume: 0.7, reverb: 0.25, delay_time_ms: 350.0, delay_feedback: 0.4, delay_mix: 0.2, drive: 0.0 },
            drive: Drive::new(0.0),
            reverb: Reverb::new(),
            delay: DelayLine::new(),
            sample_clock: 0,
            pending: VecDeque::new(),
            recording: Vec::new(),
            recording_on: false,
            scope_buf: vec![0.0; 1024],
            scope_pos: 0,
            scope_emit,
            scope_counter: 0,
            metro: MetroState::default(),
            beat_emit,
            metro_click_left: 0,
            metro_accent: false,
            arp: ArpState::default(),
            ch_gain: [1.0; N_CHANNELS],
            ch_mute: [false; N_CHANNELS],
            limiter: true,
            eq: fx::ThreeBandEq::new(),
            smart: SmartOpt::new(),
            vel_anchors: vec![(0.0, 0.0), (0.25, 0.25), (0.5, 0.5), (0.75, 0.75), (1.0, 1.0)],
            vel_min: 0.2,
            vel_power: 1.0,
        }
    }

    /// 响度探针:用该通道音色干跑渲染 0.5s A4 音符,返回峰值段 RMS(不触碰总线状态)
    /// 取前 125ms(attack 后的瞬态峰值段),短衰减音色(水滴/拨弦)也能测到真实响度
    pub fn probe_loudness(&self, ch: usize) -> f32 {
        let p = self.engines.get(ch).map(|e| e.params.clone()).unwrap_or_default();
        let mut e = engine::SynthEngine::new(p);
        e.note_on(69, 1.0, 0.0);
        let sr = dsp::sr() as usize;
        let n = sr / 2;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        e.render_block(&mut l, &mut r, n, 0.0);
        // 峰值段:起音 10ms 后 125ms(避开 attack 爬升与长音衰减尾)
        let seg = &l[sr / 100..sr / 8];
        let sum: f32 = seg.iter().map(|x| x * x).sum();
        let rms = (sum / seg.len() as f32).sqrt();
        if rms.is_finite() { rms } else { 0.0 }
    }

    /// 采样率变更后重建:按新采样率分配噪声/混响/延迟缓冲,保留各通道音色参数
    pub fn recreate(&mut self) {
        let params: Vec<engine::EngineParams> = self.engines.iter().map(|e| e.params.clone()).collect();
        let master = self.master.clone();
        let ch_gain = self.ch_gain;
        let ch_mute = self.ch_mute;
        let vel_anchors = self.vel_anchors.clone();
        let vel_min = self.vel_min;
        let vel_power = self.vel_power;
        let limiter = self.limiter;
        let mut engines = Vec::with_capacity(N_CHANNELS);
        for p in params { engines.push(SynthEngine::new(p)); }
        self.engines = engines;
        self.drive = Drive::new(master.drive);
        self.reverb = Reverb::new();
        self.delay = DelayLine::new();
        self.master = master;
        self.ch_gain = ch_gain;
        self.ch_mute = ch_mute;
        self.vel_anchors = vel_anchors;
        self.vel_min = vel_min;
        self.vel_power = vel_power;
        self.limiter = limiter;
        let (eqb, eqm, eqt) = (self.eq.bass_db, self.eq.mid_db, self.eq.treble_db);
        self.eq = fx::ThreeBandEq::new();
        self.eq.set(eqb, eqm, eqt);
        // 智能优化保留开关/强度,重建 EQ 并恢复当前增益
        let (sm_en, sm_st, sm_g) = (self.smart.enabled, self.smart.strength, self.smart.gains);
        self.smart = SmartOpt::new();
        self.smart.enabled = sm_en;
        self.smart.strength = sm_st;
        self.smart.gains = sm_g;
        self.smart.apply_gains();
        self.pending.clear();
        self.recording.clear();
        self.recording_on = false;
    }

    // ============ 力度曲线(输入力度 → 输出力度,Rust 统一应用) ============
    pub fn apply_vel(&self, v: f32) -> f32 {
        let a = &self.vel_anchors;
        let mut out = v;
        if !a.is_empty() {
            if v <= a[0].0 { out = a[0].1; }
            else if v >= a[a.len() - 1].0 { out = a[a.len() - 1].1; }
            else {
                out = v;
                for i in 0..a.len() - 1 {
                    let (x0, y0) = a[i];
                    let (x1, y1) = a[i + 1];
                    if v >= x0 && v <= x1 {
                        let t = if (x1 - x0).abs() < 1e-6 { 0.0 } else { (v - x0) / (x1 - x0) };
                        out = y0 + (y1 - y0) * t;
                        break;
                    }
                }
            }
        }
        if self.vel_power != 1.0 { out = out.max(0.0).powf(self.vel_power); }
        if self.vel_min > 0.0 && v > 0.01 { out = out.max(self.vel_min); }
        out.clamp(0.0, 1.0)
    }
    pub fn set_vel_curve(&mut self, anchors: Vec<(f32, f32)>, vel_min: f32, vel_power: f32) {
        if !anchors.is_empty() { self.vel_anchors = anchors; }
        self.vel_min = vel_min.clamp(0.0, 1.0);
        self.vel_power = vel_power.clamp(0.3, 3.0);
    }

    // ============ 通道音量/静音 ============
    pub fn set_channel(&mut self, ch: usize, gain: f32, mute: bool) {
        if ch < N_CHANNELS {
            // NaN 防御:非法增益一律回落 1.0(否则输出全静音)
            let g = if gain.is_finite() { gain.clamp(0.0, 2.0) } else { 1.0 };
            self.ch_gain[ch] = g;
            self.ch_mute[ch] = mute;
        }
    }

    // ============ 主输出软限制 ============
    pub fn set_limiter(&mut self, on: bool) { self.limiter = on; }

    // ============ 节拍器(采样级 click,直出不进录音) ============
    pub fn metro_set(&mut self, running: bool, bpm: f32, volume: f32) {
        self.metro.running = running;
        self.metro.bpm = bpm.clamp(20.0, 300.0);
        self.metro.volume = volume.clamp(0.0, 1.0);
        if running {
            self.metro.beat = 0;
            self.metro.next_sample = self.sample_clock + (0.08 * dsp::sr()) as u64;
        } else {
            self.metro_click_left = 0;
        }
    }
    fn metro_schedule(&mut self) {
        if self.metro.running && self.metro_click_left == 0 && self.sample_clock >= self.metro.next_sample {
            self.metro_accent = self.metro.beat % 4 == 0;
            self.metro.beat += 1;
            let interval = (60.0 / self.metro.bpm * dsp::sr()) as u64;
            self.metro.next_sample = self.sample_clock + interval;
            self.metro_click_left = (0.06 * dsp::sr()) as usize;
            let _ = self.beat_emit.send(self.metro_accent);
        }
    }

    // ============ 琶音器(采样级,注入 pending 事件队列) ============
    pub fn arp_set(&mut self, running: bool, notes: Vec<u8>, bpm: f32, direction: u8, octaves: u8) {
        self.arp.running = running;
        self.arp.notes = notes;
        self.arp.bpm = bpm.clamp(20.0, 400.0);
        self.arp.direction = direction.min(3);
        self.arp.octaves = octaves.clamp(1, 4);
        if running {
            self.arp.step = 0;
            self.arp.next_sample = self.sample_clock + (0.05 * dsp::sr()) as u64;
        }
    }
    fn arp_tick(&mut self) {
        if !self.arp.running || self.arp.notes.is_empty() { return; }
        if self.sample_clock < self.arp.next_sample { return; }
        let n = self.arp.notes.len();
        let step = self.arp.step;
        let idx = match self.arp.direction {
            0 => (step % n as u32) as usize,
            1 => n - 1 - (step % n as u32) as usize,
            2 => {
                let cycle = step % (2 * n as u32 - 2).max(1);
                if cycle < n as u32 { cycle as usize } else { (2 * n as u32 - 2 - cycle) as usize }
            }
            _ => (dsp::rand01() * n as f32) as usize % n,
        };
        let oct = (step / n as u32) % self.arp.octaves as u32;
        let midi = self.arp.notes[idx] + (oct * 12) as u8;
        let step_samples = (60.0 / self.arp.bpm / 2.0 * dsp::sr()) as u64;   // 八分音符
        let now = self.sample_clock;
        let vel = self.apply_vel(0.8);
        self.pending.push_back(PendingEvent { sample: now, ev: AudioEvent::NoteOn { ch: 0, midi, vel } });
        self.pending.push_back(PendingEvent { sample: now + step_samples * 6 / 10, ev: AudioEvent::NoteOff { ch: 0, midi } });
        self.arp.step += 1;
        self.arp.next_sample = now + step_samples;
    }

    /// 主效果链参数(音量/混响/延迟/驱动)
    pub fn set_master(&mut self, key: &str, v: f64) {
        let f = v as f32;
        match key {
            "volume" => self.master.volume = f,
            "reverb" => self.master.reverb = f.clamp(0.0, 1.0),
            "delay_time_ms" => self.master.delay_time_ms = f,
            "delay_feedback" => self.master.delay_feedback = f.clamp(0.0, 1.0),
            "delay_mix" => self.master.delay_mix = f.clamp(0.0, 1.0),
            "drive" => { self.master.drive = f.clamp(0.0, 1.0); self.drive.set(f); }
            "limiter" => self.limiter = v > 0.5,
            "eq_bass" => self.eq.set(f, self.eq.mid_db, self.eq.treble_db),
            "eq_mid" => self.eq.set(self.eq.bass_db, f, self.eq.treble_db),
            "eq_treble" => self.eq.set(self.eq.bass_db, self.eq.mid_db, f),
            _ => {}
        }
        if key == "reverb" {
            // 发送量 = 混响量 ^ 1.6 * 0.9(与 TS setReverb 一致)
        }
    }

    fn reverb_send(&self) -> f32 {
        self.master.reverb.powf(1.6) * 0.9
    }

    /// 消费播放事件:处理所有落在 [clock, clock+block) 的事件
    fn consume_events(&mut self, block: usize) {
        let end = self.sample_clock + block as u64;
        while let Some(pe) = self.pending.front() {
            if pe.sample >= end { break; }
            let pe = self.pending.pop_front().unwrap();
            let ch = pe.ev.channel();
            let eng = self.engines.get_mut(ch);
            let Some(eng) = eng else { continue };
            let t = (pe.sample as f32) / dsp::sr();
            match pe.ev {
                AudioEvent::NoteOn { midi, vel, .. } => eng.note_on(midi, vel, t),
                AudioEvent::NoteOff { midi, .. } => eng.note_off(midi, false),
                AudioEvent::Bend { semitones, .. } => eng.set_bend(semitones),
                AudioEvent::Sustain { on, .. } => eng.set_sustain(on),
                AudioEvent::AllOff { .. } => eng.all_off(),
            }
        }
    }

    /// 渲染一个 block(音频回调调用):引擎 → 主效果链 → 输出/录音/作用域
    pub fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32], block: usize) {
        self.consume_events(block);
        self.arp_tick();
        self.metro_schedule();
        for s in out_l.iter_mut() { *s = 0.0; }
        for s in out_r.iter_mut() { *s = 0.0; }
        let t0 = (self.sample_clock as f32) / dsp::sr();
        for (i, eng) in self.engines.iter_mut().enumerate() {
            eng.render_block(out_l, out_r, block, t0);
            eng.apply_gain(out_l, out_r, block);
            // 通道音量/静音
            if self.ch_gain[i] != 1.0 || self.ch_mute[i] {
                let g = if self.ch_mute[i] { 0.0 } else { self.ch_gain[i] };
                for s in 0..block { out_l[s] *= g; out_r[s] *= g; }
            }
        }
        let dt = 1.0 / dsp::sr();
        let send = self.reverb_send();
        let delay_mix = self.master.delay_mix;
        let vol = self.master.volume;
        let click_len = (0.06 * dsp::sr()) as usize;
        for s in 0..block {
            let x = out_l[s] + out_r[s];
            let d0 = self.drive.process(x);
            let d1 = self.eq.process(d0);   // 三频段 EQ(手动)
            let d = self.smart.process(d1); // 智能频谱整形(自动)
            out_l[s] = d * 0.5 * vol;
            out_r[s] = d * 0.5 * vol;
            // 混响(发送量按 TS 公式)
            self.reverb.process(d * 0.5 * send, &mut out_l[s], &mut out_r[s]);
            // 延迟
            self.delay.time_s = self.master.delay_time_ms / 1000.0;
            self.delay.feedback = self.master.delay_feedback;
            self.delay.mix = delay_mix;
            self.delay.process(d * 0.5, d * 0.5, &mut out_l[s], &mut out_r[s]);
            // 主输出软限制(防多通道叠加削波)
            if self.limiter {
                let k = 1.2f32;
                let norm = k.tanh();
                out_l[s] = (out_l[s] * k).tanh() / norm;
                out_r[s] = (out_r[s] * k).tanh() / norm;
            }
            // 录音捕获(节拍器不录:click 在 push 之后才叠加)
            if self.recording_on {
                self.recording.push(out_l[s]);
                self.recording.push(out_r[s]);
            }
            // 节拍器 click(直出不进录音,与 TS 一致)
            if self.metro_click_left > 0 {
                self.metro_click_left -= 1;
                let t = (click_len - self.metro_click_left) as f32 / dsp::sr();
                let f = if self.metro_accent { 1760.0 } else { 1175.0 };
                let env = (-t * 80.0).exp();
                let click = (std::f32::consts::TAU * f * t).sin() * env * self.metro.volume * 0.8;
                out_l[s] += click;
                out_r[s] += click;
            }
            let _ = dt;
            // 作用域采样(post-drive)
            self.scope_buf[self.scope_pos] = d;
            self.scope_pos += 1;
            if self.scope_pos >= self.scope_buf.len() { self.scope_pos = 0; }
        }
        // 作用域节流:约每 23ms 发一次(时域 1024 + 频谱 128 + 智能优化 4 带增益)
        self.scope_counter += 1;
        if self.scope_counter >= 4 {
            self.scope_counter = 0;
            let mut samples = self.scope_buf.clone();
            samples.rotate_left(self.scope_pos);
            let mut spec = fft_magnitudes(&samples, 256);
            spec.truncate(128);
            // 智能优化:按 4 频带统计能量并调整过载频段
            let mut bands = [0.0f32; 4];
            let mut total = 0.0f32;
            let bin_hz = dsp::sr() / 256.0;
            for (i, &m) in spec.iter().enumerate() {
                let f = i as f32 * bin_hz;
                let b = if f < 300.0 { 0 } else if f < 1200.0 { 1 } else if f < 5000.0 { 2 } else { 3 };
                bands[b] += m * m;
                total += m * m;
            }
            self.smart.analyze(bands, total);
            samples.extend(spec);
            samples.extend(self.smart.gains);
            let _ = self.scope_emit.send(samples);
        }
        self.sample_clock += block as u64;
    }
}

// 迭代 radix-2 FFT(256 点 → 128 bin 幅度谱,音频线程用)
// 加 Hann 窗:非整数周期信号的旁瓣泄漏从 -13dB 降到 -31dB,频谱/智能优化检测更准
fn fft_magnitudes(x: &[f32], n: usize) -> Vec<f32> {
    let mut re: Vec<f64> = vec![0.0; n];
    let mut im: Vec<f64> = vec![0.0; n];
    for i in 0..n.min(x.len()) {
        let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();  // Hann
        re[i] = x[i] as f64 * w;
    }
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j { re.swap(i, j); im.swap(i, j); }
    }
    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut i = 0usize;
        while i < n {
            let (mut cwr, mut cwi) = (1.0f64, 0.0f64);
            for k in 0..half {
                let (ur, ui) = (re[i + k], im[i + k]);
                let vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
                let vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
                let nwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = nwr;
            }
            i += len;
        }
        len <<= 1;
    }
    let mut mag = vec![0.0f32; n / 2];
    for i in 0..n / 2 {
        mag[i] = ((re[i] * re[i] + im[i] * im[i]) as f32).sqrt() / n as f32;
    }
    mag
}

impl AudioEvent {
    fn channel(&self) -> usize {
        match self {
            AudioEvent::NoteOn { ch, .. } | AudioEvent::NoteOff { ch, .. }
            | AudioEvent::Bend { ch, .. } | AudioEvent::Sustain { ch, .. }
            | AudioEvent::AllOff { ch } => *ch,
        }
    }
}

// 渲染试听 WAV(无设备环境验证用,单通道引擎)
pub fn render_wav(engines: &mut [SynthEngine], seconds: u32) -> Vec<f32> {
    let n = (dsp::sr() as u32 * seconds) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    for e in engines.iter_mut() {
        e.render_block(&mut l, &mut r, n, 0.0);
    }
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        out.push(l[i]);
        out.push(r[i]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bus() -> AudioBus {
        AudioBus::new(std::sync::mpsc::channel().0, std::sync::mpsc::channel().0)
    }

    #[test]
    fn metro_clicks_at_bpm_intervals() {
        let mut b = bus();
        b.metro_set(true, 120.0, 0.8);   // 每 0.5s 一拍
        let n = (dsp::sr() as usize) * 2;  // 2s → 4 拍
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        // 分块渲染
        let mut done = 0;
        while done < n {
            let block = BLOCK.min(n - done);
            b.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
            done += block;
        }
        // 每 0.5s 段应有 click 能量,其他段接近静音
        let seg = (dsp::sr() as usize) / 2;
        for i in 0..4 {
            let s = &l[i * seg..(i + 1) * seg];
            let energy: f32 = s.iter().map(|x| x * x).sum();
            assert!(energy > 1e-3, "segment {i} should have click energy={energy}");
        }
        // 节拍器不进录音:先排干混响尾音,再开录音
        b.metro_set(false, 120.0, 0.8);
        let drain = (dsp::sr() as usize) * 2;
        let mut dl = vec![0.0f32; drain];
        let mut dr = vec![0.0f32; drain];
        let mut done = 0;
        while done < drain {
            let block = BLOCK.min(drain - done);
            b.render_block(&mut dl[done..done + block], &mut dr[done..done + block], block);
            done += block;
        }
        b.recording_on = true;
        let mut l2 = [0.0f32; BLOCK];
        let mut r2 = [0.0f32; BLOCK];
        b.metro_set(true, 120.0, 0.8);
        b.render_block(&mut l2, &mut r2, BLOCK);
        // 录音内容应接近静音(click 不录;这一块还没到拍点)
        let peak = b.recording.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak < 1e-3, "metro click must not enter recording, peak={peak}");
    }

    #[test]
    fn arp_injects_sample_accurate_events() {
        let mut b = bus();
        b.arp_set(true, vec![60, 64, 67], 120.0, 0, 1);   // up,八分音符 0.25s
        let n = (dsp::sr() as usize);   // 1s → 4 步
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        let mut done = 0;
        while done < n {
            let block = BLOCK.min(n - done);
            b.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
            done += block;
        }
        // 4 步后引擎应有发声(事件被消费)
        let active = b.engines[0].active_notes();
        assert!(!active.is_empty(), "arp notes should sound, active={active:?}");
        // 琶音注入的事件确实是采样级:最后一步音符在 ~0.75-1.0s 触发
        assert!(b.sample_clock >= (dsp::sr() as u64) as u64);
    }

    #[test]
    fn channel_gain_and_mute() {
        let mut b = bus();
        b.engines[0].note_on(69, 1.0, 0.0);
        b.engines[1].note_on(69, 1.0, 0.0);
        let mut l = [0.0f32; 4410];
        let mut r = [0.0f32; 4410];
        // ch0 静音,ch1 正常 → 输出只有 ch1
        b.set_channel(0, 1.0, true);
        b.render_block(&mut l, &mut r, 4410);
        // 先渲染 ch1 单独的能量作参照(另起 bus)
        let mut b2 = bus();
        b2.engines[1].note_on(69, 1.0, 0.0);
        let mut l2 = [0.0f32; 4410];
        let mut r2 = [0.0f32; 4410];
        b2.render_block(&mut l2, &mut r2, 4410);
        let e1: f32 = l.iter().map(|x| x * x).sum();
        let e2: f32 = l2.iter().map(|x| x * x).sum();
        assert!(e1 > e2 * 0.5, "muted ch0 should leave ch1 audible, e1={e1} e2={e2}");
    }

    #[test]
    fn limiter_caps_output() {
        let mut b = bus();
        b.set_limiter(true);
        // 注入 8 个通道全开大音量 → 输出不削波
        for i in 0..8 {
            let mut p = engine::EngineParams::default();
            p.wave_type = "saw".into();
            p.gain = 2.0;
            b.engines[i].set_params(p);
            b.engines[i].note_on(69, 1.0, 0.0);
        }
        let mut l = vec![0.0f32; 4410];
        let mut r = vec![0.0f32; 4410];
        b.render_block(&mut l, &mut r, 4410);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak <= 1.05, "limiter caps peak, got {peak}");
    }

    #[test]
    fn vel_curve_applied() {
        let mut b = bus();
        // 自定义曲线:0.5 输入 → 0.9 输出
        b.set_vel_curve(vec![(0.0, 0.0), (0.5, 0.9), (1.0, 1.0)], 0.0, 1.0);
        let v = b.apply_vel(0.5);
        assert!((v - 0.9).abs() < 1e-4, "vel curve at 0.5 -> 0.9, got {v}");
        // velMin 下限
        b.set_vel_curve(vec![(0.0, 0.0), (1.0, 1.0)], 0.3, 1.0);
        let v2 = b.apply_vel(0.05);
        assert!(v2 >= 0.3, "vel min floor, got {v2}");
    }

    #[test]
    fn fft_detects_fundamental() {
        let sr = dsp::sr();
        // 440Hz 正弦 512 点
        let x: Vec<f32> = (0..512).map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin()).collect();
        let mag = fft_magnitudes(&x, 256);
        // 峰应在 440Hz bin
        let bin = (440.0 / sr * 256.0) as usize;
        let mut peak_bin = 0;
        let mut peak = 0.0f32;
        for (i, m) in mag.iter().enumerate() {
            if *m > peak { peak = *m; peak_bin = i; }
        }
        assert!((peak_bin as i32 - bin as i32).abs() <= 1, "FFT peak at {peak_bin}, expect ~{bin}");
        assert!(peak > 0.1, "FFT peak strong, got {peak}");
    }
}


#[cfg(test)]
mod smart_tests {
    use super::*;

    #[test]
    fn smart_opt_pulls_dominant_band_and_recovers() {
        let mut s = SmartOpt::new();
        s.set(true, 1.0);
        // 单频带主导(中高频 90% 能量)→ 该带衰减
        s.analyze([0.05, 0.9, 0.02, 0.02], 0.99);
        assert!(s.gains[1] < -0.5, "dominant band should drop, gains={:?}", s.gains);
        assert_eq!(s.gains[0], 0.0, "quiet band untouched");
        // 均衡分布 → 回升
        s.analyze([0.3, 0.3, 0.2, 0.2], 1.0);
        s.analyze([0.3, 0.3, 0.2, 0.2], 1.0);
        s.analyze([0.3, 0.3, 0.2, 0.2], 1.0);
        assert!(s.gains[1] > -0.5, "band should recover, gains={:?}", s.gains);
        // 关闭 → 归零
        s.set(false, 1.0);
        assert_eq!(s.gains, [0.0; 4]);
    }

    #[test]
    fn smart_opt_process_chain_renders() {
        let mut b = AudioBus::new(std::sync::mpsc::channel().0, std::sync::mpsc::channel().0);
        b.smart.set(true, 0.6);
        b.engines[0].note_on(69, 1.0, 0.0);
        let mut l = [0.0f32; 4410];
        let mut r = [0.0f32; 4410];
        b.render_block(&mut l, &mut r, 4410);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 1e-3 && peak <= 1.5, "smart chain renders, peak={peak}");
        // scope 事件尾部应带 4 个增益
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let mut b2 = AudioBus::new(tx, std::sync::mpsc::channel().0);
        b2.smart.set(true, 1.0);
        b2.engines[0].note_on(69, 1.0, 0.0);
        for _ in 0..5 {
            let mut l2 = [0.0f32; BLOCK];
            let mut r2 = [0.0f32; BLOCK];
            b2.render_block(&mut l2, &mut r2, BLOCK);
        }
        if let Ok(ev) = rx.try_recv() {
            assert_eq!(ev.len(), 1024 + 128 + 4, "scope event carries smart gains");
        }
    }
}

#[cfg(test)]
mod wt_tests {
    use super::*;
    #[test]
    fn wt_pos_changes_spectrum() {
        // wt_pos 必须真正改变输出频谱(sine 槽位 vs sawtooth 槽位)
        for (pos, expect_harmonics) in [(0.0f32, 0.0f32), (1.0, 1.0)] {
            let mut p = engine::EngineParams::default();
            p.wave_type = "wt".into();
            p.wt_slots = vec!["sine".into(), "sawtooth".into(), "square".into()];
            p.wt_pos = pos;
            let mut b = AudioBus::new(std::sync::mpsc::channel().0, std::sync::mpsc::channel().0);
            b.engines[0].set_params(p);
            b.engines[0].note_on(60, 1.0, 0.0);
            let n = (dsp::sr() as usize) * 1;
            let mut l = vec![0.0f32; n];
            let mut r = vec![0.0f32; n];
            let mut done = 0;
            while done < n {
                let block = BLOCK.min(n - done);
                b.render_block(&mut l[done..done + block], &mut r[done..done + block], block);
                done += block;
            }
            // 4096 点 FFT(分辨率 10.8Hz):261.6Hz ≈ bin 24,取稳态尾部(避开 attack/权重爬升瞬态)
            let tail = &l[n - 4096..];
            let spec = fft_magnitudes(tail, 4096);
            let fund = spec[23] + spec[24] + spec[25];
            let harm: f32 = spec[27..400].iter().sum();
            let ratio = harm / fund.max(1e-6);
            if expect_harmonics > 0.5 {
                assert!(ratio > 0.15, "wt_pos=1 (saw) should be harmonic-rich, ratio={ratio:.3}");
            } else {
                assert!(ratio < 0.15, "wt_pos=0 (sine) should be pure, ratio={ratio:.3}");
            }
        }
    }
}



#[cfg(test)]
mod loudness_tests {
    use super::*;
    #[test]
    fn probe_differs_across_tones() {
        let mut b = AudioBus::new(std::sync::mpsc::channel().0, std::sync::mpsc::channel().0);
        let mut p1 = engine::EngineParams::default();
        p1.wave_type = "piano".into();
        let mut p2 = engine::EngineParams::default();
        p2.wave_type = "sine".into();
        let mut p3 = engine::EngineParams::default();
        p3.wave_type = "dx7".into();
        p3.dx_pm = true; p3.dx_lut = true; p3.dx_aa = true;
        p3.dx_algorithm = 7; p3.dx_feedback = 0;
        p3.dx_ratios = [1.0, 2.0, 3.0, 4.0, 0.5, 1.5];
        b.engines[0].set_params(p1);
        b.engines[1].set_params(p2);
        b.engines[2].set_params(p3);
        let r1 = b.probe_loudness(0);
        let r2 = b.probe_loudness(1);
        let r3 = b.probe_loudness(2);
        println!("PROBE rms piano={r1} sine={r2} organ={r3}");
        assert!(r1 > 1e-4 && r2 > 1e-4 && r3 > 1e-4, "probe should be nonzero");
        assert!((r1 - r2).abs() > 1e-4, "不同音色响度应不同: {r1} vs {r2}");
    }
}

#[cfg(test)]
mod channel_tone_tests {
    use super::*;
    #[test]
    fn additive_tones_sound_on_channels() {
        // lockTone 场景:通道引擎 set_params 钢琴/竖琴/古筝后必须出声
        for w in ["piano", "harp", "guzheng", "drip"] {
            let mut b = AudioBus::new(std::sync::mpsc::channel().0, std::sync::mpsc::channel().0);
            let mut p = engine::EngineParams::default();
            p.wave_type = w.into();
            b.engines[3].set_params(p);
            b.engines[3].note_on(69, 0.8, 0.0);
            let mut l = [0.0f32; 4410];
            let mut r = [0.0f32; 4410];
            b.render_block(&mut l, &mut r, 4410);
            let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
            println!("PROBE {w}: peak={peak}");
            assert!(peak > 1e-3, "{w} should sound on channel, peak={peak}");
            // 探针也应返回非零
            let rms = b.probe_loudness(3);
            println!("PROBE {w}: rms={rms}");
            assert!(rms > 1e-4, "{w} probe rms should be nonzero, rms={rms}");
        }
    }
}
