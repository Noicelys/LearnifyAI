/* PostgreSQL returns ISO 8601 with a zone; rows migrated from the old SQLite
   store are "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Both must parse. */
export function parseServerDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/[TZ+]|\dZ$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function thaiDate(value) {
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : "";
}

export function thaiDateTime(value) {
  const d = parseServerDate(value);
  return d
    ? d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
}

export function fileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

export const TRUST_LABEL = { green: "น่าเชื่อถือ", yellow: "ควรถามเพิ่ม", red: "ควรตรวจสอบ" };

export const STATUS_LABEL = {
  awaiting: "รอประมวลผล",
  transcribing: "กำลังถอดเสียง",
  analyzing: "กำลังวิเคราะห์",
  done: "ตรวจแล้ว",
  error: "ผิดพลาด",
};

export const SCORE_LABEL = {
  content_match: "ตรงกับงาน",
  specificity: "ความเฉพาะเจาะจง",
  reasoning: "การให้เหตุผล",
  ownership: "ความเป็นเจ้าของงาน",
  own_words: "อธิบายด้วยคำตัวเอง",
};
