// 琶音器:Rust 采样级调度(音频线程按步进注入音符事件),按住音符实时同步
import { heldNotes } from "../core/store";
import { ra } from "../core/rust-audio";
import { $id, toast } from "./dom";

const arp = {
  running: false,
  bpm: 120,
  direction: "up" as "up" | "down" | "updown" | "random",
  octaves: 1,
};

// 同步按住音符到 Rust(键盘/MIDI 按下时调用)
export function syncArp() {
  ra.arpSet(arp.running, [...heldNotes].sort((a, b) => a - b), arp.bpm, arp.direction, arp.octaves);
}

function arpToggle() {
  arp.running = !arp.running;
  $id("btn-arp").classList.toggle("running", arp.running);
  ($id("btn-arp") as HTMLElement).textContent = arp.running ? "停止" : "启动";
  syncArp();
}
export function arpToggleFromMidi(cc: number) {
  arpToggle();
  toast(`ARP 联动(${arp.running ? "开" : "关"} · CC${cc})`);
}

$id("btn-arp").addEventListener("click", arpToggle);
// 外部设置 BPM(tap tempo 联动)
export function setArpBpm(bpm: number) {
  arp.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  ($id("arp-bpm") as HTMLInputElement).value = String(arp.bpm);
  const v = $id("arp-bpm-val") as HTMLElement | null;
  if (v) v.textContent = String(arp.bpm);
  if (arp.running) syncArp();
}
$id("arp-bpm").addEventListener("input", (e) => {
  arp.bpm = Number((e.target as HTMLInputElement).value);
  $id("arp-bpm-val").textContent = String(arp.bpm);
  if (arp.running) syncArp();
});
$id("arp-dir").addEventListener("change", (e) => {
  arp.direction = (e.target as HTMLSelectElement).value as typeof arp.direction;
  if (arp.running) syncArp();
});
$id("arp-oct").addEventListener("change", (e) => {
  arp.octaves = Number((e.target as HTMLSelectElement).value);
  if (arp.running) syncArp();
});
