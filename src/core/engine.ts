// 合成引擎:PeriodicWave 统一波形、复音、ADSR、滤波器、波表渐变、效果
import { WT_SLOTS, PIANO_HARMONICS, INHARMONICITY, presetWaveAt, interpAnchors, wtSlotFnAt } from "./wave";
import type { WaveType } from "./wave";
export const SAMPLE_RATE = 44100;
export const WAVE_LEN = 2048;                 // 周期采样数
export const MAX_VOICES = 32;
export class SynthEngine {
  ctx: AudioContext;
  master: GainNode;
  recorderDest!: MediaStreamAudioDestinationNode;
  active = new Map<number, VoiceRec>();

  private voiceOrder: number[] = [];   // 复音 steal 队列

  // 混响链:master → dry(destination) + send → convolver → return → destination
  reverbSend!: GainNode;
  reverbReturn!: GainNode;
  convolver!: ConvolverNode;
  // 波形显示(录音轨道用)
  analyser!: AnalyserNode;
  // 钢琴锤击噪声缓冲
  noiseBuffer!: AudioBuffer;

  // 音色参数
  volume = 1;   // 0dB 默认(UI 显示 dB)
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

  // 波表合成参数(形态渐变 + LFO)
  wtPos = 0.3;                     // 波形形态位置 0..1(槽位间连续渐变)
  wtLfoRate = 0;                   // 形态 LFO 频率 Hz(0=关)
  wtLfoDepth = 0;                  // 形态 LFO 深度 0..1(1=扫满整表)
  wtSlots: string[] = [...WT_SLOTS];   // 当前渐变组的槽位(内置波形名 或 "preset:<预设名>")
  // 渐变槽位引用用户预设时的解析器(由 ui/presets.ts 注入)
  wtPresetResolver: ((name: string) => { waveType: string; wtPos: number; wtSlots: string[] } | null) | null = null;
  wtLfoT0 = 0;                     // LFO 相位零点
  private wtBank: PeriodicWave[] | null = null;   // 波表槽位缓存
  private wtBankDirty = true;      // 缓存失效(谐波/自定义波形变化)
  wtVoiceMap = new Map<number, GainNode[]>();     // 活跃 WT 音符 → 槽位增益(midi → gains)

  // 弯音(音分,0xE0 驱动,默认 ±2 半音)
  bendCents = 0;
  // 滑音(单音模式,ms;0=关)
  portamentoMs = 0;
  // 延音踏板(CC64)
  sustainPedal = false;
  // 滤波包络(独立 ADSR,截止偏移量 Hz)
  filterEnvHz = 800;
  filterEnvA = 0.01; filterEnvD = 0.3; filterEnvS = 0.5; filterEnvR = 0.3;
  // 调制 LFO(多目标:截止/音量/声像)
  modLfoRate = 4;
  modLfoDepth = 0;                    // 0..1
  modLfoWave: OscillatorType | "s&h" = "sine";
  modLfoTarget: "off" | "cutoff" | "volume" | "pan" = "off";
  private modLfoShRaf = 0;
  private modLfoShNext = 0;
  // 键位跟踪 / 力度 → 截止
  keyTrack = 0.3;                     // 0..1
  velTrack = 0.3;                     // 0..1
  // 延迟(时间 ms / 反馈 0..1 / 混音 0..1)
  delayTimeMs = 350;
  delayFeedback = 0.4;
  delayMix = 0.2;
  delayNode!: DelayNode;
  delayFeedbackGain!: GainNode;
  delaySend!: GainNode;
  // 失真驱动 0..1
  drive = 0;
  driveNode!: WaveShaperNode;
  // 三频段 EQ(主效果链,±12dB)
  eqBass = 0;
  eqMid = 0;
  eqTreble = 0;
  // 副振荡器
  subLevel = 0;                       // 0..1
  subWave: OscillatorType = "sine";
  // 增益与 NoteOn 随机扰动
  gain = 1;                           // 输出增益 0-2
  noteJitter = 0;                     // NoteOn 随机扰动 0-1
  // PM 硬件模拟参数(镜像,Rust 引擎实际渲染)
  grainSizeMs = 80;
  grainDensity = 40;
  grainSpread = 30;
  grainRandom = 0.3;
  grainSizeEnd = 80;
  grainDensityEnd = 40;
  grainEnvMs = 800;
  grainEnvExp = 0;
  dxPm = false;                       // PM 相位调制
  dxLutSize = 4096;                      // 4096 正弦查表
  dxQuantBits = 0;                    // 16bit 定点截断
  dxDac = false;                      // DAC 输出量化
  dxBits = 12;                        // DAC 量化位数 8/12/16
  dxAa = false;                       // 抗混叠平滑
  dxAlgorithm = 1;                    // 1-7 算法(7=六载波并行)
  dxFeedback = 5;                     // OP6 反馈 0-7
  dxRatios = [1, 2.73, 1.41, 3, 2.01, 1];
  dxTls = [82, 52, 56, 64, 68, 72];
  dxDets = [0, 0, 0, 0, 0, 0];
  dxEgs = new Array<number>(48).fill(99);

  // 分身模式:传入父引擎时共享其 AudioContext 与主效果链(发声汇入父引擎 driveNode),
  // 只建独立通道总线 + 独立音色/复音状态 —— 多轨 MIDI 播放时每通道一个分身,最终合并到主输出
  constructor(parent?: SynthEngine) {
    if (parent) {
      this.ctx = parent.ctx;
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(parent.driveNode);   // 汇入主效果链输入(合并输出)
      this.noiseBuffer = parent.noiseBuffer;
      this.wtPresetResolver = parent.wtPresetResolver;
      this.wtLfoT0 = this.ctx.currentTime;
      return;
    }
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.recorderDest = this.ctx.createMediaStreamDestination();

    // 失真驱动:master → waveshaper → 干声 + 效果发送
    this.driveNode = this.ctx.createWaveShaper();
    this.driveNode.curve = makeDriveCurve(0);
    this.master.connect(this.driveNode);

    // 混响:指数衰减白噪声 IR(2.2s)
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.2, 2.8);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.driveNode.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.ctx.destination);
    this.reverbReturn.connect(this.recorderDest);

    // 延迟:发送 → delay → 反馈回路 → 输出
    this.delayNode = this.ctx.createDelay(2);
    this.delayNode.delayTime.value = 0.35;
    this.delayFeedbackGain = this.ctx.createGain();
    this.delayFeedbackGain.gain.value = 0.4;
    this.delaySend = this.ctx.createGain();
    this.delaySend.gain.value = 0.2;
    this.driveNode.connect(this.delaySend);
    this.delaySend.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedbackGain);
    this.delayFeedbackGain.connect(this.delayNode);
    this.delayNode.connect(this.ctx.destination);
    this.delayNode.connect(this.recorderDest);

    this.driveNode.connect(this.ctx.destination);
    this.driveNode.connect(this.recorderDest);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.driveNode.connect(this.analyser);
    // 钢琴锤击噪声缓冲(60ms 白噪声)
    const nb = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.06), this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuffer = nb;
    this.wtLfoT0 = this.ctx.currentTime;
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
    if (!this.reverbSend) return;   // 通道分身无独立混响,共享主引擎效果链
    // 发送量 = 混响量 ^ 1.6(非线性让低值更敏感)
    this.reverbSend.gain.setTargetAtTime(Math.pow(v, 1.6) * 0.9, this.ctx.currentTime, 0.05);
  }

  setDelay(timeMs: number, feedback: number, mix: number) {
    this.delayTimeMs = timeMs; this.delayFeedback = feedback; this.delayMix = mix;
    if (!this.delayNode) return;    // 通道分身无独立延迟
    const t = this.ctx.currentTime;
    this.delayNode.delayTime.setTargetAtTime(timeMs / 1000, t, 0.03);
    this.delayFeedbackGain.gain.setTargetAtTime(feedback, t, 0.03);
    this.delaySend.gain.setTargetAtTime(mix, t, 0.03);
  }

  setDrive(v: number) {
    this.drive = Math.min(1, Math.max(0, v));
    if (!this.driveNode) return;    // 通道分身无独立失真
    this.driveNode.curve = makeDriveCurve(this.drive);
  }

  // 弯音(半音):叠加到所有活跃音的高频振荡器 detune
  setBend(semitones: number) {
    this.bendCents = semitones * 100;
    const cents = this.bendCents;
    const t = this.ctx.currentTime;
    for (const v of this.active.values()) {
      for (const o of v.oscs) {
        // 只弯音振荡器类节点(ConstantSource 无 frequency)
        const f = (o as { frequency?: AudioParam }).frequency;
        if (f && f.value > 100) {
          const spread = v.oscSpreads ? (v.oscSpreads.get(o) ?? 0) : 0;
          o.detune.setTargetAtTime(spread + cents, t, 0.01);
        }
      }
    }
  }

  // 延音踏板(CC64):踩下后 noteOff 挂起,抬起统一释放
  setSustain(on: boolean) {
    this.sustainPedal = on;
    if (!on) {
      const t = this.ctx.currentTime;
      for (const [n, v] of [...this.active.entries()]) {
        if (v.pedaled) {
          this.releaseVoice(v, t, false);
          this.active.delete(n);
          this.wtVoiceMap.delete(n);
          this.voiceOrder = this.voiceOrder.filter((x) => x !== n);
        }
      }
    }
  }

  // 调制 LFO 参数(速率/深度实时生效;波形/目标作用于新音符)
  setModLfoParams(rate: number, depth: number, wave: OscillatorType | "s&h", target: "off" | "cutoff" | "volume" | "pan") {
    this.modLfoRate = rate; this.modLfoDepth = depth;
    this.modLfoWave = wave; this.modLfoTarget = target;
    const t = this.ctx.currentTime;
    for (const v of this.active.values()) {
      if (v.modLfo) {
        if (v.modLfo.osc) v.modLfo.osc.frequency.setTargetAtTime(Math.max(0.01, rate), t, 0.02);
        if (v.modLfo.osc === null) { /* s&h 由循环驱动 */ }
        else v.modLfo.depthGain.gain.setTargetAtTime(v.modLfo.rangeFactor * depth, t, 0.02);
      }
    }
    this.modLfoShSync();
  }

  // 采样保持 LFO 循环:按速率随机跳变目标参数
  private modLfoShTick = () => {
    if (this.modLfoTarget === "off" || this.modLfoDepth <= 0 || this.modLfoRate <= 0 || this.modLfoWave !== "s&h") {
      this.modLfoShRaf = 0; return;
    }
    const t = this.ctx.currentTime;
    if (t >= this.modLfoShNext) {
      this.modLfoShNext = t + 1 / this.modLfoRate;
      const val = Math.random() * 2 - 1;
      for (const v of this.active.values()) {
        if (v.modLfo && v.modLfo.osc === null) {
          v.modLfo.depthGain.gain.setTargetAtTime(v.modLfo.rangeFactor * this.modLfoDepth * val, t, 0.005);
        }
      }
    }
    this.modLfoShRaf = requestAnimationFrame(this.modLfoShTick);
  }
  private modLfoShSync() {
    const active = this.modLfoTarget !== "off" && this.modLfoDepth > 0 && this.modLfoRate > 0 && this.modLfoWave === "s&h";
    if (active && !this.modLfoShRaf) {
      this.modLfoShNext = this.ctx.currentTime + 0.01;
      this.modLfoShRaf = requestAnimationFrame(this.modLfoShTick);
    } else if (!active && this.modLfoShRaf) {
      cancelAnimationFrame(this.modLfoShRaf);
      this.modLfoShRaf = 0;
    }
  }

  // 合成路径公共效果:键位/力度跟踪截止 + 滤波包络 + 调制 LFO + 副振荡器
  private synthFx(ctx: AudioContext, filter: BiquadFilterNode, g: GainNode, panner: StereoPannerNode,
                  freq: number, midi: number, velocity: number, t: number,
                  oscs: OscillatorNode[], freqOscs: OscillatorNode[], spreadCents: number) {
    // 键位跟踪(截止随音高)+ 力度跟踪
    const kt = Math.pow(2, ((midi - 60) / 12) * this.keyTrack);
    const vt = 1 + (velocity - 0.5) * this.velTrack * 2;
    const cutoffEff = Math.min(18000, Math.max(30, this.cutoffHz * kt * vt));
    filter.frequency.value = cutoffEff;
    // 滤波包络(独立 ADSR)
    if (this.filterEnvHz > 0) {
      const peak = Math.min(18000, cutoffEff + this.filterEnvHz);
      filter.frequency.setValueAtTime(cutoffEff, t);
      filter.frequency.linearRampToValueAtTime(peak, t + Math.max(0.001, this.filterEnvA));
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, cutoffEff + this.filterEnvHz * Math.max(0.01, this.filterEnvS)),
        t + Math.max(0.002, this.filterEnvA + this.filterEnvD));
    }
    // 副振荡器(基频下方一个八度)
    if (this.subLevel > 0) {
      const sub = ctx.createOscillator();
      sub.type = this.subWave;
      sub.frequency.value = freq / 2;
      sub.detune.value = spreadCents + this.bendCents;
      const sg = ctx.createGain();
      sg.gain.value = this.subLevel * 0.6;
      sub.connect(sg);
      sg.connect(filter);
      oscs.push(sub);
      freqOscs.push(sub);
    }
    // 调制 LFO(振荡器类波形);采样保持仅支持截止目标(与包络无冲突)
    let modLfo: { osc: OscillatorNode | null; src: ConstantSourceNode | null;
                  depthGain: GainNode; target: "cutoff" | "volume" | "pan";
                  base: number; rangeFactor: number } | null = null;
    if (this.modLfoTarget !== "off" && this.modLfoDepth > 0 && this.modLfoRate > 0) {
      const depth = this.modLfoDepth;
      let param: AudioParam, base = 0, rangeFactor = 0;
      if (this.modLfoTarget === "cutoff") { param = filter.frequency; base = cutoffEff; rangeFactor = cutoffEff * 0.8; }
      else if (this.modLfoTarget === "volume") { param = g.gain; base = 0; rangeFactor = velocity; }
      else { param = panner.pan; base = 0; rangeFactor = 1; }
      const depthGain = ctx.createGain();
      depthGain.gain.value = rangeFactor * depth;
      depthGain.connect(param);
      let osc: OscillatorNode | null = null;
      let src: ConstantSourceNode | null = null;
      const useSh = this.modLfoWave === "s&h" && this.modLfoTarget === "cutoff";
      if (useSh) {
        src = ctx.createConstantSource();
        src.offset.value = 1;
        src.connect(depthGain);
        oscs.push(src as unknown as OscillatorNode);  // 随音符统一 start/stop
        this.modLfoShSync();
      } else {
        osc = ctx.createOscillator();
        osc.type = this.modLfoWave === "s&h" ? "sine" : this.modLfoWave;
        osc.frequency.value = this.modLfoRate;
        osc.connect(depthGain);
        oscs.push(osc);
      }
      modLfo = { osc, src, depthGain, target: this.modLfoTarget, base, rangeFactor };
    }
    return { cutoffEff, modLfo };
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
      wtPos: this.wtPos, wtLfoRate: this.wtLfoRate, wtLfoDepth: this.wtLfoDepth,
      bendCents: this.bendCents, portamentoMs: this.portamentoMs, sustainPedal: this.sustainPedal,
      filterEnvHz: this.filterEnvHz, filterEnvA: this.filterEnvA, filterEnvD: this.filterEnvD,
      filterEnvS: this.filterEnvS, filterEnvR: this.filterEnvR,
      modLfoRate: this.modLfoRate, modLfoDepth: this.modLfoDepth,
      modLfoWave: this.modLfoWave, modLfoTarget: this.modLfoTarget,
      keyTrack: this.keyTrack, velTrack: this.velTrack,
      delayTimeMs: this.delayTimeMs, delayFeedback: this.delayFeedback, delayMix: this.delayMix,
      drive: this.drive, subLevel: this.subLevel, subWave: this.subWave,
    };
    try { this.ctx.close(); } catch { /* 已关闭 */ }
    this.active.clear();
    this.voiceOrder = [];
    this.wtVoiceMap.clear();
    this.wtBank = null;
    this.wtBankDirty = true;
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
    this.wtPos = p.wtPos; this.wtLfoRate = p.wtLfoRate; this.wtLfoDepth = p.wtLfoDepth;
    this.wtLfoT0 = this.ctx.currentTime;
    this.bendCents = p.bendCents; this.portamentoMs = p.portamentoMs; this.sustainPedal = p.sustainPedal;
    this.filterEnvHz = p.filterEnvHz; this.filterEnvA = p.filterEnvA; this.filterEnvD = p.filterEnvD;
    this.filterEnvS = p.filterEnvS; this.filterEnvR = p.filterEnvR;
    this.modLfoRate = p.modLfoRate; this.modLfoDepth = p.modLfoDepth;
    this.modLfoWave = p.modLfoWave; this.modLfoTarget = p.modLfoTarget;
    this.keyTrack = p.keyTrack; this.velTrack = p.velTrack;
    this.delayTimeMs = p.delayTimeMs; this.delayFeedback = p.delayFeedback; this.delayMix = p.delayMix;
    this.drive = p.drive; this.subLevel = p.subLevel; this.subWave = p.subWave;
    this.setReverb(p.reverb);
    this.setDelay(p.delayTimeMs, p.delayFeedback, p.delayMix);
    this.setDrive(p.drive);
    this.modLfoShSync();
    this.resume();
  }

  // 生成 PeriodicWave:内置波形按谐波截断,自定义/预设波形由采样 DFT
  buildWave(type: SynthEngine["waveType"], anchors: { x: number; y: number }[]): PeriodicWave {
    if (type === "custom") {
      // 锚点线性插值 → 采样,再 DFT
      const samples = new Float64Array(WAVE_LEN);
      for (let i = 0; i < WAVE_LEN; i++) samples[i] = interpAnchors(anchors, i / WAVE_LEN);
      return this.waveFromSamples(samples);
    }
    if (type === "dx7" || type === "piano" || type === "drip" || type === "acc"
        || type === "clar" || type === "harp" || type === "guzheng") {
      // 合成器预设波形:按 presetWaveAt 采样 → DFT(波表槽位用)
      const samples = new Float64Array(WAVE_LEN);
      for (let i = 0; i < WAVE_LEN; i++) samples[i] = presetWaveAt(type, i / WAVE_LEN);
      return this.waveFromSamples(samples);
    }
    const N = this.harmonics;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    real[0] = 0; imag[0] = 0;
    for (let k = 1; k <= N; k++) {
      const n = k;
      switch (type) {
        case "sine": imag[k] = n === 1 ? 1 : 0; break;
        case "square": if (n % 2 === 1) imag[k] = 1 / n; break;
        case "saw": imag[k] = 1 / n; break;
        case "triangle": if (n % 2 === 1) imag[k] = (n % 4 === 1 ? 1 : -1) / (n * n); break;
      }
    }
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // 采样数组 → PeriodicWave(DFT 谐波分解;自定义/预设/渐变槽位共用)
  private waveFromSamples(samples: Float64Array): PeriodicWave {
    const N = this.harmonics;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
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
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // 槽位采样:内置波形/合成器预设直接采样;用户预设解析其振荡器波形;
  // 渐变类预设取其形态位置波形(等功率交叉淡化);depth 防预设互相引用死循环
  wtSlotSamples(slot: string, depth = 0): Float64Array | null {
    const sine = () => {
      const out = new Float64Array(WAVE_LEN);
      for (let k = 0; k < WAVE_LEN; k++) out[k] = Math.sin(2 * Math.PI * (k / WAVE_LEN));
      return out;
    };
    if (slot === "custom" || slot === "wt") return null;   // custom 走 customWave 路径
    if (!slot.startsWith("preset:")) {
      const out = new Float64Array(WAVE_LEN);
      for (let k = 0; k < WAVE_LEN; k++) out[k] = wtSlotFnAt(slot, k / WAVE_LEN);
      return out;
    }
    const pr = this.wtPresetResolver?.(slot.slice(7));
    if (!pr || depth > 2) return null;
    if (pr.waveType === "wt" && Array.isArray(pr.wtSlots) && pr.wtSlots.length > 0) {
      // 渐变预设:取其形态位置的单波形
      const n = pr.wtSlots.length;
      const pos = Math.min(0.9999, Math.max(0, pr.wtPos ?? 0.5)) * (n - 1);
      const i = Math.floor(pos);
      const frac = pos - i;
      const w0 = Math.cos((frac * Math.PI) / 2);
      const w1 = Math.sin((frac * Math.PI) / 2);
      const a = this.wtSlotSamples(pr.wtSlots[i], depth + 1) ?? sine();
      const b = this.wtSlotSamples(pr.wtSlots[Math.min(i + 1, n - 1)], depth + 1) ?? sine();
      const out = new Float64Array(WAVE_LEN);
      for (let k = 0; k < WAVE_LEN; k++) out[k] = w0 * a[k] + w1 * b[k];
      return out;
    }
    // 常规预设:取其振荡器波形
    return this.wtSlotSamples(pr.waveType, depth + 1);
  }

  // 合成器参数统一作用于所有波形:基础波形来源不同(内置=PeriodicWave,预设=专用合成结构)
  isSynthPreset(type: SynthEngine["waveType"]): boolean {
    return type === "moog" || type === "dx7" || type === "piano" || type === "drip"
      || type === "acc" || type === "clar" || type === "harp" || type === "guzheng"
      || type === "wt";
  }

  private getWave(): PeriodicWave {
    if (this.waveType === "custom" && this.customWave) return this.customWave;
    return this.buildWave(this.waveType, []);
  }

  // when 可选:为未来时间调度(多轨导出用 AudioContext 时钟精确对齐)
  noteOn(midi: number, velocity = 1, when?: number) {
    const ctx = this.ctx;
    const t = when ?? ctx.currentTime;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    // 单音模式:最后按下的优先;开启滑音时按住旧音直接滑到新音高(legato)
    if (this.monoMode) {
      if (this.portamentoMs > 0 && this.active.size > 0) {
        const first = [...this.active.entries()][0];
        if (first && first[0] !== midi) {
          const [oldMidi, v] = first;
          const glide = this.portamentoMs / 1000;
          const targets = v.freqOscs ?? v.oscs;
          for (const o of targets) {
            o.frequency.cancelScheduledValues(t);
            o.frequency.setValueAtTime(o.frequency.value, t);
            o.frequency.linearRampToValueAtTime(freq, t + glide);
          }
          this.active.delete(oldMidi);
          this.voiceOrder = this.voiceOrder.filter((n) => n !== oldMidi);
          v.vel = velocity;
          v.onT = t;
          this.active.set(midi, v);
          this.voiceOrder.push(midi);
          return;
        }
      }
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

    if (type === "wt") {
      // 波表合成:8 个槽位振荡器同时发声,形态位置决定槽位间等功率交叉淡化
      // 形态位置可由滑块手动或 LFO 实时驱动 → 持续音中波形动态变化
      const bank = this.buildWtBank();
      const nSlots = bank.length;
      const slotGains: GainNode[] = [];
      const filter = ctx.createBiquadFilter();
      filter.type = this.filterKind;
      filter.Q.value = this.resonanceQ;
      const freqOscs: OscillatorNode[] = [];
      const oscSpreads = new Map<OscillatorNode, number>();
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      const fx = this.synthFx(ctx, filter, g, panner, freq, midi, velocity, t, oscs, freqOscs, 0);
      for (let s = 0; s < nSlots; s++) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(bank[s]);
        o.frequency.value = freq;
        o.detune.value = this.bendCents;
        if (this.vibratoDepth > 0) {
          const lfo = ctx.createOscillator();
          lfo.frequency.value = this.vibratoRate;
          const lg = ctx.createGain();
          lg.gain.value = this.vibratoDepth * freq * 0.05;
          lfo.connect(lg);
          lg.connect(o.frequency);
          oscs.push(lfo);
        }
        const sg = ctx.createGain();
        sg.gain.value = 0;
        o.connect(sg);
        sg.connect(filter);
        oscs.push(o);
        freqOscs.push(o);
        oscSpreads.set(o, 0);
        slotGains.push(sg);
      }
      filter.connect(g);
      this.wtSlotWeights(this.wtPos, slotGains, t);
      this.wtVoiceMap.set(midi, slotGains);
      g.connect(panner);
      panner.connect(this.master);
      for (const o of oscs) o.start(t);
      this.active.set(midi, {
        oscs, gain: g, vel: velocity, onT: t, freqOscs, oscSpreads,
        filterBaseHz: fx.cutoffEff, filter, modLfo: fx.modLfo ?? undefined,
      });
      this.voiceOrder.push(midi);
      return;
    }

    // 公共尾部:振荡器(合成路径)+ 效果 + 声像 + 登记
    const freqOscs: OscillatorNode[] = [];
    const oscSpreads = new Map<OscillatorNode, number>();
    const panner = ctx.createStereoPanner();
    panner.pan.value = this.pan;
    let filter: BiquadFilterNode | null = null;
    let cutoffEff = 0;
    let modLfo: VoiceRec["modLfo"] = undefined;
    if (type === "dx7") {
      // FM 合成:载波正弦 + 调制算子(频率比 1:1 和 1:2),调制指数随包络衰减
      // 算子1:ratio 1, index 3→0.8;算子2:ratio 2, index 2→0.5
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = freq;
      carrier.detune.value = this.bendCents;
      const mkMod = (ratio: number, peak: number, sus: number) => {
        const mod = ctx.createOscillator();
        mod.type = "sine";
        mod.frequency.value = freq * ratio;
        mod.detune.value = this.bendCents;
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
      freqOscs.push(carrier, m1, m2);
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
        let spread = 0;
        if (n > 1) {
          // 均匀分布:从 -det 到 +det
          const ratio = n === 2 ? (i === 0 ? -1 : 1) : (i / (n - 1)) * 2 - 1;
          spread = ratio * det;
          o.detune.value = spread + this.bendCents;
        } else {
          o.detune.value = this.bendCents;
        }
        oscSpreads.set(o, spread);
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

      // 滤波器(类型/截止/共振由面板控制;截止含键位/力度跟踪 + 滤波包络)
      const flt = ctx.createBiquadFilter();
      flt.type = this.filterKind;
      flt.Q.value = this.resonanceQ;
      const fx = this.synthFx(ctx, flt, g, panner, freq, midi, velocity, t, oscs, freqOscs, 0);
      filter = flt;
      cutoffEff = fx.cutoffEff;
      modLfo = fx.modLfo ?? undefined;
      for (const o of oscsToFilter) o.connect(flt);
      flt.connect(g);
      oscs.push(...oscsToFilter);
      freqOscs.push(...oscsToFilter);
    }

    // 声像
    g.connect(panner);
    panner.connect(this.master);
    for (const o of oscs) o.start(t);
    this.active.set(midi, {
      oscs, gain: g, vel: velocity, onT: t, freqOscs, oscSpreads,
      filterBaseHz: cutoffEff > 0 ? cutoffEff : undefined,
      filter: filter ?? undefined,
      modLfo: modLfo ?? undefined,
    });
    this.voiceOrder.push(midi);
  }

  // when 可选:为未来时间调度释放(多轨导出对齐)
  noteOff(midi: number, fast = false, when?: number) {
    const v = this.active.get(midi);
    if (!v) return;
    const t = when ?? this.ctx.currentTime;
    // 延音踏板:非强制释放时挂起,踏板抬起统一释放
    if (this.sustainPedal && !fast) { v.pedaled = true; return; }
    this.releaseVoice(v, t, fast);
    this.active.delete(midi);
    this.wtVoiceMap.delete(midi);
    this.voiceOrder = this.voiceOrder.filter((n) => n !== midi);
  }

  // 释放单个音:ADSR 释音 + 滤波包络回落 + 振荡器停止
  private releaseVoice(v: VoiceRec, t: number, fast: boolean) {
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
    // 滤波包络释放:截止回落到基准
    if (v.filter && v.filterBaseHz !== undefined) {
      v.filter.frequency.cancelScheduledValues(t);
      v.filter.frequency.setValueAtTime(v.filter.frequency.value, t);
      v.filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, v.filterBaseHz), t + Math.max(0.01, this.filterEnvR));
    }
  }

  // 换波形:只影响之后按下的音(不干扰正在响的音)
  setWave(type: SynthEngine["waveType"]) {
    this.waveType = type;
    // 波表模式的"自定义"槽位仍需要 customWave,不在这里清除
    if (type !== "custom" && type !== "wt") this.customWave = null;
  }
  setCustomWave(anchors: { x: number; y: number }[]) {
    this.customWave = this.buildWave("custom", anchors);
    this.markWtDirty();
  }
  markWtDirty() { this.wtBank = null; this.wtBankDirty = true; }

  // 构建波表槽位:内置波形 + 合成器预设波形 + 自定义波形(缓存,失效时重建)
  buildWtBank(): PeriodicWave[] {
    if (this.wtBank && !this.wtBankDirty) return this.wtBank;
    this.wtBank = this.wtSlots.map((slot) => {
      if (slot === "custom") return this.customWave ?? this.buildWave("sine", []);
      if (slot.startsWith("preset:")) {
        const samples = this.wtSlotSamples(slot);
        if (samples) return this.waveFromSamples(samples);
        return this.buildWave("sine", []);
      }
      return this.buildWave(slot as SynthEngine["waveType"], []);
    });
    this.wtBankDirty = false;
    return this.wtBank;
  }

  // 槽位权重:等功率交叉淡化(正弦/余弦),位置 0..1 对应整张表
  wtSlotWeights(pos: number, gains: GainNode[], t: number, smooth = false) {
    const n = gains.length;
    const scaled = Math.min(0.9999, Math.max(0, pos)) * (n - 1);
    const i = Math.floor(scaled);
    const frac = scaled - i;
    const w0 = Math.cos((frac * Math.PI) / 2);
    const w1 = Math.sin((frac * Math.PI) / 2);
    const set = (g: GainNode, v: number) => {
      const target = Math.max(0, Math.min(1, v));
      if (smooth) g.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
      else g.gain.setValueAtTime(target, t);
    };
    for (let s = 0; s < n; s++) {
      if (s === i) set(gains[s], w0);
      else if (s === i + 1) set(gains[s], w1);
      else set(gains[s], 0);
    }
  }

  // 当前形态位置:静态位置 + LFO 偏移(JS 驱动,setTargetAtTime 平滑,无爆音)
  currentWtPos(): number {
    if (this.wtLfoDepth <= 0 || this.wtLfoRate <= 0) return this.wtPos;
    const p = 0.5 + 0.5 * Math.sin(2 * Math.PI * this.wtLfoRate * (this.ctx.currentTime - this.wtLfoT0));
    return Math.min(1, Math.max(0, this.wtPos + this.wtLfoDepth * (p - 0.5) * 2));
  }
  updateMaster() { this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02); }

  allOff() {
    for (const n of [...this.active.keys()]) this.noteOff(n, true);
  }

  // ============ 引擎分身(多轨 MIDI 播放) ============
  // 复制一份与主引擎共享 AudioContext + 主效果链的独立引擎:独立音色参数/复音/弯音/踏板/波表缓存,
  // 各通道最终全部汇入主效果链合并为一个输出
  fork(): SynthEngine {
    const ch = new SynthEngine(this);
    ch.copyParams(this);
    ch.volume = 1;          // 通道总线不做二次音量,总音量由主引擎掌控
    ch.monoMode = false;    // 多轨播放各通道独立复音
    ch.sustainPedal = false;
    ch.bendCents = 0;
    return ch;
  }

  // 通道分身用完后释放(不关闭共享 AudioContext)
  dispose() {
    this.allOff();
    try { this.master.disconnect(); } catch { /* 已断开 */ }
  }

  // 复制音色参数(不含主效果链:混响/延迟/驱动由主引擎统一掌控)
  private copyParams(from: SynthEngine) {
    this.volume = from.volume; this.attack = from.attack; this.decay = from.decay;
    this.sustain = from.sustain; this.release = from.release; this.harmonics = from.harmonics;
    this.waveType = from.waveType; this.customWave = from.customWave;
    this.oscWave = from.oscWave; this.oscCount = from.oscCount; this.detuneCents = from.detuneCents;
    this.filterKind = from.filterKind; this.cutoffHz = from.cutoffHz; this.resonanceQ = from.resonanceQ;
    this.cutoffEnvHz = from.cutoffEnvHz; this.cutoffEnvMs = from.cutoffEnvMs;
    this.monoMode = from.monoMode; this.pan = from.pan;
    this.vibratoRate = from.vibratoRate; this.vibratoDepth = from.vibratoDepth;
    this.pianoDecayScale = from.pianoDecayScale; this.pianoDetuneCents = from.pianoDetuneCents;
    this.pianoNoiseLevel = from.pianoNoiseLevel; this.pianoBright = from.pianoBright;
    this.dripRatio = from.dripRatio; this.dripTimeMs = from.dripTimeMs; this.dripDecayMs = from.dripDecayMs;
    this.wtPos = from.wtPos; this.wtLfoRate = from.wtLfoRate; this.wtLfoDepth = from.wtLfoDepth;
    this.wtSlots = [...from.wtSlots];
    this.portamentoMs = from.portamentoMs;
    this.filterEnvHz = from.filterEnvHz; this.filterEnvA = from.filterEnvA;
    this.filterEnvD = from.filterEnvD; this.filterEnvS = from.filterEnvS; this.filterEnvR = from.filterEnvR;
    this.modLfoRate = from.modLfoRate; this.modLfoDepth = from.modLfoDepth;
    this.modLfoWave = from.modLfoWave; this.modLfoTarget = from.modLfoTarget;
    this.keyTrack = from.keyTrack; this.velTrack = from.velTrack;
    this.subLevel = from.subLevel; this.subWave = from.subWave;
    this.wtPresetResolver = from.wtPresetResolver;
    this.wtLfoT0 = this.ctx.currentTime;
    this.wtBank = null; this.wtBankDirty = true;   // 波表缓存独立重建
  }
}

// 活跃音符记录:振荡器组 + 包络增益 + 效果引用
interface VoiceRec {
  oscs: OscillatorNode[]; gain: GainNode; vel: number; onT: number;
  freqOscs?: OscillatorNode[];       // 参与滑音的振荡器(不含 LFO)
  oscSpreads?: Map<OscillatorNode, number>;   // 各振荡器失谐(弯音叠加用)
  filterBaseHz?: number;             // 滤波包络基准截止
  filter?: BiquadFilterNode;         // 该音的滤波器(释放时截止回落)
  pedaled?: boolean;                 // 延音踏板挂起
  modLfo?: { osc: OscillatorNode | null; src: ConstantSourceNode | null;
             depthGain: GainNode; target: "cutoff" | "volume" | "pan";
             base: number; rangeFactor: number };
}

// 失真曲线:tanh 软削波(驱动越大越饱和)
function makeDriveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + drive * 15;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = norm > 0.001 ? Math.tanh(x * k) / norm : x;
  }
  return curve;
}
