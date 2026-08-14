// 录制:音频走 Rust 引擎(record_start/stop 直接产出 WAV),MIDI 事件仍在前端记录
import { invoke } from "@tauri-apps/api/core";
import { midiRec, recStart, setRecStart } from "../core/store";
import { ra } from "../core/rust-audio";
import { $id, toast } from "./dom";
import { getLatestScope } from "./scope";
export let recTimer: number | null = null;
export let audioRecording = false;

// 录音轨道:录音时在底部画实时波形(Rust scope 事件数据)
export const trackWrap = $id("track-wrap");
export const trackCanvas = $id("track-canvas") as HTMLCanvasElement;
export let trackRaf = 0;

export function resizeTrackCanvas() {
  const r = trackCanvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const dpr = window.devicePixelRatio || 1;
  trackCanvas.width = Math.max(100, Math.round(r.width * dpr));
  trackCanvas.height = Math.max(40, Math.round(r.height * dpr));
}

export function drawTrackLoop() {
  const w = trackCanvas.width, h = trackCanvas.height;
  if (w === 0 || h === 0) { trackRaf = requestAnimationFrame(drawTrackLoop); return; }
  const ctx = trackCanvas.getContext("2d")!;
  const data = getLatestScope();
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#95d5b2";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const mid = h / 2;
  const n = Math.min(data.length, 512);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const y = mid + data[i] * (h / 2 - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  trackRaf = requestAnimationFrame(drawTrackLoop);
}

$id("btn-record").addEventListener("click", async () => {
  if (!audioRecording) {
    await ra.audioStart().catch(() => {});
    midiRec.start();
    setRecStart(performance.now());
    ra.recordStart();
    audioRecording = true;
    $id("btn-record").classList.add("recording");
    ($id("btn-record").querySelector("span") as HTMLElement).textContent = "停止";
    // 显示录音轨道,隐藏映射提示
    trackWrap.style.display = "block";
    trackWrap.classList.add("recording");
    $id("keymap-hint").style.display = "none";
    resizeTrackCanvas();
    drawTrackLoop();
    recTimer = window.setInterval(() => {
      const s = Math.floor((performance.now() - recStart) / 1000);
      const t = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      $id("rec-time").textContent = t;
      const tt = $id("track-time");
      if (tt) tt.textContent = t;
    }, 200);
  } else {
    await stopRecording();
  }
});

export async function stopRecording() {
  if (!audioRecording) return;
  audioRecording = false;
  midiRec.stop();
  $id("btn-record").classList.remove("recording");
  ($id("btn-record").querySelector("span") as HTMLElement).textContent = "录音";
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $id("rec-time").textContent = "--:--";
  cancelAnimationFrame(trackRaf);
  trackWrap.classList.remove("recording");
  $id("keymap-hint").style.display = "";

  try {
    const bytes = await ra.recordStop();   // Rust 直接产出 WAV 字节
    if (bytes.length === 0) { toast("录音为空"); return; }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const path = await invoke<string>("save_recording", {
      bytes: Array.from(bytes),
      suggestedName: `COMMIX-录音-${stamp}.wav`,
    });
    toast("录音已保存: " + path.split(/[\\/]/).pop());
  } catch (err) {
    console.error(err);
    toast("录音保存失败: " + String(err).slice(0, 60));
  }
}
