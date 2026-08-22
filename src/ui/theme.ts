// 主题切换:墨绿(默认)/ 黑白 / 粉色 / 蓝色
// 机制:html[data-theme] 覆盖 CSS 变量组(style.css :root 定义);选择持久化到 localStorage
const THEMES = ["default", "black", "pink", "blue"];
const THEME_KEY = "commix-theme";

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 主题反色描边色(--trace):波形/示波器/力度曲线等 canvas 线条用,alpha 可选转 rgba */
export function traceColor(alpha?: number): string {
  const t = cssVar("--trace") || "#7dff9b";
  if (alpha === undefined) return t;
  const r = parseInt(t.slice(1, 3), 16), g = parseInt(t.slice(3, 5), 16), b = parseInt(t.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
/** 主题边框线色(--rgb-line 三元组 → rgba):网格/虚线/辅助文字 */
export function lineColor(alpha: number): string {
  return `rgba(${cssVar("--rgb-line") || "149,213,178"},${alpha})`;
}
/** 主题深底(--rgb-bgdeep 三元组 → rgba):锚点描边等需要深色的地方 */
export function bgColor(alpha: number): string {
  return `rgba(${cssVar("--rgb-bgdeep") || "16,41,30"},${alpha})`;
}

export function applyTheme(t: string) {
  const theme = THEMES.includes(t) ? t : "default";
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 忽略 */ }
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.theme === theme);
  });
  // 通知静态 canvas(波形/力度曲线)重绘换色;实时循环(示波器/录音)自动取新色
  window.dispatchEvent(new CustomEvent("theme-changed"));
}

// 初始化(优先本地保存,否则默认墨绿)
let saved = "default";
try { saved = localStorage.getItem(THEME_KEY) || "default"; } catch { /* 忽略 */ }
applyTheme(saved);

// 按钮绑定
document.querySelectorAll(".theme-btn").forEach((b) => {
  b.addEventListener("click", () => applyTheme((b as HTMLElement).dataset.theme || "default"));
});
