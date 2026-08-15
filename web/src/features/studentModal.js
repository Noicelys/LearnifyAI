import { el } from "../lib/dom.js";
import { openModal } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { thaiDate, TRUST_LABEL, STATUS_LABEL } from "../lib/format.js";

const STATUSES = ["กำลังศึกษา", "พักการเรียน", "พ้นสภาพ", "จบการศึกษา"];

export function openStudentForm({ student = null, subjectId = null, onSaved }) {
  const editing = Boolean(student);
  const input = (value = "", attrs = {}) => el("input", { type: "text", value: value ?? "", ...attrs });

  const studentNo = input(student?.student_no, { required: !editing, placeholder: "รหัสนักเรียน" });
  const rollNo = input(student?.roll_no, { placeholder: "1" });
  const firstName = input(student?.first_name, { required: true });
  const lastName = input(student?.last_name, { required: true });
  const department = input(student?.department, { placeholder: "ช่างเชื่อมโลหะ" });
  const classLevel = input(student?.class_level, { placeholder: "ปวช.2" });
  const room = input(student?.room, { placeholder: "1" });
  const note = input(student?.note, { placeholder: "บันทึกเพิ่มเติม" });
  const status = el(
    "select",
    {},
    STATUSES.map((s) => el("option", { value: s, selected: (student?.status || STATUSES[0]) === s }, s))
  );

  const msg = el("div", { class: "msg" });
  const submit = el("button", { class: "btn", type: "submit", form: "student-form" }, editing ? "บันทึก" : "เพิ่มนักเรียน");

  const form = el(
    "form",
    { class: "stack", id: "student-form" },
    el("div", { class: "field-row" }, el("label", { class: "field" }, el("span", {}, "รหัสนักเรียน"), studentNo), el("label", { class: "field" }, el("span", {}, "เลขที่"), rollNo)),
    el("div", { class: "field-row" }, el("label", { class: "field" }, el("span", {}, "ชื่อ"), firstName), el("label", { class: "field" }, el("span", {}, "นามสกุล"), lastName)),
    el("label", { class: "field" }, el("span", {}, "แผนกวิชา"), department),
    el("div", { class: "field-row" }, el("label", { class: "field" }, el("span", {}, "ชั้น"), classLevel), el("label", { class: "field" }, el("span", {}, "ห้อง"), room)),
    el("div", { class: "field-row" }, el("label", { class: "field" }, el("span", {}, "สถานะ"), status), el("label", { class: "field" }, el("span", {}, "หมายเหตุ"), note)),
    msg
  );

  const modal = openModal({
    title: editing ? "แก้ไขข้อมูลนักเรียน" : "เพิ่มนักเรียน",
    body: form,
    footer: [submit],
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    msg.textContent = "";
    msg.className = "msg";
    const payload = {
      studentNo: studentNo.value.trim(),
      rollNo: rollNo.value.trim(),
      firstName: firstName.value.trim(),
      lastName: lastName.value.trim(),
      department: department.value.trim(),
      classLevel: classLevel.value.trim(),
      room: room.value.trim(),
      status: status.value,
      note: note.value.trim(),
    };
    try {
      if (editing) await api.updateStudent(student.id, payload);
      else await api.createStudent({ ...payload, subjectId: subjectId || undefined });
      toast(editing ? "บันทึกข้อมูลแล้ว" : "เพิ่มนักเรียนแล้ว");
      modal.close();
      onSaved?.();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg err";
      submit.disabled = false;
    }
  });
}

export async function openStudentDetail(studentId) {
  const body = el("div", { class: "stack" }, el("div", { class: "skel skel-line" }), el("div", { class: "skel skel-card" }));
  const modal = openModal({ title: "ข้อมูลนักเรียน", wide: true, body });

  let data;
  try {
    data = await api.studentDetails(studentId);
  } catch (err) {
    return modal.setBody(el("div", { class: "alert err" }, err.message));
  }

  const s = data.student;
  const stat = (label, value) => el("div", { class: "stat" }, el("div", { class: "stat-value" }, String(value)), el("div", { class: "stat-label" }, label));

  modal.setBody(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "stack-sm" },
        el("h3", {}, s.full_name),
        el("p", { class: "hint mono" }, [s.student_no, s.department, [s.class_level, s.room].filter(Boolean).join("/")].filter(Boolean).join(" · "))
      ),
      el("div", { class: "stat-grid" }, stat("รายวิชา", data.subjects.length), stat("การส่งงาน", data.submissions.length), stat("สถานะ", s.status || "—")),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "data" },
          el("thead", {}, el("tr", {}, el("th", {}, "งาน"), el("th", {}, "รายวิชา"), el("th", {}, "สถานะ"), el("th", {}, "ผล"), el("th", { class: "num" }, "ส่งเมื่อ"))),
          el(
            "tbody",
            {},
            data.submissions.length
              ? data.submissions.map((x) =>
                  el(
                    "tr",
                    {},
                    el("td", {}, x.assignment_title || "—"),
                    el("td", {}, x.subject_name || "—"),
                    el("td", {}, STATUS_LABEL[x.status] || x.status),
                    el("td", {}, x.trust_level ? el("span", { class: `pill ${x.trust_level === "yellow" ? "amber" : x.trust_level}` }, TRUST_LABEL[x.trust_level]) : "—"),
                    el("td", { class: "num" }, thaiDate(x.created_at))
                  )
                )
              : el("tr", {}, el("td", { colSpan: "5", class: "hint" }, "ยังไม่มีการส่งงาน"))
          )
        )
      )
    )
  );
}
