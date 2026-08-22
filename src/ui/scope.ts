// 示波器 + 输出电平表(VU):数据来自 Rust 音频线程("scope" 事件,post-drive 时域样本)
import { listen } from "@tauri-apps/api/event";
import { $id } from "./dom";
import { traceColor, lineColor } from "./theme";
export const scopeCanvas = $id("scope-canvas") as HTMLCanvasElement;
export const scopeCtx = scopeCanvas.getContext("2d")!;
let scopeMode: "wave" | "spec" = "wave";
export let scopeRunning = false;
export let scopeRaf = 0;
// 示波器控制按钮高亮辅助(锁定/AUTO 的激活态)
const scopeZoomBtn = (id: string, on: boolean) => {
  const b = $id(id) as HTMLElement;
  b.classList.toggle("active", on);
};

let latest: Float32Array = new Float32Array(1024);
let latestSpec: Float32Array = new Float32Array(128);
export function getLatestScope(): Float32Array { return latest; }

// Rust 音频回调每 ~23ms 发一批:[1024 时域 + 128 频谱幅度]
listen<number[]>("scope", (e) => {
  const d = e.payload;
  if (!d || d.length < 1024) return;
  latest = Float32Array.from(d.slice(0, 1024));
  latestSpec = Float32Array.from(d.slice(1024, 1152));
}).catch(() => {});

// 锁定按钮:冻结画面,再点恢复实时
$id("btn-scope-lock").addEventListener("click", () => {
  scopeLocked = !scopeLocked;
  scopeZoomBtn("btn-scope-lock", scopeLocked);
  if (!scopeLocked && scopeRunning && scopeRaf === 0) {
    scopeDraw();   // 解锁:重启绘制循环
  }
});
// AUTO 按钮:波形峰值自动适配画布高度(默认开)
$id("btn-scope-auto").addEventListener("click", () => {
  scopeAuto = !scopeAuto;
  scopeZoomBtn("btn-scope-auto", scopeAuto);
});
// 放大 / 缩小(0.25x - 4x,步进 ×1.5)
const clampZoom = () => { scopeZoom = Math.min(4, Math.max(0.25, scopeZoom)); };
$id("btn-scope-zoomin").addEventListener("click", () => {
  scopeZoom *= 1.5;
  clampZoom();
});
$id("btn-scope-zoomout").addEventListener("click", () => {
  scopeZoom /= 1.5;
  clampZoom();
});
// 抓波形:自动检测重复周期并稳定显示
$id("btn-scope-grab").addEventListener("click", () => {
  scopeGrab = !scopeGrab;
  scopeZoomBtn("btn-scope-grab", scopeGrab);
});
// 初始状态
scopeZoomBtn("btn-scope-lock", false);
scopeZoomBtn("btn-scope-auto", true);
scopeZoomBtn("btn-scope-grab", false);

export function scopeResize() {
  const dpr = window.devicePixelRatio || 1;
  const r = scopeCanvas.getBoundingClientRect();
  scopeCanvas.width = Math.max(1, Math.round(r.width * dpr));
  scopeCanvas.height = Math.max(1, Math.round(r.height * dpr));
  scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}


// ============ 示波器控制:锁定 / AUTO 自动缩放 / 手动缩放 ============
export let scopeLocked = false;
export let scopeAuto = true;    // AUTO:波形峰值自动适配画布高度
export let scopeZoom = 1.0;     // 手动缩放系数 0.25-4x(在 AUTO 基础上再乘)
export let scopeGrab = false;   // 抓波形:自动检测周期,稳定显示不闪
// 抓取缓存:只在波形/音高/幅度有实质变化时才替换画面,否则保持(消除闪烁)
let grabCache: { period: number; data: Float32Array; peak: number } | null = null;

// 周期检测:过零法(找上升过零点间距的中位数 ×2 = 一个周期采样数)
// 对周期性信号(持续音)稳定;噪声/打击乐无周期 → 返回 0(回退实时显示)
function detectPeriod(data: Float32Array): number {
  const zc: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] < 0 && data[i] >= 0) zc.push(i);
  }
  if (zc.length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < zc.length; i++) gaps.push(zc[i] - zc[i - 1]);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med < 4 || med > data.length / 2) return 0;   // 周期过小(高频噪声)/过大(无周期)
  return med * 2;
}
export function scopeDraw() {
  if (!scopeRunning) return;
  if (scopeLocked) {
    // 锁定:保留画布最后画面,暂停绘制循环
    scopeRaf = 0;
    return;
  }
  const cw = scopeCanvas.width / (window.devicePixelRatio || 1);
  const ch = scopeCanvas.height / (window.devicePixelRatio || 1);
  scopeCtx.clearRect(0, 0, cw, ch);
  const data = latest;
  if (scopeMode === "spec") {
    const bins = 96;
    const bw = cw / bins;
    scopeCtx.fillStyle = traceColor();
    for (let i = 0; i < bins; i++) {
      const v = Math.log10(1 + latestSpec[i] * 60) / 1.3;   // 对数压缩(Rust FFT 数据)
      const h = Math.max(1, Math.min(ch, v * ch));
      scopeCtx.fillRect(i * bw, ch - h, bw - 1, h);
    }
    scopeCtx.fillStyle = lineColor(0.35);
    scopeCtx.font = "10px sans-serif";
    scopeCtx.fillText("频谱", 6, 12);
    scopeRaf = requestAnimationFrame(scopeDraw);
    return;
  }
  // 中心线
  scopeCtx.strokeStyle = lineColor(0.25);
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, ch / 2);
  scopeCtx.lineTo(cw, ch / 2);
  scopeCtx.stroke();
  // 静音检测:无信号时不画直线,只显示提示(抓取模式尤其需要)
  let peak = 0.0;
  for (const v of data) { const a = Math.abs(v); if (a > peak) peak = a; }
  if (peak < 1e-4) {
    scopeCtx.fillStyle = lineColor(0.35);
    scopeCtx.font = "10px sans-serif";
    scopeCtx.fillText(scopeGrab ? "静音(等待信号…)" : "静音", 6, 12);
    scopeRaf = requestAnimationFrame(scopeDraw);
    return;
  }
  // 抓波形:自动检测周期;只在波形/音高/幅度有实质变化时才替换缓存画面,
  // 稳定时保持上次画面(消除"一闪一闪"——周期起点相位抖动不再触发重画)
  let grabbed = false;
  if (scopeGrab) {
    const period = detectPeriod(data);
    if (period > 0) {
      // 取数据末尾一个完整周期(起点对齐到最近的上升过零)
      let end = data.length - 1;
      for (let i = data.length - 1; i > 1; i--) {
        if (data[i - 1] < 0 && data[i] >= 0) { end = i; break; }
      }
      const start = Math.max(0, end - period);
      if (end - start >= period * 0.9) {
        // 与缓存比对:周期(音高)变化 >8%、峰值变化 >25%、或形状差异显著 → 替换
        let changed = false;
        if (!grabCache) {
          changed = true;
        } else if (Math.abs(period - grabCache.period) > period * 0.08
          || Math.abs(peak - grabCache.peak) > Math.max(1e-3, grabCache.peak * 0.25)) {
          changed = true;
        } else {
          // 形状比对:同周期长度下逐点差均方根超过峰值 6% 视为变化
          const n = Math.min(period, grabCache.data.length);
          let diff = 0.0;
          for (let i = 0; i < n; i += 4) {   // 隔 4 点采样比对,开销小
            const d = data[start + i] - grabCache.data[i];
            diff += d * d;
          }
          if (Math.sqrt(diff / Math.max(1, n / 4)) > grabCache.peak * 0.06 + 1e-4) changed = true;
        }
        if (changed) {
          grabCache = { period, data: Float32Array.from(data.slice(start, end)), peak };
        }
        grabbed = true;
        const cache = grabCache!;
        const freq = 44100 / period;
        scopeCtx.strokeStyle = traceColor();
        scopeCtx.lineWidth = 2.2;
        scopeCtx.shadowColor = traceColor(0.45);
        scopeCtx.shadowBlur = 6;
        scopeCtx.beginPath();
        // 画 2 个周期(水平铺满画布),数据来自缓存(稳定画面)
        const seg = cache.data;
        const segLen = seg.length;
        const amp2 = (ch / 2 - 4) * scopeZoom;
        for (let rep = 0; rep < 2; rep++) {
          for (let i = 0; i < segLen; i++) {
            const x = ((rep * segLen + i) / (2 * segLen)) * cw;
            const y = ch / 2 + seg[i] * amp2;
            if (i === 0 && rep === 0) scopeCtx.moveTo(x, y);
            else scopeCtx.lineTo(x, y);
          }
        }
        scopeCtx.stroke();
        scopeCtx.shadowBlur = 0;
        scopeCtx.fillStyle = traceColor(0.6);
        scopeCtx.font = "10px sans-serif";
        scopeCtx.fillText("抓取:周期 " + period + " 采样 ≈ " + freq.toFixed(1) + "Hz", 6, 12);
      }
    } else {
      grabCache = null;
      scopeCtx.fillStyle = "rgba(255,170,120,0.8)";
      scopeCtx.font = "10px sans-serif";
      scopeCtx.fillText("抓取:未检测到稳定周期(持续音/和弦可抓)", 6, 12);
    }
  }
  // 实时波形(缩放:AUTO 自动峰值适配 × 手动缩放系数)
  if (!grabbed) {
    let scale = scopeZoom;
    if (scopeAuto) {
      let peak = 0.0;
      for (const v of data) { const a = Math.abs(v); if (a > peak) peak = a; }
      if (peak > 1e-4) scale *= 0.9 / peak;   // 峰值拉到画布 90% 高度
    }
    scopeCtx.strokeStyle = traceColor();
    scopeCtx.lineWidth = 1.6;
    scopeCtx.shadowColor = traceColor(0.45);
    scopeCtx.shadowBlur = 6;
    scopeCtx.beginPath();
    const n = data.length;
    const amp = (ch / 2 - 4) * scale;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * cw;
      const y = ch / 2 + data[i] * amp;
      if (i === 0) scopeCtx.moveTo(x, y);
      else scopeCtx.lineTo(x, y);
    }
    scopeCtx.stroke();
    scopeCtx.shadowBlur = 0;
  }
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
  let sum = 0;
  for (const v of latest) sum += v * v;
  const rms = Math.sqrt(sum / latest.length);
  const pct = Math.min(100, Math.round(Math.pow(rms, 0.55) * 100));   // 视觉压缩
  ($id("vu-fill") as HTMLElement).style.width = pct + "%";
  $id("vu-num").textContent = pct + "%";
  requestAnimationFrame(vuLoop);
}
vuLoop();
