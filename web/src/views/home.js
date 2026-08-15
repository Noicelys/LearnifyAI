import { el } from "../lib/dom.js";
import { state, subjectTally } from "../lib/store.js";
import { navigate } from "../lib/router.js";
import { setView, viewPage, createSubject } from "./shell.js";
import { subjectColor, backgroundUrl } from "../components/subjectTheme.js";

function stat(value, label) {
  return el("div", { class: "stat" }, el("div", { class: "stat-value" }, String(value)), el("div", { class: "stat-label" }, label));
}

function subjectCard(subject) {
  const tally = subjectTally(subject);
  const image = backgroundUrl(subject);
  const cover = el("div", {
    class: "subject-cover",
    style: image
      ? `background-color:${subjectColor(subject)};background-image:url('${image}')`
      : `background-color:${subjectColor(subject)}`,
  });

  const openBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "เปิดรายวิชา");
  openBtn.addEventListener("click", () => navigate(`/subject/${subject.id}`));

  return el(
    "article",
    { class: "subject-card" },
    cover,
    el(
      "div",
      { class: "subject-card-body" },
      el("h3", { class: "subject-card-title" }, subject.name),
      el(
        "p",
        { class: "hint num" },
        `${tally.lessons} หัวข้อ · ${tally.assignments} งาน · ${tally.submissions} การส่ง`
      ),
      el("p", { class: "hint num" }, `${subject.student_count ?? 0} นักเรียน`)
    ),
    el("div", { class: "subject-card-foot" }, openBtn)
  );
}

export function showHome() {
  const subjects = state.tree;
  const totals = subjects.reduce(
    (acc, s) => {
      const t = subjectTally(s);
      acc.assignments += t.assignments;
      acc.submissions += t.submissions;
      acc.students += s.student_count || 0;
      return acc;
    },
    { assignments: 0, submissions: 0, students: 0 }
  );

  const newSubject = el("button", { class: "btn", type: "button" }, "＋ สร้างรายวิชา");
  newSubject.addEventListener("click", createSubject);

  const body = subjects.length
    ? el("div", { class: "subject-grid" }, subjects.map(subjectCard))
    : el(
        "div",
        { class: "empty" },
        el("h3", {}, "ยังไม่มีรายวิชา"),
        el("p", {}, "สร้างรายวิชาแรกเพื่อเริ่มเพิ่มหัวข้อ งาน และรายชื่อนักเรียน"),
        (() => {
          const b = el("button", { class: "btn", type: "button" }, "สร้างรายวิชา");
          b.addEventListener("click", createSubject);
          return b;
        })()
      );

  setView(
    viewPage(
      el(
        "header",
        { class: "page-head" },
        el("span", { class: "eyebrow" }, "กระดานงาน"),
        el("div", { class: "spread" }, el("h1", { class: "page-title" }, "รายวิชาของฉัน"), newSubject)
      ),
      el(
        "div",
        { class: "stat-grid", style: "margin-bottom:32px" },
        stat(subjects.length, "รายวิชา"),
        stat(totals.assignments, "งานทั้งหมด"),
        stat(totals.submissions, "การส่งงาน"),
        stat(totals.students, "นักเรียนในระบบ")
      ),
      body
    )
  );
}
