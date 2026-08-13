// DOM 小工具
export const $id = (s: string) => document.getElementById(s) as HTMLElement;
export function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 450); }, 2400);
}
