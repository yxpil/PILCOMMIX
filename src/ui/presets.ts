// 音色预设:保存/加载/内置库导入/程序变更映射
import { engine, anchors, presetButtons, captureParams, wtBanks, wtBankIdx, velAnchors, velMin, velPower, setAnchors, setVelMin, setVelPower, PRESET_KEY, setPmExtFromWave, setGrainCtrlState, migratePresets } from "../core/store";
import { PRESET_LIBRARY, findLibraryPreset, randomLibraryPreset, loadUserMap } from "../core/presets-library";
import type { LibraryPreset } from "../core/presets-library";
import type { SynthEngine } from "../core/engine";
import { ra } from "../core/rust-audio";
import { builtinAnchors, PRESET_DEFS } from "../core/wave";
import type { WaveType } from "../core/wave";
import { drawWave, syncGrainWaveFromAnchors } from "./wave-editor";
import { refreshWtUI, refreshWtBankUI } from "./wt-panel";
import { refreshSynthUI, refreshPlayUI, refreshPianoUI, refreshDripUI, refreshFxUI } from "./panel";
import { drawVelCurve } from "./velocity";
import { $id, toast } from "./dom";
// 把内置波形的机型默认参数灌入指定引擎(UI 无关,主引擎/通道分身共用)
export function applyPresetDefToEngine(eng: SynthEngine, type: WaveType) {
  eng.setWave(type);
  // 合成器预设:灌入该机型默认参数
  if (eng.isSynthPreset(type)) {
    const def = PRESET_DEFS[type];
    if (def) {
      eng.oscWave = def.oscWave;
      eng.oscCount = def.detune ? 2 : 1;
      eng.detuneCents = def.detune ?? 0;
      eng.filterKind = def.filterType ?? "lowpass";
      eng.cutoffHz = def.cutoff ?? 2000;
      eng.resonanceQ = def.resonance ?? 0.7;
      eng.cutoffEnvHz = def.cutoffEnv ?? 0;
      eng.cutoffEnvMs = def.cutoffEnvTime ? def.cutoffEnvTime * 1000 : 90;
    }
  }
  // custom:通道分身没有全局锚点,用正弦基准生成波形
  if (type === "custom" && !eng.customWave) {
    eng.customWave = eng.buildWave("custom", builtinAnchors("sine"));
  }
}
// 把当前主引擎参数整体推送给 Rust(预设/程序变更后调用;滑块走 set_param 单项)
export function syncMainToRust() {
  ra.setEngineParams(0, captureParams());
  ra.setMaster("volume", engine.volume);
  ra.setMaster("reverb", engine.reverb);
  ra.setMaster("delay_time_ms", engine.delayTimeMs);
  ra.setMaster("delay_feedback", engine.delayFeedback);
  ra.setMaster("delay_mix", engine.delayMix);
  ra.setMaster("drive", engine.drive);
  ra.setMaster("eq_bass", engine.eqBass);
  ra.setMaster("eq_mid", engine.eqMid);
  ra.setMaster("eq_treble", engine.eqTreble);
  ra.setCustomAnchors(0, anchors);
  ra.setWtSlots(0, engine.wtSlots);
}

// MIDI 程序变更 → 指定通道引擎(前端解析音色,单数据源在 localStorage 预设)
// 返回音色名,null=无对应预设
export function applyProgramToChannel(ch: number, program: number): string | null {
  const r = resolveProgram(program);
  if (!r) return null;
  const engParams: Record<string, unknown> = {};
  if (r.type !== undefined) {
    // 内置波形:机型默认参数
    const def = PRESET_DEFS[r.type] ?? {};
    engParams.waveType = r.type;
    engParams.oscWave = def.oscWave ?? "sawtooth";
    engParams.oscCount = def.detune ? 2 : 1;
    engParams.detuneCents = def.detune ?? 0;
    engParams.filterKind = def.filterType ?? "lowpass";
    engParams.cutoffHz = def.cutoff ?? 2000;
    engParams.resonanceQ = def.resonance ?? 0.7;
    engParams.cutoffEnvHz = def.cutoffEnv ?? 0;
    engParams.cutoffEnvMs = def.cutoffEnvTime ? def.cutoffEnvTime * 1000 : 90;
    // 内置库/随机匹配参数覆盖(如 PM 预设的算子参数)
    if (r.params) Object.assign(engParams, r.params);
  } else if (r.params) {
    Object.assign(engParams, r.params);
  }
  // 合并主引擎当前参数(通道继承包络/滤波/增益等,与 TS 分身语义一致)
  const merged = { ...captureParams(), ...engParams } as Record<string, unknown>;
  ra.setEngineParams(ch, merged);
  return r.name;
}

export function setPreset(type: WaveType) {
  const prevType = engine.waveType;
  applyPresetDefToEngine(engine, type);
  presetButtons.forEach((p) => p.classList.toggle("active", p.dataset.wave === type));
  setPmExtFromWave(type);   // PM 音色自动开启 PM 扩展
  setGrainCtrlState(type, (document.getElementById("grain-ext") as HTMLInputElement | null)?.checked ?? false);  // 粒子参数仅粒子音色可调(复选框状态保持)
  if (type === "custom") {
    // 从当前内置波形生成初始锚点(用切换前的类型)
    setAnchors(builtinAnchors(prevType === "custom" ? "sine" : prevType));
    engine.setCustomWave(anchors);
    syncGrainWaveFromAnchors();   // 画笔采样缓冲同步(画布统一画笔模式)
  }
  // 面板始终可用(所有波形都走合成器路径)
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
  refreshPianoUI();
  refreshDripUI();
  refreshWtUI();
  drawWave();
  syncMainToRust();
  toast("音色:" + type);   // 切换状态显示
}

export const MIDI_PROGRAM_WAVES: WaveType[] = [
  "sine", "triangle", "square", "saw", "wt", "moog",
  "dx7", "piano", "drip", "acc", "clar", "harp", "guzheng", "custom",
];
// 自动随机匹配开关(未定义程序号 → 确定性随机到内置库,同一程序号稳定同一音色)
export function autoMatchEnabled(): boolean {
  try { return localStorage.getItem("commix-auto-match") !== "off"; } catch { return true; }
}
export function setAutoMatch(on: boolean) {
  try { localStorage.setItem("commix-auto-match", on ? "on" : "off"); } catch { /* ignore */ }
}

// 程序号 → 音色(纯解析;用户绑定 → 内置库精确匹配 → 自动随机匹配 → 环形/用户预设回退)
export function resolveProgram(program: number): { type?: WaveType; params?: ReturnType<typeof captureParams>; name: string } | null {
  // ① 用户自定义绑定(程序号 → 音色映射选项卡)
  const um = loadUserMap();
  const bound = um.get(program);
  if (bound !== undefined) {
    const lib = findLibraryPreset(bound);
    if (lib) return { type: lib.wave, params: (lib.p ?? {}) as ReturnType<typeof captureParams>, name: `程序${program} 绑定:${lib.name}` };
  }
  // ② 内置库:程序号即标号(如 71 = 单簧管)
  const lib = findLibraryPreset(program);
  if (lib) return { type: lib.wave, params: (lib.p ?? {}) as ReturnType<typeof captureParams>, name: `程序${lib.program} ${lib.name}` };
  // ③ 自动随机匹配(确定性散列,同号同音色)
  if (autoMatchEnabled()) {
    const r = randomLibraryPreset(program);
    return { type: r.wave, params: (r.p ?? {}) as ReturnType<typeof captureParams>, name: `程序${program}(自动)→${r.name}` };
  }
  // ③ 回退:环形波形 / 用户预设(旧行为)
  if (program < MIDI_PROGRAM_WAVES.length) {
    return { type: MIDI_PROGRAM_WAVES[program], name: MIDI_PROGRAM_WAVES[program] };
  }
  const idx = program - MIDI_PROGRAM_WAVES.length;
  let list: { name: string; params: ReturnType<typeof captureParams> }[] = [];
  try { list = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { list = []; }
  const p = list[idx];
  if (!p) return null;
  return { params: p.params, name: p.name };
}
// 把程序变更应用到指定引擎(返回音色名,null=无对应预设)
export function applyProgramToEngine(eng: SynthEngine, program: number): string | null {
  const r = resolveProgram(program);
  if (!r) return null;
  if (r.type !== undefined) {
    applyPresetDefToEngine(eng, r.type);
    if (r.params && Object.keys(r.params).length > 0) {
      const merged = { ...captureParams(), ...r.params, waveType: r.type } as ReturnType<typeof captureParams>;
      applyParamsToEngine(eng, merged);
    }
  } else if (r.params) applyParamsToEngine(eng, r.params);
  return r.name;
}
export function handleMidiProgramChange(program: number) {
  const r = resolveProgram(program);
  if (!r) { toast("MIDI 程序 " + program + ":无对应预设"); return; }
  if (r.type !== undefined) {
    setPreset(r.type);
    if (r.params && Object.keys(r.params).length > 0) {
      applyParams({ ...captureParams(), ...r.params, waveType: r.type } as ReturnType<typeof captureParams>);
    }
  } else if (r.params) applyParams(r.params);
  toast("MIDI 程序变更 → " + r.name);
}
// PRESET_KEY 已移至 core/store.ts(渐变槽位下拉共用)
// 预设参数 → 指定引擎(纯参数,无 UI/力度曲线;主引擎与通道分身共用)
export function applyParamsToEngine(eng: SynthEngine, p: ReturnType<typeof captureParams>) {
  if (!p) return;   // 兜底:损坏/旧版预设数据
  eng.waveType = p.waveType;
  eng.oscWave = p.oscWave;
  eng.oscCount = p.oscCount;
  eng.detuneCents = p.detuneCents;
  eng.filterKind = p.filterKind;
  eng.cutoffHz = p.cutoffHz;
  eng.resonanceQ = p.resonanceQ;
  eng.cutoffEnvHz = p.cutoffEnvHz;
  eng.cutoffEnvMs = p.cutoffEnvMs;
  eng.attack = p.attack; eng.decay = p.decay;
  eng.sustain = p.sustain; eng.release = p.release;
  eng.volume = p.volume; eng.reverb = p.reverb; eng.harmonics = p.harmonics;
  eng.monoMode = p.monoMode; eng.pan = p.pan;
  if (typeof p.grainSizeMs === "number") {
    eng.grainSizeMs = p.grainSizeMs; eng.grainDensity = p.grainDensity ?? 40;
    eng.grainSpread = p.grainSpread ?? 30; eng.grainRandom = p.grainRandom ?? 0.3;
    eng.grainSizeEnd = p.grainSizeEnd ?? p.grainSizeMs;
    eng.grainDensityEnd = p.grainDensityEnd ?? p.grainDensity;
    eng.grainEnvMs = p.grainEnvMs ?? 800; eng.grainEnvExp = p.grainEnvExp ?? 0;
  }
  eng.vibratoRate = p.vibratoRate; eng.vibratoDepth = p.vibratoDepth;
  eng.pianoDecayScale = p.pianoDecayScale;
  eng.pianoDetuneCents = p.pianoDetuneCents;
  eng.pianoNoiseLevel = p.pianoNoiseLevel;
  eng.pianoBright = p.pianoBright;
  eng.dripRatio = p.dripRatio;
  eng.dripTimeMs = p.dripTimeMs;
  eng.dripDecayMs = p.dripDecayMs;
  eng.wtPos = p.wtPos ?? 0.3;
  eng.wtLfoRate = p.wtLfoRate ?? 0;
  eng.wtLfoDepth = p.wtLfoDepth ?? 0;
  if (Array.isArray(p.wtSlots) && p.wtSlots.length >= 2 && p.wtSlots.length <= 16) {
    eng.wtSlots = [...p.wtSlots];
    eng.markWtDirty();
  }
  eng.bendCents = p.bendCents ?? 0;
  eng.portamentoMs = p.portamentoMs ?? 0;
  eng.sustainPedal = p.sustainPedal ?? false;
  eng.filterEnvHz = p.filterEnvHz ?? 0;
  eng.filterEnvA = p.filterEnvA ?? 0.01;
  eng.filterEnvD = p.filterEnvD ?? 0.3;
  eng.filterEnvS = p.filterEnvS ?? 0.5;
  eng.filterEnvR = p.filterEnvR ?? 0.3;
  eng.keyTrack = p.keyTrack ?? 0.3;
  eng.velTrack = p.velTrack ?? 0.3;
  eng.modLfoRate = p.modLfoRate ?? 4;
  eng.modLfoDepth = p.modLfoDepth ?? 0;
  eng.modLfoWave = p.modLfoWave ?? "sine";
  eng.modLfoTarget = p.modLfoTarget ?? "off";
  eng.delayTimeMs = p.delayTimeMs ?? 350;
  eng.delayFeedback = p.delayFeedback ?? 0.4;
  eng.delayMix = p.delayMix ?? 0.2;
  eng.drive = p.drive ?? 0;
  eng.subLevel = p.subLevel ?? 0;
  eng.subWave = p.subWave ?? "sine";
  eng.setDelay(eng.delayTimeMs, eng.delayFeedback, eng.delayMix);
  eng.setDrive(eng.drive);
  eng.setModLfoParams(eng.modLfoRate, eng.modLfoDepth, eng.modLfoWave, eng.modLfoTarget);
  eng.setWave(p.waveType);
  if (p.waveType === "custom" && !eng.customWave) {
    eng.customWave = eng.buildWave("custom", builtinAnchors("sine"));
  }
  // 硬件模拟(PM 合成)参数
  if (typeof p.dxPm === "boolean") {
    eng.dxPm = p.dxPm; eng.dxLutSize = p.dxLutSize ?? 4096; eng.dxQuantBits = p.dxQuantBits ?? 0;
    eng.dxDac = p.dxDac ?? false; eng.dxBits = p.dxBits ?? 12; eng.dxAa = p.dxAa ?? false;
    eng.dxAlgorithm = p.dxAlgorithm ?? 1; eng.dxFeedback = p.dxFeedback ?? 0;
  }
  if (Array.isArray(p.dxRatios)) eng.dxRatios = [...p.dxRatios];
  if (Array.isArray(p.dxTls)) eng.dxTls = [...p.dxTls];
  if (Array.isArray(p.dxDets)) eng.dxDets = [...p.dxDets];
  if (Array.isArray(p.dxEgs)) eng.dxEgs = [...p.dxEgs];
  if (typeof p.gain === "number") eng.gain = p.gain;
  if (typeof p.noteJitter === "number") eng.noteJitter = p.noteJitter;
  if (typeof p.eqBass === "number") {
    eng.eqBass = p.eqBass; eng.eqMid = p.eqMid ?? 0; eng.eqTreble = p.eqTreble ?? 0;
  }
  eng.sanitizeParams();   // JS 内核层数值限制(旧预设可能存有 0 共振/越界值)
}
export function applyParams(p: ReturnType<typeof captureParams>) {
  applyParamsToEngine(engine, p);
  // 渐变面板同步显示预设槽位(UI)
  if (Array.isArray(p.wtSlots) && p.wtSlots.length >= 2 && p.wtSlots.length <= 16) {
    if (wtBanks[wtBankIdx]) { wtBanks[wtBankIdx].slots = [...p.wtSlots]; refreshWtBankUI(); }
  }
  // 力度曲线(全局输入映射,仅主引擎)
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
  if (p.waveType === "custom") {
    setAnchors(builtinAnchors("sine"));
    engine.setCustomWave(anchors);
    syncGrainWaveFromAnchors();
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
  syncMainToRust();
}

export function loadPresetList() {
  const sel = $id("preset-list") as HTMLSelectElement;
  const cur = sel.value;
  sel.innerHTML = '<option value="">加载预设...</option>';
  // 内置常见预设(带程序号标号)
  const libGroup = document.createElement("optgroup");
  libGroup.label = "内置预设(程序号)";
  PRESET_LIBRARY.forEach((lib) => {
    const opt = document.createElement("option");
    opt.value = "lib:" + lib.program;
    opt.textContent = `${lib.program} ${lib.name}`;
    libGroup.appendChild(opt);
  });
  sel.appendChild(libGroup);
  // 用户保存的预设(读取时自动迁移旧版本格式 → 新格式并写回)
  let raw: unknown[] = [];
  try { raw = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { raw = []; }
  const { list, changed } = migratePresets(raw);
  if (changed) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch { /* ignore */ }
    console.info("预设数据已自动升级到新格式:", list.length, "条");
  }
  if (list.length > 0) {
    const userGroup = document.createElement("optgroup");
    userGroup.label = "我的预设";
    list.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = "u:" + i;
      opt.textContent = (p as { name?: string })?.name ?? "未命名";
      userGroup.appendChild(opt);
    });
    sel.appendChild(userGroup);
  }
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  return list;
}

// 加载内置库预设(程序号标号音色)
export function applyLibraryPreset(lib: LibraryPreset) {
  applyPresetDefToEngine(engine, lib.wave);
  if (lib.p && Object.keys(lib.p).length > 0) {
    applyParams({ ...captureParams(), ...lib.p, waveType: lib.wave } as ReturnType<typeof captureParams>);
  } else {
    setPreset(lib.wave);
  }
  toast(`已加载:程序${lib.program} ${lib.name}`);
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
  const v = (e.target as HTMLSelectElement).value;
  if (!v) return;
  if (v.startsWith("lib:")) {
    const lib = findLibraryPreset(Number(v.slice(4)));
    if (lib) applyLibraryPreset(lib);
    return;
  }
  const i = Number(v.slice(2));
  if (isNaN(i)) return;
  let raw: unknown[] = [];
  try { raw = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return; }
  const { list } = migratePresets(raw);   // 加载前强制迁移(启动未迁移的兜底)
  const p = list[i] as { name: string; params: ReturnType<typeof captureParams> } | undefined;
  if (p && p.params) {
    applyParams(p.params);
    toast("已加载: " + p.name);
  } else {
    toast("预设数据无法识别,已忽略");
  }
});

$id("btn-del-preset").addEventListener("click", () => {
  const sel = $id("preset-list") as HTMLSelectElement;
  const v = sel.value;
  if (!v.startsWith("u:")) { toast("先选择要删除的我的预设"); return; }
  const i = Number(v.slice(2));
  if (isNaN(i)) return;
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
