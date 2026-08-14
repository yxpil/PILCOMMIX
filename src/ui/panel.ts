// 控制面板:滑块绑定、选项卡、合成器/演奏参数刷新
import { engine, dbToLin, linToDb, fmtDb, setGrainCtrlState, presetButtons, resetAllToDefault, setPmExtFromWave } from "../core/store";
import { ra } from "../core/rust-audio";
import { syncMainToRust } from "./presets";
import { scopeStart, scopeStop } from "./scope";
import { refreshWtUI, refreshWtBankUI } from "./wt-panel";
import { $id, toast } from "./dom";
export function bindSlider(id: string, apply: (v: number) => void, fmt: (v: number) => string) {
  const el = $id(id) as HTMLInputElement;
  const val = el.nextElementSibling as HTMLElement;
  const update = () => { apply(Number(el.value)); val.textContent = fmt(Number(el.value)); };
  el.addEventListener("input", update);
  update();
}
bindSlider("volume", (v) => {
  const lin = dbToLin(v);
  ra.setMaster("volume", lin); engine.volume = lin; engine.updateMaster(); }, (v) => fmtDb(v));
bindSlider("attack", (v) => {
    ra.setParam(0, "attack", v / 1000); engine.attack = v / 1000; }, (v) => v + "ms");
bindSlider("decay", (v) => {
    ra.setParam(0, "decay", v / 1000); engine.decay = v / 1000; }, (v) => v + "ms");
bindSlider("sustain", (v) => {
    ra.setParam(0, "sustain", v / 100); engine.sustain = v / 100; }, (v) => v + "%");
bindSlider("release", (v) => {
    ra.setParam(0, "release", v / 1000); engine.release = v / 1000; }, (v) => v + "ms");
bindSlider("reverb", (v) => {
    ra.setMaster("reverb", v / 100); engine.setReverb(v / 100); }, (v) => v + "%");

// ============ 合成器参数面板 ============
// (面板始终可用,无禁用状态)

export const pianoParamsEl = $id("piano-params");
export const dripParamsEl = $id("drip-params");

// 分类选项卡切换
$id("tab-bar").querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    const t = (b as HTMLElement).dataset.tab;
    if (!t) return;   // 非选项卡按钮(如复位按钮),不参与切换
    $id("tab-bar").querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".tab-body").forEach((tb) => tb.classList.remove("active"));
    $id("tab-" + t).classList.add("active");
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
bindSlider("dp-ratio", (v) => {
    ra.setParam(0, "drip_ratio", v / 100); engine.dripRatio = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("dp-time", (v) => {
    ra.setParam(0, "drip_time_ms", v); engine.dripTimeMs = v; }, (v) => v + "ms");
bindSlider("dp-decay", (v) => {
    ra.setParam(0, "drip_decay_ms", v); engine.dripDecayMs = v; }, (v) => v + "ms");
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
bindSlider("pn-decay", (v) => {
    ra.setParam(0, "piano_decay_scale", v / 100); engine.pianoDecayScale = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
bindSlider("pn-detune", (v) => {
    ra.setParam(0, "piano_detune_cents", v); engine.pianoDetuneCents = v; }, (v) => v + "c");
bindSlider("pn-noise", (v) => {
    ra.setParam(0, "piano_noise_level", v / 100); engine.pianoNoiseLevel = v / 100; }, (v) => v + "%");
bindSlider("pn-bright", (v) => {
    ra.setParam(0, "piano_bright", v / 100); engine.pianoBright = v / 100; }, (v) => (v / 100).toFixed(1) + "x");
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
syncMainToRust();
});
($id("sp-filter-type") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.filterKind = (e.target as HTMLSelectElement).value as BiquadFilterType;
syncMainToRust();
});
bindSlider("sp-osc-count", (v) => {
    ra.setParam(0, "osc_count", v); engine.oscCount = v; }, (v) => String(v));
bindSlider("sp-detune", (v) => {
    ra.setParam(0, "detune_cents", v); engine.detuneCents = v; }, (v) => v + "c");
bindSlider("sp-resonance", (v) => {
    ra.setParam(0, "resonance_q", v / 100); engine.resonanceQ = v / 100; }, (v) => (v / 100).toFixed(1));
bindSlider("sp-cutoff", (v) => {
    ra.setParam(0, "cutoff_hz", v); engine.cutoffHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-env", (v) => {
    ra.setParam(0, "cutoff_env_hz", v); engine.cutoffEnvHz = v; }, (v) => v + "Hz");
bindSlider("sp-cutoff-time", (v) => {
    ra.setParam(0, "cutoff_env_ms", v); engine.cutoffEnvMs = v; }, (v) => v + "ms");

// ============ 粒子合成参数(仅粒子音色 PILG1 生效) ============
// 基础参数:粒子时长/密度/散布/随机
bindSlider("grain-size", (v) => {
    engine.grainSizeMs = v;
    ra.setParam(0, "grain_size_ms", v);
  }, (v) => Math.round(v) + "ms");
bindSlider("grain-density", (v) => {
    engine.grainDensity = v;
    ra.setParam(0, "grain_density", v);
  }, (v) => Math.round(v) + "/s");
bindSlider("grain-spread", (v) => {
    engine.grainSpread = v;
    ra.setParam(0, "grain_spread", v);
  }, (v) => Math.round(v) + "音分");
bindSlider("grain-random", (v) => {
    engine.grainRandom = v / 100;
    ra.setParam(0, "grain_random", v / 100);
  }, (v) => Math.round(v) + "%");
// 粒子扩展开关:勾选 = 引擎切到粒子合成(声音立即变粒子,保留已调音色参数),
// 音色按钮不跳转;取消 = 恢复勾选前的音色
let grainExtOn = false;
let grainExtTouched = false;
let savedWaveForGrain = engine.waveType;
$id("grain-ext").addEventListener("change", () => {
  grainExtOn = ($id("grain-ext") as HTMLInputElement).checked;
  if (grainExtOn) {
    if (engine.waveType !== "grain") savedWaveForGrain = engine.waveType;
    engine.waveType = "grain";
    syncMainToRust();                          // 推 Rust:粒子合成立即发声(参数保留)
    presetButtons.forEach((p) => p.classList.remove("active"));   // 不跳音色按钮高亮
  } else {
    engine.waveType = savedWaveForGrain;
    syncMainToRust();                          // 恢复原音色
  }
  setGrainCtrlState(engine.waveType, grainExtOn);
  if (grainExtOn && !grainExtTouched) {
    grainExtTouched = true;
    engine.grainSizeEnd = 200; engine.grainDensityEnd = 150;
    engine.grainEnvMs = 1000; engine.grainEnvExp = 1.5;
    ($id("grain-size-end") as HTMLInputElement).value = "200";
    ($id("grain-density-end") as HTMLInputElement).value = "150";
    ($id("grain-env-ms") as HTMLInputElement).value = "1000";
    ($id("grain-env-exp") as HTMLInputElement).value = "15";
    ($id("grain-size-end-val") as HTMLElement).textContent = "200ms";
    ($id("grain-density-end-val") as HTMLElement).textContent = "150/s";
    ($id("grain-env-ms-val") as HTMLElement).textContent = "1000ms";
    ($id("grain-env-exp-val") as HTMLElement).textContent = "1.5";
    ra.setParam(0, "grain_size_end", 200);
    ra.setParam(0, "grain_density_end", 150);
    ra.setParam(0, "grain_env_ms", 1000);
    ra.setParam(0, "grain_env_exp", 1.5);
    toast("粒子扩展:已给演示曲线(时长 80→200ms,密度 40→150/s),按住琴键听变化");
  }
  setGrainCtrlState(engine.waveType, grainExtOn);
});
// 扩展参数:时长终点/密度终点/滑动时间/形状指数
bindSlider("grain-size-end", (v) => {
    engine.grainSizeEnd = v;
    ra.setParam(0, "grain_size_end", v);
  }, (v) => Math.round(v) + "ms");
bindSlider("grain-density-end", (v) => {
    engine.grainDensityEnd = v;
    ra.setParam(0, "grain_density_end", v);
  }, (v) => Math.round(v) + "/s");
bindSlider("grain-env-ms", (v) => {
    engine.grainEnvMs = v;
    ra.setParam(0, "grain_env_ms", v);
  }, (v) => Math.round(v) + "ms");
bindSlider("grain-env-exp", (v) => {
    engine.grainEnvExp = v / 10;
    ra.setParam(0, "grain_env_exp", v / 10);
  }, (v) => (v / 10).toFixed(1) + (v === 0 ? "(线性)" : ""));
setGrainCtrlState(engine.waveType, false);   // 初始:非粒子音色全部禁用

// ============ 全部复位(傻瓜模式) ============
$id("btn-reset-all").addEventListener("click", () => {
  resetAllToDefault();                       // 引擎参数回默认 + 推 Rust
  // UI 同步:各面板控件刷新回默认值
  refreshSynthUI();
  refreshPlayUI();
  refreshFxUI();
  refreshDripUI();
  refreshPianoUI();
  refreshWtUI();
  refreshWtBankUI();
  presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === "sine"));
  setPmExtFromWave("sine");                  // PM 扩展关闭
  setGrainCtrlState("sine", false);          // 粒子参数禁用
  // 力度 tab UI 同步(力度曲线已复位,刷新显示)
  try {
    const velUI = document.querySelector("#tab-vel canvas");
    if (velUI) (velUI as HTMLCanvasElement).dispatchEvent(new Event("refresh-vel"));
  } catch { /* ignore */ }
  const velMinEl = $id("vel-min") as HTMLInputElement | null;
  if (velMinEl) velMinEl.value = "20";
  const velPowEl = $id("vel-power") as HTMLInputElement | null;
  if (velPowEl) velPowEl.value = "100";
  const pmExt = $id("pm-ext") as HTMLInputElement | null;
  if (pmExt) pmExt.checked = false;
  const grainExt = $id("grain-ext") as HTMLInputElement | null;
  if (grainExt) grainExt.checked = false;
  toast("已复位全部参数(傻瓜模式:按下琴键即出默认音)");
});

// ============ 演奏参数绑定 ============
// 总静音(软件不发声;示波器照常显示)
let muted = false;
$id("btn-mute").addEventListener("click", () => {
  muted = !muted;
  ra.setMaster("mute", muted ? 1 : 0);
  const btn = $id("btn-mute");
  btn.textContent = muted ? "恢复发声" : "静音";
  btn.classList.toggle("danger", muted);
  toast(muted ? "已静音(不发声)" : "已恢复发声");
});
$id("mode-ctrl").querySelectorAll(".mini-btn").forEach((b) => {
  b.addEventListener("click", () => {
    engine.monoMode = (b as HTMLElement).dataset.mode === "mono";
    refreshPlayUI();
    ra.setParam(0, "mono_mode", engine.monoMode ? 1 : 0);   // 推 Rust(采样级生效)
    if (engine.monoMode) {
      ra.allOff(0);
      engine.allOff();   // 切单音时清空现有复音
    }
  });
});
bindSlider("pan", (v) => {
    ra.setParam(0, "pan", v / 100); engine.pan = v / 100; }, (v) => (v === 0 ? "C" : v < 0 ? "L" : "R"));
bindSlider("vib-rate", (v) => {
    ra.setParam(0, "vibrato_rate", v / 100); engine.vibratoRate = v / 100; }, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("vib-depth", (v) => {
    ra.setParam(0, "vibrato_depth", v / 100); engine.vibratoDepth = v / 100; }, (v) => v + "%");
refreshPlayUI();

// ============ 新功能参数绑定(滑音/滤波包络/键位力度/副振荡器/延迟/失真/调制LFO) ============
bindSlider("porta", (v) => {
    ra.setParam(0, "portamento_ms", v); engine.portamentoMs = v; }, (v) => v + "ms");
bindSlider("fe-amt", (v) => {
    ra.setParam(0, "filter_env_hz", v); engine.filterEnvHz = v; }, (v) => v + "Hz");
bindSlider("fe-a", (v) => {
    ra.setParam(0, "filter_env_a", v / 1000); engine.filterEnvA = v / 1000; }, (v) => v + "ms");
bindSlider("fe-d", (v) => {
    ra.setParam(0, "filter_env_d", v / 1000); engine.filterEnvD = v / 1000; }, (v) => v + "ms");
bindSlider("fe-s", (v) => {
    ra.setParam(0, "filter_env_s", v / 100); engine.filterEnvS = v / 100; }, (v) => v + "%");
bindSlider("fe-r", (v) => {
    ra.setParam(0, "filter_env_r", v / 1000); engine.filterEnvR = v / 1000; }, (v) => v + "ms");
bindSlider("kt", (v) => {
    ra.setParam(0, "key_track", v / 100); engine.keyTrack = v / 100; }, (v) => v + "%");
bindSlider("vt", (v) => {
    ra.setParam(0, "vel_track", v / 100); engine.velTrack = v / 100; }, (v) => v + "%");
bindSlider("sub-level", (v) => {
    ra.setParam(0, "sub_level", v / 100); engine.subLevel = v / 100; }, (v) => v + "%");
($id("sub-wave") as HTMLSelectElement).addEventListener("change", (e) => {
  engine.subWave = (e.target as HTMLSelectElement).value as OscillatorType;
syncMainToRust();
});
bindSlider("dl-time", (v) => {
    ra.setMaster("delay_time_ms", v); engine.setDelay(v, engine.delayFeedback, engine.delayMix); }, (v) => v + "ms");
bindSlider("dl-fb", (v) => {
    ra.setMaster("delay_feedback", v / 100); engine.setDelay(engine.delayTimeMs, v / 100, engine.delayMix); }, (v) => v + "%");
bindSlider("dl-mix", (v) => {
    ra.setMaster("delay_mix", v / 100); engine.setDelay(engine.delayTimeMs, engine.delayFeedback, v / 100); }, (v) => v + "%");
// 调制 LFO
const mlTarget = $id("ml-target") as HTMLSelectElement;
const mlWave = $id("ml-wave") as HTMLSelectElement;
export function refreshFxUI() {
  ($id("volume") as HTMLInputElement).value = String(Math.round(linToDb(engine.volume)));
  $id("volume-val").textContent = fmtDb(linToDb(engine.volume));
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
  ($id("eq-bass") as HTMLInputElement).value = String(engine.eqBass);
  $id("eq-bass-val").textContent = (engine.eqBass > 0 ? "+" : "") + engine.eqBass + "dB";
  ($id("eq-mid") as HTMLInputElement).value = String(engine.eqMid);
  $id("eq-mid-val").textContent = (engine.eqMid > 0 ? "+" : "") + engine.eqMid + "dB";
  ($id("eq-treble") as HTMLInputElement).value = String(engine.eqTreble);
  $id("eq-treble-val").textContent = (engine.eqTreble > 0 ? "+" : "") + engine.eqTreble + "dB";
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
syncMainToRust();
});
mlWave.addEventListener("change", () => {
  engine.setModLfoParams(engine.modLfoRate, engine.modLfoDepth,
    mlWave.value as OscillatorType | "s&h", engine.modLfoTarget);
syncMainToRust();
});
bindSlider("ml-rate", (v) => {
    ra.setParam(0, "mod_lfo_rate", v / 100);
  engine.setModLfoParams(v / 100, engine.modLfoDepth, engine.modLfoWave, engine.modLfoTarget);
}, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("ml-depth", (v) => {
    // 调制目标为"关"时自动切到滤波截止(否则改深度无听感变化)
    if (engine.modLfoTarget === "off") {
      engine.modLfoTarget = "cutoff";
      const mt = $id("ml-target") as HTMLSelectElement | null;
      if (mt) mt.value = "cutoff";
    }
    ra.setParam(0, "mod_lfo_depth", v / 100);
  engine.setModLfoParams(engine.modLfoRate, v / 100, engine.modLfoWave, engine.modLfoTarget);
}, (v) => Math.round(v) + "%");
bindSlider("drive", (v) => {
  engine.drive = v / 100;
  ra.setMaster("drive", engine.drive);
}, (v) => v + "%");
// 三频段 EQ(±12dB)
const eqFmt = (v: number) => (v > 0 ? "+" : "") + v + "dB";
bindSlider("eq-bass", (v) => { engine.eqBass = v; ra.setMaster("eq_bass", v); }, eqFmt);
bindSlider("eq-mid", (v) => { engine.eqMid = v; ra.setMaster("eq_mid", v); }, eqFmt);
bindSlider("eq-treble", (v) => { engine.eqTreble = v; ra.setMaster("eq_treble", v); }, eqFmt);
refreshFxUI();

// ============ 预设保存/加载 ============
