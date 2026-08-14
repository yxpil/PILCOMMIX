// 力度曲线编辑器
import { velAnchors, velMin, velPower, applyVelocityCurve, setVelMin, setVelPower } from "../core/store";
import { ra } from "../core/rust-audio";
import { $id } from "./dom";
export let velDragging: number | null = null;
export const VEL_CURVES: Record<string, number[]> = {
  linear: [0, 0.25, 0.5, 0.75, 1],
  exp:    [0, 0.5, 0.707, 0.866, 1],      // 轻按易响(y=x^0.5)
  log:    [0, 0.0625, 0.25, 0.5625, 1],   // 重按才响(y=x^2)
  s:      [0, 0.1, 0.5, 0.9, 1],          // 中间平滑过渡
};

export const velCanvas = $id("vel-canvas") as HTMLCanvasElement;
export const velCtx = velCanvas.getContext("2d")!;

export function resizeVelCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = velCanvas.getBoundingClientRect();
  velCanvas.width = Math.max(100, Math.round(r.width * dpr));
  velCanvas.height = Math.max(60, Math.round(r.height * dpr));
  velCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function pushVelCurve() {
  ra.setVelCurve(velAnchors.map((a) => ({ x: a.x, y: a.y })), velMin, velPower);
}
export function drawVelCurve() {
  const cw = velCanvas.width / (window.devicePixelRatio || 1);
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const px = (x: number) => pad + x * (cw - pad * 2);
  const py = (y: number) => ch - pad - y * (ch - pad * 2);
  velCtx.clearRect(0, 0, cw, ch);
  // 参考对角线(线性虚线)
  velCtx.strokeStyle = "rgba(149,213,178,0.25)";
  velCtx.setLineDash([4, 4]);
  velCtx.beginPath();
  velCtx.moveTo(px(0), py(0));
  velCtx.lineTo(px(1), py(1));
  velCtx.stroke();
  velCtx.setLineDash([]);
  // 曲线(实际映射:锚点插值 + 响度/衰减变换后的采样曲线)
  velCtx.strokeStyle = "#7dff9b";
  velCtx.lineWidth = 2;
  velCtx.shadowColor = "rgba(125,255,155,0.4)";
  velCtx.shadowBlur = 5;
  velCtx.beginPath();
  const SAMPLES = 60;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = i / SAMPLES;
    const y = applyVelocityCurve(x);
    const sx = px(x), sy = py(y);
    if (i === 0) velCtx.moveTo(sx, sy);
    else velCtx.lineTo(sx, sy);
  }
  velCtx.stroke();
  velCtx.shadowBlur = 0;
  // 锚点
  for (const a of velAnchors) {
    velCtx.fillStyle = "#95d5b2";
    velCtx.beginPath();
    velCtx.arc(px(a.x), py(a.y), 4, 0, Math.PI * 2);
    velCtx.fill();
    velCtx.strokeStyle = "#06130c";
    velCtx.lineWidth = 1.5;
    velCtx.stroke();
  }
}

// 拖拽锚点(只改 y)
velCanvas.addEventListener("mousedown", (e) => {
  const r = velCanvas.getBoundingClientRect();
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const mx = (e.clientX - r.left - pad) / (r.width - pad * 2);
  const my = 1 - (e.clientY - r.top - pad) / (ch - pad * 2);
  let best = -1, bestD = 0.12;
  for (let i = 0; i < velAnchors.length; i++) {
    const d = Math.hypot(velAnchors[i].x - mx, velAnchors[i].y - my);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) velDragging = best;
});
window.addEventListener("mousemove", (e) => {
  if (velDragging === null) return;
  const r = velCanvas.getBoundingClientRect();
  const ch = velCanvas.height / (window.devicePixelRatio || 1);
  const pad = 10;
  const my = 1 - (e.clientY - r.top - pad) / (ch - pad * 2);
  velAnchors[velDragging].y = Math.min(1, Math.max(0, my));
  // 保持 0 端锚点在 0、1 端锚点在 1(不破坏手感边界)
  if (velDragging === 0) velAnchors[0].y = 0;
  if (velDragging === velAnchors.length - 1) velAnchors[velAnchors.length - 1].y = 1;
  drawVelCurve();
  pushVelCurve();
});
window.addEventListener("mouseup", () => { velDragging = null; });
window.addEventListener("resize", () => { resizeVelCanvas(); drawVelCurve(); });

// 预设曲线按钮(点击后重载引擎,修复切换后音频会话失效静音)
$id("vel-presets").querySelectorAll(".preset-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $id("vel-presets").querySelectorAll(".preset-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const ys = VEL_CURVES[(b as HTMLElement).dataset.curve as string];
    if (ys) {
      for (let i = 0; i < velAnchors.length; i++) velAnchors[i].y = ys[i];
      drawVelCurve();
      pushVelCurve();
    }
  });
});
resizeVelCanvas();
drawVelCurve();
pushVelCurve();

// 响度下限滑块
$id("vel-min").addEventListener("input", () => {
  setVelMin(Number(($id("vel-min") as HTMLInputElement).value) / 100);
  $id("vel-min-val").textContent = Math.round(velMin * 100) + "%";
  drawVelCurve();
  pushVelCurve();
});
// 衰减强度滑块
$id("vel-power").addEventListener("input", () => {
  setVelPower(Number(($id("vel-power") as HTMLInputElement).value) / 100);
  $id("vel-power-val").textContent = velPower.toFixed(1) + "x";
  drawVelCurve();
  pushVelCurve();
});

// ============ 转录(SMF 文件 / 录音流程 → 简谱) ============
// 简谱:1-7 数字 + ' 高八度 + _ 低八度;半音用 # 前缀
