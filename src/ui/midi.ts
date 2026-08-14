// MIDI 输入/输出:端口选择、CC 控制、程序变更入口
// 发声由 Rust 引擎按通道直通处理(低延迟);本文件负责 UI 显示与音色解析
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { midiHeld, midiOutPort, transPlaying, setMidiOutPort, heldNotes } from "../core/store";
import { updateKeysUI, ledBlink } from "./keyboard";
import { noteName } from "../core/notes";
import { applyProgramToChannel } from "./presets";
import { transcribePlay, transcribeStop } from "./transcribe";
import { getCcAction } from "../core/cc-map";
import { applyCcAction } from "./cc-panel";
import { setMetroBpm } from "./metro";
import { setArpBpm, syncArp } from "./arpeggio";
import { $id, toast } from "./dom";
// tap tempo 状态(未映射按钮型 CC 连续按下 → 定速)
let lastTapCc = 0, lastTapTime = 0, lastDiagToast = 0;
export function handleMidiCC(cc: number, val: number) {
  // ① 用户绑定 / 内置默认映射(旋钮映射选项卡可自定义)
  const action = getCcAction(cc);
  if (action) { applyCcAction(action, val, cc); return; }
  // ② 未映射的按钮型 CC(值≥64):连续两次同 CC 按下(250-2000ms)→ tap tempo 定速
  if (val >= 64) {
    const now = performance.now();
    if (lastTapCc === cc && now - lastTapTime > 250 && now - lastTapTime < 2000) {
      const bpm = 60000 / (now - lastTapTime);
      setMetroBpm(bpm);
      setArpBpm(bpm);
      toast(`Tap BPM: ${Math.round(bpm)}`);
      lastTapTime = 0;
    } else {
      lastTapCc = cc;
      lastTapTime = now;
    }
    // 诊断提示:未映射 CC 显示一次(5 秒去重),便于把键盘按钮精确映射进来
    if (now - lastDiagToast > 5000) {
      toast(`未映射 CC${cc} = ${val}(可在旋钮映射选项卡绑定)`);
      lastDiagToast = now;
    }
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

    // 输入消息:发声已由 Rust 直通(按通道),此处仅 UI 显示 + 程序变更解析
    await listen<number[]>("midi-in", (e) => {
      const d = e.payload;
      if (!d || d.length < 2) return;
      const [status, d1] = d;
      const type = status & 0xf0;
      const ch = status & 0x0f;
      const d2 = d[2] ?? 0;
      if (type === 0x90 && d2 > 0) {
        // 诊断:状态栏显示 MIDI 输入音符与力度(音量太小时可在此发现)
        const st2 = $id("trans-status");
        if (st2 && !transPlaying) {
          st2.textContent = `MIDI 输入: ${noteName(d1)} 力度 ${d2}`;
        }
        midiHeld.set(d1, d1);   // 琴键高亮(音频在 Rust,原始键号)
        heldNotes.add(d1);      // 琶音器音符源(MIDI 键盘/打击垫按住也能琶音)
        syncArp();
        updateKeysUI();
        ledBlink();   // 右上角输入灯(MIDI 输入也闪)
      }
      else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        midiHeld.delete(d1);
        heldNotes.delete(d1);
        syncArp();
        updateKeysUI();
      }
      else if (type === 0xb0) handleMidiCC(d1, d2);   // 控制器消息(UI)
      else if (type === 0xc0) {
        // 程序变更:前端解析音色参数 → 灌入对应通道引擎
        const name = applyProgramToChannel(ch, d1);
        if (name) toast(`MIDI 通道 ${ch + 1} 程序变更 → ${name}`);
      }
      else if (type === 0xe0) {
        // 弯音轮:UI 显示(发声在 Rust 已处理)
        const v14 = (d1 | (d2 << 7)) - 8192;
        const st2 = $id("trans-status");
        if (st2 && !transPlaying) st2.textContent = `弯音 ${(v14 / 8192) * 2 >= 0 ? "+" : ""}${((v14 / 8192) * 2).toFixed(2)} 半音`;
      }
    });
  } catch (err) {
    console.error("MIDI init failed:", err);
    st.textContent = "MIDI: 不可用";
  }
}

// ============ 节拍器 ============
// MIDI 键盘走带按钮(播放/暂停/录制):Rust 识别 MMC 与通用 CC 后转发
listen<string>("midi-transport", (e) => {
  const a = e.payload;
  if (a === "play") { transcribePlay(); }
  else if (a === "stop") { transcribeStop(); }
  else if (a === "record") { ($id("btn-record") as HTMLElement).click(); }
}).catch(() => {});
