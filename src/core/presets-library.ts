// 内置预设库:带 GM 程序号标号,播放 MIDI 时程序号 → 直接对应音色
// 参数键与 captureParams 一致(camelCase);未覆盖的字段继承主引擎当前参数
import type { WaveType } from "./wave";

export interface LibraryPreset {
  program: number;   // GM 程序号 0-127(标号)
  name: string;      // 中文名
  wave: WaveType;
  p?: Record<string, unknown>;
}

// 常用预设(30 个,覆盖 GM 常见音色):MIDI 程序号即标号
export const PRESET_LIBRARY: LibraryPreset[] = [
  { program: 0,  name: "大钢琴",            wave: "piano" },
  { program: 1,  name: "亮钢琴",            wave: "piano", p: { pianoBright: 1.6, release: 0.6, pianoDetuneCents: 4 } },
  { program: 2,  name: "电钢琴",            wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxQuantBits: 16, dxAa: true, dxAlgorithm: 2, dxFeedback: 1, dxRatios: [1, 1, 14, 1, 1, 14], dxTls: [80, 70, 60, 76, 70, 60] } },
  { program: 4,  name: "电钢琴2",           wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxQuantBits: 16, dxAa: true, dxAlgorithm: 1, dxFeedback: 2, dxRatios: [1, 0.5, 14, 14, 0.5, 14], dxTls: [82, 70, 55, 60, 60, 60] } },
  { program: 6,  name: "羽管键琴",          wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 1, dxFeedback: 3, dxRatios: [1, 2.73, 1.41, 3, 2.01, 1], dxTls: [82, 52, 56, 64, 68, 72], attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.15 } },
  { program: 8,  name: "钢片琴",            wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 1, dxFeedback: 0, dxRatios: [1, 4, 10.5, 4, 7, 1], dxTls: [84, 60, 55, 62, 58, 70], attack: 0.004, decay: 0.4, sustain: 0.1, release: 0.2 } },
  { program: 11, name: "颤音琴",            wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 2, dxFeedback: 1, dxRatios: [1, 3.5, 7, 1, 3.5, 7], dxTls: [80, 62, 55, 78, 62, 55], attack: 0.01, decay: 0.8, sustain: 0.4, release: 0.4, vibratoDepth: 0.02, vibratoRate: 5 } },
  { program: 12, name: "马林巴",            wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 1, dxFeedback: 2, dxRatios: [1, 4, 2.5, 5.5, 8, 1], dxTls: [86, 58, 62, 55, 60, 75], attack: 0.004, decay: 0.3, sustain: 0.05, release: 0.15 } },
  { program: 16, name: "风琴",              wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 7, dxFeedback: 0, dxRatios: [1, 2, 3, 4, 0.5, 1.5], dxTls: [55, 60, 65, 62, 58, 66], attack: 0.008, decay: 0.05, sustain: 0.9, release: 0.1 } },
  { program: 19, name: "摇滚风琴",          wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 7, dxFeedback: 2, dxRatios: [1, 1, 2, 4, 0.5, 3], dxTls: [50, 55, 62, 58, 52, 64], attack: 0.005, decay: 0.03, sustain: 0.95, release: 0.05 } },
  { program: 24, name: "尼龙吉他",          wave: "harp", p: { decay: 0.8, sustain: 0.2, release: 0.4 } },
  { program: 25, name: "钢弦吉他",          wave: "guzheng", p: { decay: 0.6, sustain: 0.2, release: 0.3 } },
  { program: 27, name: "清音电吉他",        wave: "triangle", p: { oscCount: 2, detuneCents: 6, cutoffHz: 2200, decay: 0.25, sustain: 0.5, release: 0.2 } },
  { program: 32, name: "贝斯",              wave: "saw", p: { oscCount: 2, detuneCents: 8, cutoffHz: 350, resonanceQ: 1.2, attack: 0.008, decay: 0.4, sustain: 0.6, release: 0.2 } },
  { program: 33, name: "指拨贝斯",          wave: "triangle", p: { oscCount: 2, detuneCents: 4, cutoffHz: 500, attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.2 } },
  { program: 40, name: "小提琴",            wave: "saw", p: { oscCount: 1, cutoffHz: 1500, resonanceQ: 1.0, attack: 0.09, decay: 0.2, sustain: 0.85, release: 0.4, vibratoDepth: 0.015, vibratoRate: 5 } },
  { program: 42, name: "大提琴",            wave: "saw", p: { oscCount: 2, detuneCents: 5, cutoffHz: 700, attack: 0.07, decay: 0.2, sustain: 0.85, release: 0.4, vibratoDepth: 0.01, vibratoRate: 4.5 } },
  { program: 48, name: "弦乐群",            wave: "wt", p: { wtSlots: ["sawtooth", "triangle"], wtPos: 0.5, attack: 0.15, decay: 0.2, sustain: 0.8, release: 0.8, cutoffHz: 900, detuneCents: 6, vibratoDepth: 0.008, vibratoRate: 4 } },
  { program: 52, name: "人声合唱",          wave: "wt", p: { wtSlots: ["sine", "triangle"], wtPos: 0.4, attack: 0.2, decay: 0.2, sustain: 0.8, release: 0.6, cutoffHz: 1400, vibratoDepth: 0.012, vibratoRate: 5 } },
  { program: 56, name: "小号",              wave: "saw", p: { oscCount: 1, cutoffHz: 2000, resonanceQ: 1.1, attack: 0.02, decay: 0.15, sustain: 0.9, release: 0.15 } },
  { program: 57, name: "长号",              wave: "saw", p: { oscCount: 1, cutoffHz: 1000, resonanceQ: 1.0, attack: 0.03, decay: 0.15, sustain: 0.9, release: 0.2 } },
  { program: 60, name: "圆号",              wave: "saw", p: { oscCount: 2, detuneCents: 6, cutoffHz: 800, attack: 0.05, decay: 0.2, sustain: 0.85, release: 0.3 } },
  { program: 71, name: "单簧管",            wave: "clar" },
  { program: 73, name: "长笛",              wave: "sine", p: { attack: 0.09, decay: 0.15, sustain: 0.85, release: 0.3, vibratoDepth: 0.015, vibratoRate: 5.5 } },
  { program: 80, name: "方波主音",          wave: "square", p: { oscCount: 2, detuneCents: 5, cutoffHz: 3000, release: 0.15 } },
  { program: 81, name: "锯齿主音",          wave: "saw", p: { oscCount: 2, detuneCents: 6, cutoffHz: 4000, release: 0.15 } },
  { program: 85, name: "合成主音",          wave: "saw", p: { oscCount: 3, detuneCents: 12, cutoffHz: 3500, resonanceQ: 1.3, attack: 0.01, release: 0.4 } },
  { program: 89, name: "合成铺底",          wave: "wt", p: { wtSlots: ["sawtooth", "square"], wtPos: 0.3, attack: 0.3, decay: 0.3, sustain: 0.8, release: 1.0, cutoffHz: 1500, detuneCents: 10 } },
  { program: 99, name: "水晶音",            wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 6, dxFeedback: 2, dxRatios: [1, 0.5, 2.01, 3, 4.2, 1], dxTls: [78, 70, 60, 55, 50, 68], attack: 0.02, decay: 0.6, sustain: 0.4, release: 0.8, vibratoDepth: 0.01, vibratoRate: 4 } },
  { program: 104, name: "铃音",             wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 1, dxFeedback: 3, dxRatios: [1, 3.5, 2.5, 5, 7, 1], dxTls: [84, 60, 62, 55, 50, 70], attack: 0.005, decay: 0.5, sustain: 0.2, release: 0.4 } },
  { program: 108, name: "金属钟",           wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxQuantBits: 16, dxAa: true, dxAlgorithm: 1, dxFeedback: 3, dxRatios: [1, 2.73, 1.41, 3, 2.01, 1], dxTls: [58, 34, 38, 46, 50, 52], gain: 2.0, attack: 0.004, decay: 1.2, sustain: 0.1, release: 1.5 } },
  { program: 113, name: "滴水",             wave: "drip" },
  { program: 120, name: "八音盒",           wave: "dx7", p: { dxPm: true, dxLutSize: 4096, dxAa: true, dxAlgorithm: 2, dxFeedback: 0, dxRatios: [1, 1, 4, 1, 1, 4], dxTls: [80, 70, 55, 78, 70, 55], attack: 0.004, decay: 0.7, sustain: 0.1, release: 0.3 } },
];

// 程序号 → 库内预设(精确匹配)
export function findLibraryPreset(program: number): LibraryPreset | undefined {
  return PRESET_LIBRARY.find((x) => x.program === program);
}

// 自动随机匹配:未定义的程序号 → 确定性散列到库(同一程序号每次稳定同一音色)
export function randomLibraryPreset(program: number): LibraryPreset {
  const idx = ((program * 2654435761) >>> 0) % PRESET_LIBRARY.length;
  return PRESET_LIBRARY[idx];
}

// ============ 用户自定义绑定(程序号 → 库内音色) ============
const USER_MAP_KEY = "commix-program-map";
export function loadUserMap(): Map<number, number> {
  const m = new Map<number, number>();
  try {
    const raw = JSON.parse(localStorage.getItem(USER_MAP_KEY) || "{}") as Record<string, number>;
    for (const [k, v] of Object.entries(raw)) {
      const prog = Number(k);
      if (prog >= 0 && prog <= 127 && typeof v === "number" && v >= 0 && v <= 127) m.set(prog, v);
    }
  } catch { /* ignore */ }
  return m;
}
export function saveUserMap(m: Map<number, number>) {
  const obj: Record<string, number> = {};
  for (const [k, v] of m) obj[String(k)] = v;
  try { localStorage.setItem(USER_MAP_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

// 把库内预设转成引擎参数(captureParams 形状;未覆盖字段继承主引擎)
export function libraryParams(lib: LibraryPreset): Record<string, unknown> {
  return { waveType: lib.wave, ...(lib.p ?? {}) };
}
