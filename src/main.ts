// COMMIX 合成器 —— 单文件前端逻辑
// 合成引擎:PeriodicWave 统一波形(内置 4 种 + 自定义锚点),复音,ADSR
// 输入:电脑键盘 / 鼠标琴键 / Web MIDI 输入;输出:扬声器 + MIDI 输出(可选)
// 录制:音频(WAV) + MIDI(SMF format 0)

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";

// ============ 工具 ============
const $id = (s: string) => document.getElementById(s) as HTMLElement;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi: number): string {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 450); }, 2400);
}

// ============ 音频引擎 ============
const SAMPLE_RATE = 44100;
const WAVE_LEN = 2048;                 // 周期采样数
const MAX_VOICES = 32;

// 波形类型:内置 4 种 + 自定义 + 合成器预设
type WaveType = "sine" | "square" | "saw" | "triangle" | "custom"
  | "moog" | "dx7" | "piano" | "drip"
  | "acc" | "clar" | "harp" | "guzheng";

// 钢琴音色:加法合成(非调和泛音 + 独立衰减 + 双弦失谐 + 锤击噪声)
// 每个泛音幅度与衰减时间(高次泛音衰减更快,这是钢琴音色的关键)
const PIANO_HARMONICS: [number, number, number][] = [
  // [泛音序数, 相对幅度, 衰减时间(s)]
  [1, 1.0, 3.2], [2, 0.75, 2.1], [3, 0.55, 1.4], [4, 0.4, 1.0],
  [5, 0.28, 0.75], [6, 0.19, 0.55], [7, 0.12, 0.42], [8, 0.08, 0.32],
];
const INHARMONICITY = 0.00035;   // 非调和系数(钢琴泛音轻微偏高)

// 合成器预设定义:振荡器类型 + 失谐 + 滤波器拓扑
// 这些机型的招牌音色来自"滤波 + 双振荡器失谐",不是静态谐波
interface SynthDef {
  oscWave: OscillatorType;            // 基础振荡器波形
  detune?: number;                    // 双振荡器失谐(音分)
  filterType?: BiquadFilterType;      // 滤波器类型
  cutoff?: number;                    // 截止频率(Hz)
  resonance?: number;                 // 共振 Q
  cutoffEnv?: number;                 // 触发时截止频率扫频量(Hz,正=上升)
  cutoffEnvTime?: number;             // 扫频时间(s)
}
const PRESET_DEFS: Record<string, SynthDef> = {
  // Minimoog:单锯齿 + 4-pole 低通(温暖)
  moog:   { oscWave: "sawtooth", filterType: "lowpass", cutoff: 2600, resonance: 0.7 },
  // DX7:FM 合成,不走此表(单独路径)
};

// DX7 是 FM 合成器:载波 + 调制算子,音色由 FM 边带和调制指数包络决定。
// 画布预览用两个算子的静态 FM 波形;实际发声走真实 FM 路径(见 createVoice)。
function dx7FmWave(p: number): number {
  return 0.6 * Math.sin(2 * Math.PI * p + 3 * Math.sin(2 * Math.PI * p))
       + 0.4 * Math.sin(2 * Math.PI * p + 2 * Math.sin(4 * Math.PI * p));
}

// 预设波形画布预览值(0..1 → -1..1)
function presetWaveAt(type: string, p: number): number {
  if (type === "dx7") return dx7FmWave(p);
  if (type === "drip") {
    // 水滴预览:起始高频快速滑向基频的正弦(静态近似)
    const start = 4, end = 1;
    const k = start + (end - start) * Math.pow(p, 0.6);
    return Math.sin(2 * Math.PI * k * p * 2);
  }
  if (type === "acc" || type === "clar") {
    // 手风琴/单簧管:簧片类,方波近似(奇数谐波丰富)
    return p < 0.5 ? 1 : -1;
  }
  if (type === "harp" || type === "guzheng") {
    // 竖琴/古筝:拨弦泛音叠加(与发声一致的谐波结构)
    const H: [number, number][] = type === "guzheng"
      ? [[1, 1], [2, 0.55], [3, 0.35], [4, 0.18], [5, 0.1], [6, 0.06]]
      : [[1, 1], [2, 0.7], [3, 0.5], [4, 0.38], [5, 0.28], [6, 0.2], [7, 0.13], [8, 0.09], [9, 0.06], [10, 0.04]];
    let v = 0;
    for (const [n, amp] of H) {
      v += amp * Math.sin(2 * Math.PI * n * (1 + INHARMONICITY * n * n) * p);
    }
    return Math.max(-1, Math.min(1, v / 3.2));
  }
  if (type === "piano") {
    // 钢琴预览:非调和泛音叠加(静态快照)
    let v = 0;
    for (const [n, amp] of PIANO_HARMONICS) {
      v += amp * Math.sin(2 * Math.PI * n * (1 + INHARMONICITY * n * n) * p);
    }
    return Math.max(-1, Math.min(1, v / 3.2));
  }
  const def = PRESET_DEFS[type];
  if (!def) return 0;
  switch (def.oscWave) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "square": return p < 0.5 ? 1 : -1;
    case "triangle": return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return 2 * p - 1;   // sawtooth
  }
}

class SynthEngine {
  ctx: AudioContext;
  master: GainNode;
  recorderDest: MediaStreamAudioDestinationNode;
  active = new Map<number, { oscs: OscillatorNode[]; gain: GainNode; vel: number; onT: number }>();
  private voiceOrder: number[] = [];   // 复音 steal 队列

  // 混响链:master → dry(destination) + send → convolver → return → destination
  reverbSend: GainNode;
  reverbReturn: GainNode;
  convolver: ConvolverNode;
  // 波形显示(录音轨道用)
  analyser: AnalyserNode;
  // 钢琴锤击噪声缓冲
  noiseBuffer: AudioBuffer;

  // 音色参数
  volume = 0.7;
  attack = 0.01; decay = 0.2; sustain = 0.7; release = 0.3;
  harmonics = 32;
  reverb = 0.25;
  waveType: WaveType = "sine";
  customWave: PeriodicWave | null = null;

  // 合成器预设可调参数(面板控件驱动,预设切换时灌入默认值)
  oscWave: OscillatorType = "sawtooth";
  oscCount = 2;                    // 振荡器数 1-8
  detuneCents = 6;                 // 多振荡器失谐跨度(音分)
  filterKind: BiquadFilterType = "lowpass";
  cutoffHz = 2000;
  resonanceQ = 0.7;
  cutoffEnvHz = 0;                 // 截止扫频量
  cutoffEnvMs = 90;                // 扫频时间

  // 演奏参数
  monoMode = false;                // 单音/复音
  pan = 0;                         // 声像 -1..1
  vibratoRate = 3;                 // 颤音频率 Hz
  vibratoDepth = 0;                // 颤音深度 0..1(相对频率)

  // PILZ1 钢琴参数(加法合成)
  pianoDecayScale = 1.0;           // 泛音衰减倍率 0.5-2.5
  pianoDetuneCents = 4;            // 双弦失谐(音分)
  pianoNoiseLevel = 0.3;           // 锤击噪声量 0-1
  pianoBright = 1.0;               // 明亮度 0.5-2(高次泛音增益)

  // PILQ1 水滴参数(频率下滑合成)
  dripRatio = 4;                   // 起始频率倍率 2-10(下滑起点)
  dripTimeMs = 150;                // 下滑时间 50-500ms
  dripDecayMs = 300;               // 衰减时间 100-1000ms

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.recorderDest = this.ctx.createMediaStreamDestination();

    // 混响:指数衰减白噪声 IR(2.2s)
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.2, 2.8);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.master.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.ctx.destination);
    this.reverbReturn.connect(this.recorderDest);
    this.master.connect(this.ctx.destination);
    this.master.connect(this.recorderDest);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    // 钢琴锤击噪声缓冲(60ms 白噪声)
    const nb = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.06), this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuffer = nb;
  }

  makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  setReverb(v: number) {
    this.reverb = v;
    // 发送量 = 混响量 ^ 1.6(非线性让低值更敏感)
    this.reverbSend.gain.setTargetAtTime(Math.pow(v, 1.6) * 0.9, this.ctx.currentTime, 0.05);
  }

  async resume() { if (this.ctx.state === "suspended") await this.ctx.resume(); }

  // 重载音频引擎:关闭旧 AudioContext 并重建(修复切换操作后音频会话失效导致的静音)
  reload() {
    const p = {
      volume: this.volume, attack: this.attack, decay: this.decay,
      sustain: this.sustain, release: this.release, harmonics: this.harmonics,
      reverb: this.reverb, waveType: this.waveType, customWave: this.customWave,
      oscWave: this.oscWave, oscCount: this.oscCount, detuneCents: this.detuneCents,
      filterKind: this.filterKind, cutoffHz: this.cutoffHz, resonanceQ: this.resonanceQ,
      cutoffEnvHz: this.cutoffEnvHz, cutoffEnvMs: this.cutoffEnvMs,
      monoMode: this.monoMode, pan: this.pan,
      vibratoRate: this.vibratoRate, vibratoDepth: this.vibratoDepth,
      pianoDecayScale: this.pianoDecayScale, pianoDetuneCents: this.pianoDetuneCents,
      pianoNoiseLevel: this.pianoNoiseLevel, pianoBright: this.pianoBright,
      dripRatio: this.dripRatio, dripTimeMs: this.dripTimeMs, dripDecayMs: this.dripDecayMs,
    };
    try { this.ctx.close(); } catch { /* 已关闭 */ }
    this.active.clear();
    this.voiceOrder = [];
    // 重建音频图(与构造函数一致)
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.master = this.ctx.createGain();
    this.master.gain.value = p.volume;
    this.recorderDest = this.ctx.createMediaStreamDestination();
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.2, 2.8);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.master.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.ctx.destination);
    this.reverbReturn.connect(this.recorderDest);
    this.master.connect(this.ctx.destination);
    this.master.connect(this.recorderDest);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    const nb = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.06), this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuffer = nb;
    // 恢复参数
    this.volume = p.volume; this.attack = p.attack; this.decay = p.decay;
    this.sustain = p.sustain; this.release = p.release; this.harmonics = p.harmonics;
    this.reverb = p.reverb; this.waveType = p.waveType; this.customWave = p.customWave;
    this.oscWave = p.oscWave; this.oscCount = p.oscCount; this.detuneCents = p.detuneCents;
    this.filterKind = p.filterKind; this.cutoffHz = p.cutoffHz; this.resonanceQ = p.resonanceQ;
    this.cutoffEnvHz = p.cutoffEnvHz; this.cutoffEnvMs = p.cutoffEnvMs;
    this.monoMode = p.monoMode; this.pan = p.pan;
    this.vibratoRate = p.vibratoRate; this.vibratoDepth = p.vibratoDepth;
    this.pianoDecayScale = p.pianoDecayScale; this.pianoDetuneCents = p.pianoDetuneCents;
    this.pianoNoiseLevel = p.pianoNoiseLevel; this.pianoBright = p.pianoBright;
    this.dripRatio = p.dripRatio; this.dripTimeMs = p.dripTimeMs; this.dripDecayMs = p.dripDecayMs;
    this.setReverb(p.reverb);
    this.resume();
  }

  // 生成 PeriodicWave:内置波形按谐波截断,自定义波形由锚点 DFT
  buildWave(type: SynthEngine["waveType"], anchors: { x: number; y: number }[]): PeriodicWave {
    const N = this.harmonics;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    real[0] = 0; imag[0] = 0;
    if (type === "custom") {
      // 锚点线性插值 → 采样,再 DFT
      const samples = new Float64Array(WAVE_LEN);
      for (let i = 0; i < WAVE_LEN; i++) {
        const px = i / WAVE_LEN;
        samples[i] = interpAnchors(anchors, px);
      }
      for (let k = 1; k <= N; k++) {
        let re = 0, im = 0;
        for (let i = 0; i < WAVE_LEN; i++) {
          const ph = (2 * Math.PI * k * i) / WAVE_LEN;
          re += samples[i] * Math.cos(ph);
          im -= samples[i] * Math.sin(ph);
        }
        real[k] = re / WAVE_LEN * 2;
        imag[k] = im / WAVE_LEN * 2;
      }
      // 去掉直流
      real[0] = 0;
    } else {
      for (let k = 1; k <= N; k++) {
        const n = k;
        switch (type) {
          case "sine": imag[k] = n === 1 ? 1 : 0; break;
          case "square": if (n % 2 === 1) imag[k] = 1 / n; break;
          case "saw": imag[k] = 1 / n; break;
          case "triangle": if (n % 2 === 1) imag[k] = (n % 4 === 1 ? 1 : -1) / (n * n); break;
        }
      }
    }
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // 合成器参数统一作用于所有波形:基础波形来源不同(内置=PeriodicWave,预设=专用合成结构)
  isSynthPreset(type: SynthEngine["waveType"]): boolean {
    return type === "moog" || type === "dx7" || type === "piano" || type === "drip"
      || type === "acc" || type === "clar" || type === "harp" || type === "guzheng";
  }

  private getWave(): PeriodicWave {
    if (this.waveType === "custom" && this.customWave) return this.customWave;
    return this.buildWave(this.waveType, []);
  }

  // when 可选:为未来时间调度(多轨导出用 AudioContext 时钟精确对齐)
  noteOn(midi: number, velocity = 1, when?: number) {
    const ctx = this.ctx;
    const t = when ?? ctx.currentTime;
    // 单音模式:先释放其他音符(最后按下的优先)
    if (this.monoMode) {
      for (const n of [...this.active.keys()]) {
        if (n !== midi) this.noteOff(n, true);
      }
    }
    // 复音 steal
    if (this.active.size >= MAX_VOICES) {
      const oldest = this.voiceOrder.shift();
      if (oldest !== undefined && this.active.has(oldest)) this.noteOff(oldest, true);
    }
    if (this.active.has(midi)) this.noteOff(midi, true);

    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const a = Math.max(0.001, this.attack);
    const d = Math.max(0.001, this.decay);
    const s = Math.max(0.0001, this.sustain);
    this.noteOnVoice(midi, freq, t, velocity, a, d, s);
  }

  // 统一发声路径:振荡器(数/失谐/波形来源) + 滤波器 + ADSR + 声像 + 颤音
  private noteOnVoice(midi: number, freq: number, t: number, velocity: number,
                      a: number, d: number, s: number) {
    const ctx = this.ctx;
    const type = this.waveType;

    // 输出增益(ADSR)
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(velocity, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, velocity * s), t + a + d);

    const oscs: OscillatorNode[] = [];

    if (type === "piano") {
      // 钢琴:加法合成
      // 非调和泛音各带独立衰减包络(高次衰减更快);明亮度提升高次泛音增益
      for (const [n, amp, decayT] of PIANO_HARMONICS) {
        const o = ctx.createOscillator();
        o.type = "sine";
        // 非调和性:第 n 次泛音频率 = n·f·(1 + B·n²)
        o.frequency.value = freq * n * (1 + INHARMONICITY * n * n);
        const og = ctx.createGain();
        // 明亮度:高次泛音增益缩放(基频不变,第 8 泛音乘 pianoBright)
        const brightFactor = 1 + (this.pianoBright - 1) * ((n - 1) / 7);
        og.gain.setValueAtTime(amp * velocity * brightFactor, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + decayT * this.pianoDecayScale);
        o.connect(og);
        og.connect(g);
        oscs.push(o);
      }
      // 双弦失谐:与基频略微失谐的第二根弦(产生钢琴特有的"拍音")
      const det = ctx.createOscillator();
      det.type = "sine";
      det.frequency.value = freq * Math.pow(2, this.pianoDetuneCents / 1200);
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.6 * velocity, t);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + 2.4 * this.pianoDecayScale);
      det.connect(dg);
      dg.connect(g);
      oscs.push(det);
      // 锤击噪声瞬态(60ms 高通噪声,模拟琴槌;独立 start/stop,不入 oscs 列表)
      if (this.pianoNoiseLevel > 0) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const nf = ctx.createBiquadFilter();
        nf.type = "highpass";
        nf.frequency.value = 1200;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(this.pianoNoiseLevel * velocity, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        noise.connect(nf);
        nf.connect(ng);
        ng.connect(g);
        noise.start(t);
        noise.stop(t + 0.06);
      }
      // 钢琴总包络:快速起音 + 长衰减(钢琴无延音)
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(velocity, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5 * this.pianoDecayScale);
      // 声像
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
      this.voiceOrder.push(midi);
      return;
    }

    if (type === "drip") {
      // 梦幻水滴:柔和下滑 + 回声涟漪 + 高八度"星光"长尾
      // 主滴:频率从高处柔滑下滑(曲线缓,不生硬)
      const main = ctx.createOscillator();
      main.type = "sine";
      const ratio = this.dripRatio;
      main.frequency.setValueAtTime(freq * ratio, t);
      main.frequency.exponentialRampToValueAtTime(freq, t + this.dripTimeMs / 1000);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(velocity, t);
      mg.gain.exponentialRampToValueAtTime(0.0001, t + this.dripDecayMs / 1000);
      main.connect(mg);
      mg.connect(g);
      oscs.push(main);
      // 星光层:高八度长尾(梦幻空间感)
      const star = ctx.createOscillator();
      star.type = "sine";
      star.frequency.setValueAtTime(freq * 2 * (1 + (ratio - 1) * 0.25), t);
      star.frequency.exponentialRampToValueAtTime(freq * 2, t + this.dripTimeMs / 1500);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.35 * velocity, t);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + this.dripDecayMs / 1000 * 1.8);
      star.connect(sg);
      sg.connect(g);
      oscs.push(star);
      // 回声涟漪:0.22s 与 0.44s 后两个渐弱的滴(空间回声)
      // 注意:回声振荡器独立 start(不同时间),不加入 oscs 统一管理
      const echoTimes = [0.22, 0.44];
      const echoAmps = [0.3, 0.12];
      for (let ei = 0; ei < echoTimes.length; ei++) {
        const ec = ctx.createOscillator();
        ec.type = "sine";
        const et = t + echoTimes[ei];
        ec.frequency.setValueAtTime(freq * (ratio * 0.7 + 0.3), et);
        ec.frequency.exponentialRampToValueAtTime(freq, et + this.dripTimeMs / 2000);
        const eg2 = ctx.createGain();
        eg2.gain.setValueAtTime(echoAmps[ei] * velocity, et);
        eg2.gain.exponentialRampToValueAtTime(0.0001, et + this.dripDecayMs / 1000);
        ec.connect(eg2);
        eg2.connect(g);
        ec.start(et);
        ec.stop(et + this.dripDecayMs / 1000 + 0.05);
      }
      // 总包络:柔和起音(微升) + 衰减
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(velocity, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + this.dripDecayMs / 1000);
      // 声像
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
      this.voiceOrder.push(midi);
      return;
    }

    if (type === "acc") {
      // PILE1 手风琴:双簧片方波失谐(拍频颤音)+ 低通 + 簧片泛音
      const reeds: OscillatorNode[] = [];
      const dets = [-11, 11];
      for (let i = 0; i < 2; i++) {
        const r = ctx.createOscillator();
        r.type = "square";   // 簧片基础波形(丰富谐波)
        r.frequency.value = freq;
        r.detune.value = dets[i];
        reeds.push(r);
      }
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.min(3000, freq * 3.5 + 800);   // 跟随音高
      filter.Q.value = 1.4;
      for (const r of reeds) r.connect(filter);
      filter.connect(g);
      oscs.push(...reeds);
      // 手风琴包络:快起音 + 持续 + 快释音
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(velocity, t + 0.03);
      g.gain.setValueAtTime(velocity * 0.9, t + 0.12);
      // 声像
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
      this.voiceOrder.push(midi);
      return;
    }

    if (type === "clar") {
      // PILO1 单簧管:方波(闭管=奇数谐波)+ 低通 + 轻颤音(气息感)
      const reeds: OscillatorNode[] = [];
      const r1 = ctx.createOscillator();
      r1.type = "square";
      r1.frequency.value = freq;
      reeds.push(r1);
      // 柔和泛音:第三个奇数谐波轻微混合(单簧管的 3 次谐波特征)
      const r2 = ctx.createOscillator();
      r2.type = "sine";
      r2.frequency.value = freq * 3;
      const r2g = ctx.createGain();
      r2g.gain.value = 0.18;
      r2.connect(r2g);
      r2g.connect(g);
      reeds.push(r2);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.min(2600, freq * 3 + 700);
      filter.Q.value = 1.1;
      r1.connect(filter);
      filter.connect(g);
      oscs.push(...reeds);
      // 轻颤音:5.5Hz 调制主振荡器频率
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const lg = ctx.createGain();
      lg.gain.value = freq * 0.004;
      lfo.connect(lg);
      lg.connect(r1.frequency);
      oscs.push(lfo);
      // 单簧管包络:中速起音 + 持续
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(velocity, t + 0.06);
      g.gain.setValueAtTime(velocity * 0.92, t + 0.2);
      // 声像
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
      this.voiceOrder.push(midi);
      return;
    }

    if (type === "harp" || type === "guzheng") {
      // PILD1 竖琴 / PILS1 古筝:加法拨弦(衰减快/慢,泛音结构不同)
      // 竖琴:泛音丰富衰减快(1.2s);古筝:泛音少衰减长(3s)带金属质
      const isGuzheng = type === "guzheng";
      const H: [number, number][] = isGuzheng
        ? [[1, 1], [2, 0.55], [3, 0.35], [4, 0.18], [5, 0.1], [6, 0.06]]
        : [[1, 1], [2, 0.7], [3, 0.5], [4, 0.38], [5, 0.28], [6, 0.2], [7, 0.13], [8, 0.09], [9, 0.06], [10, 0.04]];
      for (const [n, amp] of H) {
        const o = ctx.createOscillator();
        o.type = "sine";
        // 非调和性(拨弦乐器固有)
        o.frequency.value = freq * n * (1 + INHARMONICITY * n * n);
        const og = ctx.createGain();
        const baseDecay = isGuzheng ? 3.0 : 1.2;
        // 高次泛音衰减更快:衰减时间 ∝ 1/n^0.8
        const decayT = baseDecay / Math.pow(n, 0.8);
        og.gain.setValueAtTime(amp * velocity, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + decayT);
        o.connect(og);
        og.connect(g);
        oscs.push(o);
      }
      // 拨弦瞬态:短促高频噪声(指甲/拨片)
      if (this.pianoNoiseLevel > 0) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const nf = ctx.createBiquadFilter();
        nf.type = "highpass";
        nf.frequency.value = 2500;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime((isGuzheng ? 0.22 : 0.16) * velocity * (this.pianoNoiseLevel / 0.3), t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
        noise.connect(nf);
        nf.connect(ng);
        ng.connect(g);
        noise.start(t);
        noise.stop(t + 0.04);
      }
      // 拨弦包络:瞬时起音 + 自然衰减
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(velocity, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (isGuzheng ? 3.5 : 1.5));
      // 声像
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
      this.voiceOrder.push(midi);
      return;
    }

    if (type === "dx7") {
      // FM 合成:载波正弦 + 调制算子(频率比 1:1 和 1:2),调制指数随包络衰减
      // 算子1:ratio 1, index 3→0.8;算子2:ratio 2, index 2→0.5
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = freq;
      const mkMod = (ratio: number, peak: number, sus: number) => {
        const mod = ctx.createOscillator();
        mod.type = "sine";
        mod.frequency.value = freq * ratio;
        const mg = ctx.createGain();
        // 调制深度 = 指数 × 调制频率
        const peakHz = peak * ratio * freq;
        const susHz = Math.max(0.001, sus * ratio * freq);
        mg.gain.setValueAtTime(peakHz, t);
        mg.gain.exponentialRampToValueAtTime(susHz, t + 0.45);
        mod.connect(mg);
        mg.connect(carrier.frequency);   // FM:调制器输出接到载波频率
        return mod;   // start 统一在末尾
      };
      const m1 = mkMod(1, 3, 0.8);
      const m2 = mkMod(2, 2, 0.5);
      oscs.push(carrier, m1, m2);
      carrier.connect(g);
    } else {
      // 振荡器(数量 1-8 由面板控制,失谐均匀分布在 ±detuneCents)
      // 波形来源:内置/custom 用 PeriodicWave(谐波可调),moog 用面板 oscWave 原生波形
      const useNative = type === "moog";
      const oscsToFilter: OscillatorNode[] = [];
      const n = Math.min(8, Math.max(1, this.oscCount));
      const det = this.detuneCents;
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator();
        if (useNative) {
          o.type = this.oscWave;
        } else {
          o.setPeriodicWave(this.getWave());
        }
        o.frequency.value = freq;
        if (n > 1) {
          // 均匀分布:从 -det 到 +det
          const ratio = n === 2 ? (i === 0 ? -1 : 1) : (i / (n - 1)) * 2 - 1;
          o.detune.value = ratio * det;
        }
        // 颤音 LFO 接到每个振荡器频率
        if (this.vibratoDepth > 0) {
          const lfo = ctx.createOscillator();
          lfo.frequency.value = this.vibratoRate;
          const lg = ctx.createGain();
          lg.gain.value = this.vibratoDepth * freq * 0.05;
          lfo.connect(lg);
          lg.connect(o.frequency);
          oscs.push(lfo);   // LFO 统一 start/stop
        }
        oscsToFilter.push(o);
      }

      // 滤波器(类型/截止/共振/扫频均由面板控制)
      const filter = ctx.createBiquadFilter();
      filter.type = this.filterKind;
      filter.frequency.value = Math.max(20, this.cutoffHz);
      filter.Q.value = this.resonanceQ;
      // 触发扫频(如 TB-303 的酸性上扬)
      if (this.cutoffEnvHz > 0) {
        const base = Math.max(20, this.cutoffHz);
        filter.frequency.setValueAtTime(base, t);
        filter.frequency.exponentialRampToValueAtTime(
          Math.min(18000, base + this.cutoffEnvHz), t + this.cutoffEnvMs / 1000);
      }
      for (const o of oscsToFilter) o.connect(filter);
      filter.connect(g);
      oscs.push(...oscsToFilter);
    }

    // 声像
    const panner = ctx.createStereoPanner();
    panner.pan.value = this.pan;
    g.connect(panner);
    panner.connect(this.master);
    for (const o of oscs) o.start(t);
    this.active.set(midi, { oscs, gain: g, vel: velocity, onT: t });
    this.voiceOrder.push(midi);
  }

  // when 可选:为未来时间调度释放(多轨导出对齐)
  noteOff(midi: number, fast = false, when?: number) {
    const v = this.active.get(midi);
    if (!v) return;
    const t = when ?? this.ctx.currentTime;
    const r = Math.max(fast ? 0.02 : this.release, 0.012);
    // 音龄判断:attack 未完成则先快速补起到可闻电平再释放(否则极短音符无声)
    // cancelAndHoldAtTime 保留当前计算值,不能用 cancelScheduledValues(会取消 attack ramp → 无声)
    const age = t - v.onT;
    if (!fast && age < this.attack + 0.03) {
      v.gain.gain.cancelAndHoldAtTime(t);
      v.gain.gain.linearRampToValueAtTime(v.vel * 0.9, t + 0.006);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.006 + r);
      for (const o of v.oscs) o.stop(t + 0.006 + r + 0.05);
    } else {
      v.gain.gain.cancelAndHoldAtTime(t);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, t + r);
      for (const o of v.oscs) o.stop(t + r + 0.05);
    }
    this.active.delete(midi);
    this.voiceOrder = this.voiceOrder.filter((n) => n !== midi);
  }

  // 换波形:只影响之后按下的音(不干扰正在响的音)
  setWave(type: SynthEngine["waveType"]) {
    this.waveType = type;
    if (type !== "custom") this.customWave = null;
  }
  setCustomWave(anchors: { x: number; y: number }[]) {
    this.customWave = this.buildWave("custom", anchors);
  }
  updateMaster() { this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02); }

  allOff() {
    for (const n of [...this.active.keys()]) this.noteOff(n, true);
  }
}

function interpAnchors(anchors: { x: number; y: number }[], px: number): number {
  if (anchors.length === 0) return 0;
  if (anchors.length === 1) return anchors[0].y;
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (px >= anchors[i].x && px <= anchors[i + 1].x) { lo = anchors[i]; hi = anchors[i + 1]; break; }
  }
  const span = hi.x - lo.x || 1e-6;
  const k = Math.min(1, Math.max(0, (px - lo.x) / span));
  return lo.y + (hi.y - lo.y) * k;
}

// ============ 全局实例(必须在所有使用点之前初始化) ============
const engine = new SynthEngine();
const midiRec = {
  events: [] as { t: number; on: boolean; note: number; vel: number }[],
  recording: false,
  start() { this.events = []; this.recording = true; },
  stop() { this.recording = false; },
  onNote(note: number, on: boolean, vel = 1) {
    if (!this.recording) return;
    this.events.push({ t: performance.now() - recStart, on, note, vel });
  },
};

// ============ 波形编辑器 ============
const waveCanvas = $id("wave-canvas") as HTMLCanvasElement;
const ctx2d = waveCanvas.getContext("2d")!;
const presets = [...document.querySelectorAll(".preset-btn[data-wave]")] as HTMLButtonElement[];

let anchors: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 0.25, y: 0.7 }, { x: 0.5, y: 0 },
  { x: 0.75, y: -0.7 }, { x: 1, y: 0 },
];
let draggingAnchor: { x: number; y: number } | null = null;
let painting = false;          // 画笔模式:按住空白处拖动画波形
const MIN_DX = 0.012;          // 画笔最小采样间距(x 归一化)

function resizeCanvas() {
  const r = waveCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.max(100, Math.round(r.width * dpr));
  waveCanvas.height = Math.max(60, Math.round(r.height * dpr));
}
function canvasXY(e: MouseEvent) {
  const r = waveCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
}
function hitAnchor(px: number, py: number): { x: number; y: number } | null {
  const th = 14 / waveCanvas.width;   // 命中阈值(像素→归一化)
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const a of anchors) {
    const d = Math.hypot(a.x - px, a.y - py);
    if (d < th && d < bd) { bd = d; best = a; }
  }
  return best;
}

// 画笔:在 (x,y) 处落一笔——同 x 附近有锚点就吸附改值,否则插入新锚点
function paintAnchor(x: number, y: number) {
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(-1, y));
  const near = anchors.find((a) => Math.abs(a.x - x) < MIN_DX);
  if (near) { near.y = y; return; }
  const idx = anchors.findIndex((a) => a.x > x);
  const left = idx > 0 ? anchors[idx - 1] : null;
  const right = idx >= 0 ? anchors[idx] : null;
  if (left && Math.abs(left.x - x) < MIN_DX) { left.y = y; return; }
  if (right && Math.abs(right.x - x) < MIN_DX) { right.y = y; return; }
  const insertAt = idx === -1 ? anchors.length : idx;
  anchors.splice(insertAt, 0, { x, y });
}

// rAF 节流:画笔/拖拽期间每帧最多重建一次波形
let redrawQueued = false;
function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    engine.setCustomWave(anchors);
    drawWave();
  });
}

function drawWave() {
  const w = waveCanvas.width, h = waveCanvas.height;
  ctx2d.clearRect(0, 0, w, h);
  const midY = h / 2;
  const isCustom = engine.waveType === "custom";

  // 网格
  ctx2d.strokeStyle = "rgba(149,213,178,0.07)";
  ctx2d.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    ctx2d.beginPath();
    ctx2d.moveTo((w / 8) * i, 0); ctx2d.lineTo((w / 8) * i, h);
    ctx2d.stroke();
  }
  ctx2d.beginPath();
  ctx2d.moveTo(0, midY); ctx2d.lineTo(w, midY);
  ctx2d.stroke();

  // 波形曲线:内置波形按类型函数值,自定义按锚点插值
  ctx2d.strokeStyle = "#95d5b2";
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i <= w; i += 2) {
    const px = i / w;
    const yv = isCustom ? interpAnchors(anchors, px) : builtinWaveAt(engine.waveType, px);
    const y = midY - yv * (h / 2 - 10);
    if (i === 0) ctx2d.moveTo(i, y); else ctx2d.lineTo(i, y);
  }
  ctx2d.stroke();

  // 锚点(仅自定义模式显示)
  if (isCustom) {
    for (const a of anchors) {
      const ax = a.x * w;
      const ay = midY - a.y * (h / 2 - 10);
      ctx2d.beginPath();
      ctx2d.arc(ax, ay, 5, 0, Math.PI * 2);
      ctx2d.fillStyle = "#40916c";
      ctx2d.fill();
      ctx2d.strokeStyle = "#95d5b2";
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();
    }
  }
}

// 内置波形的周期函数值(0..1 → -1..1)
function builtinWaveAt(type: SynthEngine["waveType"], p: number): number {
  switch (type) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "square": return p < 0.5 ? 1 : -1;
    case "saw": return 2 * p - 1;
    case "triangle": return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return presetWaveAt(type, p);   // 合成器预设
  }
}

function applyWaveToEngine() {
  if (engine.waveType === "custom") engine.setCustomWave(anchors);
  else engine.setWave(engine.waveType);
}

function setPreset(type: SynthEngine["waveType"]) {
  const prevType = engine.waveType;
  engine.setWave(type);
  presets.forEach((p) => p.classList.toggle("active", p.dataset.wave === type));
  if (type === "custom") {
    // 从当前内置波形生成初始锚点(用切换前的类型)
    anchors = builtinAnchors(prevType === "custom" ? "sine" : prevType);
    engine.setCustomWave(anchors);
  }
  // 合成器预设:灌入该机型默认参数;面板始终可用(所有波形都走合成器路径)
  if (engine.isSynthPreset(type)) {
    const def = PRESET_DEFS[type];
    if (def) {
      engine.oscWave = def.oscWave;
      engine.oscCount = def.detune ? 2 : 1;
      engine.detuneCents = def.detune ?? 0;
      engine.filterKind = def.filterType ?? "lowpass";
      engine.cutoffHz = def.cutoff ?? 2000;
      engine.resonanceQ = def.resonance ?? 0.7;
      engine.cutoffEnvHz = def.cutoffEnv ?? 0;
      engine.cutoffEnvMs = def.cutoffEnvTime ? def.cutoffEnvTime * 1000 : 90;
    }
    if (type === "dx7") {
      $id("sp-note").textContent = "FM 音色:振荡器参数不适用";
    } else if (type === "piano") {
      $id("sp-note").textContent = "PILZ1 加法合成:钢琴参数可用";
      refreshPianoUI();
    } else if (type === "drip") {
      $id("sp-note").textContent = "PILQ1 频率下滑:水滴参数可用";
      refreshDripUI();
    } else {
      $id("sp-note").textContent = "已加载机型默认参数";
      refreshSynthUI();
    }
  }
  refreshPianoUI();
  refreshDripUI();
  drawWave();
}

// 内置波形 → 锚点采样(进入自定义编辑的起点)
function builtinAnchors(type: SynthEngine["waveType"]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const M = 16;
  for (let i = 0; i <= M; i++) {
    const p = i / M;
    pts.push({ x: p, y: builtinWaveAt(type, p) });
  }
  return pts;
}

// ============ 数学函数解析器 ============
// 支持:数字、x、pi、e、+-*/^、括号、一元负号、
//       sin cos tan asin acos atan abs sqrt cbrt ln log floor ceil round
class FnParser {
  private s = "";
  private i = 0;
  static parse(src: string): ((x: number) => number) | null {
    const p = new FnParser();
    p.s = src.replace(/\s+/g, "").toLowerCase();
    try {
      const fn = p.expr();
      if (p.i !== p.s.length) return null;
      return fn;
    } catch { return null; }
  }
  private peek(): string { return this.s[this.i] ?? ""; }
  private eat(c: string): boolean {
    if (this.peek() === c) { this.i++; return true; }
    return false;
  }
  private expr(): (x: number) => number {
    let left = this.term();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.peek();
      this.i++;
      const right = this.term();
      const l = left;
      left = op === "+" ? ((x) => l(x) + right(x)) : ((x) => l(x) - right(x));
    }
    return left;
  }
  private term(): (x: number) => number {
    let left = this.pow();
    while (this.peek() === "*" || this.peek() === "/") {
      const op = this.peek();
      this.i++;
      const right = this.pow();
      const l = left;
      left = op === "*" ? ((x) => l(x) * right(x)) : ((x) => l(x) / right(x));
    }
    return left;
  }
  private pow(): (x: number) => number {
    const base = this.unary();
    if (this.eat("^")) {
      const exp = this.unary();
      const b = base;
      return (x) => Math.pow(b(x), exp(x));
    }
    return base;
  }
  private unary(): (x: number) => number {
    if (this.eat("-")) {
      const v = this.unary();
      return (x) => -v(x);
    }
    if (this.eat("+")) return this.unary();
    return this.primary();
  }
  private primary(): (x: number) => number {
    const c = this.peek();
    // 函数调用
    if (/[a-z]/.test(c)) {
      let name = "";
      while (/[a-z0-9]/.test(this.peek())) name += this.peek(), this.i++;
      if (this.eat("(")) {
        const inner = this.expr();
        if (!this.eat(")")) throw new Error("括号不匹配");
        const FUNCS: Record<string, (v: number) => number> = {
          sin: Math.sin, cos: Math.cos, tan: Math.tan,
          asin: Math.asin, acos: Math.acos, atan: Math.atan,
          abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt,
          ln: Math.log, log: Math.log10, floor: Math.floor,
          ceil: Math.ceil, round: Math.round,
        };
        const f = FUNCS[name];
        if (!f) throw new Error("未知函数: " + name);
        return (x) => f(inner(x));
      }
      // 常量
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      if (name === "x") return (x) => x;
      throw new Error("未知符号: " + name);
    }
    // 数字
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (/[0-9.]/.test(this.peek())) num += this.peek(), this.i++;
      const v = parseFloat(num);
      return () => v;
    }
    if (this.eat("(")) {
      const inner = this.expr();
      if (!this.eat(")")) throw new Error("括号不匹配");
      return inner;
    }
    throw new Error("无法解析: " + c);
  }
}

// 应用数学函数 → 生成锚点波形(自动切到自定义模式)
function applyFunctionWave(expr: string) {
  const fn = FnParser.parse(expr);
  if (!fn) { toast("表达式无法解析"); return; }
  const N = 48;
  const pts: { x: number; y: number }[] = [];
  let min = Infinity, max = -Infinity;
  for (let i = 0; i <= N; i++) {
    const p = i / N;
    const v = fn(p);
    if (!isFinite(v)) { toast("函数值超出范围(检查 tan 等奇异点)"); return; }
    if (v < min) min = v;
    if (v > max) max = v;
    pts.push({ x: p, y: v });
  }
  const range = max - min;
  if (range < 1e-9) { toast("函数值恒为常数"); return; }
  // 归一化到 -1..1
  for (const pt of pts) {
    pt.y = ((pt.y - min) / range) * 2 - 1;
    pt.y = Math.min(1, Math.max(-1, pt.y));
  }
  anchors = pts;
  engine.setWave("custom");
  engine.setCustomWave(anchors);
  presets.forEach((p) => p.classList.toggle("active", p.dataset.wave === "custom"));
  $id("sp-note").textContent = "";
  drawWave();
  toast("已应用函数波形");
}

$id("btn-apply-fn").addEventListener("click", () => {
  const v = ($id("fn-input") as HTMLInputElement).value.trim();
  if (v) applyFunctionWave(v);
});
$id("fn-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = ($id("fn-input") as HTMLInputElement).value.trim();
    if (v) applyFunctionWave(v);
  }
});

waveCanvas.addEventListener("mousedown", (e) => {
  if (engine.waveType !== "custom") return;
  if (e.button === 2) return; // 右键单独处理
  const { x, y } = canvasXY(e);
  const hit = hitAnchor(x, y);
  if (hit) {
    draggingAnchor = hit;
  } else {
    // 空白处按下:进入画笔模式,立即落第一笔
    painting = true;
    paintAnchor(x, y);
    scheduleRedraw();
  }
});
window.addEventListener("mousemove", (e) => {
  const { x, y } = canvasXY(e);
  if (draggingAnchor) {
    draggingAnchor.x = Math.min(1, Math.max(0, x));
    draggingAnchor.y = Math.min(1, Math.max(-1, y));
    anchors.sort((a, b) => a.x - b.x);
    scheduleRedraw();
  } else if (painting) {
    paintAnchor(x, y);
    scheduleRedraw();
  }
});
window.addEventListener("mouseup", () => {
  draggingAnchor = null;
  painting = false;
});
waveCanvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (engine.waveType !== "custom") return;
  const { x, y } = canvasXY(e);
  const hit = hitAnchor(x, y);
  if (hit) {
    // 保留首尾端点
    const isEnd = anchors[0] === hit || anchors[anchors.length - 1] === hit;
    if (!isEnd) {
      anchors = anchors.filter((a) => a !== hit);
      engine.setCustomWave(anchors);
      drawWave();
    }
  }
});

presets.forEach((p) =>
  p.addEventListener("click", () => { setPreset(p.dataset.wave as SynthEngine["waveType"]); engine.reload(); })
);
$id("btn-smooth").addEventListener("click", () => {
  if (engine.waveType !== "custom") return;
  smoothAnchors();
  engine.setCustomWave(anchors);
  drawWave();
});
function smoothAnchors() {
  const inner = anchors.slice(1, -1);
  if (inner.length === 0) return;
  const copy = [...inner];
  for (let i = 0; i < copy.length; i++) {
    const prev = i > 0 ? copy[i - 1] : anchors[0];
    const next = i < copy.length - 1 ? copy[i + 1] : anchors[anchors.length - 1];
    inner[i].y = (prev.y + copy[i].y * 2 + next.y) / 4;
  }
}
$id("btn-reset-wave").addEventListener("click", () => {
  if (engine.waveType !== "custom") return;
  anchors = builtinAnchors(engine.waveType);
  engine.setCustomWave(anchors);
  drawWave();
});
$id("harmonics").addEventListener("input", (e) => {
  engine.harmonics = Number((e.target as HTMLInputElement).value);
  applyWaveToEngine();
});

// ============ 电脑键盘映射 ============
// 分区式布局:数字行全黑键(按黑键音阶连续),QWERTY + ASDF 两排白键
// 数字行: 1=C#3 2=D#3 3=F#3 4=G#3 5=A#3 6=C#4 7=D#4 8=F#4 9=G#4 0=A#4
// QWERTY: Q-P = C3 D3 E3 F3 G3 A3 B3 C4 D4 E4
// ASDF:   A-;  = C4 D4 E4 F4 G4 A4 B4 C5 D5 E5
const KEYMAP: Record<string, number> = {
  // 黑键行(数字 1-0,连续黑键音阶)
  Digit1: 49, Digit2: 51, Digit3: 54, Digit4: 56, Digit5: 58,
  Digit6: 61, Digit7: 63, Digit8: 66, Digit9: 68, Digit0: 70,
  // 白键行 1(QWERTY):C3-E4
  KeyQ: 48, KeyW: 50, KeyE: 52, KeyR: 53, KeyT: 55,
  KeyY: 57, KeyU: 59, KeyI: 60, KeyO: 62, KeyP: 64,
  // 白键行 2(ASDF):C4-E5
  KeyA: 60, KeyS: 62, KeyD: 64, KeyF: 65, KeyG: 67,
  KeyH: 69, KeyJ: 71, KeyK: 72, KeyL: 74, Semicolon: 76,
};
let octaveShift = 0;
const heldKeys = new Map<string, number>(); // code → midi

window.addEventListener("keydown", (e) => {
  // 焦点在输入框时,按键只用于输入,不触发音符
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.repeat) return;
  if (e.code === "ArrowUp") { shiftOctave(1); return; }
  if (e.code === "ArrowDown") { shiftOctave(-1); return; }
  const base = KEYMAP[e.code];
  if (base === undefined) return;
  e.preventDefault();
  const midi = base + octaveShift * 12;
  if (heldKeys.has(e.code)) return;
  heldKeys.set(e.code, midi);
  noteOn(midi);
});
window.addEventListener("keyup", (e) => {
  const midi = heldKeys.get(e.code);
  if (midi === undefined) return;
  heldKeys.delete(e.code);
  noteOff(midi);
});
window.addEventListener("blur", () => { heldKeys.clear(); engine.allOff(); updateKeysUI(); });

// ============ 力度曲线(输入力度 → 输出力度) ============
// 锚点:x 固定 [0, 0.25, 0.5, 0.75, 1],y 可拖拽;分段线性插值
const velAnchors: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 }, { x: 1, y: 1 },
];
let velDragging: number | null = null;
let velMin = 0.2;    // 响度下限:0-1(任何真实按击输出不低于此值,轻按也有声)
let velPower = 1;    // 衰减强度:0.3-3(曲线指数,>1 更重按才响,<1 更轻按易响)

// 预设曲线填充锚点
const VEL_CURVES: Record<string, number[]> = {
  linear: [0, 0.25, 0.5, 0.75, 1],
  exp:    [0, 0.5, 0.707, 0.866, 1],      // 轻按易响(y=x^0.5)
  log:    [0, 0.0625, 0.25, 0.5625, 1],   // 重按才响(y=x^2)
  s:      [0, 0.1, 0.5, 0.9, 1],          // 中间平滑过渡
};

// 应用力度曲线:锚点插值 → 衰减强度指数 → 响度下限
function applyVelocityCurve(v: number): number {
  const n = velAnchors.length;
  let out: number;
  if (v <= velAnchors[0].x) out = velAnchors[0].y;
  else if (v >= velAnchors[n - 1].x) out = velAnchors[n - 1].y;
  else {
    out = v;
    for (let i = 0; i < n - 1; i++) {
      const a = velAnchors[i], b = velAnchors[i + 1];
      if (v >= a.x && v <= b.x) {
        const t = (v - a.x) / (b.x - a.x);
        out = a.y + (b.y - a.y) * t;
        break;
      }
    }
  }
  // 衰减强度(曲线指数变形)
  if (velPower !== 1) out = Math.pow(Math.max(0, out), velPower);
  // 响度下限:任何真实按击(力度>1%)输出不低于下限——轻按也有声
  if (velMin > 0 && v > 0.01) out = Math.max(out, velMin);
  return out;
}
const velCanvas = $id("vel-canvas") as HTMLCanvasElement;
const velCtx = velCanvas.getContext("2d")!;

function resizeVelCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = velCanvas.getBoundingClientRect();
  velCanvas.width = Math.max(100, Math.round(r.width * dpr));
  velCanvas.height = Math.max(60, Math.round(r.height * dpr));
  velCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawVelCurve() {
  const cw = velCanvas.width / (window.devicePixelRatio || 1);
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const px = (x: number) => pad + x * (cw - pad * 2);
  const py = (y: number) => ch - pad - y * (ch - pad * 2);
  velCtx.clearRect(0, 0, cw, ch);
  // 参考对角线(线性虚线)
  velCtx.strokeStyle = "rgba(149,213,178,0.25)";
  velCtx.setLineDash([4, 4]);
  velCtx.beginPath();
  velCtx.moveTo(px(0), py(0));
  velCtx.lineTo(px(1), py(1));
  velCtx.stroke();
  velCtx.setLineDash([]);
  // 曲线(实际映射:锚点插值 + 响度/衰减变换后的采样曲线)
  velCtx.strokeStyle = "#7dff9b";
  velCtx.lineWidth = 2;
  velCtx.shadowColor = "rgba(125,255,155,0.4)";
  velCtx.shadowBlur = 5;
  velCtx.beginPath();
  const SAMPLES = 60;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = i / SAMPLES;
    const y = applyVelocityCurve(x);
    const sx = px(x), sy = py(y);
    if (i === 0) velCtx.moveTo(sx, sy);
    else velCtx.lineTo(sx, sy);
  }
  velCtx.stroke();
  velCtx.shadowBlur = 0;
  // 锚点
  for (const a of velAnchors) {
    velCtx.fillStyle = "#95d5b2";
    velCtx.beginPath();
    velCtx.arc(px(a.x), py(a.y), 4, 0, Math.PI * 2);
    velCtx.fill();
    velCtx.strokeStyle = "#06130c";
    velCtx.lineWidth = 1.5;
    velCtx.stroke();
  }
}

// 拖拽锚点(只改 y)
velCanvas.addEventListener("mousedown", (e) => {
  const r = velCanvas.getBoundingClientRect();
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const mx = (e.clientX - r.left - pad) / (r.width - pad * 2);
  const my = 1 - (e.clientY - r.top - pad) / (ch - pad * 2);
  let best = -1, bestD = 0.12;
  for (let i = 0; i < velAnchors.length; i++) {
    const d = Math.hypot(velAnchors[i].x - mx, velAnchors[i].y - my);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) velDragging = best;
});
window.addEventListener("mousemove", (e) => {
  if (velDragging === null) return;
  const r = velCanvas.getBoundingClientRect();
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const my = 1 - (e.clientY - r.top - pad) / (ch - pad * 2);
  velAnchors[velDragging].y = Math.min(1, Math.max(0, my));
  // 保持 0 端锚点在 0、1 端锚点在 1(不破坏手感边界)
  if (velDragging === 0) velAnchors[0].y = 0;
  if (velDragging === velAnchors.length - 1) velAnchors[velAnchors.length - 1].y = 1;
  drawVelCurve();
});
window.addEventListener("mouseup", () => { velDragging = null; });
window.addEventListener("resize", () => { resizeVelCanvas(); drawVelCurve(); });

// 预设曲线按钮(点击后重载引擎,修复切换后音频会话失效静音)
$id("vel-presets").querySelectorAll(".preset-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $id("vel-presets").querySelectorAll(".preset-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const ys = VEL_CURVES[(b as HTMLElement).dataset.curve as string];
    if (ys) {
      for (let i = 0; i < velAnchors.length; i++) velAnchors[i].y = ys[i];
      drawVelCurve();
    }
    engine.reload();   // 切换后重载音频引擎(消除静音)
  });
});
resizeVelCanvas();
drawVelCurve();

// 响度下限滑块
$id("vel-min").addEventListener("input", () => {
  velMin = Number(($id("vel-min") as HTMLInputElement).value) / 100;
  $id("vel-min-val").textContent = Math.round(velMin * 100) + "%";
  drawVelCurve();
});
// 衰减强度滑块
$id("vel-power").addEventListener("input", () => {
  velPower = Number(($id("vel-power") as HTMLInputElement).value) / 100;
  $id("vel-power-val").textContent = velPower.toFixed(1) + "x";
  drawVelCurve();
});

// ============ 转录(SMF 文件 / 录音流程 → 简谱) ============
// 简谱:1-7 数字 + ' 高八度 + _ 低八度;半音用 # 前缀
const JP_NUMS = ["1", "#1", "2", "#2", "3", "4", "#4", "5", "#5", "6", "#6", "7"];

function midiToJianpu(midi: number): string {
  const pc = midi % 12;
  const oct = Math.floor(midi / 12) - 1;   // C4 = 60 → oct 4
  const base = JP_NUMS[pc];
  if (oct === 4) return base;
  if (oct > 4) return base + "'".repeat(Math.min(3, oct - 4));    // 高音
  return base + "_".repeat(Math.min(3, 4 - oct));                  // 低音
}

const transState = {
  mode: "file" as "file" | "flow",
  t0: 0,
  notes: [] as { note: number; vel: number; t: number }[],
  fileName: "",
  // 文件转录的原始解析数据(用于多轨/速度/导出)
  smf: null as null | {
    notes: SmfNote[];
    division: number;
    ntrks: number;
    usPerQuarter: number;
    beatsPerBar: number;
  },
};

// 时值标记:按拍数 → 简谱时值符号(标准记谱)
function jpDuration(beats: number): string {
  if (beats >= 3.5) return "---";   // 全音符
  if (beats >= 1.5) return "-";     // 二分音符
  if (beats >= 0.75) return "";     // 四分音符
  if (beats >= 0.375) return "_";   // 八分音符
  return "__";                      // 十六分音符
}

function velLabel(v: number): string {
  return v < 0.4 ? "弱" : v < 0.75 ? "中" : "强";
}

// 标准简谱渲染(多轨 + 小节线 + 休止 + 和弦 + 时值)
function renderTranscription() {
  const el = $id("trans-output");
  if (transState.mode === "file" && transState.smf) {
    renderSmfJianpu(transState.smf, el);
    return;
  }
  // 录音流程:按时间轴渲染(单轨)
  if (transState.notes.length === 0) { el.textContent = ""; return; }
  const sorted = [...transState.notes].sort((a, b) => a.t - b.t);
  const groups: { t: number; items: { note: number; vel: number }[] }[] = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && n.t - last.t < 30) last.items.push({ note: n.note, vel: n.vel });
    else groups.push({ t: n.t, items: [{ note: n.note, vel: n.vel }] });
  }
  const lines: string[] = [];
  let line: string[] = [];
  let prevT: number | null = null;
  for (const g of groups) {
    const jp = g.items.length === 1
      ? midiToJianpu(g.items[0].note) + jpDuration(prevT === null ? 0 : (g.t - prevT) / 500) + "·" + velLabel(g.items[0].vel)
      : "(" + g.items.map((i) => midiToJianpu(i.note)).join(" ") + ")·" + velLabel(g.items[0].vel);
    line.push(jp);
    prevT = g.t;
    if (line.length >= 10) { lines.push(line.join("  ")); line = []; }
  }
  if (line.length) lines.push(line.join("  "));
  el.textContent = lines.join("\n");
}

// 文件简谱:多轨独立渲染,小节线按拍号,休止符补空拍
function renderSmfJianpu(smf: NonNullable<typeof transState.smf>, el: HTMLElement) {
  if (smf.notes.length === 0) { el.textContent = "文件中没有音符事件"; return; }
  const bpm = Math.round(60000000 / smf.usPerQuarter);
  const sorted = [...smf.notes].sort((a, b) => a.tick - b.tick);
  const endTick = sorted.reduce((m, n) => Math.max(m, n.tick + n.dur), 0);
  const totalSec = (endTick / smf.division) * (smf.usPerQuarter / 1e6);
  // 按轨道分组
  const tracks = new Map<number, SmfNote[]>();
  for (const n of sorted) {
    if (!tracks.has(n.track)) tracks.set(n.track, []);
    tracks.get(n.track)!.push(n);
  }
  const parts: string[] = [];
  parts.push(`文件 ${transState.fileName} · ${bpm} BPM · ${smf.beatsPerBar} 拍/小节 · ${smf.notes.length} 音符 · ${tracks.size} 轨 · 时长 ${totalSec.toFixed(1)}s`);
  parts.push("=".repeat(46));
  for (const [tr, notes] of [...tracks.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`轨道 ${tr + 1}(${notes.length} 音符):`);
    const trSorted = [...notes].sort((a, b) => a.tick - b.tick);
    // 同 tick 合并为和弦
    const groups: { tick: number; items: SmfNote[] }[] = [];
    for (const n of trSorted) {
      const last = groups[groups.length - 1];
      if (last && n.tick - last.tick < 10) last.items.push(n);
      else groups.push({ tick: n.tick, items: [n] });
    }
    let line = "";
    let barBeats = 0;          // 当前小节累计拍数
    let prevTick = 0;
    const pushBar = () => { line = line.trimEnd(); line += " | "; barBeats = 0; };
    line = "| ";
    for (const g of groups) {
      // 补休止:前一个音符结束到本音符开始之间的空拍
      const gapTicks = g.tick - prevTick;
      if (gapTicks > 0 && groups.indexOf(g) > 0) {
        let gapBeats = gapTicks / smf.division;
        while (gapBeats >= 0.25) {
          const r = gapBeats >= 3.5 ? 4 : gapBeats >= 1.5 ? 2 : gapBeats >= 0.75 ? 1 : gapBeats >= 0.375 ? 0.5 : 0.25;
          line += "0" + jpDuration(r) + " ";
          barBeats += r;
          gapBeats -= r;
          while (barBeats >= smf.beatsPerBar) pushBar();
        }
      }
      // 本组音符:时值取第一个音的时长
      const durBeats = Math.max(0.25, g.items[0].dur / smf.division);
      const jp = g.items.length === 1
        ? midiToJianpu(g.items[0].note) + jpDuration(durBeats)
        : "(" + g.items.map((i) => midiToJianpu(i.note)).join(" ") + ")" + jpDuration(durBeats);
      line += jp + " ";
      barBeats += durBeats;
      while (barBeats >= smf.beatsPerBar) pushBar();
      prevTick = g.tick + g.items[0].dur;
    }
    // 结尾补齐休止到小节线
    while (barBeats < smf.beatsPerBar && barBeats > 0) {
      line += "0 ";
      barBeats += 1;
    }
    line = line.trimEnd() + " |";
    parts.push(line);
    parts.push("");
  }
  el.textContent = parts.join("\n");
}

// ============ 标准 MIDI 文件(SMF)解析 ============
// MThd / MTrk、VLQ 变长、运行状态、tempo/拍号、note on/off 组装
interface SmfNote { tick: number; dur: number; note: number; vel: number; ch: number; track: number; }

function readVLQ(bytes: Uint8Array, pos: { i: number }): number {
  let v = 0, b = 0;
  do {
    b = bytes[pos.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return v;
}

function parseSmf(bytes: Uint8Array): { notes: SmfNote[]; division: number; ntrks: number; usPerQuarter: number; beatsPerBar: number } {
  const pos = { i: 0 };
  const rd = (n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 8) | bytes[pos.i++];
    return v;
  };
  if (rd(4) !== 0x4d546864) throw new Error("不是标准 MIDI 文件(MThd 缺失)");
  rd(4);                       // header len
  rd(2);                       // format(0/1/2,解析时不依赖)
  const ntrks = rd(2);
  const division = rd(2);      // ticks per quarter(bit15=1 为 SMPTE,少见)
  if (division & 0x8000) throw new Error("SMPTE 时间码 MIDI 暂不支持");

  let usPerQuarter = 500000;   // 默认 120 BPM
  let beatsPerBar = 4;         // 默认 4/4

  const rawEvents: { track: number; tick: number; ch: number; note: number; vel: number; on: boolean }[] = [];
  for (let tr = 0; tr < ntrks; tr++) {
    if (rd(4) !== 0x4d54726b) throw new Error("轨道头 MTrk 缺失");
    const len = rd(4);
    const end = pos.i + len;
    let tick = 0;
    let running = 0;
    while (pos.i < end) {
      tick += readVLQ(bytes, pos);
      let status = bytes[pos.i];
      if (status >= 0x80) { pos.i++; if (status < 0xf0) running = status; }
      else status = running;
      if (status >= 0xf0) {
        if (status === 0xff) {
          // Meta 事件:tempo(51)与拍号(58)需要解析
          const mtype = bytes[pos.i++];
          const mlen = readVLQ(bytes, pos);
          if (mtype === 0x51 && mlen >= 3) {
            // Set Tempo:3 字节 µs/四分音符
            const us = (bytes[pos.i] << 16) | (bytes[pos.i + 1] << 8) | bytes[pos.i + 2];
            usPerQuarter = us;
          } else if (mtype === 0x58 && mlen >= 2) {
            // 拍号:nn dd cc bb(nn=每小节拍数,dd=分母幂)
            beatsPerBar = bytes[pos.i];
          }
          pos.i += mlen;
        } else {
          // Sysex F0/F7:跳过
          const slen = readVLQ(bytes, pos);
          pos.i += slen;
        }
        continue;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) { pos.i += 1; continue; }   // 程序/通道压力
      const d1 = bytes[pos.i++];
      const d2 = bytes[pos.i++];
      if (kind === 0x90 && d2 > 0) rawEvents.push({ track: tr, tick, ch, note: d1, vel: d2, on: true });
      else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) rawEvents.push({ track: tr, tick, ch, note: d1, vel: 0, on: false });
    }
    pos.i = end;
  }

  // note on/off 组装:同 (track,ch,note) 匹配最近未闭合的 on
  const open = new Map<string, { tick: number; vel: number }>();
  const notes: SmfNote[] = [];
  for (const e of rawEvents) {
    const key = e.track + ":" + e.ch + ":" + e.note;
    if (e.on) {
      open.set(key, { tick: e.tick, vel: e.vel });
    } else {
      const s = open.get(key);
      if (s) {
        notes.push({ tick: s.tick, dur: Math.max(1, e.tick - s.tick), note: e.note, vel: s.vel, ch: e.ch, track: e.track });
        open.delete(key);
      }
    }
  }
  return { notes, division, ntrks, usPerQuarter, beatsPerBar };
}

// ============ 转录(MIDI 文件播放:虚拟按键) ============
// 打开 MIDI 文件:解析 + 显示简谱
$id("btn-trans-open").addEventListener("click", async () => {
  try {
    const [b64, name] = await invoke<[string, string]>("open_midi");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = parseSmf(bytes);
    transState.smf = parsed;
    transState.fileName = name;
    transState.notes = [];
    const bpm = Math.round(60000000 / parsed.usPerQuarter);
    $id("trans-status").textContent =
      `已加载 ${name} · ${bpm} BPM · ${parsed.ntrks} 轨 · ${parsed.notes.length} 音符 — 点播放(虚拟按键演奏)`;
    $id("trans-status").classList.add("on");
    renderTranscription();   // 同时显示简谱
  } catch (err) {
    if (String(err).includes("已取消")) return;
    $id("trans-status").textContent = "打开失败: " + String(err).slice(0, 60);
    $id("trans-status").classList.remove("on");
  }
});

// 播放:按每轨音色用 AudioContext 时钟调度 + UI 实时跟随(琴键/LED)
let transPlaying = false;
let playProgTimer = 0;   // 播放进度定时器
const playNotes = new Set<number>();   // 播放期间高亮的琴键
let playUiTimers: number[] = [];

function playUiCleanup() {
  for (const t of playUiTimers) window.clearTimeout(t);
  playUiTimers = [];
  playNotes.clear();
  updateKeysUI();
}

// 虚拟按键:与键盘输入完全一致的播放路径(跳过力度曲线,用 MIDI 原始力度)
function playNoteOn(midi: number, vel: number) {
  engine.noteOn(midi, vel);
  ledBlink();
  updateKeysUI();
}
function playNoteOff(midi: number) {
  engine.noteOff(midi);
  updateKeysUI();
}

$id("btn-trans-play").addEventListener("click", async () => {
  if (!transState.smf || transState.smf.notes.length === 0) {
    toast("请先打开 MIDI 文件");
    return;
  }
  if (transPlaying) return;
  const smf = transState.smf;
  await engine.resume();
  engine.allOff();
  playUiCleanup();
  // 生成按键事件流:所有轨道音符合并,按时间排序(不做音色/轨道区分)
  const events: { t: number; on: boolean; midi: number; vel: number }[] = [];
  for (const n of smf.notes) {
    events.push({ t: n.tick, on: true, midi: n.note, vel: Math.max(1, Math.round(n.vel)) });
    events.push({ t: n.tick + n.dur, on: false, midi: n.note, vel: 0 });
  }
  events.sort((a, b) => a.t - b.t);
  const secPerTick = (smf.usPerQuarter / 1e6) / smf.division;
  const endTick = events[events.length - 1].t;
  const totalSec = endTick * secPerTick;
  const fmt = (s: number) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const totalStr = fmt(totalSec);
  // 启动:300ms 后开始"按键"
  const startWall = performance.now() + 300;
  transPlaying = true;
  $id("btn-trans-play").classList.add("running");
  $id("trans-status").textContent = `播放中 00:00 / ${totalStr}`;
  let idx = 0;
  const drive = () => {
    if (!transPlaying) return;
    const el = (performance.now() - startWall) / 1000;
    // 触发所有到期按键(模拟键盘输入)
    while (idx < events.length && events[idx].t * secPerTick <= el) {
      const ev = events[idx++];
      if (ev.on) playNoteOn(ev.midi, ev.vel / 127);
      else playNoteOff(ev.midi);
    }
    $id("trans-status").textContent = `播放中 ${fmt(Math.max(0, el))} / ${totalStr}`;
    if (el < totalSec + 0.4) {
      requestAnimationFrame(drive);
    } else {
      transPlaying = false;
      $id("btn-trans-play").classList.remove("running");
      $id("trans-status").textContent = "播放完成";
      engine.allOff();
      updateKeysUI();
    }
  };
  requestAnimationFrame(drive);
});

// 停止播放
$id("btn-trans-stop").addEventListener("click", () => {
  engine.allOff();
  transPlaying = false;
  if (playProgTimer) { window.clearInterval(playProgTimer); playProgTimer = 0; }
  $id("btn-trans-play").classList.remove("running");
  $id("trans-status").textContent = "已停止";
  playUiCleanup();
});

$id("btn-trans-clear").addEventListener("click", () => {
  engine.allOff();
  transState.notes = [];
  transState.smf = null;
  transState.fileName = "";
  $id("trans-output").textContent = "";
  $id("trans-status").textContent = "已清空";
  $id("trans-status").classList.remove("on");
});

// 录音转录(录音选项卡):从录音的 MIDI 事件转简谱
$id("btn-trans-flow").addEventListener("click", transcribeFlow);
function transcribeFlow() {
  const evs = midiRec.events.filter((e) => e.on);
  const out = $id("rec-output");
  if (evs.length === 0) {
    out.textContent = "没有录到音符,请先录音并弹奏";
    return;
  }
  transState.notes = evs.map((e) => ({ note: e.note, vel: e.vel, t: e.t }));
  transState.t0 = 0;
  renderTranscription();
  out.textContent = $id("trans-output").textContent;
  $id("trans-status").textContent = "录音转录:完成(" + evs.length + " 个音符)";
  $id("trans-status").classList.add("on");
}

// ============ 演奏调度(统一入口:键盘/鼠标/MIDI 都走这) ============

const ledEl = $id("in-led");
let ledTimer: number | null = null;
// 输入指示灯:有音符输入就点亮,停止输入 120ms 后熄灭
function ledBlink() {
  ledEl.classList.add("on");
  if (ledTimer) window.clearTimeout(ledTimer);
  ledTimer = window.setTimeout(() => ledEl.classList.remove("on"), 120);
}

function noteOn(midi: number, velocity = 1) {
  const v = applyVelocityCurve(velocity);   // 力度曲线映射
  engine.noteOn(midi, v);
  ledBlink();
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x90, midi, Math.round(v * 127)] }).catch(() => {});
  }
  midiRec.onNote(midi, true, v);
  updateKeysUI();
}
function noteOff(midi: number) {
  engine.noteOff(midi);
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x80, midi, 0] }).catch(() => {});
  }
  midiRec.onNote(midi, false);
  updateKeysUI();
}

// ============ 琴键 UI ============
const keyboardEl = $id("keyboard");
const LOW_NOTE = 36;   // C2
const HIGH_NOTE = 83;  // B5 → 显示 3 个八度(覆盖 Vboard 25 常见 C2-C6 范围)
const keyEls = new Map<number, HTMLElement>();

// 重建琴键(octaveShift 变化时整体平移)
function buildKeyboard() {
  const low = LOW_NOTE + octaveShift * 12;
  const high = HIGH_NOTE + octaveShift * 12;
  keyboardEl.innerHTML = "";
  keyEls.clear();
  const whiteNotes: number[] = [];
  for (let n = low; n <= high; n++) if (!isBlack(n)) whiteNotes.push(n);
  const wCount = whiteNotes.length;
  const whiteW = 100 / wCount;
  for (const n of whiteNotes) {
    const el = document.createElement("div");
    el.className = "key white";
    el.style.left = (whiteNotes.indexOf(n) * whiteW) + "%";
    el.style.width = whiteW + "%";
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = noteName(n);
    el.appendChild(label);
    bindKey(el, n);
    keyboardEl.appendChild(el);
    keyEls.set(n, el);
  }
  // 黑键:插在两个白键之间,宽度约为白键的 62%
  for (let n = low; n <= high; n++) {
    if (!isBlack(n)) continue;
    const left = whiteNotes.indexOf(n - 1);
    const el = document.createElement("div");
    el.className = "key black";
    const centerPct = (left + 1) * whiteW;
    const blackW = whiteW * 0.62;
    el.style.left = (centerPct - blackW / 2) + "%";
    el.style.width = blackW + "%";
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = noteName(n);
    el.appendChild(label);
    bindKey(el, n);
    keyboardEl.appendChild(el);
    keyEls.set(n, el);
  }
}
function isBlack(n: number) { return [1, 3, 6, 8, 10].includes(n % 12); }

const mouseKeys = new Map<number, boolean>();
function bindKey(el: HTMLElement, midi: number) {
  const on = (e: Event) => {
    e.preventDefault();
    if (mouseKeys.get(midi)) return;
    mouseKeys.set(midi, true);
    noteOn(midi);
  };
  const off = () => {
    if (!mouseKeys.get(midi)) return;
    mouseKeys.delete(midi);
    noteOff(midi);
  };
  el.addEventListener("mousedown", on);
  el.addEventListener("mouseenter", (e) => { if ((e as MouseEvent).buttons & 1) on(e); });
  window.addEventListener("mouseup", off);
}
function updateKeysUI() {
  const active = new Set([...engine.active.keys()]);
  // 播放期间高亮的琴键也计入
  if (transPlaying) for (const n of playNotes) active.add(n);
  keyEls.forEach((el, midi) => el.classList.toggle("active", active.has(midi)));
  // 当前音符显示
  const sorted = [...active].sort((a, b) => a - b);
  $id("nd-notes").textContent = sorted.length ? sorted.map(noteName).join(" ") : "-";
}

// ============ MIDI 输入 ============
// 走 Rust midir 原生层(WebView2 Web MIDI 实例不稳定):invoke 枚举/连接,event 收消息

let midiOutPort: number | null = null;   // 输出端口索引(选择器 value)
let midiOctave = 0;   // MIDI 键盘八度偏移(CC14/15 调节)

// MIDI CC 控制:旋钮/调制轮(CC1/74/91)→ 混响;CC14/15 → 八度
function handleMidiCC(cc: number, val: number) {
  if (cc === 14 || cc === 15) {
    midiOctave = Math.min(2, Math.max(-2, midiOctave + (cc === 15 ? 1 : -1)));
    toast(`MIDI 八度: ${noteName(48 + midiOctave * 12)}`);
    return;
  }
  if (cc === 1 || cc === 74 || cc === 91) {
    const v = val / 127;
    engine.setReverb(v);
    const slider = $id("reverb") as HTMLInputElement;
    slider.value = String(Math.round(v * 100));
    $id("reverb-val").textContent = Math.round(v * 100) + "%";
  }
}

async function initMidi() {
  const st = $id("midi-status");
  try {
    const [inputs, outputs] = await invoke<[string[], string[]]>("midi_list_devices");
    st.textContent = inputs.length ? `MIDI: 已连接(${inputs.length} 输入)` : "MIDI: 就绪(无输入)";
    st.classList.toggle("on", inputs.length > 0);

    // 自动连接第一个输入端
    if (inputs.length > 0) {
      await invoke("midi_start_input", { port: 0 });
      st.textContent = `MIDI: 已连接(${inputs[0]})`;
      st.classList.add("on");
      toast("MIDI 输入: " + inputs[0]);
    }

    // 输出下拉
    const sel = $id("midi-out") as HTMLSelectElement;
    sel.innerHTML = '<option value="">无(仅内部发声)</option>';
    outputs.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      midiOutPort = sel.value === "" ? null : Number(sel.value);
      toast(midiOutPort !== null
        ? `MIDI 输出: ${outputs[midiOutPort] ?? ""}`
        : "MIDI 输出已关闭");
    });

    // 输入消息:note on/off + CC 控制
    await listen<number[]>("midi-in", (e) => {
      const d = e.payload;
      if (!d || d.length < 3) return;
      const [status, d1, d2] = d;
      const type = status & 0xf0;
      if (type === 0x90 && d2 > 0) {
        // 诊断:状态栏显示 MIDI 输入音符与力度(音量太小时可在此发现)
        const st2 = $id("trans-status");
        if (st2 && !transPlaying) {
          st2.textContent = `MIDI 输入: ${noteName(d1 + midiOctave * 12)} 力度 ${d2}`;
        }
        noteOn(d1 + midiOctave * 12, d2 / 127);   // 力度 0-127 → 0-1
      }
      else if (type === 0x80 || (type === 0x90 && d2 === 0)) noteOff(d1 + midiOctave * 12);
      else if (type === 0xb0) handleMidiCC(d1, d2);   // 控制器消息
    });
  } catch (err) {
    console.error("MIDI init failed:", err);
    st.textContent = "MIDI: 不可用";
  }
}

// ============ 节拍器 ============
// 哒哒声走独立路径:只连 ctx.destination(扬声器),不连 recorderDest → 不进录音
const metro = {
  running: false,
  bpm: 120,
  volume: 0.5,
  beat: 0,          // 当前拍序号(从 0 起,0 为重拍)
  nextTime: 0,      // 下一拍时间(AudioContext 时钟)
  timer: null as number | null,
};

function metroClick(accent: boolean) {
  const ctx = engine.ctx;
  const t = ctx.currentTime;
  // 短促正弦"哒":重拍 1760Hz(高),普通拍 1175Hz
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = accent ? 1760 : 1175;
  const g = ctx.createGain();
  g.gain.setValueAtTime(metro.volume * 0.8, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g);
  g.connect(ctx.destination);   // 仅扬声器,不进录音
  osc.start(t);
  osc.stop(t + 0.06);

  // 指示灯:重拍绿色高亮,普通拍红色
  const led = $id("metro-led");
  led.classList.remove("accent");
  led.classList.add("on");
  if (accent) led.classList.add("accent");
  window.setTimeout(() => { led.classList.remove("on"); led.classList.remove("accent"); }, 70);
}

function metroSchedule() {
  if (!metro.running) return;
  const interval = 60 / metro.bpm;
  // 提前 0.12s 把到期的拍全部调度
  while (metro.nextTime < engine.ctx.currentTime + 0.12) {
    metroClick(metro.beat % 4 === 0);   // 每 4 拍一个重拍
    metro.beat++;
    metro.nextTime += interval;
  }
  metro.timer = window.setTimeout(metroSchedule, 30);
}

function metroStart() {
  if (metro.running) return;
  metro.running = true;
  metro.beat = 0;
  metro.nextTime = engine.ctx.currentTime + 0.08;
  $id("btn-metro").classList.add("running");
  ($id("btn-metro") as HTMLElement).textContent = "停止";
  metroSchedule();
}

function metroStop() {
  metro.running = false;
  if (metro.timer) { window.clearTimeout(metro.timer); metro.timer = null; }
  $id("btn-metro").classList.remove("running");
  ($id("btn-metro") as HTMLElement).textContent = "启动";
  $id("metro-led").classList.remove("on");
  $id("metro-led").classList.remove("accent");
}

$id("btn-metro").addEventListener("click", async () => {
  if (!metro.running) {
    await engine.resume();
    metroStart();
  } else {
    metroStop();
  }
});
bindSlider("metro-bpm", (v) => { metro.bpm = v; }, (v) => String(v));
bindSlider("metro-vol", (v) => { metro.volume = v / 100; }, (v) => v + "%");

// ============ 录制 ============
// 音频:MediaRecorder → webm → decode → WAV 16bit PCM
// MIDI:note 事件 → SMF format 0
let mediaRecorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recStart = 0;
let recTimer: number | null = null;
let audioRecording = false;

// 录音轨道:录音时在底部画实时波形(替代映射提示框)
const trackWrap = $id("track-wrap");
const trackCanvas = $id("track-canvas") as HTMLCanvasElement;
let trackRaf = 0;

function resizeTrackCanvas() {
  const r = trackCanvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const dpr = window.devicePixelRatio || 1;
  trackCanvas.width = Math.max(100, Math.round(r.width * dpr));
  trackCanvas.height = Math.max(40, Math.round(r.height * dpr));
}

function drawTrackLoop() {
  const w = trackCanvas.width, h = trackCanvas.height;
  if (w === 0 || h === 0) { trackRaf = requestAnimationFrame(drawTrackLoop); return; }
  const ctx = trackCanvas.getContext("2d")!;
  const data = new Uint8Array(engine.analyser.fftSize);
  engine.analyser.getByteTimeDomainData(data);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#95d5b2";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * w;
    const y = mid + ((data[i] - 128) / 128) * (h / 2 - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  trackRaf = requestAnimationFrame(drawTrackLoop);
}

$id("btn-record").addEventListener("click", async () => {
  if (!audioRecording) {
    await engine.resume();
    midiRec.start();
    recChunks = [];
    recStart = performance.now();
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    mediaRecorder = new MediaRecorder(engine.recorderDest.stream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.start();
    audioRecording = true;
    $id("btn-record").classList.add("recording");
    ($id("btn-record").querySelector("span") as HTMLElement).textContent = "停止";
    // 显示录音轨道,隐藏映射提示
    trackWrap.style.display = "block";
    trackWrap.classList.add("recording");
    $id("keymap-hint").style.display = "none";
    resizeTrackCanvas();
    drawTrackLoop();
    recTimer = window.setInterval(() => {
      const s = Math.floor((performance.now() - recStart) / 1000);
      const t = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      $id("rec-time").textContent = t;
      // 底部录音机时长同步
      const tt = $id("track-time");
      if (tt) tt.textContent = t;
    }, 200);
  } else {
    await stopRecording();
  }
});

async function stopRecording() {
  if (!mediaRecorder) return;
  audioRecording = false;
  midiRec.stop();
  $id("btn-record").classList.remove("recording");
  ($id("btn-record").querySelector("span") as HTMLElement).textContent = "录音";
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $id("rec-time").textContent = "--:--";
  // 停止波形循环,面板保留最后画面
  cancelAnimationFrame(trackRaf);
  trackWrap.classList.remove("recording");
  $id("keymap-hint").style.display = "";
  const done = new Promise<void>((res) => {
    mediaRecorder!.onstop = () => res();
    mediaRecorder!.stop();
  });
  await done;

  try {
    const blob = new Blob(recChunks, { type: "audio/webm" });
    if (blob.size === 0) { toast("录音为空"); return; }
    const buf = await blob.arrayBuffer();
    const audioBuf = await engine.ctx.decodeAudioData(buf);
    const wav = audioBufferToWav(audioBuf);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await invoke<string>("save_recording", {
      bytes: Array.from(new Uint8Array(wav)),
      suggestedName: `COMMIX-录音-${stamp}.wav`,
    });
    toast("录音已保存: " + path.split(/[\\/]/).pop());
  } catch (err) {
    console.error(err);
    toast("录音保存失败: " + String(err).slice(0, 60));
  }
}

function audioBufferToWav(buf: AudioBuffer): ArrayBuffer {
  const ch = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const data = new Int16Array(len * ch);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, src[i]));
      data[i * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  const hdr = new ArrayBuffer(44);
  const dv = new DataView(hdr);
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + data.byteLength, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, data.byteLength, true);
  const out = new Uint8Array(hdr.byteLength + data.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(data.buffer), hdr.byteLength);
  return out.buffer;
}

// MIDI 文件保存(SMF format 0, division 480)
$id("btn-save-midi").addEventListener("click", async () => {
  if (midiRec.events.length === 0) { toast("没有录制的音符"); return; }
  try {
    const smf = buildSmf(midiRec.events);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await invoke<string>("save_midi", {
      bytes: Array.from(new Uint8Array(smf)),
      suggestedName: `COMMIX-MIDI-${stamp}.mid`,
    });
    toast("MIDI 已保存: " + path.split(/[\\/]/).pop());
  } catch (err) {
    toast("MIDI 保存失败: " + String(err).slice(0, 60));
  }
});

function buildSmf(events: { t: number; on: boolean; note: number; vel: number }[]): ArrayBuffer {
  const DIV = 480;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const track: number[] = [];
  let prevT = 0;
  const pushVar = (v: number) => {
    let val = Math.max(0, Math.round(v));
    const bytes = [val & 0x7f];
    while ((val >>= 7) > 0) bytes.unshift((val & 0x7f) | 0x80);
    track.push(...bytes);
  };
  for (const ev of sorted) {
    const dt = Math.round((ev.t - prevT) / 1000 * DIV);
    pushVar(dt);
    track.push(ev.on ? 0x90 : 0x80, ev.note, ev.on ? Math.max(1, Math.round(ev.vel * 127)) : 0);
    prevT = ev.t;
  }
  pushVar(0); track.push(0xff, 0x2f, 0x00);
  // SMF 标准:所有头字段均为大端序
  const hdr = new ArrayBuffer(14);
  const dv = new DataView(hdr);
  const wstr = (o: number, s: string, dvw: DataView) => { for (let i = 0; i < s.length; i++) dvw.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "MThd", dv); dv.setUint32(4, 6, false); dv.setUint16(8, 0, false);
  dv.setUint16(10, 1, false); dv.setUint16(12, DIV, false);
  const trk = new ArrayBuffer(8 + track.length);
  const dv2 = new DataView(trk);
  wstr(0, "MTrk", dv2); dv2.setUint32(4, track.length, false);
  new Uint8Array(trk, 8).set(track);
  const out = new Uint8Array(hdr.byteLength + trk.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(trk), hdr.byteLength);
  return out.buffer;
}

// ============ 控制面板 ============
function bindSlider(id: string, apply: (v: number) => void, fmt: (v: number) => string) {
  const el = $id(id) as HTMLInputElement;
  const val = el.nextElementSibling as HTMLElement;
  const update = () => { apply(Number(el.value)); val.textContent = fmt(Number(el.value)); };
  el.addEventListener("input", update);
  update();
}
bindSlider("volume", (v) => { engine.volume = v / 100; engine.updateMaster(); }, (v) => v + "%");
bindSlider("attack", (v) => { engine.attack = v / 1000; }, (v) => v + "ms");
bindSlider("decay", (v) => { engine.decay = v / 1000; }, (v) => v + "ms");
bindSlider("sustain", (v) => { engine.sustain = v / 100; }, (v) => v + "%");
bindSlider("release", (v) => { engine.release = v / 1000; }, (v) => v + "ms");
bindSlider("reverb", (v) => { engine.setReverb(v / 100); }, (v) => v + "%");

// ============ 合成器参数面板 ============
// (面板始终可用,无禁用状态)

const pianoParamsEl = $id("piano-params");
const dripParamsEl = $id("drip-params");

// 分类选项卡切换
$id("tab-bar").querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $id("tab-bar").querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".tab-body").forEach((tb) => tb.classList.remove("active"));
    $id("tab-" + (b as HTMLElement).dataset.tab).classList.add("active");
    // 示波器 tab 激活时启动绘制,离开时停止
    if ((b as HTMLElement).dataset.tab === "scope") {
      scopeStart();
    } else {
      scopeStop();
    }
  });
});

// ============ 示波器(实时波形) ============
const scopeCanvas = $id("scope-canvas") as HTMLCanvasElement;
const scopeCtx = scopeCanvas.getContext("2d")!;
const scopeBuf = new Uint8Array(2048);
let scopeRunning = false;
let scopeRaf = 0;

function scopeResize() {
  const dpr = window.devicePixelRatio || 1;
  const r = scopeCanvas.getBoundingClientRect();
  scopeCanvas.width = Math.max(1, Math.round(r.width * dpr));
  scopeCanvas.height = Math.max(1, Math.round(r.height * dpr));
  scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function scopeDraw() {
  if (!scopeRunning) return;
  const cw = scopeCanvas.width / (window.devicePixelRatio || 1);
  const ch = scopeCanvas.height / (window.devicePixelRatio || 1);
  scopeCtx.clearRect(0, 0, cw, ch);
  // 中心线
  scopeCtx.strokeStyle = "rgba(149,213,178,0.25)";
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, ch / 2);
  scopeCtx.lineTo(cw, ch / 2);
  scopeCtx.stroke();
  // 实时波形(绿色示波器线)
  engine.analyser.getByteTimeDomainData(scopeBuf);
  scopeCtx.strokeStyle = "#7dff9b";
  scopeCtx.lineWidth = 1.6;
  scopeCtx.shadowColor = "rgba(125,255,155,0.45)";
  scopeCtx.shadowBlur = 6;
  scopeCtx.beginPath();
  const n = scopeBuf.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * cw;
    const y = (scopeBuf[i] / 255) * ch;
    if (i === 0) scopeCtx.moveTo(x, y);
    else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();
  scopeCtx.shadowBlur = 0;
  scopeRaf = requestAnimationFrame(scopeDraw);
}

function scopeStart() {
  if (scopeRunning) return;
  scopeRunning = true;
  scopeResize();
  scopeDraw();
}
function scopeStop() {
  scopeRunning = false;
  if (scopeRaf) { cancelAnimationFrame(scopeRaf); scopeRaf = 0; }
}
window.addEventListener("resize", () => { if (scopeRunning) scopeResize(); });

// ============ 输出电平表(VU):常驻显示 master 实际输出电平 ============
function vuLoop() {
  const buf = new Uint8Array(engine.analyser.fftSize);
  engine.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const d = v - 128; sum += d * d; }
  const rms = Math.sqrt(sum / buf.length) / 128;   // 0-1
  const pct = Math.min(100, Math.round(Math.pow(rms, 0.55) * 100));   // 视觉压缩
  ($id("vu-fill") as HTMLElement).style.width = pct + "%";
  $id("vu-num").textContent = pct + "%";
  requestAnimationFrame(vuLoop);
}
vuLoop();

// 水滴参数控件 ↔ 引擎
function refreshDripUI() {
  dripParamsEl.style.display = engine.waveType === "drip" ? "block" : "none";
  ($id("dp-ratio") as HTMLInputElement).value = String(Math.round(engine.dripRatio * 100));
  $id("dp-ratio-val").textContent = engine.dripRatio.toFixed(1) + "x";
  ($id("dp-time") as HTMLInputElement).value = String(engine.dripTimeMs);
  $id("dp-time-val").textContent = engine.dripTimeMs + "ms";
  ($id("dp-decay") as HTMLInputElement).value = String(engine.dripDecayMs);
  $id("dp-decay-val").textContent = engine.dripDecayMs + "ms";
}
bindSlider("dp-ratio", (v) => { engine.dripRatio = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("dp-time", (v) => { engine.dripTimeMs = v; }, (v) => v + "ms");
bindSlider("dp-decay", (v) => { engine.dripDecayMs = v; }, (v) => v + "ms");
refreshDripUI();

// 钢琴参数控件 ↔ 引擎
function refreshPianoUI() {
  pianoParamsEl.style.display = engine.waveType === "piano" ? "block" : "none";
  dripParamsEl.style.display = engine.waveType === "drip" ? "block" : "none";
  ($id("pn-decay") as HTMLInputElement).value = String(Math.round(engine.pianoDecayScale * 100));
  $id("pn-decay-val").textContent = engine.pianoDecayScale.toFixed(1) + "x";
  ($id("pn-detune") as HTMLInputElement).value = String(engine.pianoDetuneCents);
  $id("pn-detune-val").textContent = engine.pianoDetuneCents + "c";
  ($id("pn-noise") as HTMLInputElement).value = String(Math.round(engine.pianoNoiseLevel * 100));
  $id("pn-noise-val").textContent = Math.round(engine.pianoNoiseLevel * 100) + "%";
  ($id("pn-bright") as HTMLInputElement).value = String(Math.round(engine.pianoBright * 100));
  $id("pn-bright-val").textContent = engine.pianoBright.toFixed(1) + "x";
}
bindSlider("pn-decay", (v) => { engine.pianoDecayScale = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("pn-detune", (v) => { engine.pianoDetuneCents = v; }, (v) => v + "c");
bindSlider("pn-noise", (v) => { engine.pianoNoiseLevel = v / 100; }, (v) => v + "%");
bindSlider("pn-bright", (v) => { engine.pianoBright = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
refreshPianoUI();

// 把引擎当前合成器参数同步到 UI 控件
function refreshSynthUI() {
  ($id("sp-osc-wave") as HTMLSelectElement).value = engine.oscWave;
  ($id("sp-osc-count") as HTMLInputElement).value = String(engine.oscCount);
  $id("sp-osc-count-val").textContent = String(engine.oscCount);
  ($id("sp-detune") as HTMLInputElement).value = String(engine.detuneCents);
  $id("sp-detune-val").textContent = engine.detuneCents + "c";
  ($id("sp-filter-type") as HTMLSelectElement).value = engine.filterKind;
  ($id("sp-resonance") as HTMLInputElement).value = String(Math.round(engine.resonanceQ * 100));
  $id("sp-resonance-val").textContent = engine.resonanceQ.toFixed(1);
  ($id("sp-cutoff") as HTMLInputElement).value = String(engine.cutoffHz);
  $id("sp-cutoff-val").textContent = engine.cutoffHz + "Hz";
  ($id("sp-cutoff-env") as HTMLInputElement).value = String(engine.cutoffEnvHz);
  $id("sp-cutoff-env-val").textContent = engine.cutoffEnvHz + "Hz";
  ($id("sp-cutoff-time") as HTMLInputElement).value = String(engine.cutoffEnvMs);
  $id("sp-cutoff-time-val").textContent = engine.cutoffEnvMs + "ms";
}

// 把引擎演奏参数同步到 UI
function refreshPlayUI() {
  const modeBtns = $id("mode-ctrl").querySelectorAll(".mini-btn");
  modeBtns.forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.mode === (engine.monoMode ? "mono" : "poly")));
  ($id("pan") as HTMLInputElement).value = String(Math.round(engine.pan * 100));
  $id("pan-val").textContent = engine.pan === 0 ? "C" : engine.pan < 0 ? "L" : "R";
  ($id("vib-rate") as HTMLInputElement).value = String(Math.round(engine.vibratoRate * 100));
  $id("vib-rate-val").textContent = engine.vibratoRate.toFixed(1) + "Hz";
  ($id("vib-depth") as HTMLInputElement).value = String(Math.round(engine.vibratoDepth * 100));
  $id("vib-depth-val").textContent = Math.round(engine.vibratoDepth * 100) + "%";
}

($id("sp-osc-wave") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.oscWave = (e.target as HTMLSelectElement).value as OscillatorType;
});
($id("sp-filter-type") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.filterKind = (e.target as HTMLSelectElement).value as BiquadFilterType;
});
bindSlider("sp-osc-count", (v) => { engine.oscCount = v; }, (v) => String(v));
bindSlider("sp-detune", (v) => { engine.detuneCents = v; }, (v) => v + "c");
bindSlider("sp-resonance", (v) => { engine.resonanceQ = v / 100; }, (v) => (v / 100).toFixed(1));
bindSlider("sp-cutoff", (v) => { engine.cutoffHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-env", (v) => { engine.cutoffEnvHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-time", (v) => { engine.cutoffEnvMs = v; }, (v) => v + "ms");

// ============ 演奏参数绑定 ============
$id("mode-ctrl").querySelectorAll(".mini-btn").forEach((b) => {
  b.addEventListener("click", () => {
    engine.monoMode = (b as HTMLElement).dataset.mode === "mono";
    refreshPlayUI();
    if (engine.monoMode) engine.allOff();   // 切单音时清空现有复音
  });
});
bindSlider("pan", (v) => { engine.pan = v / 100; }, (v) => (v === 0 ? "C" : v < 0 ? "L" : "R"));
bindSlider("vib-rate", (v) => { engine.vibratoRate = v / 100; }, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("vib-depth", (v) => { engine.vibratoDepth = v / 100; }, (v) => v + "%");
refreshPlayUI();

// ============ 预设保存/加载 ============
const PRESET_KEY = "commix-presets";

function captureParams() {
  return {
    waveType: engine.waveType,
    oscWave: engine.oscWave,
    oscCount: engine.oscCount,
    detuneCents: engine.detuneCents,
    filterKind: engine.filterKind,
    cutoffHz: engine.cutoffHz,
    resonanceQ: engine.resonanceQ,
    cutoffEnvHz: engine.cutoffEnvHz,
    cutoffEnvMs: engine.cutoffEnvMs,
    attack: engine.attack, decay: engine.decay, sustain: engine.sustain, release: engine.release,
    volume: engine.volume, reverb: engine.reverb, harmonics: engine.harmonics,
    monoMode: engine.monoMode, pan: engine.pan,
    vibratoRate: engine.vibratoRate, vibratoDepth: engine.vibratoDepth,
    pianoDecayScale: engine.pianoDecayScale,
    pianoDetuneCents: engine.pianoDetuneCents,
    pianoNoiseLevel: engine.pianoNoiseLevel,
    pianoBright: engine.pianoBright,
    dripRatio: engine.dripRatio,
    dripTimeMs: engine.dripTimeMs,
    dripDecayMs: engine.dripDecayMs,
    velCurve: velAnchors.map((a) => a.y),
    velMin, velPower,
  };
}

function applyParams(p: ReturnType<typeof captureParams>) {
  engine.waveType = p.waveType;
  engine.oscWave = p.oscWave;
  engine.oscCount = p.oscCount;
  engine.detuneCents = p.detuneCents;
  engine.filterKind = p.filterKind;
  engine.cutoffHz = p.cutoffHz;
  engine.resonanceQ = p.resonanceQ;
  engine.cutoffEnvHz = p.cutoffEnvHz;
  engine.cutoffEnvMs = p.cutoffEnvMs;
  engine.attack = p.attack; engine.decay = p.decay;
  engine.sustain = p.sustain; engine.release = p.release;
  engine.volume = p.volume; engine.reverb = p.reverb; engine.harmonics = p.harmonics;
  engine.monoMode = p.monoMode; engine.pan = p.pan;
  engine.vibratoRate = p.vibratoRate; engine.vibratoDepth = p.vibratoDepth;
  engine.pianoDecayScale = p.pianoDecayScale;
  engine.pianoDetuneCents = p.pianoDetuneCents;
  engine.pianoNoiseLevel = p.pianoNoiseLevel;
  engine.pianoBright = p.pianoBright;
  engine.dripRatio = p.dripRatio;
  engine.dripTimeMs = p.dripTimeMs;
  engine.dripDecayMs = p.dripDecayMs;
  if (Array.isArray(p.velCurve) && p.velCurve.length === velAnchors.length) {
    for (let i = 0; i < velAnchors.length; i++) velAnchors[i].y = p.velCurve[i];
  }
  if (typeof p.velMin === "number") {
    velMin = p.velMin;
    ($id("vel-min") as HTMLInputElement).value = String(Math.round(velMin * 100));
    $id("vel-min-val").textContent = Math.round(velMin * 100) + "%";
  }
  if (typeof p.velPower === "number") {
    velPower = p.velPower;
    ($id("vel-power") as HTMLInputElement).value = String(Math.round(velPower * 100));
    $id("vel-power-val").textContent = velPower.toFixed(1) + "x";
  }
  engine.setWave(p.waveType);
  if (p.waveType === "custom") {
    anchors = builtinAnchors("sine");
    engine.setCustomWave(anchors);
  }
  // 刷新所有 UI(面板始终可用,预设加载时同步合成器参数)
  presets.forEach((b) => b.classList.toggle("active", b.dataset.wave === p.waveType));
  if (engine.isSynthPreset(p.waveType)) {
    if (p.waveType === "dx7") {
      $id("sp-note").textContent = "FM 音色:振荡器参数不适用";
    } else if (p.waveType === "piano") {
      $id("sp-note").textContent = "PILZ1 加法合成:钢琴参数可用";
    } else if (p.waveType === "drip") {
      $id("sp-note").textContent = "PILQ1 频率下滑:水滴参数可用";
    } else {
      $id("sp-note").textContent = "已加载机型默认参数";
    }
    refreshSynthUI();
  } else {
    $id("sp-note").textContent = "";
  }
  refreshPianoUI();
  refreshDripUI();
  refreshPlayUI();
  (($id("volume") as HTMLInputElement).value = String(Math.round(p.volume * 100)));
  $id("volume-val").textContent = Math.round(p.volume * 100) + "%";
  (($id("attack") as HTMLInputElement).value = String(Math.round(p.attack * 1000)));
  $id("attack-val").textContent = Math.round(p.attack * 1000) + "ms";
  (($id("decay") as HTMLInputElement).value = String(Math.round(p.decay * 1000)));
  $id("decay-val").textContent = Math.round(p.decay * 1000) + "ms";
  (($id("sustain") as HTMLInputElement).value = String(Math.round(p.sustain * 100)));
  $id("sustain-val").textContent = Math.round(p.sustain * 100) + "%";
  (($id("release") as HTMLInputElement).value = String(Math.round(p.release * 1000)));
  $id("release-val").textContent = Math.round(p.release * 1000) + "ms";
  (($id("reverb") as HTMLInputElement).value = String(Math.round(p.reverb * 100)));
  $id("reverb-val").textContent = Math.round(p.reverb * 100) + "%";
  (($id("harmonics") as HTMLInputElement).value = String(p.harmonics));
  drawWave();
}

function loadPresetList() {
  const sel = $id("preset-list") as HTMLSelectElement;
  const cur = sel.value;
  sel.innerHTML = '<option value="">加载预设...</option>';
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  list.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  return list;
}

$id("btn-save-preset").addEventListener("click", () => {
  const name = ($id("preset-name") as HTMLInputElement).value.trim();
  if (!name) { toast("请输入预设名称"); return; }
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  list.push({ name, params: captureParams() });
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  loadPresetList();
  toast("预设已保存: " + name);
});

$id("preset-list").addEventListener("change", (e) => {
  const i = Number((e.target as HTMLSelectElement).value);
  if (isNaN(i)) return;
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return; }
  const p = list[i];
  if (p) { applyParams(p.params); toast("已加载: " + p.name); }
});

$id("btn-del-preset").addEventListener("click", () => {
  const sel = $id("preset-list") as HTMLSelectElement;
  const i = Number(sel.value);
  if (isNaN(i)) { toast("先选择要删除的预设"); return; }
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return; }
  const name = list[i]?.name ?? "";
  list.splice(i, 1);
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  loadPresetList();
  toast("已删除: " + name);
});
loadPresetList();

function shiftOctave(d: number) {
  octaveShift = Math.min(2, Math.max(-2, octaveShift + d));
  $id("octave-val").textContent = noteName(48 + octaveShift * 12);
  buildKeyboard();   // 琴键 UI 整体平移跟随
  updateKeysUI();
}
$id("oct-up").addEventListener("click", () => shiftOctave(1));
$id("oct-down").addEventListener("click", () => shiftOctave(-1));
$id("octave-val").textContent = noteName(48);

// ============ 窗口控制 ============
const win = getCurrentWindow();
$id("btn-min").addEventListener("click", () => win.minimize());
$id("btn-max").addEventListener("click", async () => {
  if (await win.isMaximized()) await win.unmaximize();
  else await win.maximize();
});
$id("btn-close").addEventListener("click", () => win.close());

// ============ 启动 ============
$id("keymap-hint").textContent =
  "黑键: 数字行 1 2 3 4 5 6 7 8 9 0 · 白键: Q W E R T Y U I O P + A S D F G H J K L ; · ↑↓ 移八度 · 数字行黑键从 C#3 起连续";

// 固定窗口宽高比:波形画布按比例显示,变形会破坏波形严谨性
// 仅普通窗口生效;最大化/全屏时按屏幕比例,不做修正
const DESIGN_RATIO = 1180 / 780;   // ≈1.513
let ratioFixing = false;
window.addEventListener("resize", async () => {
  if (ratioFixing) return;
  let maximized = false;
  try { maximized = await win.isMaximized(); } catch { maximized = false; }
  if (maximized) return;   // 最大化:跟随屏幕比例
  const w = window.innerWidth, h = window.innerHeight;
  const r = w / h;
  if (Math.abs(r - DESIGN_RATIO) > 0.03) {
    ratioFixing = true;
    // 以当前宽或高为基准,另一维按比例修正(选变化小的)
    const byW = Math.round(w / DESIGN_RATIO);   // 固定宽 → 新高
    const byH = Math.round(h * DESIGN_RATIO);   // 固定高 → 新宽
    const useW = Math.abs(byH - w) <= Math.abs(byW - h);
    win.setSize(new LogicalSize(useW ? byH : w, useW ? h : byW))
      .catch(() => {})
      .finally(() => { ratioFixing = false; });
  }
});

window.addEventListener("resize", () => { resizeCanvas(); drawWave(); });
resizeCanvas();
buildKeyboard();
drawWave();
applyWaveToEngine();
initMidi();

// 首次交互解锁 AudioContext
document.addEventListener("pointerdown", () => engine.resume(), { once: false });
