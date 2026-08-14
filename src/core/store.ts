// 全局单例与共享状态(引擎实例、演奏状态、渐变组、预设捕获;无 DOM 依赖)
import { SynthEngine } from "./engine";
import { ra } from "./rust-audio";
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
    programChanges: { track: number; tick: number; program: number; ch: number }[];
  },
  // SMF 原始字节(Rust 播放调度用)
  smfBytes: null as null | Uint8Array,
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
// 增益换算:UI 用 dB(-24..+6),Rust 收线性
export function dbToLin(db: number): number { return Math.pow(10, db / 20); }
export function linToDb(lin: number): number { return 20 * Math.log10(Math.max(lin, 1e-4)); }
export function fmtDb(db: number): string { return (db > 0 ? "+" : "") + Math.round(db) + "dB"; }

export function captureParams() {
  return {
    waveType: engine.waveType,
    oscWave: engine.oscWave,
    subLevel: engine.subLevel,
    subWave: engine.subWave,
    gain: engine.gain,
    noteJitter: engine.noteJitter,
    dxPm: engine.dxPm,
    dxLutSize: engine.dxLutSize,
    dxQuantBits: engine.dxQuantBits,
    dxDac: engine.dxDac,
    dxBits: Math.round(engine.dxBits),   // Rust u8,强制整数
    dxAa: engine.dxAa,
    dxAlgorithm: engine.dxAlgorithm,
    dxFeedback: Math.round(engine.dxFeedback),   // Rust u8,强制整数
    dxRatios: [...engine.dxRatios],
    dxTls: [...engine.dxTls],
    dxDets: [...engine.dxDets],
    dxEgs: [...engine.dxEgs],
    oscCount: Math.round(engine.oscCount),   // Rust u8,强制整数
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
    grainSizeMs: engine.grainSizeMs, grainDensity: engine.grainDensity,
    grainSpread: engine.grainSpread, grainRandom: engine.grainRandom,
    grainSizeEnd: engine.grainSizeEnd, grainDensityEnd: engine.grainDensityEnd,
    grainEnvMs: engine.grainEnvMs, grainEnvExp: engine.grainEnvExp,
    delayTimeMs: engine.delayTimeMs, delayFeedback: engine.delayFeedback, delayMix: engine.delayMix,
    drive: engine.drive,
    eqBass: engine.eqBass,
    eqMid: engine.eqMid,
    eqTreble: engine.eqTreble,

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

// ============ 用户预设数据迁移(旧版本格式 → 新格式) ============
// 新格式:{ name, params }(params = captureParams 全参数)
// 旧版本保存格式可能为平铺:{ name, waveType, attack, ... }(无 params 字段)
// 迁移规则:
//   - params 是有效对象(有字段)→ 已是新格式,原样保留
//   - params 缺失/无效但有 waveType 字段 → 整条(除 name)当 params 升级
//   - 完全无法识别(既无 params 也无 waveType)→ 视为垃圾数据剔除
//     (历史遗留:早期测试写入的残缺条目,加载无意义)
export function migratePresets(list: unknown[]): { list: unknown[]; changed: boolean } {
  let changed = false;
  const out: unknown[] = [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const it = item as Record<string, unknown>;
      const hasValidParams = !!it.params && typeof it.params === "object"
        && Object.keys(it.params as object).length > 0;
      if (hasValidParams) {
        out.push(item);   // 新格式,保留
      } else if (typeof it.waveType === "string") {
        // 旧版平铺:除 name/params 外的全部字段 = 合成参数
        const { name, params: _p, ...rest } = it;
        out.push({ name: String(name ?? "未命名"), params: rest });
        changed = true;
      } else {
        // 无法识别:剔除(垃圾数据,保留只会反复报"无法识别")
        changed = true;
      }
    }
  }
  return { list: out, changed };
}

// 粒子参数控件状态同步(仅粒子音色 PILG1 可调)
const GRAIN_CTRL_IDS = ["grain-size", "grain-density", "grain-spread", "grain-random"];
const GRAIN_EXT_IDS = ["grain-size-end", "grain-density-end", "grain-env-ms", "grain-env-exp"];
export function setGrainCtrlState(wave: string, extOn = false) {
  // 基础参数:粒子音色可调;粒子扩展勾选时(引擎处于粒子模式)同样可调
  const baseOn = wave === "grain" || extOn;
  for (const id of GRAIN_CTRL_IDS) {
    const c = document.getElementById(id) as HTMLInputElement | null;
    if (c) c.disabled = !baseOn;
  }
  for (const id of GRAIN_EXT_IDS) {
    const c = document.getElementById(id) as HTMLInputElement | null;
    if (c) c.disabled = !extOn;       // 扩展参数:只跟扩展开关
  }
}

// PM 扩展开关状态同步(音色切换/预设加载时调用;PM 音色自动开启)
// 扩展关闭时硬件模拟控件禁用(PM 相位调制/查表/定点/抗混叠/算法/反馈)
const PM_CTRL_IDS = ["dx-pm", "dx-lut", "dx-quant", "dx-aa", "dx-algorithm", "dx-feedback"];
export function setPmExtFromWave(wave: string) {
  const el = document.getElementById("pm-ext") as HTMLInputElement | null;
  const isPm = wave === "dx7";
  if (el) el.checked = isPm;
  for (const id of PM_CTRL_IDS) {
    const c = document.getElementById(id) as HTMLInputElement | null;
    if (c) c.disabled = !isPm;
  }
}

// ============ 全部参数复位(傻瓜模式) ============
// 引擎所有参数恢复默认并推 Rust;所有面板控件同步回默认值;
// 扩展开关(PM/粒子)关闭。复位后 = 按下琴键即出默认音色,无需任何调节。
// 注意:不能用 new SynthEngine() 重置(构造函数会新建 AudioContext,
// 副作用大且可能被浏览器限制导致无声)——用启动时的字段快照。

// 启动时保存引擎字段默认快照(纯字段副本)
const engineDefaults: Record<string, unknown> = {};
for (const k of Object.keys(engine)) engineDefaults[k] = (engine as unknown as Record<string, unknown>)[k];

import type { SynthEngine as _SynthEngine } from "./engine";   // 仅类型,无运行时依赖

export function resetAllToDefault() {
  // ① 引擎参数恢复启动默认(字段快照,不触碰 AudioContext/运行时节点)
  for (const k of Object.keys(engineDefaults)) {
    (engine as unknown as Record<string, unknown>)[k] = engineDefaults[k];
  }
  // ② 力度曲线/响度状态回默认(独立于引擎字段,复位必须覆盖:
  //    用户调过的力度曲线可能把输入力度映射为 0 → 弹琴无声)
  const velDefault: [number, number][] = [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]];
  for (let i = 0; i < velAnchors.length && i < velDefault.length; i++) {
    velAnchors[i].x = velDefault[i][0];
    velAnchors[i].y = velDefault[i][1];
  }
  velMin = 0.2;
  velPower = 1;
  // ③ 推 Rust(整组灌入默认参数)
  try {
    ra.setEngineParams(0, captureParams());
    ra.setMaster("volume", dbToLin(0));
    ra.setMaster("reverb", 0.25);
    ra.setMaster("drive", 0);
    ra.setMaster("chorus_mix", 0);
    ra.setMaster("mute", 0);
  } catch { /* ignore */ }
  // ④ UI 同步(由调用方触发各面板 refresh + 按钮状态)
}
