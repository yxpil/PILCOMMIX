// MIDI 输入/输出:端口选择、CC 控制、程序变更入口
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { octaveShift, midiHeld, engine, midiOutPort, transPlaying, setMidiOutPort } from "../core/store";
import { noteOn, noteOff, shiftOctave } from "./keyboard";
import { noteName } from "../core/notes";
import { handleMidiProgramChange } from "./presets";
import { $id, toast } from "./dom";
export function handleMidiCC(cc: number, val: number) {
  // 延音踏板(CC64):指示灯同步
  if (cc === 64) {
    engine.setSustain(val >= 64);
    $id("sustain-led").classList.toggle("on", val >= 64);
    return;
  }
  if (cc === 14 || cc === 15 || cc === 26 || cc === 27) {
    shiftOctave(cc === 15 || cc === 27 ? 1 : -1);
    toast(`MIDI 八度: ${noteName(48 + octaveShift * 12)}`);
    return;
  }
  if (cc === 1 || cc === 74 || cc === 91) {
    const v = val / 127;
    engine.setReverb(v);
    const slider = $id("reverb") as HTMLInputElement;
    slider.value = String(Math.round(v * 100));
    $id("reverb-val").textContent = Math.round(v * 100) + "%";
  }
}

export async function initMidi() {
  const st = $id("midi-status");
  try {
    const [inputs, outputs] = await invoke<[string[], string[]]>("midi_list_devices");
    st.textContent = inputs.length ? `MIDI: 就绪(${inputs.length} 输入)` : "MIDI: 就绪(无输入)";
    st.classList.toggle("on", inputs.length > 0);

    // 输入端口选择器(音源机/外接键盘场景:选哪个口监听)
    const inSel = $id("midi-in") as HTMLSelectElement;
    inSel.innerHTML = '<option value="">无(仅电脑键盘)</option>';
    inputs.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = name;
      inSel.appendChild(opt);
    });
    // 自动连接第一个输入端
    if (inputs.length > 0) {
      inSel.value = "0";
      await invoke("midi_start_input", { port: 0 });
      st.textContent = `MIDI: 已连接(${inputs[0]})`;
      st.classList.add("on");
      toast("MIDI 输入: " + inputs[0]);
    }
    inSel.addEventListener("change", async () => {
      try { await invoke("midi_stop_input"); } catch { /* 未连接 */ }
      const v = inSel.value;
      if (v === "") {
        st.textContent = "MIDI: 未连接";
        st.classList.remove("on");
        toast("MIDI 输入已关闭");
        return;
      }
      const name = await invoke<string>("midi_start_input", { port: Number(v) }).catch(() => "");
      st.textContent = name ? `MIDI: 已连接(${name})` : "MIDI: 连接失败";
      st.classList.toggle("on", !!name);
      toast(name ? "MIDI 输入: " + name : "MIDI 输入连接失败");
    });

    // 输出下拉
    const sel = $id("midi-out") as HTMLSelectElement;
    sel.innerHTML = '<option value="">无(仅内部发声)</option>';
    outputs.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      setMidiOutPort(sel.value === "" ? null : Number(sel.value));
      toast(midiOutPort !== null
        ? `MIDI 输出: ${outputs[midiOutPort] ?? ""}`
        : "MIDI 输出已关闭");
    });

    // 输入消息:note on/off + CC 控制
    await listen<number[]>("midi-in", (e) => {
      const d = e.payload;
      if (!d || d.length < 3) return;
      const [status, d1, d2] = d;
      const type = status & 0xf0;
      if (type === 0x90 && d2 > 0) {
        // 诊断:状态栏显示 MIDI 输入音符与力度(音量太小时可在此发现)
        const st2 = $id("trans-status");
        if (st2 && !transPlaying) {
          st2.textContent = `MIDI 输入: ${noteName(d1 + octaveShift * 12)} 力度 ${d2}`;
        }
        midiHeld.set(d1, d1 + octaveShift * 12);   // 记录移调后键号,八度变化不卡音
        noteOn(d1 + octaveShift * 12, d2 / 127);   // 力度 0-127 → 0-1
      }
      else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        const m = midiHeld.get(d1);
        if (m !== undefined) { midiHeld.delete(d1); noteOff(m); }
      }
      else if (type === 0xb0) handleMidiCC(d1, d2);   // 控制器消息
      else if (type === 0xc0) handleMidiProgramChange(d1);   // 程序变更(音色切换)
      else if (type === 0xe0) {
        // 弯音轮:14 位,中心 8192,±2 半音
        const v14 = (d1 | (d2 << 7)) - 8192;
        engine.setBend((v14 / 8192) * 2);
      }
    });
  } catch (err) {
    console.error("MIDI init failed:", err);
    st.textContent = "MIDI: 不可用";
  }
}

// ============ 节拍器 ============
