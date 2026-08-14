// 音色映射:程序号 → 音色,用户自定义绑定(优先于内置预设,存 localStorage)
import { PRESET_LIBRARY, findLibraryPreset, loadUserMap, saveUserMap } from "../core/presets-library";
import { $id, toast } from "./dom";

// 音色下拉:内置库音色(显示库程序号 + 名称)
const presetSel = $id("map-preset") as HTMLSelectElement;
presetSel.innerHTML = PRESET_LIBRARY.map(
  (lib) => `<option value="${lib.program}">${lib.program} ${lib.name}</option>`
).join("");

function renderMapList() {
  const list = $id("map-list");
  const um = loadUserMap();
  if (um.size === 0) {
    list.innerHTML = '<div class="vel-hint">暂无绑定。上面选择程序号和音色后点「绑定」。</div>';
    return;
  }
  const rows: string[] = [];
  const entries = [...um.entries()].sort((a, b) => a[0] - b[0]);
  for (const [prog, libProg] of entries) {
    const lib = findLibraryPreset(libProg);
    const name = lib ? `${libProg} ${lib.name}` : `?${libProg}`;
    rows.push(
      `<div class="map-row">
        <span class="map-prog">程序 ${prog}</span>
        <span class="map-name">→ ${name}</span>
        <button class="tool-btn map-del" data-prog="${prog}">解绑</button>
      </div>`
    );
  }
  list.innerHTML = rows.join("");
  list.querySelectorAll(".map-del").forEach((b) => {
    b.addEventListener("click", () => {
      const um2 = loadUserMap();
      um2.delete(Number((b as HTMLElement).dataset.prog));
      saveUserMap(um2);
      renderMapList();
      toast("已解绑");
    });
  });
}

$id("btn-map-add").addEventListener("click", () => {
  const prog = Math.round(Number(($id("map-program") as HTMLInputElement).value));
  if (isNaN(prog) || prog < 0 || prog > 127) { toast("程序号需在 0-127"); return; }
  const libProg = Number(presetSel.value);
  const lib = findLibraryPreset(libProg);
  const um = loadUserMap();
  um.set(prog, libProg);
  saveUserMap(um);
  renderMapList();
  toast(`已绑定:程序${prog} → ${lib?.name ?? libProg}`);
});

renderMapList();
