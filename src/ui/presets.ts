// 音色预设:保存/加载/内置库导入/程序变更映射
import { engine, anchors, presetButtons, captureParams, wtBanks, wtBankIdx, velAnchors, velMin, velPower, setAnchors, setVelMin, setVelPower, PRESET_KEY } from "../core/store";
import { builtinAnchors, PRESET_DEFS } from "../core/wave";
import type { WaveType } from "../core/wave";
import { drawWave } from "./wave-editor";
import { refreshWtUI, refreshWtBankUI } from "./wt-panel";
import { refreshSynthUI, refreshPlayUI, refreshPianoUI, refreshDripUI, refreshFxUI } from "./panel";
import { drawVelCurve } from "./velocity";
import { $id, toast } from "./dom";
import { PRESET_LIBRARY } from "../core/presets-library";
export function setPreset(type: WaveType) {
  const prevType = engine.waveType;
  engine.setWave(type);
  presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === type));
  if (type === "custom") {
    // 从当前内置波形生成初始锚点(用切换前的类型)
    setAnchors(builtinAnchors(prevType === "custom" ? "sine" : prevType));
    engine.setCustomWave(anchors);
  }
  // 合成器预设:灌入该机型默认参数;面板始终可用(所有波形都走合成器路径)
  if (engine.isSynthPreset(type)) {
    const def = PRESET_DEFS[type];
    if (def) {
      engine.oscWave = def.oscWave;
      engine.oscCount = def.detune ? 2 : 1;
      engine.detuneCents = def.detune ?? 0;
      engine.filterKind = def.filterType ?? "lowpass";
      engine.cutoffHz = def.cutoff ?? 2000;
      engine.resonanceQ = def.resonance ?? 0.7;
      engine.cutoffEnvHz = def.cutoffEnv ?? 0;
      engine.cutoffEnvMs = def.cutoffEnvTime ? def.cutoffEnvTime * 1000 : 90;
    }
    if (type === "dx7") {
      $id("sp-note").textContent = "FM 音色:振荡器参数不适用";
    } else if (type === "wt") {
      $id("sp-note").textContent = "波表合成:渐变配置见「渐变」选项卡";
      refreshWtUI();
    } else if (type === "piano") {
      $id("sp-note").textContent = "PILZ1 加法合成:钢琴参数可用";
      refreshPianoUI();
    } else if (type === "drip") {
      $id("sp-note").textContent = "PILQ1 频率下滑:水滴参数可用";
      refreshDripUI();
    } else {
      $id("sp-note").textContent = "已加载机型默认参数";
      refreshSynthUI();
    }
  }
  refreshPianoUI();
  refreshDripUI();
  refreshWtUI();
  drawWave();
}

export const MIDI_PROGRAM_WAVES: WaveType[] = [
  "sine", "triangle", "square", "saw", "wt", "moog",
  "dx7", "piano", "drip", "acc", "clar", "harp", "guzheng", "custom",
];
export function handleMidiProgramChange(program: number) {
  let name = "";
  if (program < MIDI_PROGRAM_WAVES.length) {
    const t = MIDI_PROGRAM_WAVES[program];
    setPreset(t);
    name = t;
  } else {
    // 用户预设:program-14 对应 localStorage 预设列表下标
    const idx = program - MIDI_PROGRAM_WAVES.length;
    let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
    try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
    const p = list[idx];
    if (!p) { toast("MIDI 程序 " + program + ":无对应预设"); return; }
    applyParams(p.params);
    name = p.name;
  }
  toast("MIDI 程序变更 → " + name);
}
// PRESET_KEY 已移至 core/store.ts(渐变槽位下拉共用)
export function applyParams(p: ReturnType<typeof captureParams>) {
  engine.waveType = p.waveType;
  engine.oscWave = p.oscWave;
  engine.oscCount = p.oscCount;
  engine.detuneCents = p.detuneCents;
  engine.filterKind = p.filterKind;
  engine.cutoffHz = p.cutoffHz;
  engine.resonanceQ = p.resonanceQ;
  engine.cutoffEnvHz = p.cutoffEnvHz;
  engine.cutoffEnvMs = p.cutoffEnvMs;
  engine.attack = p.attack; engine.decay = p.decay;
  engine.sustain = p.sustain; engine.release = p.release;
  engine.volume = p.volume; engine.reverb = p.reverb; engine.harmonics = p.harmonics;
  engine.monoMode = p.monoMode; engine.pan = p.pan;
  engine.vibratoRate = p.vibratoRate; engine.vibratoDepth = p.vibratoDepth;
  engine.pianoDecayScale = p.pianoDecayScale;
  engine.pianoDetuneCents = p.pianoDetuneCents;
  engine.pianoNoiseLevel = p.pianoNoiseLevel;
  engine.pianoBright = p.pianoBright;
  engine.dripRatio = p.dripRatio;
  engine.dripTimeMs = p.dripTimeMs;
  engine.dripDecayMs = p.dripDecayMs;
  engine.wtPos = p.wtPos ?? 0.3;
  engine.wtLfoRate = p.wtLfoRate ?? 0;
  engine.wtLfoDepth = p.wtLfoDepth ?? 0;
  if (Array.isArray(p.wtSlots) && p.wtSlots.length >= 2 && p.wtSlots.length <= 16) {
    engine.wtSlots = [...p.wtSlots];
    engine.markWtDirty();
    // 渐变面板同步显示预设槽位
    if (wtBanks[wtBankIdx]) { wtBanks[wtBankIdx].slots = [...p.wtSlots]; refreshWtBankUI(); }
  }
  engine.bendCents = p.bendCents ?? 0;
  engine.portamentoMs = p.portamentoMs ?? 0;
  engine.sustainPedal = p.sustainPedal ?? false;
  engine.filterEnvHz = p.filterEnvHz ?? 0;
  engine.filterEnvA = p.filterEnvA ?? 0.01;
  engine.filterEnvD = p.filterEnvD ?? 0.3;
  engine.filterEnvS = p.filterEnvS ?? 0.5;
  engine.filterEnvR = p.filterEnvR ?? 0.3;
  engine.keyTrack = p.keyTrack ?? 0.3;
  engine.velTrack = p.velTrack ?? 0.3;
  engine.modLfoRate = p.modLfoRate ?? 4;
  engine.modLfoDepth = p.modLfoDepth ?? 0;
  engine.modLfoWave = p.modLfoWave ?? "sine";
  engine.modLfoTarget = p.modLfoTarget ?? "off";
  engine.delayTimeMs = p.delayTimeMs ?? 350;
  engine.delayFeedback = p.delayFeedback ?? 0.4;
  engine.delayMix = p.delayMix ?? 0.2;
  engine.drive = p.drive ?? 0;
  engine.subLevel = p.subLevel ?? 0;
  engine.subWave = p.subWave ?? "sine";
  engine.setDelay(engine.delayTimeMs, engine.delayFeedback, engine.delayMix);
  engine.setDrive(engine.drive);
  engine.setModLfoParams(engine.modLfoRate, engine.modLfoDepth, engine.modLfoWave, engine.modLfoTarget);
  if (Array.isArray(p.velCurve) && p.velCurve.length === velAnchors.length) {
    for (let i = 0; i < velAnchors.length; i++) velAnchors[i].y = p.velCurve[i];
  }
  if (typeof p.velMin === "number") {
    setVelMin(p.velMin);
    ($id("vel-min") as HTMLInputElement).value = String(Math.round(velMin * 100));
    $id("vel-min-val").textContent = Math.round(velMin * 100) + "%";
  }
  if (typeof p.velPower === "number") {
    setVelPower(p.velPower);
  drawVelCurve();
    ($id("vel-power") as HTMLInputElement).value = String(Math.round(velPower * 100));
    $id("vel-power-val").textContent = velPower.toFixed(1) + "x";
  }
  engine.setWave(p.waveType);
  if (p.waveType === "custom") {
    setAnchors(builtinAnchors("sine"));
    engine.setCustomWave(anchors);
  }
  // 刷新所有 UI(面板始终可用,预设加载时同步合成器参数)
  presetButtons.forEach((b) => b.classList.toggle("active", b.dataset.wave === p.waveType));
  if (engine.isSynthPreset(p.waveType)) {
    if (p.waveType === "dx7") {
      $id("sp-note").textContent = "FM 音色:振荡器参数不适用";
    } else if (p.waveType === "wt") {
      $id("sp-note").textContent = "波表合成:渐变配置见「渐变」选项卡";
    } else if (p.waveType === "piano") {
      $id("sp-note").textContent = "PILZ1 加法合成:钢琴参数可用";
    } else if (p.waveType === "drip") {
      $id("sp-note").textContent = "PILQ1 频率下滑:水滴参数可用";
    } else {
      $id("sp-note").textContent = "已加载机型默认参数";
    }
    refreshSynthUI();
  } else {
    $id("sp-note").textContent = "";
  }
  refreshPianoUI();
  refreshDripUI();
  refreshWtUI();
  refreshPlayUI();
  refreshFxUI();
  (($id("volume") as HTMLInputElement).value = String(Math.round(p.volume * 100)));
  $id("volume-val").textContent = Math.round(p.volume * 100) + "%";
  (($id("attack") as HTMLInputElement).value = String(Math.round(p.attack * 1000)));
  $id("attack-val").textContent = Math.round(p.attack * 1000) + "ms";
  (($id("decay") as HTMLInputElement).value = String(Math.round(p.decay * 1000)));
  $id("decay-val").textContent = Math.round(p.decay * 1000) + "ms";
  (($id("sustain") as HTMLInputElement).value = String(Math.round(p.sustain * 100)));
  $id("sustain-val").textContent = Math.round(p.sustain * 100) + "%";
  (($id("release") as HTMLInputElement).value = String(Math.round(p.release * 1000)));
  $id("release-val").textContent = Math.round(p.release * 1000) + "ms";
  (($id("reverb") as HTMLInputElement).value = String(Math.round(p.reverb * 100)));
  $id("reverb-val").textContent = Math.round(p.reverb * 100) + "%";
  (($id("harmonics") as HTMLInputElement).value = String(p.harmonics));
  drawWave();
}

export function loadPresetList() {
  const sel = $id("preset-list") as HTMLSelectElement;
  const cur = sel.value;
  sel.innerHTML = '<option value="">加载预设...</option>';
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  list.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  return list;
}

$id("btn-save-preset").addEventListener("click", () => {
  const name = ($id("preset-name") as HTMLInputElement).value.trim();
  if (!name) { toast("请输入预设名称"); return; }
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  list.push({ name, params: captureParams() });
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  loadPresetList();
  toast("预设已保存: " + name);
});

$id("preset-list").addEventListener("change", (e) => {
  const i = Number((e.target as HTMLSelectElement).value);
  if (isNaN(i)) return;
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return; }
  const p = list[i];
  if (p) { applyParams(p.params); toast("已加载: " + p.name); }
});

$id("btn-del-preset").addEventListener("click", () => {
  const sel = $id("preset-list") as HTMLSelectElement;
  const i = Number(sel.value);
  if (isNaN(i)) { toast("先选择要删除的预设"); return; }
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return; }
  const name = list[i]?.name ?? "";
  list.splice(i, 1);
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  loadPresetList();
  toast("已删除: " + name);
});
loadPresetList();


// 波形预设按钮接线(点击 → 切换音色 + 重载音频引擎)
presetButtons.forEach((p) =>
  p.addEventListener("click", () => { setPreset(p.dataset.wave as WaveType); engine.reload(); })
);

// 内置预设库导入:启动时把库里没有的预设全量加入用户列表(全选导入旧版音色)
export function seedBuiltinPresets() {
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  const names = new Set(list.map((p) => p.name));
  let added = 0;
  for (const lib of PRESET_LIBRARY) {
    if (names.has(lib.name)) continue;
    list.push(lib as unknown as { name: string; params: ReturnType<typeof captureParams> });
    names.add(lib.name);
    added++;
  }
  if (added > 0) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
    toast("已导入旧版音色预设 " + added + " 个(全选)");
  }
  loadPresetList();
}
