// 琴键 UI + 键盘/鼠标/MIDI 统一演奏调度(发声走 Rust 引擎)
import { invoke } from "@tauri-apps/api/core";
import { midiRec, midiOutPort, octaveShift, midiHeld, transPlaying, playNotes, heldNotes, setOctaveShift } from "../core/store";
import { ra } from "../core/rust-audio";
import { syncArp } from "./arpeggio";
import { noteName, KEYMAP } from "../core/notes";
import { getKbdAction } from "../core/cc-map";
import { applyCcAction } from "./cc-panel";
import { $id } from "./dom";
export const heldKeys = new Map<string, number>(); // code → midi
const keyRefs = new Map<number, number>();          // midi → 按住的键数(同音高多键防提前释放)
const clampMidi = (m: number) => Math.min(127, Math.max(0, m));

// 按键引用计数:同一音高被多个来源(如 , 与 Q 同音)按下时只发一次声,全部松开才释放
export function pressKey(midi: number, velocity = 1) {
  const c = keyRefs.get(midi) ?? 0;
  keyRefs.set(midi, c + 1);
  if (c === 0) noteOn(midi, velocity);
}
export function releaseKey(midi: number) {
  const c = keyRefs.get(midi) ?? 0;
  if (c <= 1) { keyRefs.delete(midi); noteOff(midi); }
  else keyRefs.set(midi, c - 1);
}

window.addEventListener("keydown", (e) => {
  // 焦点在输入框时,按键只用于输入,不触发音符
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.repeat) return;
  if (e.code === "ArrowUp") { shiftOctave(1); return; }
  if (e.code === "ArrowDown") { shiftOctave(-1); return; }
  if (e.code === "Space") { e.preventDefault(); setSustainPedal(true); return; }
  // 键盘按键绑定(特殊键/小键盘,优先于音符映射)
  const bound = getKbdAction(e.code);
  if (bound) {
    e.preventDefault();
    applyCcAction(bound, 127, 0, true);
    return;
  }
  const base = KEYMAP[e.code];
  if (base === undefined) return;
  e.preventDefault();
  const midi = clampMidi(base + octaveShift * 12);
  if (heldKeys.has(e.code)) return;
  heldKeys.set(e.code, midi);
  pressKey(midi);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { setSustainPedal(false); return; }
  const bound = getKbdAction(e.code);
  if (bound) { applyCcAction(bound, 0, 0, true); return; }
  const midi = heldKeys.get(e.code);
  if (midi === undefined) return;
  heldKeys.delete(e.code);
  releaseKey(midi);
});
window.addEventListener("blur", () => {
  heldKeys.clear();
  keyRefs.clear();
  mouseKeys.clear();
  mouseHeldOnKeys = false;
  midiHeld.clear();
  ra.allOff(0);
  if (bendTarget !== 0) setBendNow(0);
  if (sustainOn) setSustainPedal(false);
  ra.setSostenuto(0, false);   // 绑定键踏板的 keyup 可能丢失,失焦统一释放
  ra.setSoft(0, false);
  updateKeysUI();
});

// ============ 空格 = 延音踏板(CC64) ============
let sustainOn = false;
export function setSustainPedal(on: boolean) {
  if (sustainOn === on) return;
  sustainOn = on;
  ra.setSustain(0, on);
  const led = $id("sustain-led"); if (led) led.classList.toggle("on", on);
  const kled = $id("kbd-sustain-led"); if (kled) kled.classList.toggle("on", on);
  const kst = $id("kbd-status"); if (kst) kst.classList.toggle("on", on);
  const ktxt = $id("kbd-sustain-txt"); if (ktxt) ktxt.textContent = on ? "延音 踩下" : "延音";
}

// ============ 鼠标滚轮 = 滑音(弯音) ============
let bendTarget = 0;          // 当前弯音(半音)
const BEND_LIMIT = 2;        // ±2 半音(与 MIDI 弯音轮默认一致)
let bendTimer: number | null = null;
export function setBendNow(v: number) {
  bendTarget = Math.min(BEND_LIMIT, Math.max(-BEND_LIMIT, v));
  ra.setBend(0, bendTarget);
  const el = $id("kbd-bend");
  if (el) el.textContent = `滑音 ${bendTarget >= 0 ? "+" : ""}${bendTarget.toFixed(2)}`;
}
// 滚轮在琴键区滚动 → 弯音;停止 3s 后自动回中(模拟弯音轮松手回中)
window.addEventListener("wheel", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest("#keyboard, #kbd-status")) return;
  // 演奏操作:释放输入框焦点,保证后续琴键/空格不被拦截
  (document.activeElement as HTMLElement | null)?.blur?.();
  e.preventDefault();
  // 灵敏度 0.006 半音/滚格(约 1.2 格 = 半音,听感明显)
  setBendNow(bendTarget - (e as WheelEvent).deltaY * 0.006);
  if (bendTimer) window.clearTimeout(bendTimer);
  bendTimer = window.setTimeout(() => setBendNow(0), 3000);
}, { passive: false });

// 滚轮中键按下 → 滑音立即归零(应急回中,不用等 3s 自动回中)
window.addEventListener("mousedown", (e) => {
  if ((e as MouseEvent).button !== 1) return;   // 1 = 中键
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest("#keyboard, #kbd-status")) return;
  e.preventDefault();
  if (bendTimer) window.clearTimeout(bendTimer);
  bendTimer = null;
  setBendNow(0);
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
  heldNotes.add(midi);
  ra.noteOn(0, midi, velocity);   // 力度曲线在 Rust 统一应用
  ledBlink();
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x90, midi, Math.round(velocity * 127)] }).catch(() => {});
  }
  midiRec.onNote(midi, true, velocity);
  updateKeysUI();
  syncArp();
}
export function noteOff(midi: number) {
  heldNotes.delete(midi);
  ra.noteOff(0, midi);
  if (midiOutPort !== null) {
    invoke("midi_send", { port: midiOutPort, data: [0x80, midi, 0] }).catch(() => {});
  }
  midiRec.onNote(midi, false);
  updateKeysUI();
  syncArp();
}

// ============ 琴键 UI ============
export const keyboardEl = $id("keyboard");
export const LOW_NOTE = 36;    // C2
export const HIGH_NOTE = 101;  // F7 → 覆盖 KEYMAP 全部键位(C2-F7,F1-F12/小键盘/-= 全部可见)
export const keyEls = new Map<number, HTMLElement>();

// 按键名美化(反查 KEYMAP 用)
function prettyKeyName(code: string): string {
  return code
    .replace("Key", "").replace("Digit", "")
    .replace("BracketLeft", "【").replace("BracketRight", "】")
    .replace("Semicolon", ";").replace("Quote", "'")
    .replace("Comma", ",").replace("Period", ".").replace("Slash", "/")
    .replace("Minus", "-").replace("Equal", "=")
    .replace("Numpad", "小");
}

// 重建琴键(octaveShift 变化时整体平移)
export function buildKeyboard() {
  const low = LOW_NOTE + octaveShift * 12;
  const high = HIGH_NOTE + octaveShift * 12;
  keyboardEl.innerHTML = "";
  keyEls.clear();
  // 按键说明与真实按键联动:每个 KEYMAP 键位按当前八度平移后,
  // 在显示位置上标注对应的按键名(主键盘优先;多个键同音取第一个)
  const keyAt = new Map<number, string>();
  for (const [code, m] of Object.entries(KEYMAP)) {
    const shown = m + octaveShift * 12;
    if (shown < low || shown > high) continue;
    if (!keyAt.has(shown)) keyAt.set(shown, prettyKeyName(code));
  }
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
    const keyName = keyAt.get(n) ?? "";
    // 按键说明 = 电脑按键名(主)+ 音名(副),随八度平移保持一致
    label.innerHTML = keyName ? `<b>${keyName}</b><i>${noteName(n)}</i>` : `<i>${noteName(n)}</i>`;
    el.title = `${keyName || "鼠标"} → ${noteName(n)}`;
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
    const keyName = keyAt.get(n) ?? "";
    label.innerHTML = keyName ? `<b>${keyName}</b>` : `<i>${noteName(n)}</i>`;
    el.title = `${keyName || "鼠标"} → ${noteName(n)}`;
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
    pressKey(midi);
  };
  const off = () => {
    if (!mouseKeys.get(midi)) return;
    mouseKeys.delete(midi);
    releaseKey(midi);
  };
  el.addEventListener("mousedown", (e) => {
    if ((e as MouseEvent).button !== 0) return;   // 只左键弹奏;中键留给滑音归零
    // 点琴键 = 开始演奏:释放输入框焦点,避免之后空格/琴键被 INPUT 焦点拦截
    (document.activeElement as HTMLElement | null)?.blur?.();
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
  // 高亮来源:键盘/鼠标按住的音符 + 播放中的音符 + MIDI 输入(UI 状态,发声在 Rust)
  const active = new Set([...heldNotes]);
  for (const n of playNotes) active.add(n);
  for (const m of midiHeld.values()) active.add(m);
  if (transPlaying) for (const n of playNotes) active.add(n);
  // 显示域跟随:只跟随 MIDI 键盘(电脑键盘/鼠标/播放用 ↑↓/按钮手动控八度,避免弹奏时自己跳)
  if (midiHeld.size > 0) {
    const low = LOW_NOTE + octaveShift * 12;
    const high = HIGH_NOTE + octaveShift * 12;
    const srt = [...active].sort((a, b) => a - b);
    const mn = srt[0], mx = srt[srt.length - 1];
    if (mn < low + 2 || mx > high - 2) {
      const center = (mn + mx) / 2;
      const wantShift = Math.round((center - (LOW_NOTE + HIGH_NOTE) / 2) / 12);
      const ns = Math.max(-4, Math.min(5, wantShift));
      if (ns !== octaveShift) {
        setOctaveShift(ns);
        $id("octave-val").textContent = noteName(48 + octaveShift * 12);
        buildKeyboard();   // 重建后 keyEls 更新,下方高亮作用于新琴键
      }
    }
  }
  keyEls.forEach((el, midi) => el.classList.toggle("active", active.has(midi)));
  // 当前音符显示
  const sorted = [...active].sort((a, b) => a - b);
  $id("nd-notes").textContent = sorted.length ? sorted.map(noteName).join(" ") : "-";
}

// ============ MIDI 输入 ============
// 走 Rust midir 原生层(WebView2 Web MIDI 实例不稳定):invoke 枚举/连接,event 收消息
export function shiftOctave(d: number) {
  setOctaveShift(Math.min(5, Math.max(-4, octaveShift + d)));
  $id("octave-val").textContent = noteName(48 + octaveShift * 12);
  buildKeyboard();   // 琴键 UI 整体平移跟随
  updateKeysUI();
}
$id("oct-up").addEventListener("click", () => shiftOctave(1));
$id("oct-down").addEventListener("click", () => shiftOctave(-1));
$id("octave-val").textContent = noteName(48);

// 虚拟按键:与键盘输入完全一致的播放路径(跳过力度曲线,用 MIDI 原始力度)
// ch 可选:多轨播放时指定通道引擎分身(发声走 Rust);所有通道都计入琴键高亮
export function playNoteOn(midi: number, vel: number, ch = 0) {
  ra.noteOn(ch, midi, vel);
  playNotes.add(midi);
  ledBlink();
  updateKeysUI();
}
export function playNoteOff(midi: number, ch = 0) {
  ra.noteOff(ch, midi);
  if (ch !== 0) playNotes.delete(midi);
  updateKeysUI();
}
