// 控制面板:滑块绑定、选项卡、合成器/演奏参数刷新
import { engine } from "../core/store";
import { scopeStart, scopeStop } from "./scope";
import { $id } from "./dom";
export function bindSlider(id: string, apply: (v: number) => void, fmt: (v: number) => string) {
  const el = $id(id) as HTMLInputElement;
  const val = el.nextElementSibling as HTMLElement;
  const update = () => { apply(Number(el.value)); val.textContent = fmt(Number(el.value)); };
  el.addEventListener("input", update);
  update();
}
bindSlider("volume", (v) => { engine.volume = v / 100; engine.updateMaster(); }, (v) => v + "%");
bindSlider("attack", (v) => { engine.attack = v / 1000; }, (v) => v + "ms");
bindSlider("decay", (v) => { engine.decay = v / 1000; }, (v) => v + "ms");
bindSlider("sustain", (v) => { engine.sustain = v / 100; }, (v) => v + "%");
bindSlider("release", (v) => { engine.release = v / 1000; }, (v) => v + "ms");
bindSlider("reverb", (v) => { engine.setReverb(v / 100); }, (v) => v + "%");

// ============ 合成器参数面板 ============
// (面板始终可用,无禁用状态)

export const pianoParamsEl = $id("piano-params");
export const dripParamsEl = $id("drip-params");

// 分类选项卡切换
$id("tab-bar").querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $id("tab-bar").querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".tab-body").forEach((tb) => tb.classList.remove("active"));
    $id("tab-" + (b as HTMLElement).dataset.tab).classList.add("active");
    // 示波器 tab 激活时启动绘制,离开时停止
    if ((b as HTMLElement).dataset.tab === "scope") {
      scopeStart();
    } else {
      scopeStop();
    }
  });
});

// ============ 示波器(实时波形) ============
export function refreshDripUI() {
  dripParamsEl.style.display = engine.waveType === "drip" ? "block" : "none";
  ($id("dp-ratio") as HTMLInputElement).value = String(Math.round(engine.dripRatio * 100));
  $id("dp-ratio-val").textContent = engine.dripRatio.toFixed(1) + "x";
  ($id("dp-time") as HTMLInputElement).value = String(engine.dripTimeMs);
  $id("dp-time-val").textContent = engine.dripTimeMs + "ms";
  ($id("dp-decay") as HTMLInputElement).value = String(engine.dripDecayMs);
  $id("dp-decay-val").textContent = engine.dripDecayMs + "ms";
}
bindSlider("dp-ratio", (v) => { engine.dripRatio = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("dp-time", (v) => { engine.dripTimeMs = v; }, (v) => v + "ms");
bindSlider("dp-decay", (v) => { engine.dripDecayMs = v; }, (v) => v + "ms");
refreshDripUI();

// 钢琴参数控件 ↔ 引擎
export function refreshPianoUI() {
  pianoParamsEl.style.display = engine.waveType === "piano" ? "block" : "none";
  dripParamsEl.style.display = engine.waveType === "drip" ? "block" : "none";
  ($id("pn-decay") as HTMLInputElement).value = String(Math.round(engine.pianoDecayScale * 100));
  $id("pn-decay-val").textContent = engine.pianoDecayScale.toFixed(1) + "x";
  ($id("pn-detune") as HTMLInputElement).value = String(engine.pianoDetuneCents);
  $id("pn-detune-val").textContent = engine.pianoDetuneCents + "c";
  ($id("pn-noise") as HTMLInputElement).value = String(Math.round(engine.pianoNoiseLevel * 100));
  $id("pn-noise-val").textContent = Math.round(engine.pianoNoiseLevel * 100) + "%";
  ($id("pn-bright") as HTMLInputElement).value = String(Math.round(engine.pianoBright * 100));
  $id("pn-bright-val").textContent = engine.pianoBright.toFixed(1) + "x";
}
bindSlider("pn-decay", (v) => { engine.pianoDecayScale = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("pn-detune", (v) => { engine.pianoDetuneCents = v; }, (v) => v + "c");
bindSlider("pn-noise", (v) => { engine.pianoNoiseLevel = v / 100; }, (v) => v + "%");
bindSlider("pn-bright", (v) => { engine.pianoBright = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
refreshPianoUI();

// 渐变(波表形态)控件 ↔ 引擎
export function refreshSynthUI() {
  ($id("sp-osc-wave") as HTMLSelectElement).value = engine.oscWave;
  ($id("sp-osc-count") as HTMLInputElement).value = String(engine.oscCount);
  $id("sp-osc-count-val").textContent = String(engine.oscCount);
  ($id("sp-detune") as HTMLInputElement).value = String(engine.detuneCents);
  $id("sp-detune-val").textContent = engine.detuneCents + "c";
  ($id("sp-filter-type") as HTMLSelectElement).value = engine.filterKind;
  ($id("sp-resonance") as HTMLInputElement).value = String(Math.round(engine.resonanceQ * 100));
  $id("sp-resonance-val").textContent = engine.resonanceQ.toFixed(1);
  ($id("sp-cutoff") as HTMLInputElement).value = String(engine.cutoffHz);
  $id("sp-cutoff-val").textContent = engine.cutoffHz + "Hz";
  ($id("sp-cutoff-env") as HTMLInputElement).value = String(engine.cutoffEnvHz);
  $id("sp-cutoff-env-val").textContent = engine.cutoffEnvHz + "Hz";
  ($id("sp-cutoff-time") as HTMLInputElement).value = String(engine.cutoffEnvMs);
  $id("sp-cutoff-time-val").textContent = engine.cutoffEnvMs + "ms";
}

// 把引擎演奏参数同步到 UI
export function refreshPlayUI() {
  const modeBtns = $id("mode-ctrl").querySelectorAll(".mini-btn");
  modeBtns.forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.mode === (engine.monoMode ? "mono" : "poly")));
  ($id("pan") as HTMLInputElement).value = String(Math.round(engine.pan * 100));
  $id("pan-val").textContent = engine.pan === 0 ? "C" : engine.pan < 0 ? "L" : "R";
  ($id("vib-rate") as HTMLInputElement).value = String(Math.round(engine.vibratoRate * 100));
  $id("vib-rate-val").textContent = engine.vibratoRate.toFixed(1) + "Hz";
  ($id("vib-depth") as HTMLInputElement).value = String(Math.round(engine.vibratoDepth * 100));
  $id("vib-depth-val").textContent = Math.round(engine.vibratoDepth * 100) + "%";
}

($id("sp-osc-wave") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.oscWave = (e.target as HTMLSelectElement).value as OscillatorType;
});
($id("sp-filter-type") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.filterKind = (e.target as HTMLSelectElement).value as BiquadFilterType;
});
bindSlider("sp-osc-count", (v) => { engine.oscCount = v; }, (v) => String(v));
bindSlider("sp-detune", (v) => { engine.detuneCents = v; }, (v) => v + "c");
bindSlider("sp-resonance", (v) => { engine.resonanceQ = v / 100; }, (v) => (v / 100).toFixed(1));
bindSlider("sp-cutoff", (v) => { engine.cutoffHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-env", (v) => { engine.cutoffEnvHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-time", (v) => { engine.cutoffEnvMs = v; }, (v) => v + "ms");

// ============ 演奏参数绑定 ============
$id("mode-ctrl").querySelectorAll(".mini-btn").forEach((b) => {
  b.addEventListener("click", () => {
    engine.monoMode = (b as HTMLElement).dataset.mode === "mono";
    refreshPlayUI();
    if (engine.monoMode) engine.allOff();   // 切单音时清空现有复音
  });
});
bindSlider("pan", (v) => { engine.pan = v / 100; }, (v) => (v === 0 ? "C" : v < 0 ? "L" : "R"));
bindSlider("vib-rate", (v) => { engine.vibratoRate = v / 100; }, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("vib-depth", (v) => { engine.vibratoDepth = v / 100; }, (v) => v + "%");
refreshPlayUI();

// ============ 新功能参数绑定(滑音/滤波包络/键位力度/副振荡器/延迟/失真/调制LFO) ============
bindSlider("porta", (v) => { engine.portamentoMs = v; }, (v) => v + "ms");
bindSlider("fe-amt", (v) => { engine.filterEnvHz = v; }, (v) => v + "Hz");
bindSlider("fe-a", (v) => { engine.filterEnvA = v / 1000; }, (v) => v + "ms");
bindSlider("fe-d", (v) => { engine.filterEnvD = v / 1000; }, (v) => v + "ms");
bindSlider("fe-s", (v) => { engine.filterEnvS = v / 100; }, (v) => v + "%");
bindSlider("fe-r", (v) => { engine.filterEnvR = v / 1000; }, (v) => v + "ms");
bindSlider("kt", (v) => { engine.keyTrack = v / 100; }, (v) => v + "%");
bindSlider("vt", (v) => { engine.velTrack = v / 100; }, (v) => v + "%");
bindSlider("sub-level", (v) => { engine.subLevel = v / 100; }, (v) => v + "%");
($id("sub-wave") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.subWave = (e.target as HTMLSelectElement).value as OscillatorType;
});
bindSlider("dl-time", (v) => { engine.setDelay(v, engine.delayFeedback, engine.delayMix); }, (v) => v + "ms");
bindSlider("dl-fb", (v) => { engine.setDelay(engine.delayTimeMs, v / 100, engine.delayMix); }, (v) => v + "%");
bindSlider("dl-mix", (v) => { engine.setDelay(engine.delayTimeMs, engine.delayFeedback, v / 100); }, (v) => v + "%");
bindSlider("drive", (v) => { engine.setDrive(v / 100); }, (v) => v + "%");
// 调制 LFO
const mlTarget = $id("ml-target") as HTMLSelectElement;
const mlWave = $id("ml-wave") as HTMLSelectElement;
export function refreshFxUI() {
  ($id("porta") as HTMLInputElement).value = String(engine.portamentoMs);
  $id("porta-val").textContent = engine.portamentoMs + "ms";
  ($id("fe-amt") as HTMLInputElement).value = String(engine.filterEnvHz);
  $id("fe-amt-val").textContent = engine.filterEnvHz + "Hz";
  ($id("fe-a") as HTMLInputElement).value = String(Math.round(engine.filterEnvA * 1000));
  $id("fe-a-val").textContent = Math.round(engine.filterEnvA * 1000) + "ms";
  ($id("fe-d") as HTMLInputElement).value = String(Math.round(engine.filterEnvD * 1000));
  $id("fe-d-val").textContent = Math.round(engine.filterEnvD * 1000) + "ms";
  ($id("fe-s") as HTMLInputElement).value = String(Math.round(engine.filterEnvS * 100));
  $id("fe-s-val").textContent = Math.round(engine.filterEnvS * 100) + "%";
  ($id("fe-r") as HTMLInputElement).value = String(Math.round(engine.filterEnvR * 1000));
  $id("fe-r-val").textContent = Math.round(engine.filterEnvR * 1000) + "ms";
  ($id("kt") as HTMLInputElement).value = String(Math.round(engine.keyTrack * 100));
  $id("kt-val").textContent = Math.round(engine.keyTrack * 100) + "%";
  ($id("vt") as HTMLInputElement).value = String(Math.round(engine.velTrack * 100));
  $id("vt-val").textContent = Math.round(engine.velTrack * 100) + "%";
  ($id("sub-wave") as HTMLSelectElement).value = engine.subWave;
  ($id("sub-level") as HTMLInputElement).value = String(Math.round(engine.subLevel * 100));
  $id("sub-level-val").textContent = Math.round(engine.subLevel * 100) + "%";
  ($id("dl-time") as HTMLInputElement).value = String(engine.delayTimeMs);
  $id("dl-time-val").textContent = engine.delayTimeMs + "ms";
  ($id("dl-fb") as HTMLInputElement).value = String(Math.round(engine.delayFeedback * 100));
  $id("dl-fb-val").textContent = Math.round(engine.delayFeedback * 100) + "%";
  ($id("dl-mix") as HTMLInputElement).value = String(Math.round(engine.delayMix * 100));
  $id("dl-mix-val").textContent = Math.round(engine.delayMix * 100) + "%";
  ($id("drive") as HTMLInputElement).value = String(Math.round(engine.drive * 100));
  $id("drive-val").textContent = Math.round(engine.drive * 100) + "%";
  mlTarget.value = engine.modLfoTarget;
  mlWave.value = engine.modLfoWave;
  ($id("ml-rate") as HTMLInputElement).value = String(Math.round(engine.modLfoRate * 100));
  $id("ml-rate-val").textContent = engine.modLfoRate.toFixed(1) + "Hz";
  ($id("ml-depth") as HTMLInputElement).value = String(Math.round(engine.modLfoDepth * 100));
  $id("ml-depth-val").textContent = Math.round(engine.modLfoDepth * 100) + "%";
}
mlTarget.addEventListener("change", () => {
  engine.setModLfoParams(engine.modLfoRate, engine.modLfoDepth, engine.modLfoWave,
    mlTarget.value as "off" | "cutoff" | "volume" | "pan");
});
mlWave.addEventListener("change", () => {
  engine.setModLfoParams(engine.modLfoRate, engine.modLfoDepth,
    mlWave.value as OscillatorType | "s&h", engine.modLfoTarget);
});
bindSlider("ml-rate", (v) => {
  engine.setModLfoParams(v / 100, engine.modLfoDepth, engine.modLfoWave, engine.modLfoTarget);
}, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("ml-depth", (v) => {
  engine.setModLfoParams(engine.modLfoRate, v / 100, engine.modLfoWave, engine.modLfoTarget);
}, (v) => v + "%");
refreshFxUI();

// ============ 预设保存/加载 ============
