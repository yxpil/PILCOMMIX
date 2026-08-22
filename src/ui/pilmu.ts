// .PILMU 多轨音乐工程面板:新建/打开/保存/播放 + 轨道拖拽排序与编辑
// 轨道类型:plspmid(32 轨高密度)/ mid / wav / mp3;资源随工程打包进 ZIP 容器
import { ra } from "../core/rust-audio";
import { $id, toast } from "./dom";

interface ProjTrack {
  id: number;
  name: string;
  kind: "plspmid" | "mid" | "wav" | "mp3" | "ogg" | "code";
  file: string;
  volume: number;    // 0..2
  pan: number;       // -1..1
  offsetMs: number;
}
let proj: { name: string; bpm: number; beatsPerBar: number; tracks: ProjTrack[]; files: Map<string, string> } | null = null;
let nextId = 0;
const KIND_LABEL: Record<string, string> = { plspmid: "plspmid", mid: "MIDI", wav: "WAV", mp3: "MP3", ogg: "OGG", code: "代码" };
const KIND_EXT: Record<string, string> = { plspmid: "plspmid", mid: "mid", wav: "wav", mp3: "mp3", ogg: "ogg", code: "mcode" };

function projStatus(msg: string) {
  const st = $id("proj-status");
  st.textContent = msg;
  st.classList.add("on");
}

function newProject() {
  proj = { name: "未命名工程", bpm: 120, beatsPerBar: 4, tracks: [], files: new Map() };
  nextId = 0;
  renderProj();
  projStatus("已新建空工程(可添加 MIDI/plspmid/WAV/MP3 轨道)");
}

function buildManifest() {
  return { format: "PILMU", version: 1, bpm: proj!.bpm, beatsPerBar: proj!.beatsPerBar, tracks: proj!.tracks };
}
async function buildBytes(): Promise<string> {
  return ra.pilmuBuild(JSON.stringify(buildManifest()), [...proj!.files.entries()]);
}

// ============ 轨道渲染(含拖拽排序) ============
let dragId: number | null = null;

function renderProj() {
  const list = $id("proj-list");
  if (!proj) { list.innerHTML = '<div class="vel-hint">尚未打开工程 — 点「新建工程」或「打开工程」。</div>'; return; }
  if (proj.tracks.length === 0) {
    list.innerHTML = '<div class="vel-hint">空工程 — 点上方按钮添加轨道(拖拽行可排序,每轨可改名称/音量/声像/偏移)。</div>';
    return;
  }
  list.innerHTML = proj.tracks.map((t) => `
    <div class="proj-track" draggable="true" data-id="${t.id}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;margin:3px 0;border:1px solid rgba(var(--rgb-line),0.15);border-radius:6px;background:rgba(var(--rgb-line),0.04)">
      <span title="拖拽排序" style="cursor:grab;color:var(--text-dim);display:inline-flex;flex-direction:column;gap:2px">
        <svg width="8" height="10" viewBox="0 0 8 10"><circle cx="2" cy="1" r="1" fill="currentColor"/><circle cx="6" cy="1" r="1" fill="currentColor"/><circle cx="2" cy="5" r="1" fill="currentColor"/><circle cx="6" cy="5" r="1" fill="currentColor"/><circle cx="2" cy="9" r="1" fill="currentColor"/><circle cx="6" cy="9" r="1" fill="currentColor"/></svg>
      </span>
      <input class="proj-name" value="${t.name}" title="轨道名称" style="width:86px;background:transparent;border:1px solid rgba(var(--rgb-line),0.25);color:var(--text);border-radius:4px;padding:2px 6px;font-size:11px">
      <span style="font-size:10px;color:var(--text-dim);width:56px">${KIND_LABEL[t.kind]}</span>
      <label style="font-size:10px;color:var(--text-dim)">音量</label>
      <input type="range" class="proj-vol" min="0" max="200" value="${Math.round(t.volume * 100)}" style="width:56px">
      <label style="font-size:10px;color:var(--text-dim)">声像</label>
      <input type="range" class="proj-pan" min="-100" max="100" value="${Math.round(t.pan * 100)}" style="width:56px">
      <label style="font-size:10px;color:var(--text-dim)">偏移ms</label>
      <input type="number" class="proj-offset" value="${t.offsetMs}" min="0" style="width:58px;background:transparent;border:1px solid rgba(var(--rgb-line),0.25);color:var(--text);border-radius:4px;padding:2px 4px;font-size:10px">
      <button class="tool-btn proj-del" style="padding:2px 8px;font-size:10px"><svg class="ic" style="width:11px;height:11px"><use href="#i-trash"/></svg>移除</button>
      ${t.kind === "code" ? `<button class="tool-btn proj-edit-code" style="padding:2px 8px;font-size:10px"><svg class="ic" style="width:11px;height:11px"><use href="#i-pencil"/></svg>编辑代码</button>` : ""}
    </div>`).join("");

  // 编辑事件
  list.querySelectorAll(".proj-track").forEach((row) => {
    const id = Number((row as HTMLElement).dataset.id);
    const t = proj!.tracks.find((x) => x.id === id);
    if (!t) return;
    row.querySelector(".proj-name")!.addEventListener("input", (e) => { t.name = (e.target as HTMLInputElement).value; });
    row.querySelector(".proj-vol")!.addEventListener("input", (e) => { t.volume = Number((e.target as HTMLInputElement).value) / 100; });
    row.querySelector(".proj-pan")!.addEventListener("input", (e) => { t.pan = Number((e.target as HTMLInputElement).value) / 100; });
    row.querySelector(".proj-offset")!.addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      t.offsetMs = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    });
    row.querySelector(".proj-del")!.addEventListener("click", () => {
      proj!.files.delete(t.file);
      proj!.tracks = proj!.tracks.filter((x) => x.id !== id);
      renderProj();
      projStatus(`已移除轨道「${t.name}」`);
    });
    row.querySelector(".proj-edit-code")?.addEventListener("click", () => {
      const b64 = proj!.files.get(t.file) ?? "";
      let src = "";
      try { src = decodeURIComponent(escape(atob(b64))); } catch { /* 非文本 */ }
      openCodeEditor(src || "use piano\nc4 1/4  e4 1/4", t.id);
    });
  });

  // 拖拽排序(draggable 行)
  list.querySelectorAll(".proj-track").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragId = Number((row as HTMLElement).dataset.id);
      (row as HTMLElement).style.opacity = "0.4";
      (e as DragEvent).dataTransfer?.setData("text/plain", String(dragId));
    });
    row.addEventListener("dragend", () => {
      (row as HTMLElement).style.opacity = "";
      dragId = null;
      list.querySelectorAll(".proj-track").forEach((r) => (r as HTMLElement).style.borderColor = "");
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      (row as HTMLElement).style.borderColor = "var(--accent)";
    });
    row.addEventListener("dragleave", () => { (row as HTMLElement).style.borderColor = ""; });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragId === null) return;
      const targetId = Number((row as HTMLElement).dataset.id);
      if (dragId === targetId) return;
      const from = proj!.tracks.findIndex((x) => x.id === dragId);
      const to = proj!.tracks.findIndex((x) => x.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = proj!.tracks.splice(from, 1);
      proj!.tracks.splice(to, 0, moved);
      renderProj();
      projStatus("轨道已排序");
    });
  });
}

// ============ 添加轨道(文件对话框) ============
async function addTrack(kind: ProjTrack["kind"], picker: () => Promise<[string, string]>) {
  if (!proj) { toast("请先新建或打开工程"); return; }
  try {
    const [b64, origName] = await picker();
    const t: ProjTrack = {
      id: nextId++,
      name: origName.replace(/\.[^.]+$/, ""),
      kind,
      file: `t${nextId}.${KIND_EXT[kind]}`,
      volume: 1, pan: 0, offsetMs: 0,
    };
    t.file = `t${t.id}.${KIND_EXT[kind]}`;
    proj.files.set(t.file, b64);
    proj.tracks.push(t);
    renderProj();
    projStatus(`已添加轨道「${t.name}」(${KIND_LABEL[kind]})`);
  } catch (e) {
    if (!String(e).includes("已取消")) toast("添加失败: " + String(e).slice(0, 60));
  }
}

// ============ 工程按钮 ============
$id("btn-proj-new").addEventListener("click", newProject);
$id("btn-proj-open").addEventListener("click", async () => {
  try {
    const [b64, name] = await ra.pilmuOpen();
    const [manifestJson, resources] = await ra.pilmuExtract(b64);
    const m = JSON.parse(manifestJson);
    proj = { name: name.replace(/\.pilmu$/i, ""), bpm: m.bpm ?? 120, beatsPerBar: m.beatsPerBar ?? 4, tracks: m.tracks ?? [], files: new Map(resources) };
    nextId = proj.tracks.reduce((mx, t) => Math.max(mx, t.id + 1), 0);
    renderProj();
    projStatus(`已打开工程「${name}」:${proj.tracks.length} 轨 · ${m.bpm} BPM · 可拖拽编辑`);
  } catch (e) {
    if (!String(e).includes("已取消")) toast("打开失败: " + String(e).slice(0, 60));
  }
});
$id("btn-proj-save").addEventListener("click", async () => {
  if (!proj) { toast("请先新建工程"); return; }
  try {
    const b64 = await buildBytes();
    await ra.pilmuSave(b64);
    projStatus(`已保存工程(${proj.tracks.length} 轨 · ZIP 压缩)`);
  } catch (e) {
    if (!String(e).includes("已取消")) toast("保存失败: " + String(e).slice(0, 60));
  }
});
$id("btn-proj-play").addEventListener("click", async () => {
  if (!proj) { toast("请先新建或打开工程"); return; }
  if (proj.tracks.length === 0) { toast("工程是空的,先添加轨道"); return; }
  try {
    const b64 = await buildBytes();
    ra.audioStart().catch(() => {});
    ra.smfStop();
    await ra.pilmuPlay(b64);
    projStatus(`播放工程:${proj.tracks.length} 轨(音频混合 + MIDI 采样级调度)`);
  } catch (e) {
    toast("播放失败: " + String(e).slice(0, 80));
  }
});
$id("btn-proj-stop").addEventListener("click", () => {
  ra.smfStop();
  ra.wavStop();
  projStatus("已停止");
});

// 添加轨道按钮
$id("btn-proj-add-plsp").addEventListener("click", () => addTrack("plspmid", ra.plspmidOpen));
$id("btn-proj-add-mid").addEventListener("click", () => addTrack("mid", ra.openMidi));
$id("btn-proj-add-wav").addEventListener("click", () => addTrack("wav", ra.openWav));
$id("btn-proj-add-mp3").addEventListener("click", () => addTrack("mp3", ra.openMp3));
$id("btn-proj-add-ogg").addEventListener("click", () => addTrack("ogg", ra.openWav));   // openWav 现支持 wav/mp3/ogg

// ============ 音乐编程代码轨(mcode):代码定义音乐 ============
const CODE_SAMPLE = `// 代码定义音乐:钢琴旋律 + 贝斯 + 和弦
use piano        // 音色:piano/saw/sine/clar/dx7/wt/square/drip
tempo 120        // 速度 BPM

c4 1/4  e4 1/4  g4 1/4  c5 1/2    // 音符 + 时值(1/4 四分,1/8 八分,1/2 二分,1 全音符)
[c4 e4 g4] 1/2                    // 和弦
r 1/4                             // 休止
repeat 2 { a4 1/8  g4 1/8 }       // 重复 2 次
f4 1/4 v100  e4 1/4 v80           // 力度后缀

track 贝斯 {                      // 独立音轨(并行)
  use saw
  c2 1/2  d2 1/4  e2 1/4
}

track 弦乐 {
  use sine
  e4 1/1  g4 1/1
}`;

let codeEditId: number | null = null;   // null = 新增,-1.. 编辑已有轨 id

function openCodeEditor(initial: string, editId: number | null) {
  codeEditId = editId;
  ($id("code-editor-src") as HTMLTextAreaElement).value = initial;
  $id("code-err").textContent = "";
  $id("code-editor").style.display = "block";
  $id("code-editor-src").focus();
}
$id("btn-proj-add-code").addEventListener("click", () => {
  if (!proj) { toast("请先新建或打开工程"); return; }
  openCodeEditor(CODE_SAMPLE, null);
});
$id("btn-code-example").addEventListener("click", () => {
  ($id("code-editor-src") as HTMLTextAreaElement).value = CODE_SAMPLE;
  $id("code-err").textContent = "";
});
$id("btn-code-cancel").addEventListener("click", () => { $id("code-editor").style.display = "none"; codeEditId = null; });

// UTF-8 文本 → base64(支持中文)
function textToB64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

$id("btn-code-save").addEventListener("click", () => {
  if (!proj) return;
  const src = ($id("code-editor-src") as HTMLTextAreaElement).value.trim();
  if (!src) { toast("代码为空"); return; }
  if (codeEditId !== null) {
    // 编辑已有代码轨
    const t = proj.tracks.find((x) => x.id === codeEditId);
    if (t) { proj.files.set(t.file, textToB64(src)); projStatus(`已更新代码轨「${t.name}」`); }
  } else {
    const t: ProjTrack = { id: nextId++, name: "代码音乐", kind: "code", file: "", volume: 1, pan: 0, offsetMs: 0 };
    t.file = `t${t.id}.mcode`;
    proj.files.set(t.file, textToB64(src));
    proj.tracks.push(t);
    projStatus("已添加代码轨(播放时 Rust 编译 mcode)");
  }
  $id("code-editor").style.display = "none";
  codeEditId = null;
  renderProj();
});

renderProj();
