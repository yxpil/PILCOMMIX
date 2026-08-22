// 磁轴键盘(霍尔效应)力度支持:WebHID 读取模拟压力 → MIDI 力度弹奏
//
// 主流磁轴键盘模拟输入协议(按公开协议补齐,无硬件实测):
// - Wooting 60HE/80HE/Two HE:vendor 接口(UsagePage 0xFF00),报告 ID 4,
//   64 字节报告 = 报告 ID + 14 对 [标准 HID usage, 压力 0-255]
// - 醉鹿 Gaming A75/A2、珂芝、狼蛛、VXE75 等国产磁轴:多数兼容 Wooting 报告 ID 4 格式
//   (同 AP-0108 主控方案),部分用报告 ID 0x0C
// - 本实现:报告偏移自适应(带/不带报告 ID),usage 用标准 HID Keyboard Usage(0x04-0x65),
//   覆盖 Wooting 系与国产兼容系;若遇厂商自定义键码(非标准 usage)可在此扩展映射表
//
// WebHID 类型声明(TS lib.dom 未内置)
interface HIDInputReportEvent extends Event {
  data: DataView;
  reportId: number;
  device: HIDDevice;
}
interface HIDDevice {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: { usagePage?: number; usage?: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "inputreport", cb: (e: HIDInputReportEvent) => void): void;
}
interface HID {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(opts: { filters: unknown[] }): Promise<HIDDevice[]>;
}
interface Navigator { hid?: HID }

import { octaveShift } from "../core/store";
import { KEYMAP } from "../core/notes";
import { pressKey, releaseKey } from "./keyboard";
import { $id, toast } from "./dom";

let device: HIDDevice | null = null;
let deviceName = "";
const PRESS_THRESHOLD = 14;   // 压力阈值(0-255):超过=按下,低于=松开

// HID usage → e.code(标准键盘 Usage IDs)
const HID_TO_CODE: Record<number, string> = {};
for (let i = 0; i < 26; i++) HID_TO_CODE[0x04 + i] = "Key" + String.fromCharCode(65 + i);   // a-z
for (let i = 0; i < 10; i++) HID_TO_CODE[0x1E + i] = "Digit" + (i === 9 ? "0" : String(i + 1)); // 1-0
HID_TO_CODE[0x2C] = "Space";
HID_TO_CODE[0x2D] = "Minus"; HID_TO_CODE[0x2E] = "Equal";
HID_TO_CODE[0x2F] = "BracketLeft"; HID_TO_CODE[0x30] = "BracketRight";
HID_TO_CODE[0x33] = "Semicolon"; HID_TO_CODE[0x34] = "Quote";
HID_TO_CODE[0x37] = "Comma"; HID_TO_CODE[0x38] = "Period"; HID_TO_CODE[0x39] = "Slash";
for (let i = 0; i < 12; i++) HID_TO_CODE[0x3A + i] = "F" + (i + 1);                          // F1-F12
// 小键盘
HID_TO_CODE[0x59] = "Numpad1"; HID_TO_CODE[0x5A] = "Numpad2"; HID_TO_CODE[0x5B] = "Numpad3";
HID_TO_CODE[0x5C] = "Numpad4"; HID_TO_CODE[0x5D] = "Numpad5"; HID_TO_CODE[0x5E] = "Numpad6";
HID_TO_CODE[0x5F] = "Numpad7"; HID_TO_CODE[0x60] = "Numpad8"; HID_TO_CODE[0x61] = "Numpad9";
HID_TO_CODE[0x62] = "Numpad0";

const held = new Map<number, number>();   // usage → midi(磁轴按住中,防重复触发)

function codeToMidi(code: string): number | undefined {
  const base = KEYMAP[code];
  if (base === undefined) return undefined;
  return Math.min(127, Math.max(0, base + octaveShift * 12));
}

function status(msg: string, on = false) {
  const el = $id("hall-status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("on", on);
}

// 自适应报告偏移:磁轴模拟接口几乎都带 1 字节报告 ID,无 ID 较少见。
// 统计两种偏移下"合法键盘 usage 对"数量:默认偏移 1(带 ID),
// 仅当偏移 0 匹配数显著更多(>+2)才判定为无 ID 报告(避免压力值巧合撞 usage 的误判)
function reportStart(dv: DataView): number {
  const score = (start: number) => {
    let s = 0;
    for (let i = start; i + 1 < dv.byteLength; i += 2) {
      const u = dv.getUint8(i);
      if (u >= 0x04 && u <= 0x65 && HID_TO_CODE[u]) s++;
    }
    return s;
  };
  return score(0) > score(1) + 2 ? 0 : 1;
}

function handleReport(dv: DataView) {
  const n = dv.byteLength;
  const start = reportStart(dv);
  // 诊断:显示原始报告前 32 字节(排障/确认协议用)
  const dbg = $id("hall-dbg");
  if (dbg) {
    let hex = "";
    for (let i = 0; i < Math.min(32, n); i++) hex += dv.getUint8(i).toString(16).padStart(2, "0") + " ";
    dbg.textContent = "报告 " + hex.trim();
  }
  for (let i = start; i + 1 < n; i += 2) {
    const usage = dv.getUint8(i);
    const pressure = dv.getUint8(i + 1);
    if (usage < 0x04 || usage > 0x65) continue;     // 非键盘 usage
    const code = HID_TO_CODE[usage];
    if (!code) continue;
    const midi = codeToMidi(code);
    if (midi === undefined) continue;
    if (pressure > PRESS_THRESHOLD) {
      if (!held.has(usage)) {
        held.set(usage, midi);
        const vel = Math.max(0.03, Math.min(1, pressure / 255));   // 压力 → 力度(0-1)
        pressKey(midi, vel);
      }
    } else if (held.has(usage)) {
      held.delete(usage);
      releaseKey(midi);
    }
  }
}

async function connect(h: HIDDevice) {
  device = h;
  deviceName = h.productName || h.vendorId.toString(16);
  h.addEventListener("inputreport", (e) => handleReport(e.data as DataView));
  try { await h.open(); } catch (err) {
    status("连接失败:" + String(err).slice(0, 60));
    device = null;
    return;
  }
  status(`已连接 ${deviceName}(霍尔力度)`, true);
  toast(`磁轴键盘 ${deviceName} 已连接,按键压力即力度`);
}

export async function scanHallKeys() {
  if (!("hid" in navigator)) {
    toast("当前环境不支持 WebHID(需新版 WebView2)");
    status("不支持 WebHID");
    return;
  }
  try {
    const hid = (navigator as Navigator & { hid: HID }).hid;
    // ① 优先重连已授权设备(刷新页面后恢复)
    const granted = await hid.getDevices().catch(() => []);
    if (granted.length > 0) {
      // 优先选 vendor 自定义接口(UsagePage 0xFF00 系,磁轴模拟口),否则第一个
      const prefer = granted.find((d) => {
        const page = d.collections?.[0]?.usagePage as number | undefined;
        return page !== undefined && (page & 0xFF00) === 0xFF00;
      });
      const pick = prefer ?? granted[0];
      if (device && device !== pick) { try { await device.close(); } catch { /* 忽略 */ } }
      if (!pick.opened) await connect(pick);
      else { device = pick; status(`已连接 ${pick.productName}(霍尔力度)`, true); }
      return;
    }
    // ② 无已授权 → 弹选择器(提示选模拟/vendor 接口)
    const devs = await hid.requestDevice({ filters: [] });
    if (devs.length === 0) return;
    if (device) { try { await device.close(); } catch { /* 忽略 */ } }
    await connect(devs[0]);
  } catch (err) {
    // 用户取消选择
    if (String(err).includes("cancel")) return;
    status("扫描失败:" + String(err).slice(0, 60));
  }
}

export async function disconnectHallKey() {
  if (!device) return;
  try { await device.close(); } catch { /* 忽略 */ }
  held.clear();
  device = null;
  status("已断开磁轴键盘");
  toast("磁轴键盘已断开");
}

$id("btn-hall-scan").addEventListener("click", () => scanHallKeys());
$id("btn-hall-disconnect").addEventListener("click", () => disconnectHallKey());

// 页面失焦时释放所有磁轴按住的音,避免卡音
window.addEventListener("blur", () => {
  if (held.size === 0) return;
  for (const [, midi] of held) releaseKey(midi);
  held.clear();
});
