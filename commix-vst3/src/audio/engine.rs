// 单通道合成引擎(引擎分身):音色参数 + 复音管理 + 逐样本渲染
// 与 TS SynthEngine 各音色参数 1:1 对应;每个 MIDI 通道一个实例,共享主效果链
use super::dsp::sr;
use super::voice::{build_wt_bank, custom_table_from_anchors, Voice};
use serde::Deserialize;

pub const MAX_VOICES: usize = 32;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineParams {
    pub wave_type: String,
    pub osc_wave: String,
    pub osc_count: u8,
    pub detune_cents: f32,
    pub filter_kind: String,
    pub cutoff_hz: f32,
    pub resonance_q: f32,
    pub cutoff_env_hz: f32,
    pub cutoff_env_ms: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub volume: f32,
    pub harmonics: u16,
    pub mono_mode: bool,
    pub pan: f32,
    pub vibrato_rate: f32,
    pub vibrato_depth: f32,
    pub piano_decay_scale: f32,
    pub piano_detune_cents: f32,
    pub piano_noise_level: f32,
    pub piano_bright: f32,
    pub drip_ratio: f32,
    pub drip_time_ms: f32,
    pub drip_decay_ms: f32,
    pub wt_pos: f32,
    pub wt_lfo_rate: f32,
    pub wt_lfo_depth: f32,
    pub wt_slots: Vec<String>,
    pub portamento_ms: f32,
    pub filter_env_hz: f32,
    pub filter_env_a: f32,
    pub filter_env_d: f32,
    pub filter_env_s: f32,
    pub filter_env_r: f32,
    pub mod_lfo_rate: f32,
    pub mod_lfo_depth: f32,
    pub mod_lfo_wave: String,
    pub mod_lfo_target: String,
    pub key_track: f32,
    pub vel_track: f32,
    pub sub_level: f32,
    pub sub_wave: String,
    pub bend_cents: f32,   // 引擎级弯音(音分),渲染时叠加
    // 增益与随机扰动(NoteOn 一次性施加,模拟硬件不稳定)
    pub gain: f32,         // 输出增益 0-2
    pub note_jitter: f32,  // NoteOn 随机扰动 0-1(初始相位/失谐/电平微偏)
    // DX7 硬件模拟(轻量路线:PM 相位调制 + 4096 正弦表 + 定点截断 + 仅 OP6 反馈)
    pub dx_pm: bool,       // 切换为 PM 相位调制(默认 false=标准 FM)
    pub dx_lut: bool,      // 4096 正弦查表替代浮点 sin
    pub dx_quant: bool,    // 16bit 定点截断模拟
    pub dx_dac: bool,      // 12bit DAC 输出量化
    pub dx_bits: u8,       // DAC 量化位数 8/12/16
    pub dx_aa: bool,       // 抗混叠平滑(true=低通软化;false=允许混叠,默认)
    pub dx_algorithm: u8,  // 1=六级串联堆栈 32=六载波并行
    pub dx_feedback: u8,   // OP6 反馈档 0-7(DX 非线性曲线,仅 OP6 生效)
    pub dx_ratios: [f32; 6],  // 算子频率比(OP1..OP6)
    pub dx_tls: [f32; 6],     // 算子总电平 TL 0-99
    pub dx_dets: [f32; 6],    // 算子失谐 0-7
    pub dx_egs: Vec<f32>,     // 每算子 4R4L EG:r1 l1 r2 l2 r3 l3 r4 l4(0-99),48 个
}

impl Default for EngineParams {
    fn default() -> Self {
        Self {
            wave_type: "sine".into(), osc_wave: "sawtooth".into(),
            osc_count: 2, detune_cents: 6.0, filter_kind: "lowpass".into(),
            cutoff_hz: 2000.0, resonance_q: 0.7, cutoff_env_hz: 0.0, cutoff_env_ms: 90.0,
            attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.3,
            volume: 0.7, harmonics: 32, mono_mode: false, pan: 0.0,
            vibrato_rate: 3.0, vibrato_depth: 0.0,
            piano_decay_scale: 1.0, piano_detune_cents: 4.0, piano_noise_level: 0.3, piano_bright: 1.0,
            drip_ratio: 4.0, drip_time_ms: 150.0, drip_decay_ms: 300.0,
            wt_pos: 0.3, wt_lfo_rate: 0.0, wt_lfo_depth: 0.0, wt_slots: vec![],
            portamento_ms: 0.0,
            filter_env_hz: 800.0, filter_env_a: 0.01, filter_env_d: 0.3,
            filter_env_s: 0.5, filter_env_r: 0.3,
            mod_lfo_rate: 4.0, mod_lfo_depth: 0.0, mod_lfo_wave: "sine".into(), mod_lfo_target: "off".into(),
            key_track: 0.3, vel_track: 0.3,
            sub_level: 0.0, sub_wave: "sine".into(),
            bend_cents: 0.0,
            gain: 1.0, note_jitter: 0.0,
            dx_pm: false, dx_lut: false, dx_quant: false, dx_dac: false, dx_aa: false,
            dx_bits: 12,
            dx_algorithm: 1, dx_feedback: 5,
            dx_ratios: [1.0, 2.73, 1.41, 3.0, 2.01, 1.0],
            dx_tls: [82.0, 52.0, 56.0, 64.0, 68.0, 72.0],
            dx_dets: [0.0; 6],
            dx_egs: vec![99.0; 48],   // 默认全速全电平,用户/前端预设覆盖
        }
    }
}

pub struct SynthEngine {
    pub params: EngineParams,
    pub voices: Vec<Voice>,
    voice_order: Vec<usize>,
    pub sustain_pedal: bool,
    pub bend_cents: f32,
    noise: Vec<f32>,           // 锤击噪声缓冲(60ms)
    pub wt_bank: Vec<Vec<f32>>, // 波表缓存(槽位或主波形)
    pub custom_table: Vec<f32>,
    pub custom_dirty: bool,
}

impl SynthEngine {
    pub fn new(params: EngineParams) -> Self {
        let mut noise = vec![0.0; (0.06 * sr()) as usize];
        for n in noise.iter_mut() { *n = super::dsp::rand01() * 2.0 - 1.0; }
        let wt_bank = build_wt_bank(&params.wt_slots, params.harmonics as usize, None);
        Self {
            params,
            voices: Vec::new(),
            voice_order: Vec::new(),
            sustain_pedal: false,
            bend_cents: 0.0,
            noise,
            wt_bank,
            custom_table: Vec::new(),
            custom_dirty: true,
        }
    }

    /// 更换音色参数(整组灌入,预设/程序变更用)
    pub fn set_params(&mut self, p: EngineParams) {
        self.params = p;
        self.rebuild_tables();
    }

    /// 更新单个参数(滑块实时)
    pub fn set_param(&mut self, key: &str, v: f64) {
        {
            let p = &mut self.params;
            let f = v as f32;
            match key {
                "volume" => p.volume = f,
                "attack" => p.attack = f,
                "decay" => p.decay = f,
                "sustain" => p.sustain = f,
                "release" => p.release = f,
                "harmonics" => p.harmonics = v.clamp(1.0, 32.0) as u16,
                "osc_count" => p.osc_count = v.clamp(1.0, 8.0) as u8,
                "detune_cents" => p.detune_cents = f,
            "filter_kind" => if v < 0.5 { p.filter_kind = "lowpass".into() } else { p.filter_kind = "highpass".into() },
            "cutoff_hz" => p.cutoff_hz = f,
            "resonance_q" => p.resonance_q = f,
            "cutoff_env_hz" => p.cutoff_env_hz = f,
            "cutoff_env_ms" => p.cutoff_env_ms = f,
            "mono_mode" => p.mono_mode = v > 0.5,
            "pan" => p.pan = f.clamp(-1.0, 1.0),
            "vibrato_rate" => p.vibrato_rate = f,
            "vibrato_depth" => p.vibrato_depth = f,
            "piano_decay_scale" => p.piano_decay_scale = f,
            "piano_detune_cents" => p.piano_detune_cents = f,
            "piano_noise_level" => p.piano_noise_level = f,
            "piano_bright" => p.piano_bright = f,
            "drip_ratio" => p.drip_ratio = f,
            "drip_time_ms" => p.drip_time_ms = f,
            "drip_decay_ms" => p.drip_decay_ms = f,
            "wt_pos" => p.wt_pos = f,
            "wt_lfo_rate" => p.wt_lfo_rate = f,
            "wt_lfo_depth" => p.wt_lfo_depth = f,
            "portamento_ms" => p.portamento_ms = f,
            "filter_env_hz" => p.filter_env_hz = f,
            "filter_env_a" => p.filter_env_a = f,
            "filter_env_d" => p.filter_env_d = f,
            "filter_env_s" => p.filter_env_s = f,
            "filter_env_r" => p.filter_env_r = f,
            "mod_lfo_rate" => p.mod_lfo_rate = f,
            "mod_lfo_depth" => p.mod_lfo_depth = f,
            "mod_lfo_wave" => if v < 0.5 { p.mod_lfo_wave = "sine".into() } else { p.mod_lfo_wave = "s&h".into() },
            "mod_lfo_target" => match v as i64 { 1 => p.mod_lfo_target = "cutoff".into(), 2 => p.mod_lfo_target = "volume".into(), 3 => p.mod_lfo_target = "pan".into(), _ => p.mod_lfo_target = "off".into() },
            "key_track" => p.key_track = f,
            "vel_track" => p.vel_track = f,
            "sub_level" => p.sub_level = f,
            "sub_wave" => if v < 0.5 { p.sub_wave = "sine".into() } else { p.sub_wave = "square".into() },
            "gain" => p.gain = f.clamp(0.0, 2.0),
            "note_jitter" => p.note_jitter = f.clamp(0.0, 1.0),
            "dx_pm" => p.dx_pm = v > 0.5,
            "dx_lut" => p.dx_lut = v > 0.5,
            "dx_quant" => p.dx_quant = v > 0.5,
            "dx_dac" => p.dx_dac = v > 0.5,
            "dx_aa" => p.dx_aa = v > 0.5,
            "dx_algorithm" => { let a = v.round() as i32; p.dx_algorithm = if (1..=7).contains(&a) { a as u8 } else if a == 32 { 7 } else { 1 }; }
            "dx_feedback" => p.dx_feedback = v.clamp(0.0, 7.0) as u8,
            "dx_bits" => p.dx_bits = v.clamp(8.0, 16.0) as u8,
            _ => {}
            }
        }
        // 谐波数变化:重建波表并刷新活跃音符(实时生效)
        if key == "harmonics" { self.rebuild_tables(); }
    }

    /// 渐变槽位更换(标记波表重建)
    pub fn set_wt_slots(&mut self, slots: Vec<String>) {
        self.params.wt_slots = slots;
        self.rebuild_tables();
    }

    /// 自定义波形锚点(→ 2048 采样)
    pub fn set_custom_anchors(&mut self, anchors: Vec<(f32, f32)>) {
        self.custom_table = custom_table_from_anchors(&anchors);
        self.custom_dirty = true;
        self.rebuild_tables();
    }

    fn rebuild_tables(&mut self) {
        let custom = if self.custom_table.is_empty() { None } else { Some(&self.custom_table) };
        self.wt_bank = build_wt_bank(&self.params.wt_slots, self.params.harmonics as usize, custom);
        self.custom_dirty = false;
        // 活跃音符实时更新波形表(画波形/换槽位/调谐波立即生效,无需重新按键)
        let bank = self.wt_bank.clone();
        for v in self.voices.iter_mut() {
            match v.wave_type.as_str() {
                "piano" | "drip" | "dx7" | "acc" | "clar" | "harp" | "guzheng" => {}
                _ => v.wt_bank = bank.clone(),
            }
        }
    }

    /// 主波形表(通用波形路径用):波表槽位第一个或主波形
    fn main_table(&self) -> Vec<f32> {
        let custom = if self.custom_table.is_empty() { None } else { Some(&self.custom_table) };
        match self.params.wave_type.as_str() {
            "custom" => custom.cloned().unwrap_or_else(|| super::waves::build_wavetable("sine", self.params.harmonics as usize)),
            t => super::waves::build_wavetable(t, self.params.harmonics as usize),
        }
    }

    pub fn note_on(&mut self, midi: u8, velocity: f32, t: f32) {
        let vel = velocity.clamp(0.0, 1.0).max(0.0001);
        // 单音模式:滑音 legato
        if self.params.mono_mode {
            if self.params.portamento_ms > 0.0 && !self.voices.is_empty() {
                if let Some(v) = self.voices.first_mut() {
                    if v.midi != midi {
                        v.freq = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
                        v.midi = midi;
                        v.vel = vel;
                        v.on_t = t;
                        self.voice_order.retain(|&i| i != 0);
                        self.voice_order.push(0);
                        return;
                    }
                }
            }
            for i in (0..self.voices.len()).rev() {
                if self.voices[i].midi != midi { self.note_off_inner(i, true); }
            }
        }
        // 复音 steal:只算未释放的活跃音(释放尾音不占复音,与 TS active map 语义一致)
        let active_count = self.voices.iter().filter(|v| !v.releasing).count();
        if active_count >= MAX_VOICES {
            if let Some(oldest) = self.voice_order.first().copied() {
                self.note_off_inner(oldest, true);
            }
        }
        // 同音重触发
        if let Some(i) = self.voices.iter().position(|v| v.midi == midi) {
            self.note_off_inner(i, true);
        }
        let p = self.params.clone();
        let wt_bank = if p.wave_type == "wt" {
            self.wt_bank.clone()
        } else if p.wave_type != "moog" {
            vec![self.main_table()]
        } else {
            vec![]
        };
        let mut v = Voice::new(&p.wave_type, midi, vel, t, &p, wt_bank);
        // NoteOn 随机扰动:一次性施加(初始相位/失谐/电平微偏),模拟硬件不稳定
        if p.note_jitter > 0.0 {
            v.apply_jitter(p.note_jitter);
        }
        self.voices.push(v);
        self.voice_order.push(self.voices.len() - 1);
    }

    pub fn note_off(&mut self, midi: u8, fast: bool) {
        // 延音踏板:挂起
        if self.sustain_pedal && !fast {
            for v in self.voices.iter_mut() {
                if v.midi == midi { v.pedaled = true; }
            }
            return;
        }
        for i in (0..self.voices.len()).rev() {
            if self.voices[i].midi == midi { self.note_off_inner(i, fast); }
        }
    }

    fn note_off_inner(&mut self, i: usize, fast: bool) {
        if i >= self.voices.len() { return; }
        self.voices[i].release(fast);
        self.voice_order.retain(|&x| x != i);
    }

    /// 延音踏板
    pub fn set_sustain(&mut self, on: bool) {
        self.sustain_pedal = on;
        if !on {
            for i in (0..self.voices.len()).rev() {
                if self.voices[i].pedaled {
                    self.voices[i].pedaled = false;
                    self.voices[i].release(false);
                }
            }
        }
    }

    /// 弯音(半音)
    pub fn set_bend(&mut self, semitones: f32) {
        self.params.bend_cents = semitones * 100.0;
    }

    pub fn all_off(&mut self) {
        for i in 0..self.voices.len() {
            self.voices[i].release(true);
        }
        self.voice_order.clear();
    }

    /// 渲染一个采样块到 (l, r);返回峰值
    pub fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32], block: usize, t0: f32) {
        let dt = 1.0 / sr();
        let p = &self.params;
        let custom = if self.custom_table.is_empty() { None } else { Some(&self.custom_table) };
        let _ = custom;
        for s in 0..block {
            let t = t0 + s as f32 * dt;
            let mut acc = [0.0f32, 0.0f32];
            let mut i = 0;
            while i < self.voices.len() {
                let done = self.voices[i].render(dt, p, &self.noise, &mut acc);
                if done {
                    self.voices.remove(i);
                    self.voice_order.retain(|&x| x != i);
                    // 下标偏移修正
                    for o in self.voice_order.iter_mut() {
                        if *o > i { *o -= 1; }
                    }
                } else {
                    i += 1;
                }
                let _ = t;
            }
            out_l[s] += acc[0];
            out_r[s] += acc[1];
        }
    }
    // 增益(音量改为增益选项:0-2 线性)
    pub fn apply_gain(&mut self, out_l: &mut [f32], out_r: &mut [f32], block: usize) {
        let g = self.params.gain;
        if (g - 1.0).abs() > 1e-4 {
            for i in 0..block { out_l[i] *= g; out_r[i] *= g; }
        }
    }

    pub fn active_notes(&self) -> Vec<u8> {
        let mut v: Vec<u8> = self.voices.iter().map(|v| v.midi).collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_params(wt: &str) -> EngineParams {
        let mut p = EngineParams::default();
        p.wave_type = wt.into();
        p.wt_slots = vec!["sine".into(), "saw".into()];
        p
    }

    #[test]
    fn note_on_off_renders_sound() {
        let mut e = SynthEngine::new(test_params("sine"));
        let mut l = [0.0f32; 4410];
        let mut r = [0.0f32; 4410];
        e.note_on(69, 1.0, 0.0);
        e.render_block(&mut l, &mut r, 4410, 0.0);
        // A4 正弦 1s:应持续发声
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 0.05, "sine note should produce sound, peak={peak}");
        assert!(peak <= 1.5, "peak not clipping, peak={peak}");
    }

    #[test]
    fn polyphony_and_steal() {
        let mut e = SynthEngine::new(test_params("saw"));
        for m in 0..40u8 { e.note_on(40 + m, 1.0, 0.0); }
        let active = e.voices.iter().filter(|v| !v.releasing).count();
        assert!(active <= MAX_VOICES, "active voices capped at {MAX_VOICES}, got {active}");
    }

    #[test]
    fn sustain_pedal_holds() {
        let mut e = SynthEngine::new(test_params("saw"));
        e.set_sustain(true);
        e.note_on(60, 1.0, 0.0);
        e.note_off(60, false);
        assert!(e.voices.iter().any(|v| v.pedaled), "pedaled voice should persist");
        e.set_sustain(false);
        assert!(e.voices.iter().all(|v| !v.pedaled), "pedal up releases");
    }

    #[test]
    fn wt_engine_renders() {
        let mut e = SynthEngine::new(test_params("wt"));
        let mut l = [0.0f32; 4410];
        let mut r = [0.0f32; 4410];
        e.note_on(69, 1.0, 0.0);
        e.render_block(&mut l, &mut r, 4410, 0.0);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 0.01, "wt should render, peak={peak}");
    }

    #[test]
    fn piano_renders_without_clip() {
        let mut e = SynthEngine::new(test_params("piano"));
        let mut l = [0.0f32; 4410 * 3];
        let mut r = [0.0f32; 4410 * 3];
        e.note_on(69, 1.0, 0.0);
        e.render_block(&mut l, &mut r, 4410 * 3, 0.0);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        // 原始引擎输出(总线主音量在 bus 层 ×0.35);只需有限且在合理范围
        assert!(peak.is_finite() && peak > 0.01 && peak < 3.5, "piano in range, peak={peak}");
    }

    fn dx_bell_params() -> EngineParams {
        let mut p = EngineParams::default();
        p.wave_type = "dx7".into();
        p.dx_pm = true;
        p.dx_lut = true;
        p.dx_algorithm = 1;
        p.dx_feedback = 5;
        p.dx_ratios = [1.0, 2.73, 1.41, 3.0, 2.01, 1.0];
        p.dx_tls = [82.0, 52.0, 56.0, 64.0, 68.0, 72.0];
        // 豆包参考表:OP6 快速衰减(顶层),OP1 长释放(载波)
        // [r1,l1,r2,l2,r3,l3,r4,l4] × 6
        p.dx_egs = vec![
            // OP1 载波:快起音 + 长释放
            90.0, 99.0, 50.0, 60.0, 30.0, 50.0, 20.0, 20.0,
            // OP2 长衰减
            95.0, 99.0, 60.0, 70.0, 40.0, 60.0, 30.0, 10.0,
            // OP3 较快衰减
            95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
            // OP4 中等衰减
            95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
            // OP5 中等衰减
            95.0, 99.0, 70.0, 80.0, 50.0, 70.0, 40.0, 10.0,
            // OP6 顶层快速衰减(反馈)
            99.0, 99.0, 80.0, 50.0, 60.0, 30.0, 50.0, 5.0,
        ];
        p
    }

    #[test]
    fn dx_bell_has_inharmonic_partials() {
        // PM + 反馈 + 非整数 Ratio → 频谱应包含基频之外的强非谐波分量(金属感)
        let mut e = SynthEngine::new(dx_bell_params());
        let n = 8192usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        e.note_on(69, 1.0, 0.0);
        e.render_block(&mut l, &mut r, n, 0.0);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak.is_finite() && peak > 0.001, "dx bell should sound, peak={peak}");
        // 简易频谱:基频 A4=440Hz,检查 440Hz 之外的能量占比
        let sr = crate::audio::dsp::sr();
        let bin = |f: f32| (f / sr * n as f32) as usize;
        let mut total_energy = 0.0f64;
        let mut non_fund = 0.0f64;
        for i in 0..n / 2 {
            let mut re = 0.0f64;
            let mut im = 0.0f64;
            for (j, x) in l.iter().step_by(2).take(64).enumerate() {
                let ph = 2.0 * std::f32::consts::PI as f64 * i as f64 * j as f64 / 128.0;
                re += *x as f64 * ph.cos();
                im -= *x as f64 * ph.sin();
            }
            let e2 = re * re + im * im;
            total_energy += e2;
            let f = i as f32 * sr / n as f32;
            if (f - 440.0).abs() > 40.0 { non_fund += e2; }
        }
        let ratio = if total_energy > 0.0 { non_fund / total_energy } else { 0.0 };
        assert!(ratio > 0.15, "bell should be inharmonic-rich, non-fundamental ratio={ratio:.2}");
    }

    #[test]
    fn dx_all_algorithms_render() {
        // 算法 1-6 与 32 都能出声且不 panic
        for alg in [1u8, 2, 3, 4, 5, 6, 7] {
            let mut p = test_params("dx7");
            p.dx_pm = true;
            p.dx_algorithm = alg;
            p.dx_feedback = 2;
            let mut e = SynthEngine::new(p);
            e.note_on(69, 0.8, 0.0);
            let mut l = [0.0f32; 4410];
            let mut r = [0.0f32; 4410];
            e.render_block(&mut l, &mut r, 4410, 0.0);
            let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
            assert!(peak > 1e-3 && peak <= 1.5, "alg {alg} peak={peak}");
        }
    }

    #[test]
    fn dx_alg32_parallel_renders() {
        let mut p = dx_bell_params();
        p.dx_algorithm = 7;
        let mut e = SynthEngine::new(p);
        let mut l = [0.0f32; 4410];
        let mut r = [0.0f32; 4410];
        e.note_on(69, 1.0, 0.0);
        e.render_block(&mut l, &mut r, 4410, 0.0);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 0.001 && peak < 1.5, "alg32 render, peak={peak}");
    }

    #[test]
    fn note_jitter_perturbs_only_once() {
        let mut p = EngineParams::default();
        p.wave_type = "sine".into();
        p.note_jitter = 1.0;
        let mut e1 = SynthEngine::new(p.clone());
        let mut e2 = SynthEngine::new(p);
        let mut l1 = [0.0f32; 2048]; let mut r1 = [0.0f32; 2048];
        let mut l2 = [0.0f32; 2048]; let mut r2 = [0.0f32; 2048];
        e1.note_on(60, 1.0, 0.0);
        e2.note_on(60, 1.0, 0.0);
        e1.render_block(&mut l1, &mut r1, 2048, 0.0);
        e2.render_block(&mut l2, &mut r2, 2048, 0.0);
        // 两次发声相位不同(扰动生效),但都正常发声
        let mut diff = 0.0f32;
        for i in 0..2048 { diff += (l1[i] - l2[i]).abs(); }
        assert!(diff > 1e-3, "jitter should change phase, diff={diff}");
        let peak = l1.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 0.05, "jittered note still sounds, peak={peak}");
    }

    #[test]
    fn sample_rate_switch_rebuilds() {
        let p = test_params("saw");
        let mut e = SynthEngine::new(p);
        // 切换采样率后重新创建引擎应正常发声
        crate::audio::dsp::set_sr(49096);
        let mut e2 = SynthEngine::new(EngineParams::default());
        let mut l = [0.0f32; 4909];
        let mut r = [0.0f32; 4909];
        e2.note_on(69, 1.0, 0.0);
        e2.render_block(&mut l, &mut r, 4909, 0.0);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak > 0.01, "renders at 49096, peak={peak}");
        crate::audio::dsp::set_sr(44100);
        drop(e);
    }
}

