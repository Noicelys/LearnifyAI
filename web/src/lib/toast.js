import { el } from "./dom.js";

let area;

export function toast(message, { kind = "info", ms = 3200 } = {}) {
  if (!area) {
    area = el("div", { class: "toast-area", role: "status", "aria-live": "polite" });
    document.body.append(area);
  }
  const node = el("div", { class: `toast${kind === "err" ? " err" : ""}` }, message);
  area.append(node);
  setTimeout(() => node.remove(), ms);
}

export const toastError = (err) =>
  toast(err?.message || String(err) || "เกิดข้อผิดพลาด", { kind: "err", ms: 5000 });
