// 转录:SMF 播放(虚拟按键)、简谱渲染、录音转录
import { invoke } from "@tauri-apps/api/core";
import { engine, transState, midiRec, transPlaying, playNotes, setTransPlaying } from "../core/store";
import { parseSmf } from "../core/smf";
import type { SmfNote } from "../core/smf";
import { midiToJianpu, jpDuration, velLabel } from "../core/notes";
import { playNoteOn, playNoteOff, updateKeysUI } from "./keyboard";
import { handleMidiProgramChange } from "./presets";
import { $id, toast } from "./dom";
export function renderTranscription() {
  const el = $id("trans-output");
  if (transState.mode === "file" && transState.smf) {
    renderSmfJianpu(transState.smf, el);
    return;
  }
  // 录音流程:按时间轴渲染(单轨)
  if (transState.notes.length === 0) { el.textContent = ""; return; }
  const sorted = [...transState.notes].sort((a, b) => a.t - b.t);
  const groups: { t: number; items: { note: number; vel: number }[] }[] = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && n.t - last.t < 30) last.items.push({ note: n.note, vel: n.vel });
    else groups.push({ t: n.t, items: [{ note: n.note, vel: n.vel }] });
  }
  const lines: string[] = [];
  let line: string[] = [];
  let prevT: number | null = null;
  for (const g of groups) {
    const jp = g.items.length === 1
      ? midiToJianpu(g.items[0].note) + jpDuration(prevT === null ? 0 : (g.t - prevT) / 500) + "·" + velLabel(g.items[0].vel)
      : "(" + g.items.map((i) => midiToJianpu(i.note)).join(" ") + ")·" + velLabel(g.items[0].vel);
    line.push(jp);
    prevT = g.t;
    if (line.length >= 10) { lines.push(line.join("  ")); line = []; }
  }
  if (line.length) lines.push(line.join("  "));
  el.textContent = lines.join("\n");
}

// 文件简谱:多轨独立渲染,小节线按拍号,休止符补空拍
export function renderSmfJianpu(smf: NonNullable<typeof transState.smf>, el: HTMLElement) {
  if (smf.notes.length === 0) { el.textContent = "文件中没有音符事件"; return; }
  const bpm = Math.round(60000000 / smf.usPerQuarter);
  const sorted = [...smf.notes].sort((a, b) => a.tick - b.tick);
  const endTick = sorted.reduce((m, n) => Math.max(m, n.tick + n.dur), 0);
  const totalSec = (endTick / smf.division) * (smf.usPerQuarter / 1e6);
  // 按轨道分组
  const tracks = new Map<number, SmfNote[]>();
  for (const n of sorted) {
    if (!tracks.has(n.track)) tracks.set(n.track, []);
    tracks.get(n.track)!.push(n);
  }
  const parts: string[] = [];
  parts.push(`文件 ${transState.fileName} · ${bpm} BPM · ${smf.beatsPerBar} 拍/小节 · ${smf.notes.length} 音符 · ${tracks.size} 轨 · 时长 ${totalSec.toFixed(1)}s`);
  parts.push("=".repeat(46));
  for (const [tr, notes] of [...tracks.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`轨道 ${tr + 1}(${notes.length} 音符):`);
    const trSorted = [...notes].sort((a, b) => a.tick - b.tick);
    // 同 tick 合并为和弦
    const groups: { tick: number; items: SmfNote[] }[] = [];
    for (const n of trSorted) {
      const last = groups[groups.length - 1];
      if (last && n.tick - last.tick < 10) last.items.push(n);
      else groups.push({ tick: n.tick, items: [n] });
    }
    let line = "";
    let barBeats = 0;          // 当前小节累计拍数
    let prevTick = 0;
    const pushBar = () => { line = line.trimEnd(); line += " | "; barBeats = 0; };
    line = "| ";
    for (const g of groups) {
      // 补休止:前一个音符结束到本音符开始之间的空拍
      const gapTicks = g.tick - prevTick;
      if (gapTicks > 0 && groups.indexOf(g) > 0) {
        let gapBeats = gapTicks / smf.division;
        while (gapBeats >= 0.25) {
          const r = gapBeats >= 3.5 ? 4 : gapBeats >= 1.5 ? 2 : gapBeats >= 0.75 ? 1 : gapBeats >= 0.375 ? 0.5 : 0.25;
          line += "0" + jpDuration(r) + " ";
          barBeats += r;
          gapBeats -= r;
          while (barBeats >= smf.beatsPerBar) pushBar();
        }
      }
      // 本组音符:时值取第一个音的时长
      const durBeats = Math.max(0.25, g.items[0].dur / smf.division);
      const jp = g.items.length === 1
        ? midiToJianpu(g.items[0].note) + jpDuration(durBeats)
        : "(" + g.items.map((i) => midiToJianpu(i.note)).join(" ") + ")" + jpDuration(durBeats);
      line += jp + " ";
      barBeats += durBeats;
      while (barBeats >= smf.beatsPerBar) pushBar();
      prevTick = g.tick + g.items[0].dur;
    }
    // 结尾补齐休止到小节线
    while (barBeats < smf.beatsPerBar && barBeats > 0) {
      line += "0 ";
      barBeats += 1;
    }
    line = line.trimEnd() + " |";
    parts.push(line);
    parts.push("");
  }
  el.textContent = parts.join("\n");
}

// ============ 标准 MIDI 文件(SMF)解析 ============
$id("btn-trans-open").addEventListener("click", async () => {
  try {
    const [b64, name] = await invoke<[string, string]>("open_midi");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = parseSmf(bytes);
    transState.smf = parsed;
    transState.fileName = name;
    transState.notes = [];
    const bpm = Math.round(60000000 / parsed.usPerQuarter);
    $id("trans-status").textContent =
      `已加载 ${name} · ${bpm} BPM · ${parsed.ntrks} 轨 · ${parsed.notes.length} 音符 — 点播放(虚拟按键演奏)`;
    $id("trans-status").classList.add("on");
    renderTranscription();   // 同时显示简谱
  } catch (err) {
    if (String(err).includes("已取消")) return;
    $id("trans-status").textContent = "打开失败: " + String(err).slice(0, 60);
    $id("trans-status").classList.remove("on");
  }
});

// 播放:按每轨音色用 AudioContext 时钟调度 + UI 实时跟随(琴键/LED)
export let playProgTimer = 0;   // 播放进度定时器
export let playUiTimers: number[] = [];

export function playUiCleanup() {
  for (const t of playUiTimers) window.clearTimeout(t);
  playUiTimers = [];
  playNotes.clear();
  updateKeysUI();
}

// 虚拟按键:与键盘输入完全一致的播放路径(跳过力度曲线,用 MIDI 原始力度)

$id("btn-trans-play").addEventListener("click", async () => {
  if (!transState.smf || transState.smf.notes.length === 0) {
    toast("请先打开 MIDI 文件");
    return;
  }
  if (transPlaying) return;
  const smf = transState.smf;
  await engine.resume();
  engine.allOff();
  playUiCleanup();
  // 生成按键事件流:所有轨道音符合并,按时间排序(不做音色/轨道区分)
  const events: { t: number; on: boolean; midi: number; vel: number; program?: number }[] = [];
  for (const n of smf.notes) {
    events.push({ t: n.tick, on: true, midi: n.note, vel: Math.max(1, Math.round(n.vel)) });
    events.push({ t: n.tick + n.dur, on: false, midi: n.note, vel: 0 });
  }
  // 程序变更事件:播放到该时刻自动切换音色(后续音符用新音色)
  for (const pc of smf.programChanges) {
    events.push({ t: pc.tick, on: false, midi: 0, vel: 0, program: pc.program });
  }
  events.sort((a, b) => a.t - b.t);
  const secPerTick = (smf.usPerQuarter / 1e6) / smf.division;
  const endTick = events[events.length - 1].t;
  const totalSec = endTick * secPerTick;
  const fmt = (s: number) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const totalStr = fmt(totalSec);
  // 启动:300ms 后开始"按键"
  const startWall = performance.now() + 300;
  setTransPlaying(true);
  $id("btn-trans-play").classList.add("running");
  $id("trans-status").textContent = `播放中 00:00 / ${totalStr}`;
  let idx = 0;
  const drive = () => {
    if (!transPlaying) return;
    const el = (performance.now() - startWall) / 1000;
    // 触发所有到期按键(模拟键盘输入)
    while (idx < events.length && events[idx].t * secPerTick <= el) {
      const ev = events[idx++];
      if (ev.program !== undefined) handleMidiProgramChange(ev.program);
      else if (ev.on) playNoteOn(ev.midi, ev.vel / 127);
      else playNoteOff(ev.midi);
    }
    $id("trans-status").textContent = `播放中 ${fmt(Math.max(0, el))} / ${totalStr}`;
    if (el < totalSec + 0.4) {
      requestAnimationFrame(drive);
    } else {
      setTransPlaying(false);
      $id("btn-trans-play").classList.remove("running");
      $id("trans-status").textContent = "播放完成";
      engine.allOff();
      updateKeysUI();
    }
  };
  requestAnimationFrame(drive);
});

// 停止播放
$id("btn-trans-stop").addEventListener("click", () => {
  engine.allOff();
  setTransPlaying(false);
  if (playProgTimer) { window.clearInterval(playProgTimer); playProgTimer = 0; }
  $id("btn-trans-play").classList.remove("running");
  $id("trans-status").textContent = "已停止";
  playUiCleanup();
});

$id("btn-trans-clear").addEventListener("click", () => {
  engine.allOff();
  transState.notes = [];
  transState.smf = null;
  transState.fileName = "";
  $id("trans-output").textContent = "";
  $id("trans-status").textContent = "已清空";
  $id("trans-status").classList.remove("on");
});

// 录音转录(录音选项卡):从录音的 MIDI 事件转简谱
$id("btn-trans-flow").addEventListener("click", transcribeFlow);
export function transcribeFlow() {
  const evs = midiRec.events.filter((e) => e.on);
  const out = $id("rec-output");
  if (evs.length === 0) {
    out.textContent = "没有录到音符,请先录音并弹奏";
    return;
  }
  transState.notes = evs.map((e) => ({ note: e.note, vel: e.vel, t: e.t }));
  transState.t0 = 0;
  renderTranscription();
  out.textContent = $id("trans-output").textContent;
  $id("trans-status").textContent = "录音转录:完成(" + evs.length + " 个音符)";
  $id("trans-status").classList.add("on");
}

// ============ 演奏调度(统一入口:键盘/鼠标/MIDI 都走这) ============
