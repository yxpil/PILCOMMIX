// 音符/键盘映射/简谱工具(纯逻辑)
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(midi: number): string {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
export const KEYMAP: Record<string, number> = {
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
export const JP_NUMS = ["1", "#1", "2", "#2", "3", "4", "#4", "5", "#5", "6", "#6", "7"];

export function midiToJianpu(midi: number): string {
  const pc = midi % 12;
  const oct = Math.floor(midi / 12) - 1;   // C4 = 60 → oct 4
  const base = JP_NUMS[pc];
  if (oct === 4) return base;
  if (oct > 4) return base + "'".repeat(Math.min(3, oct - 4));    // 高音
  return base + "_".repeat(Math.min(3, 4 - oct));                  // 低音
}
export function jpDuration(beats: number): string {
  if (beats >= 3.5) return "---";   // 全音符
  if (beats >= 1.5) return "-";     // 二分音符
  if (beats >= 0.75) return "";     // 四分音符
  if (beats >= 0.375) return "_";   // 八分音符
  return "__";                      // 十六分音符
}

export function velLabel(v: number): string {
  return v < 0.4 ? "弱" : v < 0.75 ? "中" : "强";
}

