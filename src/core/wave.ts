// 波形数学与常量(纯逻辑,无 DOM / 引擎依赖)
export type WaveType = "sine" | "square" | "saw" | "triangle" | "custom"
  | "moog" | "dx7" | "piano" | "drip"
  | "acc" | "clar" | "harp" | "guzheng"
  | "wt";
export const PIANO_HARMONICS: [number, number, number][] = [
  // [泛音序数, 相对幅度, 衰减时间(s)]
  [1, 1.0, 3.2], [2, 0.75, 2.1], [3, 0.55, 1.4], [4, 0.4, 1.0],
  [5, 0.28, 0.75], [6, 0.19, 0.55], [7, 0.12, 0.42], [8, 0.08, 0.32],
];
export const INHARMONICITY = 0.00035;   // 非调和系数(钢琴泛音轻微偏高)
export interface SynthDef {
  oscWave: OscillatorType;            // 基础振荡器波形
  detune?: number;                    // 双振荡器失谐(音分)
  filterType?: BiquadFilterType;      // 滤波器类型
  cutoff?: number;                    // 截止频率(Hz)
  resonance?: number;                 // 共振 Q
  cutoffEnv?: number;                 // 触发时截止频率扫频量(Hz,正=上升)
  cutoffEnvTime?: number;             // 扫频时间(s)
}
export const PRESET_DEFS: Record<string, SynthDef> = {
  // Minimoog:单锯齿 + 4-pole 低通(温暖)
  moog:   { oscWave: "sawtooth", filterType: "lowpass", cutoff: 2600, resonance: 0.7 },
};
export const WT_SLOTS: WaveType[] = ["sine", "triangle", "square", "saw", "dx7", "harp", "guzheng", "custom"];
export const WT_SLOT_NAMES: Record<string, string> = {
  sine: "正弦", triangle: "三角", square: "方波", saw: "锯齿",
  dx7: "FM", harp: "竖琴", guzheng: "古筝", custom: "自定义",
};
// 渐变槽位可选波形(下拉用)
export const WT_SLOT_OPTIONS: WaveType[] = ["sine", "triangle", "square", "saw", "moog", "dx7", "piano", "drip", "acc", "clar", "harp", "guzheng", "custom"];
export const WT_SLOT_OPTION_NAMES: Record<string, string> = {
  sine: "正弦", triangle: "三角", square: "方波", saw: "锯齿", dx7: "FM",
  piano: "钢琴", drip: "水滴", acc: "手风琴", clar: "单簧管", harp: "竖琴",
  guzheng: "古筝", custom: "自定义",
};

// DX7 是 FM 合成器:载波 + 调制算子,音色由 FM 边带和调制指数包络决定。
export function dx7FmWave(p: number): number {
  return 0.6 * Math.sin(2 * Math.PI * p + 3 * Math.sin(2 * Math.PI * p))
       + 0.4 * Math.sin(2 * Math.PI * p + 2 * Math.sin(4 * Math.PI * p));
}

export function presetWaveAt(type: string, p: number): number {
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
export function interpAnchors(anchors: { x: number; y: number }[], px: number): number {
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

export function builtinWaveAt(type: WaveType, p: number): number {
  switch (type) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "square": return p < 0.5 ? 1 : -1;
    case "saw": return 2 * p - 1;
    case "triangle": return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return presetWaveAt(type, p);   // 合成器预设
  }
}

// 波表槽位波形函数(与发声一致)
export function wtSlotFnAt(slot: string, p: number): number {
  switch (slot) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "triangle": return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case "square": return p < 0.5 ? 1 : -1;
    case "saw": return 2 * p - 1;
    default: return presetWaveAt(slot, p);   // dx7/harp/guzheng
  }
}

export function builtinAnchors(type: WaveType): { x: number; y: number }[] {
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
export class FnParser {
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

