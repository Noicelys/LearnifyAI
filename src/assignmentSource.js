/* ดูแล source_text ของงานให้ตรงกับไฟล์ใน Google Drive อยู่เสมอ

   ปัญหาเดิม: ระบบดึงเนื้อหาจาก Drive แค่ตอนสร้างงานหรือตอนเปลี่ยนลิงก์เท่านั้น
   ครูที่แก้ไฟล์ต้นฉบับใน Drive (ซึ่งเป็นเรื่องปกติมาก) จะยังถูกตรวจด้วยเนื้อหาชุดเก่า
   โดยไม่มีใครรู้ตัว — ที่นี่จึงดึงซ้ำให้อัตโนมัติเมื่อเนื้อหาเก่าเกินกำหนด

   Google Drive API ให้ modifiedTime ได้ก็จริง แต่เฉพาะเส้นทางที่มี token ของครู
   ไฟล์ public ที่แชร์แบบ "anyone with link" ดูไม่ได้ จึงใช้วิธีดึงข้อความมาเทียบ hash
   แทน ซึ่งใช้ได้กับทั้งสองเส้นทางและไม่ต้องพึ่งสิทธิ์เพิ่ม */

const crypto = require("crypto");
const db = require("./db");
const { fetchAssignmentText } = require("./drive");

// เนื้อหาที่ดึงมาไม่เกินหกชั่วโมงถือว่าใหม่พอ ไม่ต้องยิง Drive ซ้ำ
// ตั้งค่าใหม่ได้ด้วย SOURCE_MAX_AGE_MIN (0 = ดึงใหม่ทุกครั้ง)
const DEFAULT_MAX_AGE_MS = Number(process.env.SOURCE_MAX_AGE_MIN || 360) * 60 * 1000;

function sourceHash(text) {
  return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex");
}

function isStale(fetchedAt, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!fetchedAt) return true;
  const ts = fetchedAt instanceof Date ? fetchedAt.getTime() : Date.parse(fetchedAt);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts >= maxAgeMs;
}

/* ดึงเนื้อหาใหม่จาก Drive แล้วเขียนกลับ DB เมื่อเปลี่ยนจริง

   assignment ต้องมีอย่างน้อย { id, drive_url, source_text, source_fetched_at, source_hash }
   คืน { sourceText, refreshed, changed, checkedAt, error }

   ไม่โยน error ออกไป — งานหลักคือการตรวจงานนักเรียน ถ้า Drive ล่มหรือสิทธิ์หมดอายุ
   ต้องยังตรวจต่อได้ด้วยเนื้อหาชุดเดิม ผู้เรียกที่อยากเห็น error ให้ดูฟิลด์ error เอง */
async function refreshAssignmentSource(assignment, accessToken = null, opts = {}) {
  const { force = false, maxAgeMs = DEFAULT_MAX_AGE_MS } = opts;
  const current = assignment?.source_text || "";

  if (!assignment?.drive_url) return { sourceText: current, refreshed: false, changed: false };
  if (!force && !isStale(assignment.source_fetched_at, maxAgeMs)) {
    return { sourceText: current, refreshed: false, changed: false };
  }

  let fetched;
  try {
    fetched = await fetchAssignmentText(assignment.drive_url, accessToken);
  } catch (err) {
    return { sourceText: current, refreshed: false, changed: false, error: err.message };
  }

  // ไฟล์ว่างหรืออ่านไม่ออก อย่าไปทับของเดิมที่ใช้ได้อยู่
  if (!fetched) {
    return {
      sourceText: current,
      refreshed: false,
      changed: false,
      error: "ดึงไฟล์ได้ แต่อ่านเนื้อหาไม่เจอ (ไฟล์ว่างหรือเป็นรูปสแกน?)",
    };
  }

  const hash = sourceHash(fetched);
  const changed = hash !== (assignment.source_hash || sourceHash(current));

  // เขียน source_fetched_at ทุกครั้งที่ดึงสำเร็จ แม้เนื้อหาจะเหมือนเดิม
  // ไม่งั้นไฟล์ที่ไม่เคยแก้จะโดนดึงซ้ำทุกครั้งที่มีนักเรียนส่งงาน
  await db.run(
    "UPDATE assignments SET source_text = ?, source_hash = ?, source_fetched_at = NOW() WHERE id = ?",
    [fetched, hash, assignment.id]
  );

  return { sourceText: fetched, refreshed: true, changed, checkedAt: new Date().toISOString() };
}

module.exports = { refreshAssignmentSource, sourceHash, isStale, DEFAULT_MAX_AGE_MS };
