// 旋钮映射选项卡:CC → 参数动作,用户自定义绑定 + 动作执行器
import { engine } from "../core/store";
import { ra } from "../core/rust-audio";
import { CC_ACTIONS, loadCcMap, saveCcMap } from "../core/cc-map";
import { $id, toast } from "./dom";
import { shiftOctave } from "./keyboard";
import { arpToggleFromMidi } from "./arpeggio";

// ============ 动作执行器(统一入口:midi.ts 与映射面板共用) ============
// 状态条显示(琴键上方,平滑)
let linkTimer: number | null = null;
export function showLinkStatus(msg: string) {
  const el = $id("midi-link-status");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("on");
  if (linkTimer) window.clearTimeout(linkTimer);
  linkTimer = window.setTimeout(() => el.classList.remove("on"), 1400);
}

function setSlider(id: string, value: string, label: string) {
  const s = $id(id) as HTMLInputElement | null;
  if (s) s.value = value;
  const v = $id(id + "-val") as HTMLElement | null;
  if (v) v.textContent = label;
}

// 调制 LFO:目标为"关"时自动切到滤波截止(否则改深度无听感变化)
function ensureModTarget() {
  if (engine.modLfoTarget === "off") {
    engine.modLfoTarget = "cutoff";
    const mt = $id("ml-target") as HTMLSelectElement | null;
    if (mt) mt.value = "cutoff";
    showLinkStatus("调制目标:滤波(自动)");
  }
}

export function applyCcAction(action: string, val: number, cc: number) {
  const v = val / 127;
  switch (action) {
    case "sustain": {
      ra.setSustain(0, val >= 64);
      const led = $id("sustain-led"); if (led) led.classList.toggle("on", val >= 64);
      const kled = $id("kbd-sustain-led"); if (kled) kled.classList.toggle("on", val >= 64);
      const kst = $id("kbd-status"); if (kst) kst.classList.toggle("on", val >= 64);
      toast(val >= 64 ? "延音踏板:开" : "延音踏板:关");
      return;
    }
    case "chord_hold":
      ra.setSustain(0, val >= 64);
      toast(val >= 64 ? "和弦保持:开" : "和弦保持:关");
      return;
    case "mod_depth": {
      ensureModTarget();
      engine.modLfoDepth = v;
      setSlider("ml-depth", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      ra.setParam(0, "mod_lfo_depth", engine.modLfoDepth);
      showLinkStatus(`调制深度: ${Math.round(v * 100)}%`);
      return;
    }
    case "cutoff": {
      const cut = Math.round(50 + v * (16000 - 50));
      engine.cutoffHz = cut;
      ra.setParam(0, "cutoff_hz", cut);
      setSlider("sp-cutoff", String(cut), cut + "Hz");
      showLinkStatus(`滤波: ${cut}Hz`);
      return;
    }
    case "resonance": {
      const res = v * 20;
      engine.resonanceQ = res;
      ra.setParam(0, "resonance_q", res);
      setSlider("sp-resonance", String(Math.round(res * 100)), res.toFixed(1));
      showLinkStatus(`谐振: ${res.toFixed(1)}`);
      return;
    }
    case "attack": {
      const ms = Math.round(v * 2000);
      engine.attack = ms / 1000;
      ra.setParam(0, "attack", engine.attack);
      setSlider("attack", String(ms), ms + "ms");
      showLinkStatus(`起音: ${ms}ms`);
      return;
    }
    case "decay": {
      const ms = Math.round(v * 2000);
      engine.decay = ms / 1000;
      ra.setParam(0, "decay", engine.decay);
      setSlider("decay", String(ms), ms + "ms");
      showLinkStatus(`衰减: ${ms}ms`);
      return;
    }
    case "sustain_level": {
      engine.sustain = v;
      ra.setParam(0, "sustain", engine.sustain);
      setSlider("sustain", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      showLinkStatus(`延音电平: ${Math.round(v * 100)}%`);
      return;
    }
    case "release": {
      const ms = Math.round(v * 3000);
      engine.release = ms / 1000;
      ra.setParam(0, "release", engine.release);
      setSlider("release", String(ms), ms + "ms");
      showLinkStatus(`释放: ${ms}ms`);
      return;
    }
    case "reverb": {
      ra.setMaster("reverb", v);
      setSlider("reverb", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      showLinkStatus(`混响: ${Math.round(v * 100)}%`);
      return;
    }
    case "delay_mix": {
      ra.setMaster("delay_mix", v);
      setSlider("delay-mix", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      showLinkStatus(`延迟混合: ${Math.round(v * 100)}%`);
      return;
    }
    case "delay_feedback": {
      ra.setMaster("delay_feedback", v);
      setSlider("delay-feedback", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      showLinkStatus(`延迟反馈: ${Math.round(v * 100)}%`);
      return;
    }
    case "drive": {
      ra.setMaster("drive", v);
      setSlider("drive", String(Math.round(v * 100)), Math.round(v * 100) + "%");
      showLinkStatus(`驱动: ${Math.round(v * 100)}%`);
      return;
    }
    case "volume": {
      const db = -24 + v * 30;
      const lin = Math.pow(10, db / 20);
      ra.setMaster("volume", lin);
      engine.volume = lin;
      setSlider("volume", String(Math.round(db)), (db >= 0 ? "+" : "") + Math.round(db) + "dB");
      showLinkStatus(`主增益: ${db >= 0 ? "+" : ""}${Math.round(db)}dB`);
      return;
    }
    case "gain": {
      const g = v * 2;
      ra.setParam(0, "gain", g);
      engine.gain = g;
      showLinkStatus(`引擎增益: ${g.toFixed(2)}`);
      return;
    }
    case "pan": {
      const p = v * 2 - 1;
      ra.setParam(0, "pan", p);
      engine.pan = p;
      setSlider("pan", String(Math.round(p * 100)), Math.round(p * 100) + "%");
      showLinkStatus(`声像: ${Math.round(p * 100)}%`);
      return;
    }
    case "vib_rate": {
      const r = v * 10;
      ra.setParam(0, "vibrato_rate", r);
      engine.vibratoRate = r;
      showLinkStatus(`颤音速率: ${r.toFixed(1)}Hz`);
      return;
    }
    case "vib_depth": {
      const d = v * 0.1;
      ra.setParam(0, "vibrato_depth", d);
      engine.vibratoDepth = d;
      showLinkStatus(`颤音深度: ${Math.round(v * 100)}%`);
      return;
    }
    case "oct_up":
      if (val >= 64) shiftOctave(1);
      return;
    case "oct_down":
      if (val >= 64) shiftOctave(-1);
      return;
    case "arp_toggle":
      if (val > 0) arpToggleFromMidi(cc);
      return;
    default:
      return;
  }
}

// ============ 映射面板 UI ============
const actionSel = $id("ccmap-action") as HTMLSelectElement;
actionSel.innerHTML = Object.entries(CC_ACTIONS)
  .map(([k, name]) => `<option value="${k}">${name}</option>`)
  .join("");

function renderCcMapList() {
  const list = $id("ccmap-list");
  const m = loadCcMap();
  const entries = Object.entries(m).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) {
    list.innerHTML = '<div class="vel-hint">暂无自定义绑定。选择 CC 号和动作后点「绑定」(绑定优先于内置映射)。</div>';
    return;
  }
  list.innerHTML = entries.map(([cc, act]) =>
    `<div class="map-row">
      <span class="map-prog">CC ${cc}</span>
      <span class="map-name">→ ${CC_ACTIONS[act] ?? act}</span>
      <button class="tool-btn map-del" data-cc="${cc}">解绑</button>
    </div>`
  ).join("");
  list.querySelectorAll(".map-del").forEach((b) => {
    b.addEventListener("click", () => {
      const m2 = loadCcMap();
      delete m2[Number((b as HTMLElement).dataset.cc)];
      saveCcMap(m2);
      renderCcMapList();
      toast("已解绑");
    });
  });
}

$id("btn-ccmap-add").addEventListener("click", () => {
  const cc = Math.round(Number(($id("ccmap-cc") as HTMLInputElement).value));
  if (isNaN(cc) || cc < 0 || cc > 127) { toast("CC 号需在 0-127"); return; }
  const act = actionSel.value;
  const m = loadCcMap();
  m[cc] = act;
  saveCcMap(m);
  renderCcMapList();
  toast(`已绑定:CC ${cc} → ${CC_ACTIONS[act]}`);
});

renderCcMapList();
