import { el } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { renderCoaching } from "./coaching.js";
import { thaiDateTime, TRUST_LABEL, STATUS_LABEL, SCORE_LABEL } from "../lib/format.js";
import { toast, toastError } from "../lib/toast.js";
import { showConfirm } from "../lib/modal.js";

function verdict(s) {
  if (s.status === "error") return el("span", { class: "verdict red" }, "วิเคราะห์ไม่สำเร็จ");
  if (s.status !== "done") return el("span", { class: "pill" }, el("span", { class: "spinner" }), STATUS_LABEL[s.status] || s.status);
  return el(
    "span",
    { class: `verdict ${s.trust_level || "yellow"}` },
    el("b", {}, TRUST_LABEL[s.trust_level] || "—"),
    el("span", { class: "num" }, `${s.trust_score ?? "—"}/100`)
  );
}

function scoreRow(key, value) {
  // A null dimension is an older analysis that never had it — showing 0 would lie.
  if (value == null) return null;
  return el(
    "div",
    { class: "score-row" },
    el("span", {}, SCORE_LABEL[key]),
    el("span", { class: "score-track" }, el("span", { class: "score-fill", style: `width:${value}%` })),
    el("span", { class: "score-value num" }, String(value))
  );
}

/* ประเด็นหลักที่ระบบสรุปจากเนื้องาน พร้อมสถานะว่านักเรียนพูดถึงหรือยัง
   เป็นที่มาของคะแนน "ตรงกับเนื้องาน" ครูจึงต้องเห็นรายข้อ ไม่ใช่เห็นแค่ตัวเลข
   ข้อที่ยังไม่พูดถึงคือคำถามตามที่ครูหยิบไปใช้ได้ทันที */
const COVERAGE_MARK = { yes: "✓ พูดถึงแล้ว", partial: "~ แตะผ่าน ๆ", no: "✗ ยังไม่พูดถึง" };

function coverageBlock(s) {
  if (!s.coverage?.length) return null;

  const done = s.coverage.filter((c) => c.covered === "yes").length;
  return el(
    "details",
    { class: "coach-section" },
    el("summary", {}, `ประเด็นในเนื้องาน — พูดถึงครบ ${done}/${s.coverage.length} ข้อ`),
    el(
      "ul",
      { class: "coach-list", style: "margin-top:8px" },
      s.coverage.map((c) =>
        el(
          "li",
          {},
          el("span", {}, `${COVERAGE_MARK[c.covered] || COVERAGE_MARK.no} — ${c.point}`),
          c.quote ? el("div", { class: "quote", style: "margin-top:4px" }, `“${c.quote}”`) : null
        )
      )
    )
  );
}

function busyButton(label, busyLabel, run, onDone) {
  const btn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, label);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await run();
      onDone?.();
    } catch (err) {
      toastError(err);
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return btn;
}

function shareRow(s, refresh) {
  if (!s.share_token) {
    return el(
      "div",
      { class: "row" },
      busyButton("สร้างลิงก์ให้นักเรียน", "กำลังสร้าง…", () => api.share(s.id), refresh),
      el("span", { class: "hint" }, "นักเรียนเปิดอ่านคำแนะนำได้เอง ไม่เห็นคะแนนเชื่อถือและข้อสงสัยของครู")
    );
  }
  const url = `${location.origin}/f/${s.share_token}`;
  const input = el("input", { type: "text", readOnly: true, value: url, style: "max-width:340px" });
  const copy = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "คัดลอกลิงก์");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "คัดลอกแล้ว ✓";
    } catch {
      // Clipboard API is unavailable over plain http, so let the teacher copy by hand.
      input.select();
      copy.textContent = "กด Ctrl+C";
    }
    setTimeout(() => (copy.textContent = "คัดลอกลิงก์"), 1800);
  });
  return el(
    "div",
    { class: "row" },
    input,
    copy,
    busyButton("ยกเลิกลิงก์", "กำลังยกเลิก…", () => api.unshare(s.id), refresh)
  );
}

function coachingBlock(s, refresh) {
  if (!s.coaching) {
    return el(
      "div",
      { class: "coach-section" },
      s.coaching_error
        ? el("div", { class: "alert err" }, s.coaching_error)
        : el("div", { class: "row hint" }, el("span", { class: "spinner" }), "กำลังเขียนคำแนะนำให้นักเรียน…"),
      s.coaching_error ? busyButton("เขียนใหม่", "กำลังเขียน…", () => api.generateCoaching(s.id), refresh) : null
    );
  }
  return el(
    "div",
    { class: "stack" },
    el("h4", { class: "eyebrow" }, "คำแนะนำสำหรับนักเรียน"),
    renderCoaching(s.coaching),
    shareRow(s, refresh),
    busyButton("เขียนคำแนะนำใหม่", "กำลังเขียน…", () => api.generateCoaching(s.id), refresh)
  );
}

function overrideBlock(s) {
  const score = el("input", { type: "number", min: "0", max: "100", value: s.teacher_score ?? "", placeholder: "—" });
  const note = el("input", { type: "text", value: s.teacher_note ?? "", placeholder: "เช่น คุยเพิ่มแล้ว อธิบายได้ดี" });
  const save = el("button", { class: "btn btn-secondary", type: "button" }, "บันทึก");

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api.updateSubmission(s.id, { teacherScore: score.value, teacherNote: note.value });
      save.textContent = "บันทึกแล้ว ✓";
      setTimeout(() => {
        save.textContent = "บันทึก";
        save.disabled = false;
      }, 1600);
    } catch (err) {
      toastError(err);
      save.disabled = false;
    }
  });

  return el(
    "div",
    { class: "coach-section" },
    el("h4", {}, "การตัดสินของครู"),
    el(
      "div",
      { class: "field-row" },
      el("label", { class: "field" }, el("span", {}, "คะแนนครู (0-100)"), score),
      el("label", { class: "field" }, el("span", {}, "บันทึกของครู"), note)
    ),
    el("div", { style: "margin-top:12px" }, save),
    el("p", { class: "hint", style: "margin-top:8px" }, "คะแนนของครูมีผลเหนือผลวิเคราะห์เสมอ")
  );
}

export function submissionCard(s, refresh) {
  const body = el("div", { class: "sub-body" });
  const head = el(
    "div",
    { class: "sub-head" },
    el(
      "span",
      { class: "grow" },
      el("span", { class: "sub-name" }, s.student_name || "ไม่ระบุชื่อ"),
      el("br"),
      el("span", { class: "sub-meta" }, `${thaiDateTime(s.created_at)} · ${s.input_mode === "text" ? "พิมพ์ตอบ" : "อัดเสียง"}`)
    ),
    verdict(s)
  );

  const card = el("article", { class: "sub-card", dataset: { id: String(s.id) } }, head, body);

  if (s.status === "error") {
    body.append(
      el("div", { class: "alert err" }, s.error_message || "เกิดข้อผิดพลาด"),
      el(
        "div",
        { class: "row" },
        busyButton("ลองวิเคราะห์ใหม่", "กำลังส่งเข้าคิว…", () => api.reanalyze(s.id), refresh),
        el("span", { class: "hint" }, "บริการวิเคราะห์อาจล่มหรือติดคิวชั่วคราว")
      )
    );
  } else if (s.status !== "done") {
    body.append(el("div", { class: "row hint" }, el("span", { class: "spinner" }), `${STATUS_LABEL[s.status] || s.status}…`));
  } else {
    if (s.needs_followup) {
      body.append(el("div", { class: "alert warn" }, "คะแนนก้ำกึ่ง — ควรถามคำถามตามสัก 1 ข้อก่อนสรุป"));
    }
    if (s.flags?.length) body.append(el("ul", { class: "coach-list" }, s.flags.map((f) => el("li", {}, f))));

    body.append(
      el(
        "div",
        { class: "score-bars" },
        Object.keys(SCORE_LABEL)
          .map((key) => scoreRow(key, s[key]))
          .filter(Boolean)
      )
    );

    const cov = coverageBlock(s);
    if (cov) body.append(cov);

    if (s.reasons?.length) body.append(el("ul", { class: "coach-list" }, s.reasons.map((r) => el("li", {}, r))));
    body.append(coachingBlock(s, refresh));
  }

  if (s.transcript) {
    const quote = el("div", { class: "quote" }, `“${s.transcript}”`);
    body.append(
      s.transcript.length > 260
        ? el("details", {}, el("summary", {}, "อ่านคำอธิบายทั้งหมด"), quote)
        : quote
    );
  }
  if (s.input_mode === "voice") {
    body.append(el("audio", { controls: true, preload: "none", src: `/api/submissions/${s.id}/audio`, style: "width:100%" }));
  }

  body.append(overrideBlock(s));

  const remove = el("button", { class: "btn btn-danger btn-sm", type: "button" }, "ลบการส่งนี้");
  remove.addEventListener("click", async () => {
    const ok = await showConfirm(`ลบการส่งของ ${s.student_name || "นักเรียนคนนี้"} รวมถึงไฟล์เสียงและผลตรวจ`, {
      title: "ลบการส่ง",
      okLabel: "ลบ",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSubmission(s.id);
      toast("ลบการส่งแล้ว");
      refresh?.();
    } catch (err) {
      toastError(err);
    }
  });
  body.append(el("div", { class: "row" }, remove));

  // Collapse the detail on click so a long class list stays scannable.
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
  });

  return card;
}
