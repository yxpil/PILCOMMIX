// COMMIX VST2 无头版:16 通道多音色合成引擎(复用 Rust 音频模块)
// 无 UI,参数自动化控制主通道(ch0)音色;MIDI 按通道直通发声
mod audio;

use audio::engine::{EngineParams};
use audio::{AudioBus, PendingEvent, AudioEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use vst::api::{Events, Supported};
use vst::buffer::AudioBuffer;
use vst::event::Event;
use vst::plugin::{CanDo, Category, HostCallback, Info, Plugin, PluginParameters};
use vst::util::AtomicFloat;

// ============ 参数表(ch0 音色 + 主效果,宿主自动化) ============
const PARAM_COUNT: usize = 22;
const PARAM_NAMES: [&str; PARAM_COUNT] = [
    "波形", "起音", "衰减", "延音", "释放",
    "滤波", "共振", "谐波", "失谐", "振荡器数",
    "音量dB", "引擎增益", "混响", "延迟混合", "延迟反馈", "驱动",
    "声像", "颤音速率", "颤音深度", "低音EQ", "中音EQ", "高音EQ",
];
const WAVE_NAMES: [&str; 14] = ["sine", "triangle", "square", "saw", "wt", "moog",
    "dx7", "piano", "drip", "acc", "clar", "harp", "guzheng", "custom"];
// 程序变更 → 环形波形回退
const MIDI_PROGRAM_WAVES: [&str; 14] = ["sine", "triangle", "square", "saw", "wt", "moog",
    "dx7", "piano", "drip", "acc", "clar", "harp", "guzheng", "custom"];
// 内置 GM 预设(与桌面版内置库对应的核心音色)
fn gm_preset(program: u8) -> Option<EngineParams> {
    let mut p = EngineParams::default();
    match program {
        0 => { p.wave_type = "piano".into(); }
        2 => { p.wave_type = "dx7".into(); p.dx_pm = true; p.dx_lut = true; p.dx_quant = true; p.dx_aa = true; p.dx_algorithm = 2; p.dx_feedback = 1; p.dx_ratios = [1.0, 1.0, 14.0, 1.0, 1.0, 14.0]; p.dx_tls = [80.0, 70.0, 60.0, 76.0, 70.0, 60.0]; }
        16 => { p.wave_type = "dx7".into(); p.dx_pm = true; p.dx_lut = true; p.dx_aa = true; p.dx_algorithm = 7; p.dx_feedback = 0; p.dx_ratios = [1.0, 2.0, 3.0, 4.0, 0.5, 1.5]; p.dx_tls = [55.0, 60.0, 65.0, 62.0, 58.0, 66.0]; p.attack = 0.008; p.decay = 0.05; p.sustain = 0.9; p.release = 0.1; }
        32 => { p.wave_type = "saw".into(); p.osc_count = 2; p.detune_cents = 8.0; p.cutoff_hz = 350.0; p.resonance_q = 1.2; p.attack = 0.008; p.decay = 0.4; p.sustain = 0.6; p.release = 0.2; }
        40 => { p.wave_type = "saw".into(); p.cutoff_hz = 1500.0; p.resonance_q = 1.0; p.attack = 0.09; p.decay = 0.2; p.sustain = 0.85; p.release = 0.4; p.vibrato_depth = 0.015; p.vibrato_rate = 5.0; }
        48 => { p.wave_type = "wt".into(); p.wt_slots = vec!["sawtooth".into(), "triangle".into()]; p.wt_pos = 0.5; p.attack = 0.15; p.decay = 0.2; p.sustain = 0.8; p.release = 0.8; p.cutoff_hz = 900.0; p.detune_cents = 6.0; }
        56 => { p.wave_type = "saw".into(); p.cutoff_hz = 2000.0; p.resonance_q = 1.1; p.attack = 0.02; p.decay = 0.15; p.sustain = 0.9; p.release = 0.15; }
        71 => { p.wave_type = "clar".into(); }
        73 => { p.wave_type = "sine".into(); p.attack = 0.09; p.decay = 0.15; p.sustain = 0.85; p.release = 0.3; p.vibrato_depth = 0.015; p.vibrato_rate = 5.5; }
        80 => { p.wave_type = "square".into(); p.osc_count = 2; p.detune_cents = 5.0; p.cutoff_hz = 3000.0; p.release = 0.15; }
        81 => { p.wave_type = "saw".into(); p.osc_count = 2; p.detune_cents = 6.0; p.cutoff_hz = 4000.0; p.release = 0.15; }
        85 => { p.wave_type = "saw".into(); p.osc_count = 3; p.detune_cents = 12.0; p.cutoff_hz = 3500.0; p.resonance_q = 1.3; p.release = 0.4; }
        99 => { p.wave_type = "dx7".into(); p.dx_pm = true; p.dx_lut = true; p.dx_aa = true; p.dx_algorithm = 6; p.dx_feedback = 2; p.dx_ratios = [1.0, 0.5, 2.01, 3.0, 4.2, 1.0]; p.dx_tls = [78.0, 70.0, 60.0, 55.0, 50.0, 68.0]; p.release = 0.8; }
        108 => { p.wave_type = "dx7".into(); p.dx_pm = true; p.dx_lut = true; p.dx_quant = true; p.dx_aa = true; p.dx_algorithm = 1; p.dx_feedback = 3; p.dx_ratios = [1.0, 2.73, 1.41, 3.0, 2.01, 1.0]; p.dx_tls = [82.0, 52.0, 56.0, 64.0, 68.0, 72.0]; p.decay = 1.2; p.sustain = 0.1; p.release = 1.5; }
        113 => { p.wave_type = "drip".into(); }
        _ => return None,
    }
    Some(p)
}

struct CommixParams {
    vals: Vec<AtomicFloat>,
    dirty: Arc<AtomicBool>,
}
impl CommixParams {
    fn new() -> Self {
        let mut v: Vec<AtomicFloat> = (0..PARAM_COUNT).map(|_| AtomicFloat::new(0.0)).collect();
        v[5] = AtomicFloat::new(0.65);    // 滤波 2kHz
        v[10] = AtomicFloat::new(0.8);    // 音量 0dB
        v[11] = AtomicFloat::new(0.5);    // 引擎增益 1.0
        Self { vals: v, dirty: Arc::new(AtomicBool::new(false)) }
    }
}
impl Clone for CommixParams {
    fn clone(&self) -> Self {
        Self { vals: self.vals.iter().map(|v| AtomicFloat::new(v.get())).collect(), dirty: self.dirty.clone() }
    }
}
impl PluginParameters for CommixParams {
    fn get_parameter(&self, index: i32) -> f32 { self.vals[index as usize].get() }
    fn set_parameter(&self, index: i32, value: f32) {
        let i = index as usize;
        if i < self.vals.len() { self.vals[i].set(value.clamp(0.0, 1.0)); self.dirty.store(true, Ordering::Relaxed); }
    }
    fn get_parameter_name(&self, index: i32) -> String {
        PARAM_NAMES.get(index as usize).map(|s| s.to_string()).unwrap_or_default()
    }
    fn get_parameter_text(&self, index: i32) -> String {
        let v = self.vals[index as usize].get();
        match index as usize {
            0 => WAVE_NAMES[(v * 14.0).min(13.999) as usize].to_string(),
            1..=4 => format!("{:.2}s", v * 8.0),
            5 => format!("{:.0}Hz", 30.0f32 * (20000.0f32 / 30.0f32).powf(v)),
            6 => format!("{:.1}", 0.1 + v * 19.9),
            7 => format!("{:.0}", 1.0 + v * 63.0),
            8 => format!("{:.0}", v * 50.0),
            9 => format!("{:.0}", 1.0 + v * 3.0),
            10 => format!("{:.0}dB", -24.0 + v * 30.0),
            11 => format!("{:.2}", v * 2.0),
            12 | 13 | 15 => format!("{:.0}%", v * 100.0),
            14 => format!("{:.0}%", v * 90.0),
            16 => format!("{:.0}%", v * 200.0 - 100.0),
            17 => format!("{:.1}Hz", v * 10.0),
            18 => format!("{:.3}", v * 0.1),
            19..=21 => format!("{:.0}dB", -12.0 + v * 24.0),
            _ => format!("{:.3}", v),
        }
    }
    fn get_preset_name(&self, _preset: i32) -> String { "COMMIX".to_string() }
    fn string_to_parameter(&self, _index: i32, _text: String) -> bool { false }
}

struct CommixPlugin {
    bus: AudioBus,
    params: CommixParams,
}
impl CommixPlugin {
    fn new() -> Self {
        let (tx, _rx) = channel::<Vec<f32>>();
        let (tx2, _rx2) = channel::<bool>();
        let bus = AudioBus::new(tx, tx2);
        Self { bus, params: CommixParams::new() }
    }
    // 参数 → 引擎/总线(宿主自动化实时生效)
    fn apply_params(&mut self) {
        let v = |i: usize| self.params.vals[i].get();
        let e = &mut self.bus.engines[0];
        let wave = WAVE_NAMES[(v(0) * 14.0).min(13.999) as usize];
        if e.params.wave_type != wave {
            let mut p = EngineParams::default();
            p.wave_type = wave.into();
            match wave {
                "dx7" => { p.dx_pm = true; p.dx_lut = true; p.dx_aa = true; }
                "piano" => {}
                _ => {}
            }
            e.set_params(p);
        }
        let mut p = e.params.clone();
        p.attack = v(1) * 8.0;
        p.decay = v(2) * 8.0;
        p.sustain = v(3);
        p.release = v(4) * 8.0;
        p.cutoff_hz = 30.0f32 * (20000.0f32 / 30.0f32).powf(v(5));
        p.resonance_q = 0.1 + v(6) * 19.9;
        p.harmonics = (1.0 + v(7) * 63.0) as u16;
        p.detune_cents = v(8) * 50.0;
        p.osc_count = (1.0 + v(9) * 3.0) as u8;
        p.volume = 10f32.powf((-24.0 + v(10) * 30.0) / 20.0);
        p.gain = v(11) * 2.0;
        p.pan = v(16) * 2.0 - 1.0;
        p.vibrato_rate = v(17) * 10.0;
        p.vibrato_depth = v(18) * 0.1;
        let vol = p.volume;
        e.set_params(p);
        // 主效果链
        self.bus.set_master("volume", vol as f64);
        self.bus.set_master("reverb", v(12) as f64);
        self.bus.set_master("delay_mix", v(13) as f64);
        self.bus.set_master("delay_feedback", (v(14) * 0.9) as f64);
        self.bus.set_master("drive", v(15) as f64);
        self.bus.set_master("eq_bass", (-12.0 + v(19) * 24.0) as f64);
        self.bus.set_master("eq_mid", (-12.0 + v(20) * 24.0) as f64);
        self.bus.set_master("eq_treble", (-12.0 + v(21) * 24.0) as f64);
    }
    fn program_change(&mut self, ch: usize, program: u8) {
        if let Some(p) = gm_preset(program) {
            self.bus.engines[ch].set_params(p);
        } else {
            let wave = MIDI_PROGRAM_WAVES[(program as usize) % MIDI_PROGRAM_WAVES.len()];
            let mut p = EngineParams::default();
            p.wave_type = wave.into();
            self.bus.engines[ch].set_params(p);
        }
    }
}

impl Plugin for CommixPlugin {
    fn new(_host: HostCallback) -> Self { Self::new() }
    fn get_info(&self) -> Info {
        Info {
            name: "COMMIX VST".to_string(),
            vendor: "枕的小屋".to_string(),
            unique_id: 0x434D5821,
            version: 3,
            inputs: 0,
            outputs: 2,
            parameters: PARAM_COUNT as i32,
            category: Category::Synth,
            ..Default::default()
        }
    }
    fn get_parameter_object(&mut self) -> Arc<dyn PluginParameters> { Arc::new(self.params.clone()) }
    fn set_sample_rate(&mut self, rate: f32) { audio::dsp::set_sr(rate as u32); }
    fn can_do(&self, can_do: CanDo) -> Supported {
        match can_do {
            CanDo::ReceiveMidiEvent => Supported::Yes,
            CanDo::SendMidiEvent => Supported::No,
            CanDo::ReceiveTimeInfo => Supported::No,
            _ => Supported::Maybe,
        }
    }
    fn get_tail_size(&self) -> isize { 2 * 44100 }

    // MIDI 事件:按通道直通(与桌面版一致的引擎分身语义)
    fn process_events(&mut self, events: &Events) {
        if self.params.dirty.swap(false, Ordering::Relaxed) { self.apply_params(); }
        for e in events.events() {
            if let Event::Midi(ev) = e {
                let data = ev.data;   // [u8; 3](VST2 事件固定 3 字节,未用位为 0)
                let status = data[0];
                if status == 0 { continue; }
                let typ = status & 0xf0;
                let ch = (status & 0x0f) as usize;
                let d1 = data[1];
                let d2 = data[2];
                let now = self.bus.sample_clock + ev.delta_frames as u64;
                let ev2 = match typ {
                    0x90 if d2 > 0 => Some(AudioEvent::NoteOn { ch, midi: d1, vel: d2 as f32 / 127.0 }),
                    0x80 | 0x90 => Some(AudioEvent::NoteOff { ch, midi: d1 }),
                    0xb0 if d1 == 64 => Some(AudioEvent::Sustain { ch, on: d2 >= 64 }),
                    0xc0 => { self.program_change(ch, d1); None }
                    0xe0 => {
                        let v14 = (d1 as i32 | ((d2 as i32) << 7)) - 8192;
                        self.bus.engines[ch].set_bend((v14 as f32 / 8192.0) * 2.0);
                        None
                    }
                    _ => None,
                };
                if let Some(ev2) = ev2 { self.bus.pending.push_back(PendingEvent { sample: now, ev: ev2 }); }
            }
        }
    }

    fn process(&mut self, buffer: &mut AudioBuffer<f32>) {
        let n = buffer.samples();
        if n == 0 { return; }
        let (_, mut outputs) = buffer.split();
        if outputs.len() < 2 { return; }
        let (mut l, mut r) = outputs.split_at_mut(1);
        let ol = &mut l[0][..];
        let or = &mut r[0][..];
        self.bus.render_block(ol, or, n);
    }
}

use vst::plugin_main;
plugin_main!(CommixPlugin);


#[cfg(test)]
mod vst_smoke {
    use super::*;
    use vst::api::{Event as ApiEvent, EventType, MidiEvent};
    use vst::buffer::AudioBuffer;

    fn events_for(midi: [u8; 3]) -> vst::api::Events {
        let mut events = vst::api::Events { num_events: 1, _reserved: 0, events: [std::ptr::null_mut(); 2] };
        // api::Event 是 repr(C) 结构:event_type 头 + 数据(转成 MidiEvent)
        let mut ev = ApiEvent {
            event_type: EventType::Midi,
            byte_size: std::mem::size_of::<ApiEvent>() as i32,
            delta_frames: 0,
            _flags: 0,
            _reserved: [0u8; 16],
        };
        unsafe {
            let midi_ev: &mut MidiEvent = std::mem::transmute(&mut ev);
            midi_ev.midi_data = midi;
        }
        events.events[0] = Box::into_raw(Box::new(ev));
        events
    }

    #[test]
    fn plugin_renders_midi() {
        audio::dsp::set_sr(44100);
        let mut plugin = CommixPlugin::new();
        plugin.set_sample_rate(44100.0);
        // 音量 0dB + 钢琴波形
        plugin.params.set_parameter(10, 0.8);
        plugin.params.set_parameter(0, 7.0 / 13.999);
        plugin.apply_params();
        // NoteOn C4
        let ev = events_for([0x90, 60, 100]);
        plugin.process_events(&ev);
        let n = 4410usize;
        let mut out = vec![0.0f32; n * 2];
        let mut outputs: Vec<*mut f32> = vec![out.as_mut_ptr(), unsafe { out.as_mut_ptr().add(n) }];
        let dummy: *const *const f32 = std::ptr::NonNull::<*const f32>::dangling().as_ptr();
        println!("DBG wave={} vol={} pending={}", plugin.bus.engines[0].params.wave_type, plugin.bus.engines[0].params.volume, plugin.bus.pending.len());
        let mut buf = unsafe { AudioBuffer::from_raw(0, 2, dummy, outputs.as_mut_ptr(), n) };
        plugin.process(&mut buf);
        let peak = out.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        println!("VST peak={} voices={} pending_after={}", peak, plugin.bus.engines[0].voices.len(), plugin.bus.pending.len());
        assert!(peak > 0.01, "VST should render audio, peak={peak}");
        // NoteOff + 程序变更(GM 音色)不 panic
        let ev = events_for([0x80, 60, 0]);
        plugin.process_events(&ev);
        let ev = events_for([0xC0, 16, 0]);
        plugin.process_events(&ev);
    }
}
