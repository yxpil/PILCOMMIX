// 版本检查:经 Rust 侧 curl.exe 拉取 https://yxpil.com/version/commix 的版本公示(标准 JSON),
// 绕过 WebView CORS 限制;比对本地版本,有新版本显示更新横幅,点击用系统浏览器打开下载地址
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { $id, toast } from "./dom";

const UPDATE_URL = "https://yxpil.com/version/commix";
const DOWNLOAD_URL = "https://yxpil.com/dl/commix.exe";

// 标准版本公示字段:version 必填;url 下载地址(缺省用 DOWNLOAD_URL);notes 更新说明
interface UpdateInfo {
  product?: string;
  version: string;
  url?: string;
  notes?: string;
}

function verCmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

let checkedOnce = false;

// 顶栏「更新」按钮只在发现新版本时显示
function showUpdateBtn(on: boolean) {
  ($id("btn-check-update") as HTMLElement).style.display = on ? "" : "none";
}

export async function checkUpdate(manual: boolean) {
  if (!manual && checkedOnce) return;
  checkedOnce = true;
  try {
    const text = (await invoke<string>("http_get", { url: UPDATE_URL + "?t=" + Date.now() })).trim();
    // 宽松解析:标准 JSON 或纯版本号("0.3" 这种也认)
    let info: UpdateInfo | null = null;
    if (text.startsWith("{")) {
      const obj = JSON.parse(text) as UpdateInfo;
      if (obj && typeof obj.version === "string") info = obj;
    } else if (/^\d+(\.\d+)*$/.test(text)) {
      info = { version: text };
    }
    if (!info) {
      showUpdateBtn(false);
      if (manual) toast("更新信息格式无效");
      return;
    }
    const cur = await getVersion().catch(() => "");
    if (verCmp(info.version, cur) > 0) {
      showUpdateBtn(true);
      $id("ub-text").textContent = "发现新版本 v" + info.version + "(当前 v" + cur + ")";
      $id("ub-notes").textContent = info.notes ? "更新内容:" + info.notes : "";
      $id("ub-download").dataset.url = info.url ?? DOWNLOAD_URL;
      $id("update-banner").style.display = "flex";
    } else {
      showUpdateBtn(false);
      if (manual) toast("已是最新版本 v" + cur);
    }
  } catch {
    showUpdateBtn(false);
    if (manual) toast("检查更新失败(无法访问更新服务器)");
  }
}

// 启动 2.5s 后静默检查一次(有新版本才提示,不打扰)
window.setTimeout(() => checkUpdate(false), 2500);

$id("btn-check-update").addEventListener("click", () => checkUpdate(true));
$id("ub-download").addEventListener("click", () => {
  const url = ($id("ub-download") as HTMLElement).dataset.url ?? DOWNLOAD_URL;
  invoke("open_external", { url });
});
$id("ub-close").addEventListener("click", () => {
  $id("update-banner").style.display = "none";
});
