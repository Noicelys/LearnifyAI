import { el, clear } from "../lib/dom.js";
import { openModal } from "../lib/modal.js";
import { api } from "../lib/api.js";

/* Two ways to look at the same Drive file: the embedded viewer (what the
   teacher sees) and the extracted text (what the analyzer actually reads). */
export function openDrivePreview({ url, id, name }) {
  const tabEmbed = el("button", { type: "button", "aria-selected": "true" }, "ตัวอย่างไฟล์");
  const tabText = el("button", { type: "button", "aria-selected": "false" }, "ข้อความที่ระบบอ่านได้");
  const tabs = el("div", { class: "tabs" }, tabEmbed, tabText);

  const pane = el("div", { style: "margin-top:16px" });
  const openExternal = el("a", { class: "btn btn-secondary btn-sm", href: url || "#", target: "_blank", rel: "noopener noreferrer" }, "เปิดใน Drive");

  const modal = openModal({
    title: name || "ไฟล์งาน",
    wide: true,
    body: el("div", { class: "stack" }, el("div", { class: "row" }, openExternal), tabs, pane),
  });

  let data = null;
  const showEmbed = () => {
    clear(pane);
    if (!data?.embedUrl) return pane.append(el("p", { class: "hint" }, "ไฟล์นี้ไม่มีตัวอย่างแบบฝัง"));
    pane.append(el("iframe", { src: data.embedUrl, style: "width:100%;height:60dvh;border:1px solid var(--line);border-radius:10px", title: "ตัวอย่างไฟล์" }));
  };
  const showText = () => {
    clear(pane);
    pane.append(
      el("p", { class: "hint num" }, `${data?.charCount ?? 0} ตัวอักษร`),
      el("pre", { class: "quote", style: "white-space:pre-wrap;max-height:60dvh;overflow:auto" }, data?.text || "อ่านข้อความจากไฟล์นี้ไม่ได้")
    );
  };

  const select = (embed) => {
    tabEmbed.setAttribute("aria-selected", String(embed));
    tabText.setAttribute("aria-selected", String(!embed));
    embed ? showEmbed() : showText();
  };
  tabEmbed.addEventListener("click", () => select(true));
  tabText.addEventListener("click", () => select(false));

  pane.append(el("div", { class: "row hint" }, el("span", { class: "spinner" }), "กำลังเปิดไฟล์…"));
  api
    .drivePreview({ url, id, name })
    .then((res) => {
      data = res;
      if (res.driveUrl) openExternal.href = res.driveUrl;
      select(true);
    })
    .catch((err) => {
      clear(pane).append(el("div", { class: "alert err" }, err.message));
    });

  return modal;
}
