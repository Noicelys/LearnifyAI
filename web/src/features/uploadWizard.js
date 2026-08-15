import { el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { toSharingUrl, isAudioFile, autoConvertOnInput } from "../lib/drive.js";
import { matchStudentDetailed, deriveStudentName } from "../lib/match.js";
import { fileSize } from "../lib/format.js";
import { toast, toastError } from "../lib/toast.js";

/* Three steps: collect files, pair each file with a student, review and send.
   Pairing the wrong student is worse than pairing none, so auto-matching only
   fills a slot when exactly one roster row matches — the rest stay for the teacher. */
export function mountUploadWizard(container, { assignment, roster, onSubmitted }) {
  let step = 1;
  let pool = []; // { key, name, size, kind: "audio"|"work", file?, driveId? }
  let rows = []; // { key, studentId, studentName, audio, work, textAnswer }

  const stepsBar = el("div", { class: "steps" });
  const panel = el("div", {});
  const back = el("button", { class: "btn btn-secondary", type: "button" }, "ย้อนกลับ");
  const next = el("button", { class: "btn", type: "button" }, "ถัดไป");
  const hint = el("span", { class: "hint grow" });

  const STEP_LABELS = ["เลือกไฟล์", "จับคู่กับนักเรียน", "ตรวจแล้วส่ง"];

  const paintSteps = () => {
    clear(stepsBar);
    STEP_LABELS.forEach((label, i) => {
      const n = i + 1;
      stepsBar.append(
        el(
          "div",
          { class: "step", dataset: { state: n === step ? "active" : n < step ? "done" : "todo" } },
          el("span", { class: "step-num" }, n < step ? "✓" : String(n)),
          el("span", { class: "step-text" }, label)
        )
      );
    });
  };

  const go = (n) => {
    step = Math.min(3, Math.max(1, n));
    paintSteps();
    back.disabled = step === 1;
    next.textContent = step === 3 ? "ส่งเข้าระบบ" : "ถัดไป";
    ({ 1: renderPick, 2: renderMatch, 3: renderReview })[step]();
  };

  /* ── step 1 ─────────────────────────────────────────── */
  // ลิงก์ของงานชิ้นนี้ใช้เป็นค่าเริ่มต้น ครูจะได้ไม่ต้องไปก๊อปจาก Drive มาวางเองทุกครั้ง
  let driveUrlValue = toSharingUrl(assignment.drive_url || "");
  let autoFetched = false; // ดึงอัตโนมัติครั้งเดียวพอ renderPick() ถูกเรียกซ้ำบ่อย
  let driveError = "";

  /* ดึงรายการไฟล์จากลิงก์ Drive เข้ากอง — ใช้ร่วมกันระหว่างปุ่มและการดึงอัตโนมัติ
     ข้ามไฟล์ที่อยู่ในกองแล้ว เพราะ key ของไฟล์ Drive คงที่ (d<fileId>) กดซ้ำจะได้ของซ้ำ */
  async function fetchDriveList(rawUrl) {
    const url = toSharingUrl(String(rawUrl || "").trim());
    if (!url) return 0;
    const files = await api.driveFolderFiles(url);
    let added = 0;
    for (const f of files) {
      const key = `d${f.id}`;
      if (pool.some((p) => p.key === key)) continue;
      pool.push({ key, name: f.name, kind: isAudioFile(f) ? "audio" : "work", driveId: f.id });
      added++;
    }
    return added;
  }

  function addFiles(files) {
    for (const file of files) {
      pool.push({
        key: `l${pool.length}-${file.name}`,
        name: file.name,
        size: file.size,
        kind: isAudioFile(file) ? "audio" : "work",
        file,
      });
    }
    renderPick();
  }

  function renderPick() {
    const fileInput = el("input", { type: "file", multiple: true, hidden: true });
    const drop = el(
      "div",
      { class: "dropzone", tabIndex: 0, role: "button" },
      el("b", {}, "ลากไฟล์มาวางที่นี่"),
      el("span", { class: "hint" }, "ไฟล์เสียงคือคำอธิบายของนักเรียน ไฟล์เอกสารคือชิ้นงาน")
    );
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
      addFiles(ev.dataTransfer.files);
    });
    fileInput.addEventListener("change", () => addFiles(fileInput.files));

    const driveUrl = el("input", { type: "url", placeholder: "https://drive.google.com/drive/folders/...", value: driveUrlValue });
    autoConvertOnInput(driveUrl);
    driveUrl.addEventListener("input", () => (driveUrlValue = driveUrl.value));
    const fetchBtn = el("button", { class: "btn btn-secondary", type: "button" }, "ดึงรายการไฟล์");
    const driveMsg = el("div", { class: driveError ? "msg err" : "msg" }, driveError || null);

    fetchBtn.addEventListener("click", async () => {
      if (!driveUrl.value.trim()) return;
      fetchBtn.disabled = true;
      driveError = "";
      driveMsg.textContent = "";
      driveMsg.className = "msg";
      try {
        const added = await fetchDriveList(driveUrl.value);
        toast(added ? `ดึงมา ${added} ไฟล์` : "ไม่มีไฟล์ใหม่ — ไฟล์ทั้งหมดอยู่ในรายการแล้ว");
        renderPick();
      } catch (err) {
        driveError = err.message;
        driveMsg.textContent = err.message;
        driveMsg.className = "msg err";
      } finally {
        fetchBtn.disabled = false;
      }
    });

    /* ลิงก์ของงานที่เป็นโฟลเดอร์ = ที่ที่นักเรียนส่งงาน ดึงให้เลยไม่ต้องรอครูกด
       ลิงก์ไฟล์เดี่ยวคือใบงานของครูเอง ไม่ใช่งานนักเรียน จึงเติมช่องไว้เฉย ๆ */
    if (!autoFetched && !pool.length && /\/folders\//.test(driveUrlValue)) {
      autoFetched = true;
      driveMsg.className = "msg";
      driveMsg.textContent = "กำลังดึงรายการไฟล์จากโฟลเดอร์ของงานนี้…";
      // ครูอาจกด "ถัดไป" ไปแล้วระหว่างรอ — วาดใหม่เฉพาะตอนยังอยู่หน้านี้ ไม่งั้นทับหน้าจับคู่
      const repaintIfHere = () => step === 1 && renderPick();
      fetchDriveList(driveUrlValue)
        .then(repaintIfHere)
        .catch((err) => {
          // ล้มเหลวไม่ใช่เรื่องคอขาดบาดตาย ครูยังลากไฟล์จากเครื่องได้ตามปกติ
          driveError = err.message;
          repaintIfHere();
        });
    }

    const list = el("div", { class: "pool-list" });
    if (!pool.length) list.append(el("p", { class: "hint" }, "ยังไม่มีไฟล์ในรายการ"));
    pool.forEach((item, index) => {
      const remove = el("button", { class: "icon-btn sm", type: "button", "aria-label": `เอา ${item.name} ออก` }, "✕");
      remove.addEventListener("click", () => {
        pool.splice(index, 1);
        renderPick();
      });
      list.append(
        el(
          "div",
          { class: "pool-item" },
          el("span", { class: `pill ${item.kind === "audio" ? "audio" : ""}` }, item.kind === "audio" ? "เสียง" : "งาน"),
          el("span", { class: "grow truncate" }, item.name),
          el("span", { class: "hint num" }, fileSize(item.size)),
          remove
        )
      );
    });

    hint.textContent = pool.length ? `${pool.length} ไฟล์พร้อมจับคู่` : "เพิ่มไฟล์อย่างน้อยหนึ่งไฟล์";
    clear(panel).append(
      el(
        "div",
        { class: "stack" },
        drop,
        fileInput,
        el("div", { class: "divider" }, "หรือดึงจากโฟลเดอร์ Google Drive"),
        el("div", { class: "row" }, el("span", { class: "grow" }, driveUrl), fetchBtn),
        assignment.drive_url
          ? el("p", { class: "hint" }, "ลิงก์นี้ดึงมาจากงานชิ้นนี้ให้อัตโนมัติ — เปลี่ยนเป็นโฟลเดอร์อื่นได้")
          : null,
        driveMsg,
        el("div", { class: "section-title" }, el("h3", {}, "ไฟล์ที่เลือกไว้"), el("span", { class: "hint num" }, String(pool.length))),
        list
      )
    );
  }

  /* ── step 2 ─────────────────────────────────────────── */
  function buildRows() {
    const used = new Set();
    const byStudent = new Map();

    for (const item of pool) {
      const match = matchStudentDetailed(item.name, roster);
      const student = match?.student ?? null;
      const key = student ? `s${student.id}` : `f${item.key}`;
      if (!byStudent.has(key)) {
        byStudent.set(key, {
          key,
          studentId: student?.id ?? null,
          studentName: student?.full_name || deriveStudentName(item.name),
          // เหตุผลที่จับคู่ให้ ครูจะได้ตรวจว่าเชื่อได้ไหมโดยไม่ต้องเดาว่าระบบคิดยังไง
          matchWhy: match ? match.why.join(" · ") : "",
          audio: null,
          work: null,
          textAnswer: "",
        });
      }
      const row = byStudent.get(key);
      if (item.kind === "audio" && !row.audio) {
        row.audio = item;
        used.add(item.key);
      } else if (item.kind === "work" && !row.work) {
        row.work = item;
        used.add(item.key);
      }
    }

    rows = [...byStudent.values()];
    return pool.filter((item) => !used.has(item.key));
  }

  /* สถานะของแถว ต้องนิยามจากเงื่อนไขเดียวกับ validRows() เป๊ะ
     ไม่งั้นสีจะบอกครูว่าแถวนี้ส่งได้ ทั้งที่ตอนกดส่งจริงถูกข้าม */
  function rowState(row) {
    const named = Boolean(row.studentId || row.studentName.trim());
    const hasContent = Boolean(row.audio || row.work || row.textAnswer.trim());
    if (named && hasContent) return "ready";
    if (named || hasContent) return "partial";
    return "empty";
  }

  const STATE_LABEL = { ready: "พร้อมส่ง", partial: "ยังไม่ครบ", empty: "ว่าง" };

  // ถอดไฟล์ออกจากทุกช่องก่อนเอาไปวางที่ใหม่ — ไฟล์เดียวห้ามอยู่สองที่พร้อมกัน
  function detachFile(key) {
    for (const r of rows) {
      if (r.audio?.key === key) r.audio = null;
      if (r.work?.key === key) r.work = null;
    }
  }

  function renderMatch() {
    const leftovers = rows.length ? pool.filter((p) => !rows.some((r) => r.audio?.key === p.key || r.work?.key === p.key)) : buildRows();

    const unmatched = rows.filter((r) => !r.studentId).length;
    hint.textContent = unmatched
      ? `${rows.length} รายการ · ยังไม่รู้ว่า ${unmatched} รายการเป็นของใคร`
      : `${rows.length} รายการ จับคู่ครบแล้ว`;

    const body = el("tbody", {});

    rows.forEach((row, index) => {
      const tr = el("tr", { dataset: { state: rowState(row) } });
      // สีของแถวเปลี่ยนได้โดยไม่ต้องวาดตารางใหม่ทั้งใบ เพื่อไม่ให้ focus ในช่องพิมพ์หลุด
      const repaint = () => (tr.dataset.state = rowState(row));

      const select = el(
        "select",
        {},
        el("option", { value: "" }, "— ไม่ระบุ (พิมพ์ชื่อเอง) —"),
        roster.map((s) =>
          el("option", { value: String(s.id), selected: String(s.id) === String(row.studentId) }, `${s.full_name}${s.student_no ? ` · ${s.student_no}` : ""}`)
        )
      );
      const nameInput = el("input", { type: "text", value: row.studentName || "", placeholder: "ชื่อนักเรียน", hidden: Boolean(row.studentId) });
      const why = el("span", { class: "hint", hidden: !row.matchWhy }, row.matchWhy ? `จับคู่จาก: ${row.matchWhy}` : "");
      select.addEventListener("change", () => {
        row.studentId = select.value ? Number(select.value) : null;
        const student = roster.find((s) => String(s.id) === select.value);
        row.studentName = student?.full_name || nameInput.value;
        nameInput.hidden = Boolean(row.studentId);
        if (!row.studentId) nameInput.value = row.studentName || "";
        // ครูเลือกเองแล้ว เหตุผลที่ระบบเดาไว้ไม่เกี่ยวอีกต่อไป
        row.matchWhy = "";
        why.hidden = true;
        repaint();
      });
      nameInput.addEventListener("input", () => {
        row.studentName = nameInput.value;
        repaint();
      });

      /* ช่องรับไฟล์: ลากเข้า ลากออก และเลือกจากรายการได้
         ต้องมีทางเลือกที่ไม่ใช้เมาส์ด้วย เพราะครูหลายคนทำงานบนแท็บเล็ต */
      const dropCell = (kind) => {
        const item = row[kind];
        const emptyLabel = kind === "audio" ? "ยังไม่มีไฟล์เสียง" : "ยังไม่มีไฟล์งาน";
        const box = el("div", { class: `drop-cell${item ? " filled" : ""}` });

        if (item) {
          box.draggable = true;
          box.append(el("span", { class: "grow truncate", title: item.name }, item.name));
          const clearBtn = el("button", { class: "icon-btn sm", type: "button", "aria-label": `เอา ${item.name} ออก` }, "✕");
          clearBtn.addEventListener("click", () => {
            row[kind] = null;
            renderMatch();
          });
          box.append(clearBtn);
          box.addEventListener("dragstart", (ev) => {
            ev.dataTransfer.setData("text/plain", item.key);
            box.classList.add("dragging");
          });
          box.addEventListener("dragend", () => box.classList.remove("dragging"));
        } else {
          const options = leftovers.filter((p) => p.kind === kind);
          const picker = el(
            "select",
            { class: "cell-picker", "aria-label": emptyLabel },
            el("option", { value: "" }, options.length ? `${emptyLabel} — เลือกไฟล์` : emptyLabel),
            options.map((p) => el("option", { value: p.key }, p.name))
          );
          picker.disabled = !options.length;
          picker.addEventListener("change", () => {
            const picked = pool.find((p) => p.key === picker.value);
            if (!picked) return;
            detachFile(picked.key);
            row[kind] = picked;
            renderMatch();
          });
          box.append(picker);
        }

        box.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          box.classList.add("over");
        });
        box.addEventListener("dragleave", () => box.classList.remove("over"));
        box.addEventListener("drop", (ev) => {
          ev.preventDefault();
          box.classList.remove("over");
          const picked = pool.find((p) => p.key === ev.dataTransfer.getData("text/plain"));
          if (!picked) return;
          // ไฟล์เอกสารลงช่องเสียงแปลว่าจะส่ง PDF ไปให้ Whisper ถอดเสียง กันไว้ตั้งแต่ตรงนี้
          if (picked.kind !== kind) {
            return toast(kind === "audio" ? "ช่องนี้รับเฉพาะไฟล์เสียง" : "ช่องนี้รับเฉพาะไฟล์ชิ้นงาน", { kind: "err" });
          }
          detachFile(picked.key);
          row[kind] = picked;
          renderMatch();
        });
        return box;
      };

      // แถวขยายสำหรับพิมพ์คำอธิบาย ซ่อนไว้เพื่อไม่ให้ตารางสูงจนสแกนทั้งห้องไม่ได้
      const text = el("textarea", { placeholder: "หรือให้พิมพ์คำอธิบายแทนการอัดเสียง", value: row.textAnswer || "", rows: 3 });
      const expandRow = el("tr", { class: "row-expand", hidden: true }, el("td", { colSpan: 6 }, text));
      text.addEventListener("input", () => {
        row.textAnswer = text.value;
        typedBtn.textContent = row.textAnswer.trim() ? "มี ✓" : "เพิ่ม";
        repaint();
      });

      const typedBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, row.textAnswer.trim() ? "มี ✓" : "เพิ่ม");
      typedBtn.addEventListener("click", () => {
        expandRow.hidden = !expandRow.hidden;
        if (!expandRow.hidden) text.focus();
      });

      const remove = el("button", { class: "icon-btn sm", type: "button", "aria-label": "เอาแถวนี้ออก" }, "✕");
      remove.addEventListener("click", () => {
        rows.splice(index, 1);
        renderMatch();
      });

      tr.append(
        // สีอย่างเดียวสื่อความหมายไม่ได้ ต้องมีข้อความกำกับสำหรับคนตาบอดสี
        el("td", {}, el("span", { class: "state-tag" }, el("span", { class: "dot" }), STATE_LABEL[rowState(row)])),
        el("td", {}, el("div", { class: "stack-xs" }, select, nameInput, why)),
        el("td", {}, dropCell("audio")),
        el("td", {}, dropCell("work")),
        el("td", {}, typedBtn),
        el("td", {}, remove)
      );
      body.append(tr, expandRow);
    });

    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colSpan: 6 }, el("p", { class: "hint" }, "ยังไม่มีแถว — กด “เพิ่มแถวว่าง” หรือย้อนกลับไปเพิ่มไฟล์"))));
    }

    const table = el(
      "table",
      { class: "data match-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "สถานะ"),
          el("th", {}, "นักเรียน"),
          el("th", {}, "ไฟล์เสียง"),
          el("th", {}, "ชิ้นงาน"),
          el("th", {}, "พิมพ์ตอบ"),
          el("th", {}, "")
        )
      ),
      body
    );

    // กองไฟล์ที่เหลือรับ drop ด้วย ครูจะได้เอาไฟล์ที่วางผิดคนคืนกองได้โดยไม่ต้องกด ✕ ก่อน
    const leftBox = el("div", { class: "pool-list" });
    if (!leftovers.length) leftBox.append(el("p", { class: "hint" }, "ไฟล์ถูกจับคู่หมดแล้ว"));
    for (const item of leftovers) {
      const node = el(
        "div",
        { class: "pool-item", draggable: true },
        el("span", { class: `pill ${item.kind === "audio" ? "audio" : ""}` }, item.kind === "audio" ? "เสียง" : "งาน"),
        el("span", { class: "grow truncate" }, item.name)
      );
      node.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", item.key);
        node.classList.add("dragging");
      });
      node.addEventListener("dragend", () => node.classList.remove("dragging"));
      leftBox.append(node);
    }
    leftBox.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      leftBox.classList.add("over");
    });
    leftBox.addEventListener("dragleave", () => leftBox.classList.remove("over"));
    leftBox.addEventListener("drop", (ev) => {
      ev.preventDefault();
      leftBox.classList.remove("over");
      const key = ev.dataTransfer.getData("text/plain");
      if (!pool.some((p) => p.key === key)) return;
      detachFile(key);
      renderMatch();
    });

    const addRow = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "＋ เพิ่มแถวว่าง");
    addRow.addEventListener("click", () => {
      rows.push({ key: `manual-${rows.length}-${Date.now()}`, studentId: null, studentName: "", matchWhy: "", audio: null, work: null, textAnswer: "" });
      renderMatch();
    });

    const rematch = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "จับคู่อัตโนมัติใหม่");
    rematch.addEventListener("click", () => {
      rows = [];
      renderMatch();
    });

    clear(panel).append(
      el(
        "div",
        { class: "stack" },
        el("div", { class: "row" }, addRow, rematch),
        el("div", { class: "section-title" }, el("h3", {}, "ไฟล์ที่ยังไม่ถูกจับคู่"), el("span", { class: "hint num" }, String(leftovers.length))),
        leftBox,
        el("p", { class: "hint" }, "ลากไฟล์มาวางในช่องของนักเรียน · ลากข้ามแถวเพื่อย้ายคน · ลากกลับมาที่กองนี้เพื่อเอาออก"),
        el("div", { class: "table-wrap" }, table)
      )
    );
  }

  /* ── step 3 ─────────────────────────────────────────── */
  function validRows() {
    return rows.filter((r) => (r.studentId || r.studentName.trim()) && (r.audio || r.work || r.textAnswer.trim()));
  }

  function renderReview() {
    const ready = validRows();
    const skipped = rows.length - ready.length;
    hint.textContent = skipped ? `ส่งได้ ${ready.length} รายการ · ข้าม ${skipped} รายการที่ยังไม่ครบ` : `ส่งได้ ${ready.length} รายการ`;

    const table = el(
      "table",
      { class: "data" },
      el("thead", {}, el("tr", {}, el("th", {}, "นักเรียน"), el("th", {}, "ไฟล์เสียง"), el("th", {}, "ชิ้นงาน"), el("th", {}, "พิมพ์ตอบ"))),
      el(
        "tbody",
        {},
        ready.map((r) =>
          el(
            "tr",
            {},
            el("td", {}, r.studentName || "—"),
            el("td", { class: "truncate" }, r.audio?.name || "—"),
            el("td", { class: "truncate" }, r.work?.name || "—"),
            el("td", {}, r.textAnswer.trim() ? "มี" : "—")
          )
        )
      )
    );

    clear(panel).append(
      el(
        "div",
        { class: "stack" },
        skipped ? el("div", { class: "alert warn" }, `${skipped} รายการยังไม่มีชื่อนักเรียนหรือไม่มีเนื้อหา จะถูกข้าม`) : null,
        el("div", { class: "table-wrap" }, table)
      )
    );
  }

  async function submitAll() {
    const ready = validRows();
    if (!ready.length) return toast("ยังไม่มีรายการที่ส่งได้", { kind: "err" });

    next.disabled = true;
    back.disabled = true;
    let sent = 0;
    const failures = [];

    for (const row of ready) {
      const form = new FormData();
      if (row.studentId) form.append("studentId", String(row.studentId));
      form.append("studentName", row.studentName.trim());
      if (row.textAnswer.trim()) form.append("textAnswer", row.textAnswer.trim());
      if (row.audio?.file) form.append("audio", row.audio.file);
      else if (row.audio?.driveId) form.append("driveFileId", row.audio.driveId);
      if (row.work?.file) form.append("workFile", row.work.file);
      else if (row.work?.driveId) form.append("workDriveFileId", row.work.driveId);

      try {
        await api.createSubmission(assignment.id, form);
        sent++;
        next.textContent = `กำลังส่ง ${sent}/${ready.length}…`;
      } catch (err) {
        failures.push(`${row.studentName}: ${err.message}`);
      }
    }

    next.disabled = false;
    back.disabled = false;
    next.textContent = "ส่งเข้าระบบ";

    if (failures.length) toast(`ส่งไม่สำเร็จ ${failures.length} รายการ — ${failures[0]}`, { kind: "err", ms: 6000 });
    if (sent) {
      toast(`ส่งเข้าระบบแล้ว ${sent} รายการ กำลังถอดเสียงและวิเคราะห์`);
      pool = [];
      rows = [];
      go(1);
      onSubmitted?.();
    }
  }

  back.addEventListener("click", () => go(step - 1));
  next.addEventListener("click", () => {
    if (step === 1 && !pool.length) return toast("เพิ่มไฟล์ก่อนอย่างน้อยหนึ่งไฟล์", { kind: "err" });
    if (step === 3) return submitAll();
    go(step + 1);
  });

  clear(container).append(
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "เพิ่มงานที่นักเรียนส่ง"), el("span", { class: "hint" }, assignment.title)),
      el("div", { class: "card-body stack" }, stepsBar, panel, el("div", { class: "row" }, hint, back, next))
    )
  );

  go(1);
  return { reset: () => go(1) };
}
