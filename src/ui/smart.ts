// 智能优化:自动频谱整形(过载频段自动衰减,均衡后回升)
// 开关/强度 → Rust;四频带实时衰减值来自 scope 事件尾部(1024 时域 + 128 频谱 + 4 增益)
import { listen } from "@tauri-apps/api/event";
import { ra } from "../core/rust-audio";
import { $id } from "./dom";

// 开关
const onCb = $id("smart-on") as HTMLInputElement;
onCb.addEventListener("change", () => {
  ra.setSmartOpt(onCb.checked, Number(($id("smart-strength") as HTMLInputElement).value) / 100);
});
onCb.checked = false;

// 强度(实时生效)
const stEl = $id("smart-strength") as HTMLInputElement;
const stSync = () => {
  const v = Number(stEl.value);
  $id("smart-strength-val").textContent = v + "%";
  if (onCb.checked) ra.setSmartOpt(true, v / 100);
};
stEl.addEventListener("input", stSync);
stSync();

// 实时频带衰减显示(Rust 随 scope 事件发 4 个增益 dB)
listen<number[]>("scope", (e) => {
  const d = e.payload;
  if (!d || d.length < 1024 + 128 + 4) return;
  for (let i = 0; i < 4; i++) {
    const el = $id("smart-band-" + i);
    if (!el) continue;
    const db = d[1024 + 128 + i];
    el.textContent = (db <= -0.05 ? db.toFixed(1) : "0") + "dB";
    el.style.color = db <= -0.05 ? "#ff9d7d" : "";
  }
}).catch(() => {});
