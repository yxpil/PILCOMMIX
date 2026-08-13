// 全局单例与共享状态(引擎实例、演奏状态、渐变组、预设捕获;无 DOM 依赖)
import { SynthEngine } from "./engine";
import type { SmfNote } from "./smf";
export const engine = new SynthEngine();
export const midiRec = {
  events: [] as { t: number; on: boolean; note: number; vel: number }[],
  recording: false,
  start() { this.events = []; this.recording = true; },
  stop() { this.recording = false; },
  onNote(note: number, on: boolean, vel = 1) {
    if (!this.recording) return;
    this.events.push({ t: performance.now() - recStart, on, note, vel });
  },
};

export let anchors: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 0.25, y: 0.7 }, { x: 0.5, y: 0 },
  { x: 0.75, y: -0.7 }, { x: 1, y: 0 },
];
export function applyWaveToEngine() {
  if (engine.waveType === "custom") engine.setCustomWave(anchors);
  else engine.setWave(engine.waveType);
}
export let octaveShift = 0;
export const velAnchors: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 }, { x: 1, y: 1 },
];
export let velMin = 0.2;    // 响度下限:0-1(任何真实按击输出不低于此值,轻按也有声)
export let velPower = 1;    // 衰减强度:0.3-3(曲线指数,>1 更重按才响,<1 更轻按易响)
export function applyVelocityCurve(v: number): number {
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
export const transState = {
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
    programChanges: { track: number; tick: number; program: number }[];
  },
};

// 时值标记:按拍数 → 简谱时值符号(标准记谱)
export let midiOutPort: number | null = null;   // 输出端口索引(选择器 value)
// MIDI 输入按住的音符:原始键号 → 移调后键号(八度变化时保证 noteOff 对准,不卡音)
export const midiHeld = new Map<number, number>();

export let recStart = 0;
export interface WtBank { name: string; slots: string[]; }   // 槽位:内置波形名 或 "preset:<预设名>"
export const WT_KEY = "commix-wt-banks";
export const DEFAULT_WT_BANKS: WtBank[] = [
  { name: "渐变 1", slots: ["sine", "triangle", "square", "saw", "dx7", "harp", "guzheng", "custom"] },
  { name: "渐变 2", slots: ["dx7", "harp", "guzheng", "piano", "drip", "acc", "clar", "custom"] },
  { name: "渐变 3", slots: ["saw", "square", "triangle", "sine", "custom", "harp", "guzheng", "dx7"] },
  { name: "渐变 4", slots: ["sine", "harp", "guzheng", "custom", "triangle", "clar", "acc", "dx7"] },
];
export function wtLoadBanks(): WtBank[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WT_KEY) || "");
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((b: WtBank, i: number) => ({
        name: typeof b.name === "string" && b.name ? b.name : "渐变 " + (i + 1),
        slots: Array.isArray(b.slots) && b.slots.length >= 2 && b.slots.length <= 16
          ? b.slots : [...DEFAULT_WT_BANKS[i % DEFAULT_WT_BANKS.length].slots],
      }));
    }
  } catch { /* 数据损坏则用默认 */ }
  return DEFAULT_WT_BANKS.map((b) => ({ name: b.name, slots: [...b.slots] }));
}
export let wtBanks = wtLoadBanks();
export let wtBankIdx = 0;
engine.wtSlots = [...wtBanks[0].slots];

// 用户预设存储键(渐变槽位下拉也要读它)
export const PRESET_KEY = "commix-presets";
engine.markWtDirty();
export function wtSaveBanks() { localStorage.setItem(WT_KEY, JSON.stringify(wtBanks)); }
export function captureParams() {
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
    wtPos: engine.wtPos,
    wtLfoRate: engine.wtLfoRate,
    wtLfoDepth: engine.wtLfoDepth,
    wtSlots: [...engine.wtSlots],
    bendCents: engine.bendCents,
    portamentoMs: engine.portamentoMs,
    sustainPedal: engine.sustainPedal,
    filterEnvHz: engine.filterEnvHz,
    filterEnvA: engine.filterEnvA, filterEnvD: engine.filterEnvD,
    filterEnvS: engine.filterEnvS, filterEnvR: engine.filterEnvR,
    modLfoRate: engine.modLfoRate, modLfoDepth: engine.modLfoDepth,
    modLfoWave: engine.modLfoWave, modLfoTarget: engine.modLfoTarget,
    keyTrack: engine.keyTrack, velTrack: engine.velTrack,
    delayTimeMs: engine.delayTimeMs, delayFeedback: engine.delayFeedback, delayMix: engine.delayMix,
    drive: engine.drive,
    subLevel: engine.subLevel, subWave: engine.subWave,
    velCurve: velAnchors.map((a) => a.y),
    velMin, velPower,
  };
}

// 波形预设按钮(共享:presets 切换高亮,wave-editor 应用函数时联动)
export const presetButtons = [...document.querySelectorAll(".preset-btn[data-wave]")] as HTMLButtonElement[];

// 共享可变状态(ESM 导入绑定只读,统一用 setter 修改)
export let transPlaying = false;
export function setTransPlaying(v: boolean) { transPlaying = v; }
export const playNotes = new Set<number>();
export function setOctaveShift(v: number) { octaveShift = v; }
export function setAnchors(a: { x: number; y: number }[]) { anchors = a; }
export function setVelMin(v: number) { velMin = v; }
export function setVelPower(v: number) { velPower = v; }
export function setRecStart(v: number) { recStart = v; }
export function setMidiOutPort(v: number | null) { midiOutPort = v; }
export function setWtBankIdx(v: number) { wtBankIdx = v; }

// 真实输入按住的音符(琶音器采样;键盘/鼠标/MIDI 统一维护)
export const heldNotes = new Set<number>();
