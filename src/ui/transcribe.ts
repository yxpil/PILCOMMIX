// 转录:SMF 播放(Rust 采样级调度)、简谱渲染、录音转录
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { transState, midiRec, transPlaying, playNotes, setTransPlaying, captureParams } from "../core/store";
import { parseSmf } from "../core/smf";
import type { SmfNote } from "../core/smf";
import { midiToJianpu, jpDuration, velLabel } from "../core/notes";
import { updateKeysUI, ledBlink } from "./keyboard";
import { applyProgramToChannel, setAutoMatch, autoMatchEnabled } from "./presets";
import { ra, bytesToBase64 } from "../core/rust-audio";
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
    transState.smfBytes = bytes;   // 播放走 Rust(采样级),保留原始字节
    transState.fileName = name;
    transState.notes = [];
    const bpm = Math.round(60000000 / parsed.usPerQuarter);
    const nCh = new Set([...parsed.notes.map((n) => n.ch), ...parsed.programChanges.map((p) => p.ch)]).size;
    $id("trans-status").textContent =
      `已加载 ${name} · ${bpm} BPM · ${parsed.ntrks} 轨 ${nCh} 通道 · ${parsed.notes.length} 音符 — 点播放(多音色合成)`;
    $id("trans-status").classList.add("on");
    renderTranscription();   // 同时显示简谱
  } catch (err) {
    if (String(err).includes("已取消")) return;
    $id("trans-status").textContent = "打开失败: " + String(err).slice(0, 60);
    $id("trans-status").classList.remove("on");
  }
});

// 播放:Rust 采样级调度(每通道引擎分身,多音色),前端只做音色解析与进度显示
export let playProgTimer = 0;   // 播放进度定时器
export let playUiTimers: number[] = [];
let pcTimers: number[] = [];    // 程序变更定时器

export function playUiCleanup() {
  for (const t of playUiTimers) window.clearTimeout(t);
  playUiTimers = [];
  for (const t of pcTimers) window.clearTimeout(t);
  pcTimers = [];
  playNotes.clear();
  updateKeysUI();
}

// 播放:可被界面按钮 / MIDI 走带按钮(MIDI 键盘 transport)调用
export async function transcribePlay() {
  if (!transState.smf || !transState.smfBytes || transState.smf.notes.length === 0) {
    toast("请先打开 MIDI 文件");
    return;
  }
  if (transPlaying) return;
  const smf = transState.smf;
  await ra.audioStart().catch(() => {});
  ra.smfStop();
  playUiCleanup();
  // 各通道继承当前主引擎参数(引擎分身语义)
  const usedChs = new Set([...smf.notes.map((n) => n.ch), ...smf.programChanges.map((pc) => pc.ch)]);
  const chList = [...usedChs];
  for (const ch of chList) ra.setEngineParams(ch, captureParams());
  // 补齐音量差距:按各通道音色实际响度探针归一(最响通道 1x,其余按比例放大,防炸基础 0.5)
  if (($id("loudness-match") as HTMLInputElement).checked) {
    const rms = await Promise.all(chList.map(async (ch) => {
      try { return await invoke<number>("probe_loudness", { ch }); } catch { return 0.01; }
    }));
    const max = Math.max(0.005, ...rms);
    chList.forEach((ch, i) => {
      ra.setChannel(ch, Math.min(2.5, Math.max(0.25, max / rms[i])) * 0.5, false);
    });
  } else {
    chList.forEach((ch) => ra.setChannel(ch, 0.5, false));
  }
  // Rust 端解析 SMF 并采样级调度(程序变更由前端按时间戳解析音色)
  ra.smfPlay(bytesToBase64(transState.smfBytes)).catch((e: unknown) => {
    toast("播放失败: " + String(e).slice(0, 60));
    stopPlaybackCleanup();   // 含恢复通道音量,防止残留增益盖过主增益
    $id("trans-status").textContent = "播放失败";
  });
  const secPerTick = (smf.usPerQuarter / 1e6) / smf.division;
  const totalSec = smf.notes.reduce((m, n) => Math.max(m, (n.tick + n.dur) * secPerTick), 0);
  const fmt = (s: number) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const totalStr = fmt(totalSec);
  // 程序变更:按播放时间戳切音色(前端解析 → 灌通道引擎),切换时状态栏显示
  // 勾选"只用当前音色"时忽略文件程序变更(所有通道保持当前主音色)
  const lockTone = ($id("lock-current-tone") as HTMLInputElement).checked;
  if (lockTone) {
    $id("trans-status").textContent = `播放中(只用当前音色) 00:00 / ${totalStr}`;
  } else {
    const pcs = [...smf.programChanges].sort((a, b) => a.tick - b.tick);
    pcTimers = pcs.map((pc) => window.setTimeout(() => {
      const name = applyProgramToChannel(pc.ch, pc.program);
      if (name) toast(`通道${pc.ch + 1} 切换音色:${name}`);   // 全局提示,不被状态栏刷新覆盖
      $id("trans-status").textContent = `播放中 · 通道${pc.ch + 1} 音色:${name ?? "?"}`;
    }, 300 + pc.tick * secPerTick * 1000));
  }
  const startWall = performance.now() + 300;
  setTransPlaying(true);
  $id("btn-trans-play").classList.add("running");
  $id("trans-status").textContent = lockTone
    ? `播放中(只用当前音色) 00:00 / ${totalStr}`
    : `播放中 00:00 / ${totalStr}`;
  const drive = () => {
    if (!transPlaying) return;
    const el = (performance.now() - startWall) / 1000;
    $id("trans-status").textContent = `播放中 ${fmt(Math.max(0, el))} / ${totalStr}`;
    if (el < totalSec + 1.0) {
      playUiTimers.push(window.setTimeout(drive, 200));
    } else {
      stopPlaybackCleanup();
      $id("trans-status").textContent = "播放完成";
    }
  };
  playUiTimers.push(window.setTimeout(drive, 250));
}
$id("btn-trans-play").addEventListener("click", () => { transcribePlay(); });

// 恢复通道音量(播放结束/停止时)
function restoreChVolumes() {
  for (let ch = 0; ch < 16; ch++) ra.setChannel(ch, 1.0, false);
}

// 播放统一清理:停止/失败/完成共用(通道音量必须恢复,否则残留归一增益脱离主增益控制)
function stopPlaybackCleanup() {
  restoreChVolumes();
  ra.smfStop();
  setTransPlaying(false);
  if (playProgTimer) { window.clearInterval(playProgTimer); playProgTimer = 0; }
  $id("btn-trans-play").classList.remove("running");
  for (const t of pcTimers) window.clearTimeout(t);
  pcTimers = [];
  playNotes.clear();
  updateKeysUI();
}

// 停止:可被界面按钮 / MIDI 走带按钮调用
export function transcribeStop() {
  stopPlaybackCleanup();
  $id("trans-status").textContent = "已停止";
  playUiCleanup();
}
$id("btn-trans-stop").addEventListener("click", () => { transcribeStop(); });

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

// 自动随机匹配开关(无音色时程序号 → 内置音色)
$id("auto-match").addEventListener("change", (e) => setAutoMatch((e.target as HTMLInputElement).checked));
($id("auto-match") as HTMLInputElement).checked = autoMatchEnabled();

// 琴键高亮:Rust 播放线程音符事件(与采样级调度同步);同时闪右上角输入灯
listen<[boolean, number]>("trans-note", (e) => {
  const [on, midi] = e.payload;
  if (on) { playNotes.add(midi); ledBlink(); } else playNotes.delete(midi);
  updateKeysUI();
}).catch(() => {});
