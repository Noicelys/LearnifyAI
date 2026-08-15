import { el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { findSubject, loadTree, subjectTally } from "../lib/store.js";
import { navigate } from "../lib/router.js";
import { setView, viewPage } from "./shell.js";
import { bannerStyle } from "../components/subjectTheme.js";
import { showConfirm, showPrompt } from "../lib/modal.js";
import { toast, toastError } from "../lib/toast.js";
import { openAssignmentModal } from "../features/assignmentModal.js";
import { openThemeModal } from "../features/themeModal.js";
import { openPickStudents } from "../features/pickStudents.js";
import { thaiDate, TRUST_LABEL, STATUS_LABEL } from "../lib/format.js";

const TRUST_FILTERS = [
  { key: "all", label: "ทั้งหมด", match: () => true },
  { key: "green", label: "น่าเชื่อถือ", match: (x) => x.trust_level === "green" },
  { key: "yellow", label: "ควรถามเพิ่ม", match: (x) => x.trust_level === "yellow" },
  { key: "red", label: "ควรตรวจสอบ", match: (x) => x.trust_level === "red" },
  { key: "followup", label: "ควรถามตาม", match: (x) => x.needs_followup },
  { key: "pending", label: "กำลังประมวลผล", match: (x) => x.status === "transcribing" || x.status === "analyzing" },
  { key: "error", label: "ผิดพลาด", match: (x) => x.status === "error" },
];

export async function showSubject(id) {
  const subject = findSubject(id);
  if (!subject) {
    await loadTree().catch(() => {});
    if (!findSubject(id)) return navigate("/", { replace: true });
    return showSubject(id);
  }

  const tally = subjectTally(subject);

  const themeBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "ปรับหน้าตา");
  themeBtn.addEventListener("click", () => openThemeModal(subject, () => showSubject(id)));

  const renameBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "เปลี่ยนชื่อ");
  renameBtn.addEventListener("click", async () => {
    const name = await showPrompt("ชื่อรายวิชา", { title: "เปลี่ยนชื่อรายวิชา", value: subject.name });
    if (!name) return;
    try {
      await api.updateSubject(subject.id, { name });
      await loadTree();
      showSubject(id);
    } catch (err) {
      toastError(err);
    }
  });

  const studentsBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "เพิ่มนักเรียน");
  studentsBtn.addEventListener("click", () => openPickStudents(subject, () => showSubject(id)));

  const deleteBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "ลบรายวิชา");
  deleteBtn.addEventListener("click", async () => {
    const ok = await showConfirm(
      `ลบ “${subject.name}” พร้อมหัวข้อ งาน และผลตรวจทั้งหมดในรายวิชานี้ ย้อนกลับไม่ได้`,
      { title: "ลบรายวิชา", okLabel: "ลบทั้งรายวิชา", danger: true }
    );
    if (!ok) return;
    try {
      await api.deleteSubject(subject.id);
      await loadTree();
      toast("ลบรายวิชาแล้ว");
      navigate("/");
    } catch (err) {
      toastError(err);
    }
  });

  const banner = el(
    "header",
    { class: "banner", style: bannerStyle(subject) },
    el("span", { class: "eyebrow", style: "color:rgba(255,255,255,.8)" }, "รายวิชา"),
    el("h1", {}, subject.name),
    el(
      "p",
      { class: "banner-sub num" },
      `${tally.lessons} หัวข้อ · ${tally.assignments} งาน · ${tally.submissions} การส่ง · ${subject.student_count ?? 0} นักเรียน`
    ),
    el("div", { class: "banner-actions" }, themeBtn, renameBtn, studentsBtn, deleteBtn)
  );

  const newLesson = el("button", { class: "btn btn-secondary", type: "button" }, "＋ หัวข้อ");
  newLesson.addEventListener("click", async () => {
    const title = await showPrompt("ชื่อหัวข้อ", { title: "สร้างหัวข้อ", placeholder: "เช่น หน่วยที่ 1 ความปลอดภัย" });
    if (!title) return;
    try {
      await api.createLesson({ title, subjectId: subject.id });
      await loadTree();
      showSubject(id);
    } catch (err) {
      toastError(err);
    }
  });

  const newAssignment = el("button", { class: "btn", type: "button" }, "＋ สร้างงาน");
  newAssignment.addEventListener("click", () => {
    if (!subject.lessons.length) return toast("สร้างหัวข้อก่อนอย่างน้อยหนึ่งหัวข้อ", { kind: "err" });
    openAssignmentModal({ subject, lesson: subject.lessons[0], onSaved: () => showSubject(id) });
  });

  const classwork = subject.lessons.length
    ? el("div", {}, subject.lessons.map((lesson) => lessonBlock(subject, lesson, id)))
    : el(
        "div",
        { class: "empty" },
        el("h3", {}, "ยังไม่มีหัวข้อในรายวิชานี้"),
        el("p", {}, "หัวข้อคือกลุ่มของงาน เช่น หน่วยการเรียน หรือสัปดาห์ที่สอน"),
        (() => {
          const b = el("button", { class: "btn", type: "button" }, "สร้างหัวข้อแรก");
          b.addEventListener("click", () => newLesson.click());
          return b;
        })()
      );

  const overview = el("section", { style: "margin-top:40px" });

  setView(
    viewPage(
      banner,
      el("div", { class: "row", style: "margin-bottom:24px" }, newAssignment, newLesson),
      classwork,
      overview
    )
  );

  renderOverview(overview, subject);
}

function lessonBlock(subject, lesson, subjectId) {
  const rename = el("button", { class: "icon-btn sm", type: "button", "aria-label": `เปลี่ยนชื่อหัวข้อ ${lesson.title}`, title: "เปลี่ยนชื่อ" }, "✎");
  rename.addEventListener("click", async () => {
    const title = await showPrompt("ชื่อหัวข้อ", { title: "เปลี่ยนชื่อหัวข้อ", value: lesson.title });
    if (!title) return;
    try {
      await api.updateLesson(lesson.id, title);
      await loadTree();
      showSubject(subjectId);
    } catch (err) {
      toastError(err);
    }
  });

  const remove = el("button", { class: "icon-btn sm", type: "button", "aria-label": `ลบหัวข้อ ${lesson.title}`, title: "ลบหัวข้อ" }, "✕");
  remove.addEventListener("click", async () => {
    const ok = await showConfirm(`ลบหัวข้อ “${lesson.title}” พร้อมงานและผลตรวจข้างในทั้งหมด`, {
      title: "ลบหัวข้อ",
      okLabel: "ลบหัวข้อ",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteLesson(lesson.id);
      await loadTree();
      showSubject(subjectId);
    } catch (err) {
      toastError(err);
    }
  });

  const addWork = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "＋ งานในหัวข้อนี้");
  addWork.addEventListener("click", () =>
    openAssignmentModal({ subject, lesson, onSaved: () => showSubject(subjectId) })
  );

  const rows = lesson.assignments.length
    ? lesson.assignments.map((a) => assignmentRow(a))
    : [el("p", { class: "hint", style: "padding:8px 0" }, "ยังไม่มีงานในหัวข้อนี้")];

  return el(
    "section",
    { class: "topic" },
    el(
      "div",
      { class: "topic-head" },
      el("h2", { class: "topic-title" }, lesson.title),
      el("div", { class: "row-tight" }, addWork, rename, remove)
    ),
    el("div", {}, rows)
  );
}

function assignmentRow(assignment) {
  const row = el(
    "button",
    { class: "work-row", type: "button" },
    el(
      "span",
      { class: "grow" },
      el("span", { class: "work-row-title" }, assignment.title),
      el("br"),
      el("span", { class: "work-row-sub num" }, `${assignment.submission_count || 0} การส่ง`)
    ),
    el("span", { class: "hint" }, "เปิด →")
  );
  row.addEventListener("click", () => navigate(`/assignment/${assignment.id}`));
  return row;
}

async function renderOverview(container, subject) {
  const ids = subject.lessons.flatMap((l) => l.assignments.map((a) => a.id));
  if (!ids.length) return;

  clear(container).append(el("div", { class: "skel skel-row" }));

  let items = [];
  try {
    const lists = await Promise.all(ids.map((id) => api.submissions({ assignmentId: id }).catch(() => [])));
    items = lists.flat();
  } catch {
    items = [];
  }

  let filter = "all";
  let query = "";

  const chips = el("div", { class: "row" });
  const results = el("div", {});
  const search = el("input", { type: "search", placeholder: "ค้นชื่อนักเรียน", style: "max-width:280px" });

  const paint = () => {
    const rule = TRUST_FILTERS.find((f) => f.key === filter);
    const q = query.toLowerCase();
    const shown = items.filter(
      (x) => rule.match(x) && (!q || String(x.student_name || "").toLowerCase().includes(q))
    );

    clear(chips);
    for (const f of TRUST_FILTERS) {
      const count = items.filter(f.match).length;
      const chip = el("button", { class: "chip", type: "button", "aria-pressed": String(filter === f.key) }, `${f.label} ${count}`);
      chip.addEventListener("click", () => {
        filter = f.key;
        paint();
      });
      chips.append(chip);
    }

    clear(results);
    if (!shown.length) {
      results.append(el("p", { class: "hint", style: "padding:16px 0" }, "ไม่มีรายการที่ตรงกับตัวกรองนี้"));
      return;
    }
    const table = el(
      "table",
      { class: "data" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "นักเรียน"),
          el("th", {}, "สถานะ"),
          el("th", { class: "num" }, "คะแนนเชื่อถือ"),
          el("th", {}, "ผล"),
          el("th", { class: "num" }, "ส่งเมื่อ")
        )
      ),
      el(
        "tbody",
        {},
        shown.map((x) =>
          el(
            "tr",
            {},
            el("td", {}, x.student_name || "ไม่ระบุชื่อ"),
            el("td", {}, STATUS_LABEL[x.status] || x.status),
            el("td", { class: "num" }, x.trust_score == null ? "—" : String(x.trust_score)),
            el(
              "td",
              {},
              x.trust_level
                ? el("span", { class: `pill ${x.trust_level === "yellow" ? "amber" : x.trust_level}` }, TRUST_LABEL[x.trust_level])
                : "—"
            ),
            el("td", { class: "num" }, thaiDate(x.created_at))
          )
        )
      )
    );
    results.append(el("div", { class: "table-wrap" }, table));
  };

  search.addEventListener("input", () => {
    query = search.value.trim();
    paint();
  });

  clear(container).append(
    el("div", { class: "section-title" }, el("h2", {}, "ภาพรวมผลตรวจ"), search),
    chips,
    el("div", { style: "margin-top:16px" }, results)
  );
  paint();
}
