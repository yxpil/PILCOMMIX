// 渐变(波表形态)面板:渐变组管理、槽位编辑、形态 LFO
import { engine, wtBanks, wtBankIdx, wtSaveBanks, DEFAULT_WT_BANKS, setWtBankIdx, PRESET_KEY } from "../core/store";
import { WT_SLOT_OPTIONS, WT_SLOT_OPTION_NAMES } from "../core/wave";
import { drawWave, setWtDrawing, wtDrawing } from "./wave-editor";
import { bindSlider } from "./panel";
import { $id, toast } from "./dom";
export function refreshWtUI() {
  ($id("wt-pos") as HTMLInputElement).value = String(Math.round(engine.wtPos * 100));
  $id("wt-pos-val").textContent = Math.round(engine.wtPos * 100) + "%";
  ($id("wt-lfo-rate") as HTMLInputElement).value = String(Math.round(engine.wtLfoRate * 100));
  $id("wt-lfo-rate-val").textContent = engine.wtLfoRate.toFixed(1) + "Hz";
  ($id("wt-lfo-depth") as HTMLInputElement).value = String(Math.round(engine.wtLfoDepth * 100));
  $id("wt-lfo-depth-val").textContent = Math.round(engine.wtLfoDepth * 100) + "%";
  $id("wave-hint").textContent = engine.waveType === "wt"
    ? "波表模式:波形曲线 = 当前形态混合 · 竖线 = 形态位置 · 分界线 = 槽位边界"
    : "按住拖动画波形 · 拖锚点微调 · 右键删除锚点";
  wtLfoSync();
}
// 形态位置应用到所有活跃 WT 音符
export function applyWtToVoices() {
  for (const gains of engine.wtVoiceMap.values()) engine.wtSlotWeights(engine.currentWtPos(), gains, 0, true);
}
// 形态 LFO 循环:rAF 驱动,实时更新活跃音符的槽位增益 + 画布预览
export let wtLfoRaf = 0;
export function wtLfoLoop() {
  if (engine.waveType !== "wt" || engine.wtLfoDepth <= 0 || engine.wtLfoRate <= 0) { wtLfoRaf = 0; return; }
  if (engine.wtVoiceMap.size > 0) applyWtToVoices();
  drawWave();
  wtLfoRaf = requestAnimationFrame(wtLfoLoop);
}
export function wtLfoStart() { if (!wtLfoRaf) wtLfoRaf = requestAnimationFrame(wtLfoLoop); }
export function wtLfoStop() { if (wtLfoRaf) { cancelAnimationFrame(wtLfoRaf); wtLfoRaf = 0; } }
export function wtLfoSync() {
  if (engine.waveType === "wt" && engine.wtLfoDepth > 0 && engine.wtLfoRate > 0) wtLfoStart();
  else wtLfoStop();
}
bindSlider("wt-pos", (v) => { engine.wtPos = v / 100; applyWtToVoices(); drawWave(); }, (v) => v + "%");
bindSlider("wt-lfo-rate", (v) => { engine.wtLfoRate = v / 100; wtLfoSync(); }, (v) => (v / 100).toFixed(1) + "Hz");
bindSlider("wt-lfo-depth", (v) => { engine.wtLfoDepth = v / 100; wtLfoSync(); applyWtToVoices(); drawWave(); }, (v) => v + "%");

// 渐变组管理:切换/编辑槽位 → 引擎波表重建
export function wtSetBank(i: number) {
  setWtBankIdx(Math.min(wtBanks.length - 1, Math.max(0, i)));
  engine.wtSlots = [...wtBanks[wtBankIdx].slots];
  engine.markWtDirty();
  refreshWtBankUI();
  drawWave();
}
export function refreshWtBankUI() {
  const row = $id("wt-banks");
  row.innerHTML = "";
  wtBanks.forEach((b, i) => {
    const btn = document.createElement("button");
    btn.className = "preset-btn" + (i === wtBankIdx ? " active" : "");
    btn.textContent = b.name;
    btn.addEventListener("click", () => wtSetBank(i));
    row.appendChild(btn);
  });
  // 槽位编辑器(8 个下拉,即时生效)
  const grid = $id("wt-slot-grid");
  grid.innerHTML = "";
  engine.wtSlots.forEach((slot, i) => {
    const cell = document.createElement("div");
    cell.className = "sp-item";
    const lab = document.createElement("label");
    lab.textContent = "槽位 " + (i + 1);
    const sel = document.createElement("select");
    // 槽位选项 = 内置波形 + 用户预设(实时读取,预设保存/删除后自动出现)
    for (const opt of WT_SLOT_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = WT_SLOT_OPTION_NAMES[opt] ?? opt;
      sel.appendChild(o);
    }
    let presetNames: string[] = [];
    try {
      presetNames = (JSON.parse(localStorage.getItem(PRESET_KEY) || "[]") as { name: string }[]).map((p) => p.name);
    } catch { presetNames = []; }
    if (presetNames.length > 0) {
      const sep = document.createElement("option");
      sep.disabled = true;
      sep.textContent = "──── 用户预设 ────";
      sel.appendChild(sep);
      for (const name of presetNames) {
        const o = document.createElement("option");
        o.value = "preset:" + name;
        o.textContent = "预设·" + name;
        sel.appendChild(o);
      }
    }
    // 当前槽位若不在选项里(如预设被删),补一个占位项避免显示错位
    if (![...sel.options].some((o) => o.value === slot)) {
      const o = document.createElement("option");
      o.value = slot;
      o.textContent = slot.startsWith("preset:") ? "预设·" + slot.slice(7) : slot;
      sel.appendChild(o);
    }
    sel.value = slot;
    sel.addEventListener("change", () => {
      wtBanks[wtBankIdx].slots[i] = sel.value;
      engine.wtSlots = [...wtBanks[wtBankIdx].slots];
      engine.markWtDirty();
      wtSaveBanks();
      drawWave();
    });
    cell.appendChild(lab);
    cell.appendChild(sel);
    grid.appendChild(cell);
  });
  refreshWtSlotCount();
}

// 槽位数自定义(2-16):增加复制末槽(波形连续),减少截断
function refreshWtSlotCount() {
  $id("wt-slot-count").textContent = String(engine.wtSlots.length);
}
$id("wt-slot-plus").addEventListener("click", () => {
  const cur = wtBanks[wtBankIdx];
  if (cur.slots.length >= 16) { toast("最多 16 个槽位"); return; }
  cur.slots.push(cur.slots[cur.slots.length - 1] ?? "sine");
  engine.wtSlots = [...cur.slots];
  engine.markWtDirty();
  wtSaveBanks();
  refreshWtBankUI();
  drawWave();
});
$id("wt-slot-minus").addEventListener("click", () => {
  const cur = wtBanks[wtBankIdx];
  if (cur.slots.length <= 2) { toast("至少 2 个槽位(两音色交替)"); return; }
  cur.slots.pop();
  engine.wtSlots = [...cur.slots];
  engine.markWtDirty();
  wtSaveBanks();
  refreshWtBankUI();
  drawWave();
});
// 画自定义波形:进入绘制态(渐变模式下画布显示锚点曲线)
$id("btn-wt-draw").addEventListener("click", () => setWtDrawing(!wtDrawing));
$id("wt-bank-add").addEventListener("click", () => {
  if (wtBanks.length >= 8) { toast("最多 8 组渐变"); return; }
  wtBanks.push({ name: "渐变 " + (wtBanks.length + 1), slots: [...DEFAULT_WT_BANKS[wtBanks.length % DEFAULT_WT_BANKS.length].slots] });
  wtSaveBanks();
  wtSetBank(wtBanks.length - 1);
});
$id("wt-bank-del").addEventListener("click", () => {
  if (wtBanks.length <= 1) { toast("至少保留 1 组渐变"); return; }
  wtBanks.splice(wtBankIdx, 1);
  wtSaveBanks();
  wtSetBank(Math.min(wtBankIdx, wtBanks.length - 1));
});
refreshWtUI();
refreshWtBankUI();

