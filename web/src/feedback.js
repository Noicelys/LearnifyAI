import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

import { $, el, clear } from "./lib/dom.js";
import { api } from "./lib/api.js";
import { renderCoaching } from "./components/coaching.js";
import "./lib/theme.js";

/* The student view deliberately never shows the trust score, the flags, or
   the audio — only the coaching the teacher chose to share. */
const token = location.pathname.split("/").filter(Boolean).pop();

function render(data) {
  const page = $("#page");
  clear(page).removeAttribute("aria-busy");

  page.append(
    el(
      "header",
      { class: "page-head" },
      el("span", { class: "eyebrow" }, "คำแนะนำสำหรับงานของคุณ"),
      el("h1", { class: "page-title" }, data.assignmentTitle || "งานของคุณ"),
      el("p", { class: "hint" }, data.studentName || "")
    ),
    renderCoaching(data.coaching || {}, { audience: "student" }),
    data.transcript
      ? el("details", { style: "margin-top:24px" }, el("summary", {}, "คำอธิบายที่คุณส่งไว้"), el("div", { class: "quote" }, `“${data.transcript}”`))
      : null
  );
}

function renderError(message) {
  const page = $("#page");
  clear(page).removeAttribute("aria-busy");
  const retry = el("button", { class: "btn", type: "button" }, "ลองใหม่");
  retry.addEventListener("click", () => location.reload());
  page.append(
    el(
      "div",
      { class: "empty" },
      el("h3", {}, "เปิดคำแนะนำนี้ไม่ได้"),
      el("p", {}, message || "ลิงก์อาจถูกยกเลิก หรือครูยังไม่ได้เปิดให้ดู ลองสอบถามครูผู้สอนอีกครั้ง"),
      retry
    )
  );
}

api
  .feedback(token)
  .then(render)
  .catch((err) => renderError(err.message));
