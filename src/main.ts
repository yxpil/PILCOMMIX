// COMMIX 入口:装配各 UI 模块并启动(模块化架构)
// 引擎与纯逻辑在 core/,各面板在 ui/,本文件只做组装
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { applyWaveToEngine } from "./core/store";
import { ra } from "./core/rust-audio";
import { $id } from "./ui/dom";
import { resizeCanvas, drawWave } from "./ui/wave-editor";
import { buildKeyboard } from "./ui/keyboard";
import { initMidi } from "./ui/midi";
import { seedBuiltinPresets, syncMainToRust } from "./ui/presets";
// UI 模块(导入即完成事件接线)
import "./ui/wave-editor";
import "./ui/velocity";
import "./ui/keyboard";
import "./ui/midi";
import "./ui/presets";
import "./ui/wt-panel";
import "./ui/panel";
import "./ui/scope";
import "./ui/metro";
import "./ui/transcribe";
import "./ui/record";
import "./ui/dx-panel";
import "./ui/smart";
import "./ui/map-panel";
import "./ui/cc-panel";
import "./ui/midi-test";
import "./ui/arpeggio";
import "./ui/updater";

// ============ 窗口控制 ============
const win = getCurrentWindow();
$id("btn-min").addEventListener("click", () => win.minimize());
$id("btn-max").addEventListener("click", async () => {
  if (await win.isMaximized()) await win.unmaximize();
  else await win.maximize();
});
$id("btn-close").addEventListener("click", () => win.close());

// ============ 启动 ============
$id("keymap-hint").textContent =
  "黑键: 数字行 1 2 3 4 5 6 7 8 9 0 · 白键: Q W E R T Y U I O P + A S D F G H J K L ; · ↑↓ 移八度 · 数字行黑键从 C#3 起连续";

// 内置预设导入(旧版精调音色,全量)
seedBuiltinPresets();

// 固定窗口宽高比:波形画布按比例显示,变形会破坏波形严谨性
// 仅普通窗口生效;最大化/全屏时按屏幕比例,不做修正
const DESIGN_RATIO = 1180 / 780;   // ≈1.513
let ratioFixing = false;
window.addEventListener("resize", async () => {
  if (ratioFixing) return;
  let maximized = false;
  try { maximized = await win.isMaximized(); } catch { maximized = false; }
  if (maximized) return;   // 最大化:跟随屏幕比例
  const w = window.innerWidth, h = window.innerHeight;
  const r = w / h;
  if (Math.abs(r - DESIGN_RATIO) > 0.03) {
    ratioFixing = true;
    // 以当前宽或高为基准,另一维按比例修正(选变化小的)
    const byW = Math.round(w / DESIGN_RATIO);   // 固定宽 → 新高
    const byH = Math.round(h * DESIGN_RATIO);   // 固定高 → 新宽
    const useW = Math.abs(byH - w) <= Math.abs(byW - h);
    win.setSize(new LogicalSize(useW ? byH : w, useW ? h : byW))
      .catch(() => {})
      .finally(() => { ratioFixing = false; });
  }
});

resizeCanvas();
buildKeyboard();
drawWave();
applyWaveToEngine();
syncMainToRust();        // 把当前参数灌入 Rust 引擎(0 通道)
ra.audioStart().catch((e) => console.error("音频启动失败:", e));   // cpal 输出流
initMidi();

// ============ 音频健康巡检(待机/睡眠唤醒自动恢复) ============
// 系统睡眠后 cpal 音频流可能失效(回调停止),采样时钟停滞。
// 每 5s 检查一次:连续 2 次(~10s)时钟未推进 → 重建音频流。
let lastClock = -1;
let stallCount = 0;
setInterval(async () => {
  try {
    const c = await ra.audioHealth();
    if (c === lastClock) {
      stallCount++;
      if (stallCount >= 2) {
        stallCount = 0;
        console.warn("音频时钟停滞,重建音频流(待机唤醒自动恢复)");
        await ra.audioRestart();
      }
    } else {
      stallCount = 0;
    }
    lastClock = c;
  } catch { /* invoke 未就绪时忽略 */ }
}, 5000);
