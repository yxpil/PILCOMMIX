// 示波器 + 输出电平表(VU)
import { engine } from "../core/store";
import { $id } from "./dom";
export const scopeCanvas = $id("scope-canvas") as HTMLCanvasElement;
export const scopeCtx = scopeCanvas.getContext("2d")!;
export const scopeBuf = new Uint8Array(2048);
const scopeFreq = new Uint8Array(1024);
let scopeMode: "wave" | "spec" = "wave";
export let scopeRunning = false;
export let scopeRaf = 0;

export function scopeResize() {
  const dpr = window.devicePixelRatio || 1;
  const r = scopeCanvas.getBoundingClientRect();
  scopeCanvas.width = Math.max(1, Math.round(r.width * dpr));
  scopeCanvas.height = Math.max(1, Math.round(r.height * dpr));
  scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function scopeDraw() {
  if (!scopeRunning) return;
  const cw = scopeCanvas.width / (window.devicePixelRatio || 1);
  const ch = scopeCanvas.height / (window.devicePixelRatio || 1);
  scopeCtx.clearRect(0, 0, cw, ch);
  if (scopeMode === "spec") {
    // 频谱视图
    engine.analyser.getByteFrequencyData(scopeFreq);
    const n = 96;   // 显示前 96 个频段
    const bw = cw / n;
    scopeCtx.fillStyle = "#7dff9b";
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, (scopeFreq[i] / 255) * ch);
      scopeCtx.fillRect(i * bw, ch - h, bw - 1, h);
    }
    scopeCtx.fillStyle = "rgba(149,213,178,0.35)";
    scopeCtx.font = "10px sans-serif";
    scopeCtx.fillText("频谱", 6, 12);
    scopeRaf = requestAnimationFrame(scopeDraw);
    return;
  }
  // 中心线
  scopeCtx.strokeStyle = "rgba(149,213,178,0.25)";
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, ch / 2);
  scopeCtx.lineTo(cw, ch / 2);
  scopeCtx.stroke();
  // 实时波形(绿色示波器线)
  engine.analyser.getByteTimeDomainData(scopeBuf);
  scopeCtx.strokeStyle = "#7dff9b";
  scopeCtx.lineWidth = 1.6;
  scopeCtx.shadowColor = "rgba(125,255,155,0.45)";
  scopeCtx.shadowBlur = 6;
  scopeCtx.beginPath();
  const n = scopeBuf.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * cw;
    const y = (scopeBuf[i] / 255) * ch;
    if (i === 0) scopeCtx.moveTo(x, y);
    else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();
  scopeCtx.shadowBlur = 0;
  scopeRaf = requestAnimationFrame(scopeDraw);
}

// 波形/频谱切换
function scopeSetMode(mode: "wave" | "spec") {
  scopeMode = mode;
  $id("btn-scope-wave").classList.toggle("active", mode === "wave");
  $id("btn-scope-spec").classList.toggle("active", mode === "spec");
}
$id("btn-scope-wave").addEventListener("click", () => scopeSetMode("wave"));
$id("btn-scope-spec").addEventListener("click", () => scopeSetMode("spec"));

export function scopeStart() {
  if (scopeRunning) return;
  scopeRunning = true;
  scopeResize();
  scopeDraw();
}
export function scopeStop() {
  scopeRunning = false;
  if (scopeRaf) { cancelAnimationFrame(scopeRaf); scopeRaf = 0; }
}
window.addEventListener("resize", () => { if (scopeRunning) scopeResize(); });

// ============ 输出电平表(VU):常驻显示 master 实际输出电平 ============
export function vuLoop() {
  const buf = new Uint8Array(engine.analyser.fftSize);
  engine.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const d = v - 128; sum += d * d; }
  const rms = Math.sqrt(sum / buf.length) / 128;   // 0-1
  const pct = Math.min(100, Math.round(Math.pow(rms, 0.55) * 100));   // 视觉压缩
  ($id("vu-fill") as HTMLElement).style.width = pct + "%";
  $id("vu-num").textContent = pct + "%";
  requestAnimationFrame(vuLoop);
}
vuLoop();

