import { el } from "../lib/dom.js";

/* Shared by the teacher view and the student feedback page.
   The first line is the system's own wording; anything inside quotes is the
   source's real text, so a reader can always tell them apart. */
/* หนึ่งแหล่งอ้างอิง = หนึ่งการ์ด เรียงบนลงล่างเสมอ
   ทุกส่วนเป็น block ไม่งั้นข้อความสองก้อนจะเรียงชนกันจนอ่านเป็นประโยคเดียว

   สามชนิดต่างกันที่ระดับความน่าเชื่อถือ จึงแยกสีและมีป้ายกำกับข้อความคู่กันเสมอ
   (สีอย่างเดียวคนตาบอดสีอ่านไม่ได้) */
const CITE_BADGE = {
  web: (p) => `บทความที่ระบบอ่านมา${p.source ? ` · ${p.source}` : ""}`,
  search: (p) => `ลิงก์ค้นหา${p.source ? ` · ${p.source}` : ""}`,
  doc: () => "ข้อความจากเอกสารงานของนักเรียนเอง",
};

function cite(p) {
  const badge = CITE_BADGE[p.kind]?.(p);
  // excerpt ของบทความเว็บผ่านการตรวจว่าตรงกับต้นฉบับจริงแล้ว จึงใส่อัญประกาศได้
  // ส่วน summary ของหลักการเป็นคำสรุปของระบบเอง ต้องแสดงเป็นข้อความธรรมดา
  const quote = p.excerpt || "";

  return el(
    "div",
    { class: "cite-card", dataset: { kind: p.kind || "other" } },
    badge ? el("span", { class: "cite-badge" }, badge) : null,
    p.title ? el("b", { class: "cite-title" }, p.title) : null,
    p.whyRelevant ? el("p", { class: "hint" }, `เกี่ยวกับงานนี้: ${p.whyRelevant}`) : null,
    p.summary ? el("p", { class: "cite-summary" }, p.summary) : null,
    quote ? el("blockquote", { class: "quote" }, `“${quote}”`) : null,
    p.excerptFrom ? el("span", { class: "hint" }, `ที่มาของข้อความ: ${p.excerptFrom}`) : null,
    p.citation || p.url
      ? p.url
        ? el(
            "a",
            { class: "cite-link", href: p.url, target: "_blank", rel: "noopener noreferrer" },
            `${p.citation || p.url} ↗`
          )
        : el("span", { class: "cite-link hint" }, p.citation)
      : null
  );
}

/* แต่ละส่วนของคำแนะนำทำหน้าที่ต่างกัน (คำชม · จุดที่ต้องแก้ · สิ่งที่ต้องทำต่อ)
   จึงให้โทนสีคนละโทน ครูจะได้กวาดตาแล้วรู้ว่าอ่านอะไรอยู่โดยไม่ต้องไล่อ่านหัวข้อทุกอัน
   หัวข้อยังเป็นข้อความชัดเจนเสมอ — สีเป็นตัวช่วย ไม่ใช่ตัวสื่อความหมายลำพัง */
function section(title, tone, ...children) {
  return el("div", { class: "coach-section", dataset: { tone } }, el("h4", {}, title), ...children);
}

function list(items, ordered = false) {
  return el(ordered ? "ol" : "ul", { class: "coach-list" }, items.map((x) => el("li", {}, x)));
}

function standingCard(s) {
  const checklist = s.checklist || [];
  const done = checklist.filter((x) => x.done).length;
  const missing = checklist.filter((x) => !x.done).map((x) => x.item);
  const tone = done === checklist.length ? "green" : done ? "amber" : "";
  return el(
    "div",
    { class: "coach-section" },
    el(
      "div",
      { class: "row" },
      el("b", {}, s.label || ""),
      el("span", { class: `pill ${tone}` }, s.bandLabel || ""),
      el("span", { class: "hint num" }, `มีแล้ว ${done}/${checklist.length} ส่วน`)
    ),
    missing.length ? el("p", { class: "hint" }, `ยังขาด: ${missing.join(" · ")}`) : null,
    s.nextDesc ? el("p", { class: "hint" }, `ขึ้นระดับถัดไปต้อง: ${s.nextDesc}`) : null
  );
}

function lessonCard(l) {
  return el(
    "div",
    { class: "coach-section" },
    el("span", { class: "eyebrow" }, l.dimensionLabel || ""),
    el("p", { class: "quote" }, l.skeleton || ""),
    el("p", {}, l.filled || ""),
    l.blanks?.length ? el("p", { class: "hint" }, `เว้นว่างให้นักเรียนเติมเอง: ${l.blanks.join(" · ")}`) : null
  );
}

function rewriteCard(r) {
  return el(
    "div",
    { class: "coach-section rewrite" },
    r.dimensionLabel ? el("span", { class: "eyebrow" }, r.dimensionLabel) : null,
    el("span", { class: "hint" }, "ตอนนี้พูดว่า"),
    el("p", { class: "quote" }, `“${r.quote || ""}”`),
    el("span", { class: "hint" }, "ลองแบบนี้"),
    el("p", { class: "rewrite-improved" }, r.improved || ""),
    r.whatChanged ? el("p", { class: "hint" }, `ต่างกันตรงไหน: ${r.whatChanged}`) : null
  );
}

/* จุดตำหนิ — ลำดับการอ่านคงที่เสมอ: พูดว่าอะไร → ผิดตรงไหน → ที่ถูกคืออะไร → ทำไม → ที่มา
   ที่มาอยู่ล่างสุดของทุกใบ เพราะข้อกล่าวหาว่า "ตรงนี้ผิด" ต้องตรวจย้อนได้เสมอ
   ป้ายบอกชนิดเป็นข้อความ ไม่ใช่สีอย่างเดียว — สองชนิดนี้เถียงกันคนละแบบ
   (ไม่ตรงงานตัวเอง ครูเปิดเอกสารดูได้ทันที · ผิดหลักวิชา ต้องไปอ่านบทความต่อ) */
const CORRECTION_LABEL = {
  work: "พูดไม่ตรงกับเนื้องานของตัวเอง",
  fact: "ไม่ตรงกับหลักวิชาตามแหล่งอ้างอิง",
};

function correctionCard(c) {
  const ev = c.evidence || {};
  return el(
    "div",
    { class: "coach-section correction", dataset: { kind: c.kind || "work" } },
    el("span", { class: "correction-tag" }, CORRECTION_LABEL[c.kind] || CORRECTION_LABEL.work),
    el("span", { class: "hint" }, "ตอนนี้พูดว่า"),
    el("p", { class: "quote" }, `“${c.quote || ""}”`),
    c.issue ? el("p", { class: "correction-issue" }, `ที่ติดคือ: ${c.issue}`) : null,
    el("span", { class: "hint" }, "ที่ถูกคือ"),
    el("p", { class: "correction-correct" }, c.correct || ""),
    c.explain ? el("p", { class: "correction-explain" }, c.explain) : null,
    ev.text
      ? cite({
          kind: ev.kind || "doc",
          title: ev.title,
          excerpt: ev.text,
          excerptFrom: ev.from,
          citation: ev.citation,
          url: ev.url,
          source: ev.source,
        })
      : null
  );
}

/* audience: "teacher" (ค่าตั้งต้น) | "student"
   ต่างกันแค่คำกำกับบางบรรทัดที่พูดกับครูโดยตรง เช่นการบอกให้ข้ามข้อที่ระบบเข้าใจผิด
   ซึ่งเป็นอำนาจของครู ไม่ใช่ของนักเรียน — เนื้อคำแนะนำที่เหลือเหมือนกันทั้งสองฝั่ง */
export function renderCoaching(coaching, { audience = "teacher" } = {}) {
  const c = coaching;
  const parts = [];

  if (c.summary) parts.push(section("ฟังคลิปแล้วเป็นยังไง", "blue", el("p", {}, c.summary)));
  if (c.strengths?.length) parts.push(section("ทำได้ดีแล้ว", "green", list(c.strengths)));

  /* วางไว้บนสุดรองจากคำชม เพราะเป็นส่วนเดียวที่ "ต้องแก้ให้ถูก" ก่อนอย่างอื่น
     ส่วนที่เหลือเป็นการทำให้ดีขึ้น แต่ส่วนนี้คือเข้าใจผิดอยู่ตอนนี้ */
  if (c.corrections?.length) {
    parts.push(
      section(
        "จุดที่พูดผิด ต้องแก้ให้ถูก",
        "red",
        el("div", { class: "coach-block" }, c.corrections.map(correctionCard)),
        el(
          "p",
          { class: "hint" },
          audience === "student"
            ? "ทุกข้อมีข้อความต้นฉบับกำกับไว้ กดดูที่มาแล้วอ่านเทียบเองได้ ถ้าไม่ตรงกับที่เข้าใจ ให้ถามครู"
            : "ทุกข้อมีข้อความต้นฉบับกำกับไว้ให้ตรวจย้อนได้ ถ้าเห็นว่าระบบเข้าใจผิด ครูข้ามข้อนั้นได้เลย"
        )
      )
    );
  } else if (c.correctionsNote) {
    parts.push(section("จุดที่พูดผิด", "neutral", el("p", { class: "hint" }, c.correctionsNote)));
  }

  if (c.standing?.length) {
    parts.push(
      el(
        "details",
        {},
        el("summary", {}, `เกณฑ์รายด้าน และสิ่งที่ยังขาด (${c.standing.length} ด้าน)`),
        el("div", { class: "coach-block", style: "margin-top:12px" }, c.standing.map(standingCard))
      )
    );
  }

  if (c.lessons?.length) {
    parts.push(
      section("โครงประโยคสำหรับฝึกอธิบาย", "violet", el("div", { class: "coach-block" }, c.lessons.map(lessonCard)))
    );
  }

  // รวม rewrite ทุกใบไว้ในกล่องเดียว เดิมลอยเดี่ยว ๆ หลายใบจนดูเหมือนคนละเรื่องกัน
  if (c.rewrites?.length) {
    parts.push(
      section("ประโยคที่ปรับให้ดูเป็นตัวอย่าง", "amber", el("div", { class: "coach-block" }, c.rewrites.map(rewriteCard)))
    );
  } else if (c.rewritesNote) {
    parts.push(el("div", { class: "alert warn" }, c.rewritesNote));
  }

  if (c.practiceQuestions?.length) {
    parts.push(section("ซ้อมตอบสามข้อนี้ก่อนอัดใหม่", "accent", list(c.practiceQuestions, true)));
  }

  // สองส่วนล่างใช้โทนกลาง เพราะการ์ดแหล่งอ้างอิงข้างในมีสีประจำชนิดของตัวเองอยู่แล้ว
  if (c.readings?.length) {
    parts.push(
      section(
        `อ่านเพิ่มเติม${c.topic ? ` — ${c.topic}` : ""}`,
        "neutral",
        el("div", { class: "coach-block" }, c.readings.map(cite)),
        el("p", { class: "hint" }, "ระบบคัดเฉพาะหน้าที่มีคำสำคัญของงานอยู่จริง ควรกดดูก่อนส่งต่อให้นักเรียน")
      )
    );
  }

  // ลิงก์ค้นต่อในฐานข้อมูลวิชาการ ระบบไม่ได้อ่านผลลัพธ์ให้ จึงบอกไว้ตรง ๆ
  if (c.searchLinks?.length) {
    parts.push(
      section(
        "ค้นต่อในฐานข้อมูลวิชาการ",
        "neutral",
        el("div", { class: "coach-block" }, c.searchLinks.map(cite)),
        el("p", { class: "hint" }, "ลิงก์เหล่านี้เป็นคำค้นที่ตั้งไว้ให้ ยังไม่ได้คัดกรองบทความ ต้องอ่านเองก่อนนำไปอ้างอิง")
      )
    );
  }

  return el("div", { class: "coach-block" }, parts);
}

export { cite };
