// 节拍器:Rust 采样级 click(不进录音),LED 由 Rust 拍点事件驱动
import { listen } from "@tauri-apps/api/event";
import { bindSlider } from "./panel";
import { ra } from "../core/rust-audio";
import { $id } from "./dom";
export const metro = {
  running: false,
  bpm: 120,
  volume: 0.5,
};

// 拍点 LED(重拍绿色高亮,普通拍红色)—— 由 Rust 音频线程发事件
listen<boolean>("metro-beat", (e) => {
  const led = $id("metro-led");
  led.classList.remove("accent");
  led.classList.add("on");
  if (e.payload) led.classList.add("accent");
  window.setTimeout(() => { led.classList.remove("on"); led.classList.remove("accent"); }, 70);
}).catch(() => {});

export function metroStart() {
  if (metro.running) return;
  metro.running = true;
  ra.metroSet(true, metro.bpm, metro.volume);
  $id("btn-metro").classList.add("running");
  ($id("btn-metro") as HTMLElement).textContent = "停止";
}
export function metroStop() {
  metro.running = false;
  ra.metroSet(false, metro.bpm, metro.volume);
  $id("btn-metro").classList.remove("running");
  ($id("btn-metro") as HTMLElement).textContent = "启动";
  $id("metro-led").classList.remove("on");
  $id("metro-led").classList.remove("accent");
}

$id("btn-metro").addEventListener("click", () => {
  if (!metro.running) metroStart();
  else metroStop();
});
bindSlider("metro-bpm", (v) => {
  metro.bpm = v;
  if (metro.running) ra.metroSet(true, v, metro.volume);
}, (v) => String(v));

// 外部设置 BPM(tap tempo 联动)
export function setMetroBpm(bpm: number) {
  metro.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  ($id("metro-bpm") as HTMLInputElement).value = String(metro.bpm);
  const v = $id("metro-bpm-val") as HTMLElement | null;
  if (v) v.textContent = String(metro.bpm);
  if (metro.running) ra.metroSet(true, metro.bpm, metro.volume);
}
bindSlider("metro-vol", (v) => {
  metro.volume = v / 100;
  if (metro.running) ra.metroSet(true, metro.bpm, metro.volume);
}, (v) => v + "%");
