import { el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state, loadRoster } from "../lib/store.js";
import { setView, viewPage } from "./shell.js";
import { showConfirm } from "../lib/modal.js";
import { toast, toastError } from "../lib/toast.js";
import { openStudentForm, openStudentDetail } from "../features/studentModal.js";
import { openCSVImport } from "../features/csvImport.js";

const unique = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();

export async function showRoster() {
  let rows = state.roster;
  let query = "";
  const filters = { department: "", class_level: "", status: "" };

  const search = el("input", { type: "search", placeholder: "ค้นชื่อ นามสกุล หรือรหัสนักเรียน", style: "max-width:320px" });
  // display:contents so the selects join the toolbar's flex row instead of
  // forming a second wrapping box inside it.
  const filterBar = el("div", { style: "display:contents" });
  const tableBox = el("div", {});
  const count = el("span", { class: "hint num" });

  const refresh = async () => {
    await loadRoster().catch(toastError);
    rows = state.roster;
    paintFilters();
    paint();
  };

  const addBtn = el("button", { class: "btn", type: "button" }, "＋ เพิ่มนักเรียน");
  addBtn.addEventListener("click", () => openStudentForm({ onSaved: refresh }));

  const csvBtn = el("button", { class: "btn btn-secondary", type: "button" }, "นำเข้าจาก CSV");
  csvBtn.addEventListener("click", () => openCSVImport({ onImported: refresh }));

  function visible() {
    const q = query.toLowerCase();
    return rows.filter((r) => {
      if (filters.department && r.department !== filters.department) return false;
      if (filters.class_level && r.class_level !== filters.class_level) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (!q) return true;
      return `${r.full_name || ""} ${r.student_no || ""}`.toLowerCase().includes(q);
    });
  }

  function paintFilters() {
    clear(filterBar);
    const make = (key, label, values) => {
      const select = el(
        "select",
        { style: "max-width:200px" },
        el("option", { value: "" }, label),
        values.map((v) => el("option", { value: v, selected: filters[key] === v }, v))
      );
      select.addEventListener("change", () => {
        filters[key] = select.value;
        paint();
      });
      return select;
    };
    filterBar.append(
      make("department", "ทุกแผนกวิชา", unique(rows, "department")),
      make("class_level", "ทุกชั้น", unique(rows, "class_level")),
      make("status", "ทุกสถานะ", unique(rows, "status"))
    );
  }

  function paint() {
    const shown = visible();
    count.textContent = `${shown.length} / ${rows.length} คน`;
    clear(tableBox);

    if (!rows.length) {
      tableBox.append(
        el(
          "div",
          { class: "empty" },
          el("h3", {}, "ยังไม่มีรายชื่อนักเรียน"),
          el("p", {}, "นำเข้ารายชื่อทั้งห้องจากไฟล์ CSV ครั้งเดียว แล้วระบบจะจับคู่ไฟล์เสียงกับเจ้าของงานให้เอง"),
          (() => {
            const b = el("button", { class: "btn", type: "button" }, "นำเข้าจาก CSV");
            b.addEventListener("click", () => csvBtn.click());
            return b;
          })()
        )
      );
      return;
    }

    if (!shown.length) {
      tableBox.append(el("p", { class: "hint", style: "padding:16px 0" }, "ไม่พบนักเรียนที่ตรงกับเงื่อนไข"));
      return;
    }

    const body = el(
      "tbody",
      {},
      shown.map((r) => {
        const view = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "ดู");
        view.addEventListener("click", () => openStudentDetail(r.id));

        const edit = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "แก้ไข");
        edit.addEventListener("click", () => openStudentForm({ student: r, onSaved: refresh }));

        const remove = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "ลบ");
        remove.addEventListener("click", async () => {
          const ok = await showConfirm(`ลบ ${r.full_name} ออกจากรายชื่อ (ผลตรวจที่เคยส่งจะยังอยู่)`, {
            title: "ลบนักเรียน",
            okLabel: "ลบ",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteStudent(r.id);
            toast("ลบนักเรียนแล้ว");
            refresh();
          } catch (err) {
            toastError(err);
          }
        });

        return el(
          "tr",
          {},
          el("td", { class: "mono" }, r.student_no || "—"),
          el("td", {}, r.full_name || `${r.first_name} ${r.last_name}`),
          el("td", {}, r.department || "—"),
          el("td", {}, [r.class_level, r.room].filter(Boolean).join("/") || "—"),
          el("td", {}, r.status || "—"),
          el("td", { class: "num" }, String(r.classroom_count ?? 0)),
          el("td", { class: "num" }, String(r.submission_count ?? 0)),
          el("td", {}, el("div", { class: "row-tight" }, view, edit, remove))
        );
      })
    );

    tableBox.append(
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "data" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "รหัส"),
              el("th", {}, "ชื่อ-นามสกุล"),
              el("th", {}, "แผนกวิชา"),
              el("th", {}, "ชั้น/ห้อง"),
              el("th", {}, "สถานะ"),
              el("th", { class: "num" }, "รายวิชา"),
              el("th", { class: "num" }, "การส่ง"),
              el("th", {}, "")
            )
          ),
          body
        )
      )
    );
  }

  search.addEventListener("input", () => {
    query = search.value.trim();
    paint();
  });

  setView(
    viewPage(
      el(
        "header",
        { class: "page-head" },
        el("span", { class: "eyebrow" }, "ฐานข้อมูลนักเรียน"),
        el("div", { class: "spread" }, el("h1", { class: "page-title" }, "รายชื่อนักเรียน"), el("div", { class: "row-tight" }, csvBtn, addBtn))
      ),
      el("div", { class: "row", style: "margin-bottom:16px" }, search, filterBar, el("span", { class: "grow" }), count),
      tableBox
    )
  );

  paintFilters();
  paint();
  if (!rows.length) refresh();
}
