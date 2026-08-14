// CC 映射:旋钮/按钮 → 参数动作(用户可自定义绑定,优先于内置默认映射)
// 动作名 → 中文显示名(旋钮映射选项卡下拉 + 状态条)
export const CC_ACTIONS: Record<string, string> = {
  sustain: "延音踏板",
  chord_hold: "和弦保持",
  mod_depth: "调制深度",
  cutoff: "滤波截止",
  resonance: "滤波谐振",
  attack: "起音",
  decay: "衰减",
  sustain_level: "延音电平",
  release: "释放",
  reverb: "混响",
  delay_mix: "延迟混合",
  delay_feedback: "延迟反馈",
  drive: "驱动",
  volume: "主增益",
  gain: "引擎增益",
  pan: "声像",
  vib_rate: "颤音速率",
  vib_depth: "颤音深度",
  oct_up: "八度上",
  oct_down: "八度下",
  arp_toggle: "琶音开关",
};

// 内置默认映射(标准 CC;用户绑定可覆盖)
export const DEFAULT_CC_MAP: Record<number, string> = {
  1: "mod_depth",
  14: "oct_down", 15: "oct_up", 26: "oct_down", 27: "oct_up",
  64: "sustain",
  66: "chord_hold",
  71: "resonance", 72: "release", 73: "attack", 74: "cutoff",
  91: "reverb",
};
// ARP 按钮候选区间(102-113, 117-119)
for (let cc = 102; cc <= 113; cc++) DEFAULT_CC_MAP[cc] = "arp_toggle";
for (let cc = 117; cc <= 119; cc++) DEFAULT_CC_MAP[cc] = "arp_toggle";

const CC_MAP_KEY = "commix-cc-map";
export function loadCcMap(): Record<number, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CC_MAP_KEY) || "{}") as Record<string, string>;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const cc = Number(k);
      if (cc >= 0 && cc <= 127 && CC_ACTIONS[v]) out[cc] = v;
    }
    return out;
  } catch { return {}; }
}
export function saveCcMap(m: Record<number, string>) {
  try { localStorage.setItem(CC_MAP_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
// 解析优先级:用户绑定 → 内置默认 → null(未映射)
export function getCcAction(cc: number): string | null {
  const u = loadCcMap();
  if (u[cc]) return u[cc];
  return DEFAULT_CC_MAP[cc] ?? null;
}
