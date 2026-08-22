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
// 最近打开的文件类型:控制"播放"按钮路由(MIDI ↔ .plspmid,都点"播放"即可)
let lastOpenedFile: "midi" | "plspmid" | null = null;
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
    lastOpenedFile = "midi";
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
$id("btn-trans-play").addEventListener("click", () => {
  // 智能路由:最近打开 .plspmid → 播 .plspmid(用文件内音色);否则播 MIDI
  if (lastOpenedFile === "plspmid" && plspB64) { playPlspmid(); return; }
  transcribePlay();
});

// 清空:停止播放 + 清空 MIDI/.plspmid 状态与显示
$id("btn-trans-clear").addEventListener("click", () => {
  stopPlaybackCleanup();          // 停止 + 恢复通道音量 + 清理播放定时器
  transState.smf = null;
  transState.smfBytes = null;
  transState.fileName = "";
  transState.notes = [];
  plspB64 = "";
  analysis = null;
  lastOpenedFile = null;
  $id("trans-output").textContent = "";
  $id("trans-status").textContent = "已清空 — 打开 MIDI 或 .plspmid 文件";
  $id("trans-status").classList.remove("on");
  wavStatus("WAV 导入 → widi 式自动扒谱(傅里叶分析)→ 音色匹配 → 超高密度 .plspmid(32 轨 × 1920 ticks/四分音符)");
  toast("已清空");
});

// 恢复通道音量(播放结束/停止时;覆盖 64 通道,与引擎分身上限一致)
function restoreChVolumes() {
  for (let ch = 0; ch < 64; ch++) ra.setChannel(ch, 1.0, false);
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

// ============ WAV 导入 / 自动扒谱(widi 式)/ 音色匹配 / .plspmid 超高密度格式 ============
let wavB64 = "";
let wavName = "";
type PlspNoteJson = { t: number; dur: number; midi: number; vel: number; track: number; bright: number; attackMs: number };
type PlspToneJson = { track: number; waveType: string; params: Record<string, number> };
let analysis: { bpm: number; duration: number; sampleRate: number; notes: PlspNoteJson[]; tones: PlspToneJson[] } | null = null;
let plspB64 = "";

function wavStatus(msg: string) {
  const st = $id("wav-status");
  st.textContent = msg;
  st.classList.add("on");
}

$id("btn-wav-open").addEventListener("click", async () => {
  try {
    const [b64, name] = await ra.openWav();
    wavB64 = b64;
    wavName = name;
    analysis = null;
    plspB64 = "";
    wavStatus(`已加载 ${name}(${(b64.length * 0.75 / 1024 / 1024).toFixed(1)}MB) — 可试听或自动扒谱`);
  } catch (e) {
    if (!String(e).includes("已取消")) toast("打开失败: " + String(e).slice(0, 60));
  }
});

$id("btn-wav-play").addEventListener("click", () => {
  if (!wavB64) { toast("请先打开 WAV"); return; }
  ra.audioStart().catch(() => {});
  ra.wavPlay(wavB64).then(() => toast("WAV 试听中(可同时弹奏合成器)")).catch((e) => toast("试听失败: " + String(e).slice(0, 60)));
});
$id("btn-wav-stop").addEventListener("click", () => { ra.wavStop(); toast("已停止试听"); });

// 自动扒谱 + 音色匹配(Rust 暴力傅里叶:hop 256 时间分辨率翻倍,阈值 -60dB 更灵敏,进度事件上报)
let analyzeUnlisten: (() => void) | null = null;
$id("btn-wav-analyze").addEventListener("click", async () => {
  if (!wavB64) { toast("请先打开 WAV"); return; }
  const btn = $id("btn-wav-analyze") as HTMLButtonElement;
  const prog = $id("analyze-progress") as HTMLProgressElement;
  btn.disabled = true;
  btn.textContent = "扒谱中…";
  prog.style.display = "block";
  prog.value = 0;
  // 进度事件:暴力傅里叶分帧推进,实时刷新进度条与状态
  analyzeUnlisten?.();
  analyzeUnlisten = await listen<number>("analyze-progress", (e) => {
    const pct = Math.round((e.payload as number) * 100);
    prog.value = pct;
    btn.textContent = `扒谱中 ${pct}%`;
    wavStatus(`扒谱中 ${pct}%…(暴力傅里叶逐帧匹配)`);
  });
  try {
    const json = await ra.analyzeWav(wavB64);
    const a = JSON.parse(json) as NonNullable<typeof analysis>;
    analysis = a;
    plspB64 = "";
    wavStatus(`扒谱完成:${a.notes.length} 音符 · ${a.tones.length} 轨音色 · ~${Math.round(a.bpm)} BPM · 时长 ${a.duration}s · 密度 ${Math.round(a.duration > 0 ? a.notes.length / a.duration : 0)} 音符/秒`);
    renderPlspJianpu(a);
  } catch (e) {
    toast("扒谱失败: " + String(e).slice(0, 60));
  }
  analyzeUnlisten?.();
  analyzeUnlisten = null;
  btn.disabled = false;
  btn.textContent = "自动扒谱";
  prog.style.display = "none";
});

// 扒谱结果 → 简谱(按音区轨分组,时间轴对齐)
function renderPlspJianpu(a: NonNullable<typeof analysis>, srcName = wavName) {
  const el = $id("trans-output");
  if (a.notes.length === 0) { el.textContent = "没检出音符(音频可能太轻或太噪)"; return; }
  const spb = a.bpm > 1 ? 60 / a.bpm : 0.5;   // 秒/拍
  const tracks = new Map<number, PlspNoteJson[]>();
  for (const n of a.notes) {
    if (!tracks.has(n.track)) tracks.set(n.track, []);
    tracks.get(n.track)!.push(n);
  }
  const parts: string[] = [];
  parts.push(`${srcName} · ~${Math.round(a.bpm)} BPM · ${a.notes.length} 音符 · ${tracks.size} 轨 · 时长 ${a.duration}s`);
  parts.push("=".repeat(46));
  for (const [tr, ns] of [...tracks.entries()].sort((x, y) => x[0] - y[0])) {
    const tone = a.tones.find((t) => t.track === tr);
    parts.push(`轨道 ${tr + 1}(${ns.length} 音符 · 音色 ${tone ? tone.waveType : "?"}):`);
    const sorted = [...ns].sort((x, y) => x.t - y.t);
    let line = "| ";
    let prevEnd = 0;
    for (const n of sorted) {
      // 补休止(音符起始与上一音符结束的间隔)
      let gapBeats = Math.max(0, (n.t - prevEnd) / spb);
      while (gapBeats >= 0.25) {
        const r = gapBeats >= 3.5 ? 4 : gapBeats >= 1.5 ? 2 : gapBeats >= 0.75 ? 1 : gapBeats >= 0.375 ? 0.5 : 0.25;
        line += "0" + jpDuration(r) + " ";
        gapBeats -= r;
      }
      const durBeats = Math.max(0.25, n.dur / spb);
      line += midiToJianpu(n.midi) + jpDuration(durBeats) + "·" + velLabel(n.vel) + " ";
      prevEnd = n.t + n.dur;
    }
    parts.push(line.trimEnd());
    parts.push("");
  }
  el.textContent = parts.join("\n");
}

// 应用匹配音色:每轨音色参数灌入对应通道引擎(32 轨通道)
$id("btn-wav-apply-tone").addEventListener("click", () => {
  if (!analysis) { toast("请先自动扒谱"); return; }
  for (const t of analysis.tones) {
    const p = captureParams();
    p.waveType = t.waveType as typeof p.waveType;
    Object.assign(p, t.params);
    ra.setEngineParams(t.track, p);
  }
  toast(`已应用 ${analysis.tones.length} 轨匹配音色`);
});

// 保存 .plspmid:扒谱结果 + 音色数据一体编码(密度 4 倍 × 轨道 2 倍)
$id("btn-wav-save-plsp").addEventListener("click", async () => {
  if (!analysis) { toast("请先自动扒谱"); return; }
  try {
    const beats = Number(($id("wav-beats") as HTMLSelectElement).value);
    const b64 = await ra.plspmidEncode(
      JSON.stringify(analysis.notes),
      JSON.stringify(analysis.tones),
      analysis.bpm > 1 ? analysis.bpm : 120,
      beats,
    );
    await ra.plspmidSave(b64);
    toast("已保存 .plspmid(音色 + 音符一体)");
  } catch (e) {
    if (!String(e).includes("已取消")) toast("保存失败: " + String(e).slice(0, 60));
  }
});

// 打开 .plspmid:解析并渲染简谱(超高密度 32 轨格式)
$id("btn-plsp-open").addEventListener("click", async () => {
  try {
    const [b64, name] = await ra.plspmidOpen();
    plspB64 = b64;
    const j = JSON.parse(await ra.plspmidParse(b64)) as {
      bpm: number; division: number; usPerQuarter: number; beatsPerBar: number; durationSec: number;
      notes: { tick: number; dur: number; midi: number; vel: number; track: number }[];
      tones: { track: number; waveType: string; params: Record<string, number> }[];
    };
    const spT = j.usPerQuarter / 1e6 / j.division;   // 秒/tick
    const a = {
      bpm: j.bpm,
      duration: j.durationSec,
      sampleRate: 44100,   // plspmid 无采样率概念,占位(渲染不用)
      notes: j.notes.map((n) => ({
        t: n.tick * spT,
        dur: Math.max(0.01, n.dur * spT),
        midi: n.midi,
        vel: Math.min(1, n.vel / 127),
        track: n.track,
        bright: 0.5,      // plspmid 无特征数据,占位
        attackMs: 0,
      })),
      tones: j.tones,
    };
    analysis = a;   // 应用匹配音色/保存也基于此
    lastOpenedFile = "plspmid";   // "播放"按钮路由到 .plspmid
    // 读取文件内音色:每轨音色参数自动灌入对应通道引擎(弹琴/播放都能听到文件音色,不必手动"应用匹配音色")
    let applied = 0;
    for (const t of a.tones) {
      const p = captureParams();
      p.waveType = t.waveType as typeof p.waveType;
      Object.assign(p, t.params);
      ra.setEngineParams(t.track, p);
      applied++;
    }
    renderPlspJianpu(a, name);
    wavStatus(`已加载 ${name} · ${j.notes.length} 音符 · 已读取 ${applied} 轨文件音色 · ~${Math.round(j.bpm)} BPM · ${j.beatsPerBar} 拍/小节 · 时长 ${j.durationSec.toFixed(1)}s — 点播放 .plspmid`);
    if (applied > 0) toast(`已读取 ${applied} 轨文件音色`);
  } catch (e) {
    if (!String(e).includes("已取消")) toast("打开失败: " + String(e).slice(0, 60));
  }
});

// 播放 .plspmid(Rust 解码 → 每轨音色灌入 32 通道引擎 → 采样级调度)
function playPlspmid() {
  if (!plspB64) { toast("请先打开 .plspmid"); return; }
  ra.audioStart().catch(() => {});
  ra.smfStop();
  playUiCleanup();
  ra.plspmidPlay(plspB64).then(() => {
    // 播放状态走统一状态栏;停止/清空用现有按钮(Rust 同一播放器,smfStop 可停)
    wavStatus(".plspmid 播放中(32 轨采样级调度)");
  }).catch((e) => toast("播放失败: " + String(e).slice(0, 60)));
}
$id("btn-plsp-play").addEventListener("click", () => playPlspmid());
