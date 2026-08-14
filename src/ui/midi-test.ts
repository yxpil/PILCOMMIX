// 测试选项卡:MIDI 输入监视器(看自己按了什么旋钮/按钮,未映射的提示可绑定)
import { listen } from "@tauri-apps/api/event";
import { getCcAction, CC_ACTIONS } from "../core/cc-map";
import { resolveProgram } from "./presets";
import { noteName } from "../core/notes";
import { $id } from "./dom";

const MAX_ROWS = 40;
function push(msg: string, cls = "") {
  const cur = $id("test-current");
  cur.textContent = msg;
  cur.className = "test-current" + (cls ? " " + cls : "");
  const list = $id("test-list");
  const row = document.createElement("div");
  row.className = "test-row" + (cls ? " " + cls : "");
  row.textContent = msg;
  list.prepend(row);
  while (list.children.length > MAX_ROWS) list.lastElementChild?.remove();
}

listen<number[]>("midi-in", (e) => {
  const d = e.payload;
  if (!d || d.length < 2) return;
  const status = d[0];
  const typ = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  const d1 = d[1];
  const d2 = d[2] ?? 0;
  if (typ === 0x90 && d2 > 0) {
    push(`音符 通道${ch} ${noteName(d1)} 力度 ${d2}`, "note");
  } else if (typ === 0x80 || (typ === 0x90 && d2 === 0)) {
    push(`音符关 通道${ch} ${noteName(d1)}`, "noteoff");
  } else if (typ === 0xb0) {
    const act = getCcAction(d1);
    push(`CC ${d1} = ${d2} 通道${ch}` + (act ? ` → ${CC_ACTIONS[act]}` : " (未映射)"), act ? "cc" : "unknown");
  } else if (typ === 0xc0) {
    let name = "程序 " + d1;
    try { const r = resolveProgram(d1); if (r) name = r.name; } catch { /* ignore */ }
    push(`程序变更 通道${ch} → ${name}`, "prog");
  } else if (typ === 0xe0) {
    const v = (d1 | (d2 << 7)) - 8192;
    push(`弯音 通道${ch} ${v >= 0 ? "+" : ""}${v}`, "bend");
  } else {
    push(`消息 ${d.map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
  }
}).catch(() => {});

$id("btn-test-clear").addEventListener("click", () => {
  $id("test-list").innerHTML = "";
  $id("test-current").textContent = "-";
  $id("test-current").className = "test-current";
});
