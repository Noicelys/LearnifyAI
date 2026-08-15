import { el } from "../lib/dom.js";
import { openModal } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { autoConvertOnInput } from "../lib/drive.js";
import { loadTree } from "../lib/store.js";
import { toast } from "../lib/toast.js";

/* Creating an assignment makes the server fetch and extract the Drive document,
   so the submit button has to stay busy until that round trip finishes. */
export function openAssignmentModal({ subject, lesson, assignment = null, onSaved }) {
  const editing = Boolean(assignment);

  const title = el("input", { type: "text", required: true, value: assignment?.title || "", placeholder: "เช่น ใบงานที่ 3 การเชื่อมต่อชน" });
  const url = el("input", { type: "url", required: !editing, value: assignment?.drive_url || "", placeholder: "https://drive.google.com/file/d/..." });
  autoConvertOnInput(url);

  const lessonSelect = el(
    "select",
    {},
    subject.lessons.map((l) =>
      el("option", { value: String(l.id), selected: String(l.id) === String(lesson?.id ?? assignment?.lesson_id) }, l.title)
    )
  );

  const msg = el("div", { class: "msg" });
  const busy = el("span", { class: "spinner", hidden: true });
  const submit = el("button", { class: "btn", type: "submit", form: "assignment-form" }, editing ? "บันทึก" : "สร้างงาน");

  const form = el(
    "form",
    { class: "stack", id: "assignment-form" },
    el("label", { class: "field" }, el("span", {}, "ชื่องาน"), title),
    el("label", { class: "field" }, el("span", {}, "หัวข้อ"), lessonSelect),
    el(
      "label",
      { class: "field" },
      el("span", {}, "ลิงก์งานใน Google Drive"),
      url,
      el("span", { class: "hint" }, "ตั้งค่าแชร์เป็น “ผู้ที่มีลิงก์” ก่อน ระบบจึงจะดึงข้อความในไฟล์มาเทียบได้")
    ),
    editing
      ? el("div", { class: "alert warn" }, "ถ้าเปลี่ยนลิงก์ ระบบจะดึงเนื้อหางานใหม่ ผลตรวจเดิมจะยังอยู่แต่เทียบกับเนื้อหาชุดเก่า")
      : null,
    msg
  );

  const modal = openModal({
    title: editing ? "แก้ไขงาน" : "สร้างงาน",
    body: el("div", { class: "stack" }, el("p", { class: "hint" }, `${subject.name}${lesson ? ` · ${lesson.title}` : ""}`), form),
    footer: [busy, submit],
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    busy.hidden = false;
    msg.textContent = "";
    msg.className = "msg";
    try {
      const driveUrl = url.value.trim();
      // ตอนแก้ไข ส่งลิงก์ไปเฉพาะเมื่อครูเปลี่ยนจริง — ส่งค่าว่างไปจะโดนปฏิเสธทั้งที่ตั้งใจแก้แค่ชื่องาน
      const saved = editing
        ? await api.updateAssignment(assignment.id, {
            title: title.value.trim(),
            ...(driveUrl && driveUrl !== assignment.drive_url ? { driveUrl } : {}),
          })
        : await api.createAssignment({ title: title.value.trim(), driveUrl, lessonId: Number(lessonSelect.value) });
      await loadTree();
      toast(editing ? "บันทึกงานแล้ว" : "สร้างงานแล้ว");
      modal.close();
      onSaved?.(saved);
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg err";
    } finally {
      submit.disabled = false;
      busy.hidden = true;
    }
  });

  return modal;
}
