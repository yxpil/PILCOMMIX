// 琴键 UI + 键盘/鼠标/MIDI 统一演奏调度
import { invoke } from "@tauri-apps/api/core";
import { engine, midiRec, midiOutPort, octaveShift, applyVelocityCurve, midiHeld, transPlaying, playNotes, heldNotes, setOctaveShift } from "../core/store";
import { noteName, KEYMAP } from "../core/notes";
import { $id } from "./dom";
export const heldKeys = new Map<string, number>(); // code → midi

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
window.addEventListener("blur", () => {
  heldKeys.clear();
  mouseKeys.clear();
  mouseHeldOnKeys = false;
  midiHeld.clear();
  engine.allOff();
  updateKeysUI();
});

// ============ 力度曲线(输入力度 → 输出力度) ============
export const ledEl = $id("in-led");
export let ledTimer: number | null = null;
// 输入指示灯:有音符输入就点亮,停止输入 120ms 后熄灭
export function ledBlink() {
  ledEl.classList.add("on");
  if (ledTimer) window.clearTimeout(ledTimer);
  ledTimer = window.setTimeout(() => ledEl.classList.remove("on"), 120);
}

export function noteOn(midi: number, velocity = 1) {
  const v = applyVelocityCurve(velocity);   // 力度曲线映射
  heldNotes.add(midi);
  engine.noteOn(midi, v);
  ledBlink();
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x90, midi, Math.round(v * 127)] }).catch(() => {});
  }
  midiRec.onNote(midi, true, v);
  updateKeysUI();
}
export function noteOff(midi: number) {
  heldNotes.delete(midi);
  engine.noteOff(midi);
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x80, midi, 0] }).catch(() => {});
  }
  midiRec.onNote(midi, false);
  updateKeysUI();
}

// ============ 琴键 UI ============
export const keyboardEl = $id("keyboard");
export const LOW_NOTE = 36;   // C2
export const HIGH_NOTE = 83;  // B5 → 显示 3 个八度(覆盖 Vboard 25 常见 C2-C6 范围)
export const keyEls = new Map<number, HTMLElement>();

// 重建琴键(octaveShift 变化时整体平移)
export function buildKeyboard() {
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
export function isBlack(n: number) { return [1, 3, 6, 8, 10].includes(n % 12); }

export const mouseKeys = new Map<number, boolean>();
export let mouseHeldOnKeys = false;                 // 鼠标按下是否起始于琴键(防从别处拖入琴键区误触发)
export let mousePressPos: { x: number; y: number } | null = null;   // 按下位置(滑奏起始阈值)

export function bindKey(el: HTMLElement, midi: number) {
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
  el.addEventListener("mousedown", (e) => {
    mouseHeldOnKeys = true;
    mousePressPos = { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
    on(e);
  });
  el.addEventListener("mouseenter", (e) => {
    // 滑奏:仅当按下起始于琴键、且指针已移出起始阈值后才触发邻键
    // (避免点击轻微抖动蹭响邻键、以及从面板/画布拖入琴键区时误触发一片)
    if (!mouseHeldOnKeys) return;
    if (!((e as MouseEvent).buttons & 1)) return;
    if (mousePressPos) {
      const dx = (e as MouseEvent).clientX - mousePressPos.x;
      const dy = (e as MouseEvent).clientY - mousePressPos.y;
      if (Math.hypot(dx, dy) < 10) return;
    }
    on(e);
  });
  window.addEventListener("mouseup", () => {
    mouseHeldOnKeys = false;
    off();
  });
}
export function updateKeysUI() {
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
export function shiftOctave(d: number) {
  setOctaveShift(Math.min(2, Math.max(-2, octaveShift + d)));
  $id("octave-val").textContent = noteName(48 + octaveShift * 12);
  buildKeyboard();   // 琴键 UI 整体平移跟随
  updateKeysUI();
}
$id("oct-up").addEventListener("click", () => shiftOctave(1));
$id("oct-down").addEventListener("click", () => shiftOctave(-1));
$id("octave-val").textContent = noteName(48);

// 虚拟按键:与键盘输入完全一致的播放路径(跳过力度曲线,用 MIDI 原始力度)
export function playNoteOn(midi: number, vel: number) {
  engine.noteOn(midi, vel);
  ledBlink();
  updateKeysUI();
}
export function playNoteOff(midi: number) {
  engine.noteOff(midi);
  updateKeysUI();
}
