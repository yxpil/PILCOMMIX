// 波形编辑器:画布绘制/锚点/画笔/函数波形/波表形态预览
import { engine, anchors, presetButtons, applyWaveToEngine, setAnchors } from "../core/store";
import { ra } from "../core/rust-audio";
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

// ============ 粒子画笔(无锚点:直接写 2048 采样点,纯自由绘制) ============
export const GRAIN_WAVE_LEN = 2048;
export let grainWave: number[] = new Array(GRAIN_WAVE_LEN).fill(0);
let grainLastX = -1;
let grainLastY = 0;
function grainPaint(x: number, y: number) {
  y = Math.min(1, Math.max(-1, y));   // 鼠标移出画布时钳制,避免波形跳变断线
  const ix = Math.min(GRAIN_WAVE_LEN - 1, Math.max(0, Math.round(x * (GRAIN_WAVE_LEN - 1))));
  if (grainLastX >= 0 && Math.abs(ix - grainLastX) > 1) {
    // 快速拖拽时线性补中间点(笔迹连续,无折线)
    // 注意:用距离绝对值归一化——从右往左画时 (ix - grainLastX) 为负,
    // 若直接用做分母会得到 ±百万级系数,补点爆炸成锯齿(左→右正常、右→左坏的根因)
    const step = Math.sign(ix - grainLastX);
    const dist = Math.abs(ix - grainLastX);
    for (let i = grainLastX + step; i !== ix; i += step) {
      const t = Math.abs(i - grainLastX) / dist;   // 0..1,方向:起点→终点
      grainWave[i] = grainLastY + (y - grainLastY) * t;
    }
  }
  grainWave[ix] = y;
  grainLastX = ix;
  grainLastY = y;
}
function grainWaveToAnchors(): { x: number; y: number }[] {
  // 不做首尾连续化:粒子源有 Hann 窗(片段跳变被窗函数平滑),
  // 自定义音色历来无连续化;强制渐变反而会覆盖右端笔迹(从右往左画线被"吃掉")
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < GRAIN_WAVE_LEN; i++) pts.push({ x: i / (GRAIN_WAVE_LEN - 1), y: grainWave[i] });
  return pts;
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

// 平滑插值(粒子模式画波形:消除锚点折线感,曲线圆滑)
// 基于 Catmull-Rom 风格:每个锚点处切线由相邻点决定,过点平滑
export function smoothInterp(pts: { x: number; y: number }[], px: number): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (px <= pts[0].x) return pts[0].y;
  if (px >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  while (i < pts.length - 2 && px > pts[i + 1].x) i++;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
  const t = (px - p1.x) / Math.max(1e-6, p2.x - p1.x);
  // Catmull-Rom 基函数
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const m1 = (p2.y - p0.y) / 2, m2 = (p3.y - p1.y) / 2;
  return h00 * p1.y + h10 * m1 + h01 * p2.y + h11 * m2;
}

// rAF + 时间节流:画笔/拖拽期间画布每帧刷新,但推 Rust 最多 20 次/秒
// (引擎表重建有成本;50ms 节流保证拖拽流畅不卡,声音仍实时跟上)
export let redrawQueued = false;
let lastRustPush = 0;
export function scheduleRedraw() {
  const now = performance.now();
  if (!redrawQueued) {
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      drawWave();                     // 画布显示保持流畅
      if (now - lastRustPush > 50) {  // 引擎更新降频
        lastRustPush = now;
        // 画笔采样整条直推(自定义/粒子统一;2048 密集锚点,线性插值精确还原)
        const pts = grainWaveToAnchors();
        engine.setCustomWave(pts);
        ra.setCustomAnchors(0, pts);
      }
    });
  }
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

// 自定义音色初始化:从锚点(旧数据/预设)填充画笔采样缓冲,保持兼容
export function syncGrainWaveFromAnchors() {
  for (let i = 0; i < GRAIN_WAVE_LEN; i++) {
    grainWave[i] = interpAnchors(anchors, i / (GRAIN_WAVE_LEN - 1));
  }
}
export function drawWave() {
  const w = waveCanvas.width, h = waveCanvas.height;
  ctx2d.clearRect(0, 0, w, h);
  const midY = h / 2;
  // 自定义/粒子模式始终显示锚点曲线(粒子可画波形当粒子源);渐变模式默认显示形态位置波形,进入绘制态后显示锚点曲线
  const isCustom = engine.waveType === "custom";
  const isWt = engine.waveType === "wt";
  const showAnchors = isCustom || engine.waveType === "grain" || (isWt && wtDrawing);

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
      // 粒子模式:平滑曲线(不要锚点折线感);自定义模式保持线性锚点
      const yv = (showAnchors)
        ? grainWave[Math.round(px * (GRAIN_WAVE_LEN - 1))]   // 画笔曲线(自定义/粒子)
        : builtinWaveAt(engine.waveType, px);
      const y = midY - yv * (h / 2);
      if (i === 0) ctx2d.moveTo(i, y); else ctx2d.lineTo(i, y);
    }
    ctx2d.stroke();
  }

  // 锚点圆点已移除(画布只显示波形曲线,干净不刺眼;自定义模式仍可拖拽锚点编辑)
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
  if (engine.waveType !== "grain") {
    engine.setWave("custom");
    presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === "custom"));
  }
  syncGrainWaveFromAnchors();          // 函数波形 → 画笔采样缓冲
  const wpts = grainWaveToAnchors();
  engine.setCustomWave(wpts);
  ra.setCustomAnchors(0, wpts);
  $id("sp-note").textContent = engine.waveType === "grain" ? "已应用到粒子源波形" : "";
  drawWave();
  toast(engine.waveType === "grain" ? "粒子源波形已更新" : "已应用函数波形");
}

$id("btn-apply-fn").addEventListener("click", () => {
  const v = ($id("fn-input") as HTMLInputElement).value.trim();
  if (v) applyFunctionWave(v);
});

// ============ 数值坐标定义波形 ============
// 输入如 "0,1,0.5,0.6,0.6"(或带括号/空格分隔):N 个数值按波表均分,
// 第 i 个值落在 x = i/(N-1),相邻值线性过渡 —— 用坐标精确定义波形。
// 兼容:自定义音色(切到自定义并应用)/粒子音色(作为粒子源)
export function applyCoordWave(raw: string): boolean {
  const cleaned = raw.replace(/[()\[\]{}]/g, "").trim();
  if (!cleaned.includes(",")) {
    toast("请用英文逗号分隔数值,如 0,1,0.5,0.6,0.6");
    return false;
  }
  const parts = cleaned.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const vals: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n)) vals.push(Math.min(1, Math.max(-1, n)));
  }
  if (vals.length < 2) {
    toast("至少输入 2 个数值(值范围 -1 ~ 1),如 0,1,0.5");
    return false;
  }
  // 均匀 x 锚点 → 画笔采样缓冲 → 推 Rust(与画笔同路径)
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < vals.length; i++) {
    pts.push({ x: vals.length === 1 ? 0 : i / (vals.length - 1), y: vals[i] });
  }
  setAnchors(pts);
  if (engine.waveType !== "grain") {
    // 非粒子音色:自动切到自定义音色(与函数波形行为一致)
    engine.setWave("custom");
    presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === "custom"));
  }
  syncGrainWaveFromAnchors();
  const wpts = grainWaveToAnchors();
  engine.setCustomWave(wpts);
  ra.setCustomAnchors(0, wpts);
  drawWave();
  toast("已应用数值波形:" + vals.join(","));
  return true;
}
$id("btn-apply-coord").addEventListener("click", () => {
  const v = ($id("coord-input") as HTMLInputElement).value.trim();
  if (v) applyCoordWave(v);
});
$id("coord-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = ($id("coord-input") as HTMLInputElement).value.trim();
    if (v) applyCoordWave(v);
  }
});

$id("fn-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = ($id("fn-input") as HTMLInputElement).value.trim();
    if (v) applyFunctionWave(v);
  }
});

const canEditWave = () => engine.waveType === "custom" || engine.waveType === "grain" || (engine.waveType === "wt" && wtDrawing);
waveCanvas.addEventListener("mousedown", (e) => {
  if (!canEditWave()) return;
  if (e.button === 2) return; // 右键单独处理
  const { x, y } = canvasXY(e);
  // 统一画笔直绘(自定义/粒子均无锚点交互,画布干净)
  // 注意:不重置 grainLastX——新笔迹从上次末端线性连线,断触/抬笔重画也无跳变锯齿
  grainPaint(x, y);
  painting = true;
  scheduleRedraw();
});
window.addEventListener("mousemove", (e) => {
  const { x, y } = canvasXY(e);
  if (draggingAnchor) {
    draggingAnchor.x = Math.min(1, Math.max(0, x));
    draggingAnchor.y = Math.min(1, Math.max(-1, y));
    anchors.sort((a, b) => a.x - b.x);
    scheduleRedraw();
  } else if (painting) {
    grainPaint(x, y);
    scheduleRedraw();
  }
});
window.addEventListener("mouseup", () => {
  draggingAnchor = null;
  painting = false;
  // 不重置 grainLastX:下一次落笔自动连线,断触不产生锯齿
});
// 双击画布 = 断开笔迹(另起新形状时用;默认连笔防断触锯齿)
waveCanvas.addEventListener("dblclick", () => {
  grainLastX = -1;
  toast("笔迹已断开,可另起新形状");
});
waveCanvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!canEditWave()) return;
  // 画笔模式:右键清除该位置波形值(归零),不涉及锚点
  const { x } = canvasXY(e);
  const ix = Math.min(GRAIN_WAVE_LEN - 1, Math.max(0, Math.round(x * (GRAIN_WAVE_LEN - 1))));
  grainWave[ix] = 0;
  scheduleRedraw();
});

$id("btn-smooth").addEventListener("click", () => {
  if (!canEditWave()) return;
  // 画笔采样 5 点移动平均平滑
  const out = new Array(GRAIN_WAVE_LEN).fill(0);
  for (let i = 0; i < GRAIN_WAVE_LEN; i++) {
    let sum = 0, cnt = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < GRAIN_WAVE_LEN) { sum += grainWave[j]; cnt++; }
    }
    out[i] = sum / cnt;
  }
  grainWave = out;
  const wpts = grainWaveToAnchors();
  engine.setCustomWave(wpts);
  ra.setCustomAnchors(0, wpts);
  drawWave();
  toast("波形已平滑");
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
  ra.setCustomAnchors(0, anchors);
  drawWave();
});
$id("harmonics").addEventListener("input", (e) => {
  engine.harmonics = Number((e.target as HTMLInputElement).value);
  ra.setParam(0, "harmonics", engine.harmonics);   // 推 Rust(重建波表,实时生效)
  engine.markWtDirty();
  applyWaveToEngine();
});

// ============ 电脑键盘映射 ============
// 分区式布局:数字行全黑键(按黑键音阶连续),QWERTY + ASDF 两排白键
// 数字行: 1=C#3 2=D#3 3=F#3 4=G#3 5=A#3 6=C#4 7=D#4 8=F#4 9=G#4 0=A#4
// QWERTY: Q-P = C3 D3 E3 F3 G3 A3 B3 C4 D4 E4

// 启动时用初始锚点填充画笔采样缓冲
syncGrainWaveFromAnchors();
