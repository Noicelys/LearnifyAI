const KEY = "eduai-theme";
const ORDER = ["system", "light", "dark"];
const LABEL = { system: "ตามระบบ", light: "สว่าง", dark: "มืด" };

export function currentTheme() {
  const saved = localStorage.getItem(KEY);
  return ORDER.includes(saved) ? saved : "system";
}

export function applyTheme(mode) {
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem(KEY, mode);
}

export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(currentTheme()) + 1) % ORDER.length];
  applyTheme(next);
  return next;
}

export const themeLabel = (mode = currentTheme()) => LABEL[mode];

applyTheme(currentTheme());
