import { el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { findAssignment, loadTree } from "../lib/store.js";
import { navigate, currentPath } from "../lib/router.js";
import { setView, viewPage } from "./shell.js";
import { showConfirm } from "../lib/modal.js";
import { toast, toastError } from "../lib/toast.js";
import { submissionCard } from "../components/submission.js";
import { openAssignmentModal } from "../features/assignmentModal.js";
import { mountUploadWizard } from "../features/uploadWizard.js";
import { openDrivePreview } from "../features/drivePreview.js";
import { TRUST_LABEL } from "../lib/format.js";

const POLL_MS = 5000;
let pollTimer = null;

const FILTERS = [
  { key: "all", label: "ทั้งหมด" },
  { key: "green", label: TRUST_LABEL.green },
  { key: "yellow", label: TRUST_LABEL.yellow },
  { key: "red", label: TRUST_LABEL.red },
  { key: "pending", label: "กำลังประมวลผล" },
];

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

export async function showAssignment(id) {
  stopPolling();

  let found = findAssignment(id);
  if (!found) {
    await loadTree().catch(() => {});
    found = findAssignment(id);
    if (!found) return navigate("/", { replace: true });
  }
  const { assignment, lesson, subject } = found;

  const backBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "← กลับไป " + subject.name);
  backBtn.addEventListener("click", () => navigate(`/subject/${subject.id}`));

  const editBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "แก้ไขงาน");
  editBtn.addEventListener("click", () =>
    openAssignmentModal({ subject, lesson, assignment, onSaved: () => showAssignment(id) })
  );

  const previewBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "ดูไฟล์ต้นฉบับ");
  previewBtn.addEventListener("click", () => openDrivePreview({ url: assignment.drive_url, name: assignment.title }));

  const deleteBtn = el("button", { class: "btn btn-danger btn-sm", type: "button" }, "ลบงาน");
  deleteBtn.addEventListener("click", async () => {
    const ok = await showConfirm(`ลบงาน “${assignment.title}” พร้อมผลตรวจของนักเรียนทุกคนในงานนี้`, {
      title: "ลบงาน",
      okLabel: "ลบงาน",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAssignment(assignment.id);
      await loadTree();
      toast("ลบงานแล้ว");
      navigate(`/subject/${subject.id}`);
    } catch (err) {
      toastError(err);
    }
  });

  // เนื้อหาที่ระบบดึงมาจาก Drive คือสิ่งที่ AI ใช้ตรวจจริง ครูควรตรวจสอบได้เอง
  // และสั่งดึงใหม่ได้เมื่อไปแก้ไฟล์ต้นฉบับ (ลิงก์เดิม เนื้อหาใหม่)
  const sourceBox = el("section", { style: "margin-bottom:24px" });
  const renderSource = async () => {
    clear(sourceBox);
    sourceBox.append(el("div", { class: "skel skel-row" }));
    let data;
    try {
      data = await api.assignmentSource(assignment.id);
    } catch (err) {
      clear(sourceBox);
      sourceBox.append(el("p", { class: "hint" }, `ดูเนื้อหาที่ดึงมาไม่ได้: ${err.message}`));
      return;
    }

    const refreshBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "ดึงเนื้อหาใหม่จาก Drive");
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "กำลังดึง…";
      try {
        const r = await api.refreshAssignmentSource(assignment.id);
        toast(r.changed ? `เนื้อหาเปลี่ยนไป — ตอนนี้ ${r.charCount} ตัวอักษร` : "เนื้อหายังเหมือนเดิม");
        await renderSource();
      } catch (err) {
        toastError(err);
        refreshBtn.disabled = false;
        refreshBtn.textContent = "ดึงเนื้อหาใหม่จาก Drive";
      }
    });

    const fetched = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("th-TH") : "ยังไม่เคยบันทึกเวลา";

    clear(sourceBox);
    sourceBox.append(
      el(
        "details",
        {},
        el("summary", {}, `เนื้อหางานที่ระบบดึงมา (${data.charCount} ตัวอักษร)`),
        el(
          "div",
          { class: "coach-block", style: "margin-top:12px" },
          el("p", { class: "hint" }, `ดึงล่าสุด: ${fetched} · ระบบจะดึงซ้ำให้เองเมื่อเนื้อหาเก่าเกินกำหนดตอนมีนักเรียนส่งงาน`),
          el("div", { class: "row" }, refreshBtn),
          el(
            "pre",
            { class: "quote", style: "white-space:pre-wrap; max-height:320px; overflow:auto" },
            data.sourceText || "(ไม่มีเนื้อหา)"
          ),
          data.searchLinks?.length
            ? el(
                "div",
                {},
                el("p", { class: "hint" }, "ค้นแหล่งอ้างอิงจากเนื้องานนี้:"),
                el(
                  "div",
                  { class: "row" },
                  data.searchLinks.map((s) =>
                    el(
                      "a",
                      { class: "btn btn-ghost btn-sm", href: s.url, target: "_blank", rel: "noopener noreferrer" },
                      s.source
                    )
                  )
                )
              )
            : null
        )
      )
    );
  };

  const wizardBox = el("section", { style: "margin-bottom:32px" });
  const listBox = el("div", {});
  const search = el("input", { type: "search", placeholder: "ค้นชื่อนักเรียนหรือข้อความในคำอธิบาย", style: "max-width:320px" });
  const chips = el("div", { class: "row" });

  let submissions = [];
  let filter = "all";

  const matches = (s) => {
    const q = search.value.trim().toLowerCase();
    if (q && !`${s.student_name || ""} ${s.transcript || ""}`.toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    if (filter === "pending") return s.status !== "done" && s.status !== "error";
    return s.status === "done" && s.trust_level === filter;
  };

  const paintChips = () => {
    clear(chips);
    for (const f of FILTERS) {
      const chip = el("button", { class: "chip", type: "button", "aria-pressed": String(filter === f.key) }, f.label);
      chip.addEventListener("click", () => {
        filter = f.key;
        paintChips();
        paintList();
      });
      chips.append(chip);
    }
  };

  const refresh = () => showAssignment(id);

  const paintList = () => {
    const shown = submissions.filter(matches);
    clear(listBox);
    if (!submissions.length) {
      listBox.append(
        el(
          "div",
          { class: "empty" },
          el("h3", {}, "ยังไม่มีนักเรียนส่งงานนี้"),
          el("p", {}, "เพิ่มไฟล์เสียงคำอธิบายและชิ้นงานของนักเรียนด้านบน ระบบจะถอดเสียงและวิเคราะห์ให้อัตโนมัติ")
        )
      );
      return;
    }
    if (!shown.length) {
      listBox.append(el("p", { class: "hint", style: "padding:16px 0" }, "ไม่มีรายการที่ตรงกับตัวกรองนี้"));
      return;
    }
    for (const s of shown) listBox.append(submissionCard(s, refresh));
  };

  const load = async () => {
    submissions = await api.submissions({ assignmentId: assignment.id });
    paintList();
    schedulePoll();
  };

  function schedulePoll() {
    stopPolling();
    const pending = submissions.some((s) => s.status !== "done" && s.status !== "error");
    const coachingPending = submissions.some((s) => s.status === "done" && !s.coaching && !s.coaching_error);
    if (!pending && !coachingPending) return;
    pollTimer = setTimeout(async () => {
      // Stop polling as soon as the teacher navigates away from this assignment.
      if (currentPath() !== `/assignment/${id}`) return stopPolling();
      try {
        await load();
      } catch {
        schedulePoll();
      }
    }, POLL_MS);
  }

  setView(
    viewPage(
      el(
        "header",
        { class: "page-head" },
        backBtn,
        el("span", { class: "eyebrow" }, `${subject.name} · ${lesson.title}`),
        el("h1", { class: "page-title" }, assignment.title),
        el("div", { class: "row" }, previewBtn, editBtn, deleteBtn)
      ),
      sourceBox,
      wizardBox,
      el("div", { class: "section-title" }, el("h2", {}, "ผลตรวจของนักเรียน"), search),
      chips,
      el("div", { style: "margin-top:16px" }, listBox)
    )
  );

  paintChips();
  search.addEventListener("input", paintList);
  mountUploadWizard(wizardBox, {
    assignment,
    roster: await api.students({ subjectId: subject.id }).catch(() => []),
    onSubmitted: load,
  });

  renderSource();

  listBox.append(el("div", { class: "skel skel-row" }), el("div", { class: "skel skel-row" }));
  load().catch(toastError);
}
