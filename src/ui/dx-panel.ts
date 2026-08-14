// 硬件模拟面板(PM/查表/定点/DAC):Rust 引擎实际渲染,本文件维护 TS 镜像参数并推送
import { engine, dbToLin, linToDb, fmtDb, setPmExtFromWave } from "../core/store";
import { ra } from "../core/rust-audio";
import { syncMainToRust } from "./presets";
import { $id, toast } from "./dom";

const $ = <T extends HTMLElement>(id: string) => $id(id) as T;

// ============ 通用开关/滑块 → 引擎镜像 + Rust 单项推送 ============
function bindToggle(id: string, key: string, get: () => boolean, set: (v: boolean) => void) {
  const cb = $id(id) as HTMLInputElement;
  cb.checked = get();
  cb.addEventListener("change", () => {
    set(cb.checked);
    ra.setParam(0, key, cb.checked ? 1 : 0);
  });
}

// ============ 复选框 ============
bindToggle("dx-pm", "dx_pm", () => engine.dxPm, (v) => { engine.dxPm = v; });
// 正弦查表尺寸(0=关,1024/2048/4096/8192)
{
  const sel = $("dx-lut-size") as HTMLSelectElement;
  sel.value = String(engine.dxLutSize);
  sel.addEventListener("change", () => {
    engine.dxLutSize = Number(sel.value);
    ra.setParam(0, "dx_lut_size", engine.dxLutSize);
  });
}
// 定点截断位数(0=关,2/4/8/12/14/16)
{
  const sel = $("dx-quant-bits") as HTMLSelectElement;
  sel.value = String(engine.dxQuantBits);
  sel.addEventListener("change", () => {
    engine.dxQuantBits = Number(sel.value);
    ra.setParam(0, "dx_quant_bits", engine.dxQuantBits);
  });
}
bindToggle("dx-dac", "dx_dac", () => engine.dxDac, (v) => { engine.dxDac = v; });
bindToggle("dx-aa", "dx_aa", () => engine.dxAa, (v) => { engine.dxAa = v; });

// ============ PM 扩展开关(自由调节 PM 合成,不局限于预设音色) ============
// 开启:当前音色切到 PM 合成,算法/反馈/算子参数全部可调,可保存为预设;
// 关闭:恢复开启前的音色。加载 PM 类预设(金属钟/风琴/电钢等)时自动开启。
const pmExt = $("pm-ext") as HTMLInputElement;
let savedWaveType = engine.waveType;
pmExt.addEventListener("change", () => {
  if (pmExt.checked) {
    savedWaveType = engine.waveType;
    engine.waveType = "dx7";
    engine.dxPm = true;
    const dxPmEl = $("dx-pm") as HTMLInputElement;
    dxPmEl.checked = true;
    syncMainToRust();
    toast("PM 扩展:开(自由调节算法/反馈/算子,可保存为预设)");
  } else {
    engine.waveType = savedWaveType;
    syncMainToRust();
    toast("PM 扩展:关,已恢复原音色");
  }
  setPmExtFromWave(engine.waveType);   // 同步控件禁用状态
});
setPmExtFromWave(engine.waveType);     // 初始化:非 PM 音色禁用硬件模拟控件

// ============ 算法 / 反馈 / 扰动 / 增益 ============
// 直接按滑块真实量程映射(避免通用映射把 0-7 档变成浮点)
const algSel = $("dx-algorithm") as HTMLSelectElement;
algSel.value = String(engine.dxAlgorithm);
algSel.addEventListener("change", () => {
  engine.dxAlgorithm = Number(algSel.value);
  ra.setParam(0, "dx_algorithm", engine.dxAlgorithm);
  // 算法只影响 PM 合成音色;其他音色调节无听感变化,明确提示
  if (engine.waveType !== "dx7") {
    toast("算法仅对 PM 合成音色生效,请先开启 PM 扩展");
  }
});

// OP6 反馈(0-7 整数档)
const fbEl = $("dx-feedback") as HTMLInputElement;
fbEl.value = String(engine.dxFeedback);
const fbSync = () => {
  engine.dxFeedback = Math.round(Number(fbEl.value));
  ra.setParam(0, "dx_feedback", engine.dxFeedback);
  $id("dx-feedback-val").textContent = String(engine.dxFeedback);
};
fbEl.addEventListener("input", fbSync);
fbSync();

// NoteOn 随机扰动(0-100%)
const njEl = $("note-jitter") as HTMLInputElement;
njEl.value = String(Math.round(engine.noteJitter * 100));
const njSync = () => {
  engine.noteJitter = Number(njEl.value) / 100;
  ra.setParam(0, "note_jitter", engine.noteJitter);
  $id("note-jitter-val").textContent = Math.round(engine.noteJitter * 100) + "%";
};
njEl.addEventListener("input", njSync);
njSync();

// 增益(-24..+6 dB)
const gEl = $("gain") as HTMLInputElement;
gEl.value = String(Math.round(linToDb(engine.gain)));
const gSync = () => {
  engine.gain = dbToLin(Number(gEl.value));
  ra.setParam(0, "gain", engine.gain);
  $id("gain-val").textContent = fmtDb(Number(gEl.value));
};
gEl.addEventListener("input", gSync);
gSync();

// DAC 量化位数(8/12/16)
const bitsSel = $("dx-bits") as HTMLSelectElement;
bitsSel.value = String(engine.dxBits);
bitsSel.addEventListener("change", () => {
  engine.dxBits = Number(bitsSel.value);
  ra.setParam(0, "dx_bits", engine.dxBits);
});

// ============ 采样率切换(重建音频引擎) ============
const srSel = $("sample-rate") as HTMLSelectElement;
srSel.addEventListener("change", async () => {
  const hz = Number(srSel.value);
  try {
    await ra.setSampleRate(hz);
    toast(`采样率已切换: ${hz} Hz`);
  } catch (e) {
    toast("采样率切换失败: " + String(e).slice(0, 50));
  }
});

// ============ 硬件模拟预设(参考参数 + 经典) ============

