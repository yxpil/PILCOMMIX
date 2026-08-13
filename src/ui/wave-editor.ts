// 波形编辑器:画布绘制/锚点/画笔/函数波形/波表形态预览
import { engine, anchors, presetButtons, applyWaveToEngine, setAnchors } from "../core/store";
import { WT_SLOT_NAMES, builtinWaveAt, interpAnchors, wtSlotFnAt, builtinAnchors, FnParser } from "../core/wave";
import { WAVE_LEN } from "../core/engine";
import { $id, toast } from "./dom";
export const waveCanvas = $id("wave-canvas") as HTMLCanvasElement;
export const ctx2d = waveCanvas.getContext("2d")!;

export let draggingAnchor: { x: number; y: number } | null = null;
export let painting = false;          // 画笔模式:按住空白处拖动画波形
export const MIN_DX = 0.012;          // 画笔最小采样间距(x 归一化)

export function resizeCanvas() {
  const r = waveCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.max(100, Math.round(r.width * dpr));
  waveCanvas.height = Math.max(60, Math.round(r.height * dpr));
}
export function canvasXY(e: MouseEvent) {
  const r = waveCanvas.getBoundingClientRect();
  // y 映射到 -1..1 全范围(与绘制一致):鼠标贴顶=+1、贴底=-1,曲线才跟手
  return { x: (e.clientX - r.left) / r.width, y: 1 - 2 * (e.clientY - r.top) / r.height };
}
export function hitAnchor(px: number, py: number): { x: number; y: number } | null {
  // 像素级命中判定(与新的 y 全幅映射一致)
  const w = waveCanvas.width, h = waveCanvas.height;
  const th = 14;
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const a of anchors) {
    const ax = a.x * w;
    const ay = h / 2 - a.y * (h / 2);
    const d = Math.hypot(ax - px * w, ay - py * h);
    if (d < th && d < bd) { bd = d; best = a; }
  }
  return best;
}

// 画笔:在 (x,y) 处落一笔——同 x 附近有锚点就吸附改值,否则插入新锚点
export function paintAnchor(x: number, y: number) {
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
export let redrawQueued = false;
export function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    engine.setCustomWave(anchors);
    drawWave();
  });
}

// 渐变模式绘制态:进入后画布显示锚点曲线,可画自定义波形(实时更新"自定义"槽位)
export let wtDrawing = false;
export function setWtDrawing(on: boolean) {
  wtDrawing = on;
  const btn = $id("btn-wt-draw");
  if (btn) btn.textContent = on ? "完成" : "画自定义波形";
  drawWave();
}

// 渐变槽位配色(循环使用;深色 UI 高对比,激活槽位不透明、其余半透明)
const WT_SLOT_COLORS = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#c77dff", "#ff9e5e", "#4dd0e1", "#f48fb1"];

export function drawWave() {
  const w = waveCanvas.width, h = waveCanvas.height;
  ctx2d.clearRect(0, 0, w, h);
  const midY = h / 2;
  // 自定义模式始终显示锚点曲线;渐变模式默认显示形态位置波形,进入绘制态后显示锚点曲线
  const isCustom = engine.waveType === "custom";
  const isWt = engine.waveType === "wt";
  const showAnchors = isCustom || (isWt && wtDrawing);

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

  // 波形曲线:渐变模式 = 每槽位一条彩色线(当前发声槽位高亮);否则锚点/内置单线
  if (isWt && !showAnchors) {
    const n = engine.wtSlots.length;
    const pos = engine.currentWtPos();
    const scaled = Math.min(0.9999, Math.max(0, pos)) * (n - 1);
    const actI = Math.floor(scaled);
    const actJ = Math.min(n - 1, actI + 1);
    for (let s = 0; s < n; s++) {
      const c = WT_SLOT_COLORS[s % WT_SLOT_COLORS.length];
      const active = s === actI || s === actJ;
      ctx2d.strokeStyle = active ? c : c + "55";
      ctx2d.lineWidth = active ? 2.2 : 1.1;
      ctx2d.beginPath();
      for (let px = 0; px <= w; px += 2) {
        const x = px / w;
        const yv = wtSlotValue(engine.wtSlots[s], x);
        const y = midY - yv * (h / 2);
        if (px === 0) ctx2d.moveTo(px, y); else ctx2d.lineTo(px, y);
      }
      ctx2d.stroke();
    }
    // 槽位分界线
    ctx2d.strokeStyle = "rgba(149,213,178,0.15)";
    ctx2d.lineWidth = 1;
    for (let s = 1; s < n - 1; s++) {
      const x = (s / (n - 1)) * w;
      ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
    }
    // 当前形态位置
    ctx2d.strokeStyle = "#7dff9b";
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath(); ctx2d.moveTo(pos * w, 0); ctx2d.lineTo(pos * w, h); ctx2d.stroke();
    // 激活槽位标签(颜色与线一致)
    ctx2d.font = "10px sans-serif";
    ctx2d.fillStyle = WT_SLOT_COLORS[actI % WT_SLOT_COLORS.length];
    ctx2d.fillText(wtSlotLabel(engine.wtSlots[actI]), 4, 12);
    ctx2d.fillStyle = WT_SLOT_COLORS[actJ % WT_SLOT_COLORS.length];
    ctx2d.fillText(wtSlotLabel(engine.wtSlots[actJ]), w - 46, h - 6);
  } else {
    ctx2d.strokeStyle = "#95d5b2";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    for (let i = 0; i <= w; i += 2) {
      const px = i / w;
      const yv = showAnchors ? interpAnchors(anchors, px)
        : builtinWaveAt(engine.waveType, px);
      const y = midY - yv * (h / 2);
      if (i === 0) ctx2d.moveTo(i, y); else ctx2d.lineTo(i, y);
    }
    ctx2d.stroke();
  }

  // 锚点(仅自定义模式显示)
  if (isCustom) {
    for (const a of anchors) {
      const ax = a.x * w;
      const ay = midY - a.y * (h / 2);
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
function wtSlotLabel(slot: string): string {
  if (slot.startsWith("preset:")) return "预设·" + slot.slice(7);
  return WT_SLOT_NAMES[slot] ?? slot;
}
function wtSlotValue(slot: string, p: number): number {
  if (slot === "custom") return interpAnchors(anchors, p);
  if (slot.startsWith("preset:")) {
    // 用户预设槽位:取采样波形(引擎侧解析;失败回退正弦)
    const samples = engine.wtSlotSamples(slot);
    if (samples) return samples[Math.floor(p * WAVE_LEN) % WAVE_LEN];
    return Math.sin(2 * Math.PI * p);
  }
  return wtSlotFnAt(slot, p);
}
export function wtMorphAt(p: number): number {
  const n = engine.wtSlots.length;
  const scaled = Math.min(0.9999, Math.max(0, engine.currentWtPos())) * (n - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const w0 = Math.cos((frac * Math.PI) / 2);
  const w1 = Math.sin((frac * Math.PI) / 2);
  const f0 = wtSlotValue(engine.wtSlots[i], p);
  const f1 = wtSlotValue(engine.wtSlots[Math.min(n - 1, i + 1)], p);
  return w0 * f0 + w1 * f1;
}

export function applyFunctionWave(expr: string) {
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
  setAnchors(pts);
  engine.setWave("custom");
  engine.setCustomWave(anchors);
  presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === "custom"));
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
  if (engine.waveType !== "custom" && !(engine.waveType === "wt" && wtDrawing)) return;
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
  if (engine.waveType !== "custom" && !(engine.waveType === "wt" && wtDrawing)) return;
  const { x, y } = canvasXY(e);
  const hit = hitAnchor(x, y);
  if (hit) {
    // 保留首尾端点
    const isEnd = anchors[0] === hit || anchors[anchors.length - 1] === hit;
    if (!isEnd) {
      setAnchors(anchors.filter((a) => a !== hit));
      engine.setCustomWave(anchors);
      drawWave();
    }
  }
});

$id("btn-smooth").addEventListener("click", () => {
  if (engine.waveType !== "custom") return;
  smoothAnchors();
  engine.setCustomWave(anchors);
  drawWave();
});
export function smoothAnchors() {
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
  setAnchors(builtinAnchors(engine.waveType));
  engine.setCustomWave(anchors);
  drawWave();
});
$id("harmonics").addEventListener("input", (e) => {
  engine.harmonics = Number((e.target as HTMLInputElement).value);
  engine.markWtDirty();
  applyWaveToEngine();
});

// ============ 电脑键盘映射 ============
// 分区式布局:数字行全黑键(按黑键音阶连续),QWERTY + ASDF 两排白键
// 数字行: 1=C#3 2=D#3 3=F#3 4=G#3 5=A#3 6=C#4 7=D#4 8=F#4 9=G#4 0=A#4
// QWERTY: Q-P = C3 D3 E3 F3 G3 A3 B3 C4 D4 E4
