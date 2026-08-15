import { el, clear, $$ } from "./dom.js";

const CLOSE_MS = 160; // must match --dur in tokens.css
const open = new Set();

function syncScrollLock() {
  document.body.classList.toggle("modal-open", open.size > 0);
}

function focusables(root) {
  return $$(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    root
  ).filter((n) => n.offsetParent !== null);
}

/* Renders a modal, traps Tab inside it, restores focus on close.
   Returns { root, close } — content receives close so it can resolve its own flow. */
const closers = new Map();

/* Navigating away must not leave a dialog floating over the new view. */
export function closeAllModals() {
  for (const close of [...closers.values()]) close();
}

export function openModal({ title, body, footer, wide = false, onClose, labelledBy }) {
  const opener = document.activeElement;
  const titleId = labelledBy || `modal-title-${Math.random().toString(36).slice(2, 8)}`;

  const closeBtn = el("button", { class: "icon-btn", type: "button", "aria-label": "ปิด" }, "✕");
  const dialog = el(
    "div",
    { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    el("div", { class: "modal-head" }, el("h2", { id: titleId, class: "modal-title" }, title), closeBtn),
    el("div", { class: "modal-body" }, body),
    footer ? el("div", { class: "modal-foot" }, footer) : null
  );
  const backdrop = el("div", { class: "modal-backdrop" }, dialog);

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    open.delete(backdrop);
    closers.delete(backdrop);
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.remove();
      syncScrollLock();
      opener?.focus?.();
    }, CLOSE_MS);
    document.removeEventListener("keydown", onKeydown, true);
    onClose?.(result);
  };

  function onKeydown(ev) {
    if (backdrop !== [...open].at(-1)) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    const items = focusables(dialog);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  closeBtn.addEventListener("click", () => close());
  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener("keydown", onKeydown, true);

  document.body.append(backdrop);
  open.add(backdrop);
  closers.set(backdrop, close);
  syncScrollLock();
  (focusables(dialog)[1] || closeBtn).focus();

  return { root: backdrop, dialog, close, setBody: (node) => clear(dialog.querySelector(".modal-body")).append(node) };
}

/* Replaces window.alert/confirm/prompt so every dialog looks like the app
   and can be styled/kept accessible. */
function basicDialog({ title, message, kind = "info", okLabel = "ตกลง", cancelLabel, input }) {
  return new Promise((resolve) => {
    const field = input
      ? el("input", { type: "text", value: input.value || "", placeholder: input.placeholder || "" })
      : null;

    const body = el(
      "div",
      { class: "stack" },
      message ? el("p", { class: "text-2" }, message) : null,
      field ? el("label", { class: "field" }, el("span", {}, input.label || ""), field) : null
    );

    const ok = el(
      "button",
      { class: `btn${kind === "danger" ? " btn-danger" : ""}`, type: "button" },
      okLabel
    );
    const cancel = cancelLabel ? el("button", { class: "btn btn-ghost", type: "button" }, cancelLabel) : null;

    const modal = openModal({
      title,
      body,
      footer: [cancel, ok].filter(Boolean),
      onClose: (result) => resolve(result === undefined ? (cancelLabel ? null : false) : result),
    });

    ok.addEventListener("click", () => modal.close(field ? field.value.trim() : true));
    cancel?.addEventListener("click", () => modal.close(null));
    field?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        modal.close(field.value.trim());
      }
    });
    (field || ok).focus();
  });
}

export const showAlert = (message, title = "แจ้งเตือน") => basicDialog({ title, message });

export const showConfirm = (message, { title = "ยืนยัน", okLabel = "ยืนยัน", danger = false } = {}) =>
  basicDialog({ title, message, okLabel, cancelLabel: "ยกเลิก", kind: danger ? "danger" : "info" }).then(Boolean);

export const showPrompt = (label, { title = "กรอกข้อมูล", value = "", placeholder = "", okLabel = "บันทึก" } = {}) =>
  basicDialog({ title, okLabel, cancelLabel: "ยกเลิก", input: { label, value, placeholder } });
