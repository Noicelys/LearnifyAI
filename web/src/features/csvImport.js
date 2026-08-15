import { el, clear } from "../lib/dom.js";
import { openModal, showAlert } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { toastError } from "../lib/toast.js";

const FIELDS = [
  { key: "studentNo", label: "รหัสนักเรียน" },
  { key: "firstName", label: "ชื่อ" },
  { key: "lastName", label: "นามสกุล" },
  { key: "department", label: "แผนกวิชา" },
  { key: "classLevel", label: "ชั้น" },
  { key: "room", label: "ห้อง" },
  { key: "rollNo", label: "เลขที่" },
];

const HEADER_RULES = {
  studentNo: [/รหัส.*นักเรียน/i, /รหัส.*ประจำตัว/i, /^รหัส$/i, /student.*id/i, /code/i, /^id$/i],
  firstName: [/^ชื่อ$/i, /ชื่อจริง/i, /first.*name/i, /fname/i, /given.*name/i, /ชื่อ.*สกุล/i, /ชื่อ.*นามสกุล/i, /^name$/i],
  lastName: [/นามสกุล/i, /^สกุล$/i, /last.*name/i, /lname/i, /surname/i],
  department: [/แผนก.*วิชา/i, /^แผนก$/i, /สาขา.*วิชา/i, /^สาขา$/i, /วิชาเอก/i, /department/i, /dept/i, /major/i],
  classLevel: [/^ชั้น$/i, /ระดับชั้น/i, /ชั้นปี/i, /^ปี$/i, /class/i, /grade/i, /level/i, /year/i],
  room: [/^ห้อง$/i, /ห้องเรียน/i, /section/i, /room/i, /^sec$/i],
  rollNo: [/เลขที่/i, /ลำดับที่/i, /roll.*no/i, /seat.*no/i, /^roll$/i, /^no\.?$/i, /number/i],
};

/* Must match csvParser.decodeCSVBuffer on the server, or the preview the
   teacher approves will not be the data that gets imported. Thai files
   exported from Excel are TIS-620, not UTF-8. */
function decodeCSVBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-874").decode(bytes);
  }
}

export function parseCSV(csvText) {
  const text = csvText.replace(/\r\n?/g, "\n");
  const sample = text.split("\n").filter((l) => l.trim()).slice(0, 5);
  if (!sample.length) return { headers: [], rows: [] };

  let delimiter = ",";
  let best = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const count = sample.reduce((sum, line) => sum + line.split(d).length - 1, 0);
    if (count > best) {
      best = count;
      delimiter = d;
    }
  }

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" && !inQuotes) {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }

  const headerIdx = rows.findIndex((r, i) => i < 5 && r.length >= 2);
  const at = headerIdx < 0 ? 0 : headerIdx;
  return { headers: rows[at] || [], rows: rows.slice(at + 1) };
}

export function detectMapping(headers) {
  const mapping = Object.fromEntries(FIELDS.map((f) => [f.key, -1]));
  headers.forEach((header, idx) => {
    const clean = header.trim();
    if (!clean) return;
    for (const [field, rules] of Object.entries(HEADER_RULES)) {
      if (mapping[field] !== -1) continue;
      if (rules.some((rx) => rx.test(clean))) mapping[field] = idx;
    }
  });
  return mapping;
}

const valueAt = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] || "" : "");

export function openCSVImport({ subjectId = null, onImported } = {}) {
  let headers = [];
  let rows = [];
  let mapping = {};
  let file = null;

  const body = el("div", { class: "stack" });
  const modal = openModal({ title: "นำเข้ารายชื่อจากไฟล์ CSV", wide: true, body });

  const analyze = (text) => {
    const parsed = parseCSV(text);
    if (!parsed.headers.length || !parsed.rows.length) {
      return showAlert("อ่านโครงสร้างไฟล์ CSV ไม่ได้ ลองตรวจสอบว่ามีบรรทัดหัวตารางและข้อมูลอย่างน้อยหนึ่งแถว", "วิเคราะห์ไม่สำเร็จ");
    }
    headers = parsed.headers;
    rows = parsed.rows;
    mapping = detectMapping(headers);
    renderMapping();
  };

  function renderPick() {
    const fileInput = el("input", { type: "file", accept: ".csv,text/csv", hidden: true });
    const drop = el(
      "div",
      { class: "dropzone", tabIndex: 0, role: "button" },
      el("b", {}, "เลือกไฟล์ CSV หรือลากมาวาง"),
      el("span", { class: "hint" }, "รองรับไฟล์ที่ export จาก Excel ทั้งแบบ UTF-8 และภาษาไทย (TIS-620)")
    );
    const paste = el("textarea", { placeholder: "หรือวางข้อมูลจากตารางที่นี่" });
    const analyzeBtn = el("button", { class: "btn", type: "button" }, "วิเคราะห์ข้อมูล");

    const readFile = (picked) => {
      file = picked;
      const reader = new FileReader();
      reader.onerror = () => showAlert("เปิดไฟล์นี้ไม่ได้ ลองเลือกไฟล์ใหม่อีกครั้ง", "อ่านไฟล์ไม่สำเร็จ");
      reader.onload = (ev) => analyze(decodeCSVBytes(ev.target.result));
      reader.readAsArrayBuffer(picked);
    };

    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        fileInput.click();
      }
    });
    drop.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      if (ev.dataTransfer.files[0]) readFile(ev.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => fileInput.files[0] && readFile(fileInput.files[0]));
    analyzeBtn.addEventListener("click", () => {
      if (!paste.value.trim()) return;
      file = null;
      analyze(paste.value);
    });

    clear(body).append(drop, fileInput, el("div", { class: "divider" }, "หรือวางข้อความ"), paste, el("div", { class: "row" }, analyzeBtn));
  }

  function renderMapping() {
    const preview = el("div", {});
    const selects = el("div", { class: "field-row" });

    const paintPreview = () => {
      clear(preview).append(
        el("p", { class: "hint num" }, `พบ ${rows.length} แถว · แสดงตัวอย่าง 10 แถวแรก`),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "data" },
            el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "รหัส"), el("th", {}, "เลขที่"), el("th", {}, "ชื่อ-นามสกุล"), el("th", {}, "แผนก"), el("th", {}, "ชั้น/ห้อง"))),
            el(
              "tbody",
              {},
              rows.slice(0, 10).map((row, i) =>
                el(
                  "tr",
                  {},
                  el("td", { class: "num" }, String(i + 1)),
                  el("td", { class: "mono" }, valueAt(row, mapping.studentNo) || "—"),
                  el("td", { class: "num" }, valueAt(row, mapping.rollNo) || "—"),
                  el("td", {}, [valueAt(row, mapping.firstName), valueAt(row, mapping.lastName)].filter(Boolean).join(" ") || "—"),
                  el("td", {}, valueAt(row, mapping.department) || "—"),
                  el("td", {}, [valueAt(row, mapping.classLevel), valueAt(row, mapping.room)].filter(Boolean).join("/") || "—")
                )
              )
            )
          )
        )
      );
    };

    for (const field of FIELDS) {
      const select = el(
        "select",
        {},
        el("option", { value: "-1" }, "— ไม่ใช้คอลัมน์นี้ —"),
        headers.map((h, idx) => el("option", { value: String(idx), selected: mapping[field.key] === idx }, `คอลัมน์ ${idx + 1}: ${h}`))
      );
      select.addEventListener("change", () => {
        mapping[field.key] = Number(select.value);
        paintPreview();
      });
      selects.append(el("label", { class: "field" }, el("span", {}, field.label), select));
    }

    const back = el("button", { class: "btn btn-ghost", type: "button" }, "ย้อนกลับ");
    back.addEventListener("click", renderPick);

    const importBtn = el("button", { class: "btn", type: "button" }, "นำเข้ารายชื่อ");
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      try {
        let result;
        if (file) {
          const form = new FormData();
          form.append("file", file);
          form.append("mapping", JSON.stringify(mapping));
          if (subjectId) form.append("subjectId", String(subjectId));
          result = await api.importStudents(form);
        } else {
          const items = rows.map((row) =>
            Object.fromEntries(FIELDS.map((f) => [f.key, valueAt(row, mapping[f.key])]))
          );
          result = await api.importStudents({ items, subjectId: subjectId || undefined });
        }
        modal.close();
        onImported?.(result);
        const warn = result.warnings?.length ? `\nหมายเหตุ: ${result.warnings.join(" · ")}` : "";
        showAlert(
          `สร้างใหม่ ${result.created ?? 0} คน · อัปเดต ${result.updated ?? 0} คน · ข้าม ${result.skipped ?? 0} คน${warn}`,
          "นำเข้าข้อมูลสำเร็จ"
        );
      } catch (err) {
        toastError(err);
        importBtn.disabled = false;
      }
    });

    clear(body).append(
      el("div", { class: "alert" }, "ตรวจว่าแต่ละคอลัมน์ตรงกับข้อมูลจริงก่อนนำเข้า ระบบเดาให้จากหัวตารางแล้ว"),
      selects,
      preview,
      el("div", { class: "row" }, back, importBtn)
    );
    paintPreview();
  }

  renderPick();
}
