// 节拍器
import { engine } from "../core/store";
import { bindSlider } from "./panel";
import { $id } from "./dom";
export const metro = {
  running: false,
  bpm: 120,
  volume: 0.5,
  beat: 0,          // 当前拍序号(从 0 起,0 为重拍)
  nextTime: 0,      // 下一拍时间(AudioContext 时钟)
  timer: null as number | null,
};

export function metroClick(accent: boolean) {
  const ctx = engine.ctx;
  const t = ctx.currentTime;
  // 短促正弦"哒":重拍 1760Hz(高),普通拍 1175Hz
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = accent ? 1760 : 1175;
  const g = ctx.createGain();
  g.gain.setValueAtTime(metro.volume * 0.8, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g);
  g.connect(ctx.destination);   // 仅扬声器,不进录音
  osc.start(t);
  osc.stop(t + 0.06);

  // 指示灯:重拍绿色高亮,普通拍红色
  const led = $id("metro-led");
  led.classList.remove("accent");
  led.classList.add("on");
  if (accent) led.classList.add("accent");
  window.setTimeout(() => { led.classList.remove("on"); led.classList.remove("accent"); }, 70);
}

export function metroSchedule() {
  if (!metro.running) return;
  const interval = 60 / metro.bpm;
  // 提前 0.12s 把到期的拍全部调度
  while (metro.nextTime < engine.ctx.currentTime + 0.12) {
    metroClick(metro.beat % 4 === 0);   // 每 4 拍一个重拍
    metro.beat++;
    metro.nextTime += interval;
  }
  metro.timer = window.setTimeout(metroSchedule, 30);
}

export function metroStart() {
  if (metro.running) return;
  metro.running = true;
  metro.beat = 0;
  metro.nextTime = engine.ctx.currentTime + 0.08;
  $id("btn-metro").classList.add("running");
  ($id("btn-metro") as HTMLElement).textContent = "停止";
  metroSchedule();
}

export function metroStop() {
  metro.running = false;
  if (metro.timer) { window.clearTimeout(metro.timer); metro.timer = null; }
  $id("btn-metro").classList.remove("running");
  ($id("btn-metro") as HTMLElement).textContent = "启动";
  $id("metro-led").classList.remove("on");
  $id("metro-led").classList.remove("accent");
}

$id("btn-metro").addEventListener("click", async () => {
  if (!metro.running) {
    await engine.resume();
    metroStart();
  } else {
    metroStop();
  }
});
bindSlider("metro-bpm", (v) => { metro.bpm = v; }, (v) => String(v));
bindSlider("metro-vol", (v) => { metro.volume = v / 100; }, (v) => v + "%");

// ============ 录制 ============
// 音频:MediaRecorder → webm → decode → WAV 16bit PCM
