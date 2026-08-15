import { el, clear } from "../lib/dom.js";
import { openModal } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { loadTree, loadRoster } from "../lib/store.js";
import { toast, toastError } from "../lib/toast.js";

export function openPickStudents(subject, onAdded) {
  const chosen = new Set();
  let candidates = [];

  const search = el("input", { type: "search", placeholder: "ค้นหาชื่อหรือรหัสนักเรียน" });
  const list = el("div", { class: "pool-list" });
  const add = el("button", { class: "btn", type: "button", disabled: true }, "เพิ่มเข้าห้อง");

  const syncAdd = () => {
    add.disabled = chosen.size === 0;
    add.textContent = chosen.size ? `เพิ่ม ${chosen.size} คนเข้าห้อง` : "เพิ่มเข้าห้อง";
  };

  const render = () => {
    clear(list);
    if (!candidates.length) {
      list.append(el("p", { class: "hint" }, "ไม่พบนักเรียนที่ยังไม่อยู่ในห้องนี้"));
      return;
    }
    for (const s of candidates) {
      const box = el("input", { type: "checkbox", checked: chosen.has(s.id), style: "width:auto;min-height:auto" });
      box.addEventListener("change", () => {
        box.checked ? chosen.add(s.id) : chosen.delete(s.id);
        syncAdd();
      });
      list.append(
        el(
          "label",
          { class: "pool-item", style: "cursor:pointer" },
          box,
          el("span", { class: "grow truncate" }, s.full_name || `${s.first_name} ${s.last_name}`),
          el("span", { class: "hint mono" }, s.student_no || "")
        )
      );
    }
  };

  const load = async (q = "") => {
    try {
      candidates = await api.students({ subjectId: subject.id, notIn: 1, q });
      render();
    } catch (err) {
      toastError(err);
    }
  };

  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value.trim()), 220);
  });

  const modal = openModal({
    title: `เพิ่มนักเรียนเข้า ${subject.name}`,
    body: el("div", { class: "stack" }, search, list),
    footer: [add],
  });

  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      await api.addStudentsToSubject(subject.id, [...chosen]);
      await Promise.all([loadTree(), loadRoster()]);
      toast(`เพิ่มนักเรียน ${chosen.size} คนแล้ว`);
      modal.close();
      onAdded?.();
    } catch (err) {
      toastError(err);
      add.disabled = false;
    }
  });

  load();
}
