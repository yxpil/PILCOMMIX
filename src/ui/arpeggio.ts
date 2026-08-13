// 琶音器:内置 BPM 步进,方向/跨八度,基于真实按住的音符(heldNotes)
import { engine, heldNotes } from "../core/store";
import { $id } from "./dom";

const arp = {
  running: false,
  bpm: 120,
  direction: "up" as "up" | "down" | "updown" | "random",
  octaves: 1,
  timer: 0,
  step: 0,
};

function arpStep() {
  if (!arp.running) return;
  const notes = [...heldNotes].sort((a, b) => a - b);
  if (notes.length === 0) {
    arp.timer = window.setTimeout(arpStep, 60);
    return;
  }
  const n = notes.length;
  let idx: number;
  if (arp.direction === "random") {
    idx = Math.floor(Math.random() * n);
  } else if (arp.direction === "down") {
    idx = n - 1 - (arp.step % n);
  } else if (arp.direction === "updown") {
    const cycle = arp.step % (2 * n - 2 || 1);
    idx = cycle < n ? cycle : 2 * n - 2 - cycle;
  } else {
    idx = arp.step % n;
  }
  const oct = Math.floor(arp.step / n) % arp.octaves;
  const midi = notes[idx] + oct * 12;
  const stepSec = 60 / arp.bpm / 2;   // 八分音符
  const t = engine.ctx.currentTime;
  engine.noteOn(midi, 0.8, t);
  engine.noteOff(midi, true, t + stepSec * 0.6);   // 短门
  arp.step++;
  arp.timer = window.setTimeout(arpStep, stepSec * 1000);
}

function arpStart() {
  arp.running = true;
  arp.step = 0;
  $id("btn-arp").classList.add("running");
  ($id("btn-arp") as HTMLElement).textContent = "停止";
  arpStep();
}
function arpStop() {
  arp.running = false;
  if (arp.timer) { window.clearTimeout(arp.timer); arp.timer = 0; }
  $id("btn-arp").classList.remove("running");
  ($id("btn-arp") as HTMLElement).textContent = "启动";
}

$id("btn-arp").addEventListener("click", () => {
  if (!arp.running) arpStart();
  else arpStop();
});
$id("arp-bpm").addEventListener("input", (e) => {
  arp.bpm = Number((e.target as HTMLInputElement).value);
  $id("arp-bpm-val").textContent = String(arp.bpm);
});
$id("arp-dir").addEventListener("change", (e) => {
  arp.direction = (e.target as HTMLSelectElement).value as typeof arp.direction;
});
$id("arp-oct").addEventListener("change", (e) => {
  arp.octaves = Number((e.target as HTMLSelectElement).value);
});
