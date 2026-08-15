import { el, clear } from "../lib/dom.js";
import { openModal } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { loadTree } from "../lib/store.js";
import { toast, toastError } from "../lib/toast.js";
import { SUBJECT_COLORS, subjectColor, backgroundUrl } from "../components/subjectTheme.js";

export function openThemeModal(subject, onSaved) {
  let picked = subjectColor(subject);
  let clearImage = false;
  let file = null;

  const preview = el("div", { class: "banner", style: "" }, el("h2", {}, subject.name));
  const paint = () => {
    const image = clearImage ? null : file ? URL.createObjectURL(file) : backgroundUrl(subject);
    preview.style.cssText = image
      ? `background-color:${picked};background-image:url('${image}')`
      : `background-color:${picked}`;
  };

  const swatches = el("div", { class: "row" });
  const renderSwatches = () => {
    clear(swatches);
    for (const color of SUBJECT_COLORS) {
      const btn = el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": `เลือกสี ${color}`,
        "aria-pressed": String(color.toLowerCase() === picked.toLowerCase()),
        style: `background:${color};border:2px solid ${color.toLowerCase() === picked.toLowerCase() ? "var(--text)" : "transparent"};border-radius:8px`,
      });
      btn.addEventListener("click", () => {
        picked = color;
        renderSwatches();
        paint();
      });
      swatches.append(btn);
    }
  };

  const fileInput = el("input", { type: "file", accept: "image/*", hidden: true });
  const pickImage = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "เลือกรูปหน้าปก");
  const removeImage = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "เอารูปออก");
  pickImage.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    file = fileInput.files?.[0] || null;
    clearImage = false;
    paint();
  });
  removeImage.addEventListener("click", () => {
    file = null;
    clearImage = true;
    paint();
  });

  const save = el("button", { class: "btn", type: "button" }, "บันทึก");
  const modal = openModal({
    title: "หน้าตารายวิชา",
    body: el(
      "div",
      { class: "stack" },
      preview,
      el("div", { class: "stack-sm" }, el("span", { class: "field-label" }, "สีประจำวิชา"), swatches),
      el("div", { class: "row" }, pickImage, removeImage, fileInput),
      el("p", { class: "hint" }, "รูปหน้าปกจะถูกคลุมด้วยเงาบาง ๆ เพื่อให้ชื่อวิชายังอ่านออก")
    ),
    footer: [save],
  });

  renderSwatches();
  paint();

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api.updateSubject(subject.id, { themeColor: picked });
      if (clearImage) await api.clearSubjectBackground(subject.id);
      if (file) {
        const form = new FormData();
        form.append("image", file);
        await api.uploadSubjectBackground(subject.id, form);
      }
      await loadTree();
      toast("บันทึกหน้าตารายวิชาแล้ว");
      modal.close();
      onSaved?.();
    } catch (err) {
      toastError(err);
    } finally {
      save.disabled = false;
    }
  });
}
