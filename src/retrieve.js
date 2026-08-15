
const GRAM = 3;

// ตัดช่องว่างและวรรคตอนทิ้งก่อน — ตัวถอดเสียงใส่ช่องว่างตำแหน่งมั่วเป็นปกติ
// ถ้าไม่ตัดออก trigram ที่คร่อมช่องว่างจะไม่มีวันตรงกับในเอกสาร
const normalize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s​]+/g, "")
    .replace(/[.,!?;:()[\]{}"'“”‘’…\-–—]/g, "");

function trigrams(text) {
  const s = normalize(text);
  const out = new Set();
  for (let i = 0; i + GRAM <= s.length; i++) out.add(s.slice(i, i + GRAM));
  return out;
}

// ── หั่นเอกสารเป็นท่อน ──
// พยายามตัดที่ท้ายย่อหน้าก่อน ถ้าไม่มีค่อยตัดกลางประโยค
// ท่อนที่ขาดกลางใจความยังใช้ได้ เพราะซ้อนทับกัน (overlap) ทำให้ใจความที่คร่อมรอยตัด
// ยังไปโผล่เต็ม ๆ อยู่ในอีกท่อนหนึ่ง
function chunk(text, size = 900, overlap = 200) {
  const s = String(text || "");
  if (s.length <= size) return s.trim() ? [{ start: 0, text: s }] : [];

  const chunks = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);

    // มองหารอยต่อย่อหน้า/ประโยคในช่วง 25% ท้ายของท่อน เพื่อไม่ให้ตัดกลางคำ
    if (end < s.length) {
      const window = s.slice(i + Math.floor(size * 0.75), end);
      const br = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      if (br > 0) end = i + Math.floor(size * 0.75) + br + 1;
    }

    const body = s.slice(i, end);
    if (body.trim()) chunks.push({ start: i, text: body });
    if (end >= s.length) break;
    i = end - overlap;
  }
  return chunks;
}

// ── ให้คะแนนความเกี่ยวข้อง ──
// ถ่วงน้ำหนักแบบ IDF: trigram ที่โผล่แทบทุกท่อน (เช่นคำเชื่อม "การ" "ของ") แทบไม่บอกอะไร
// ส่วน trigram ที่โผล่ไม่กี่ท่อน (ศัพท์เฉพาะของหัวข้อนั้น) คือตัวที่บอกว่าตรงกันจริง
// ถ้านับดิบ ๆ ท่อนที่มีคำเชื่อมเยอะจะชนะทุกที ซึ่งไม่เกี่ยวกับเนื้อหาเลย
function buildIdf(chunkGrams) {
  const df = new Map();
  for (const grams of chunkGrams) for (const g of grams) df.set(g, (df.get(g) || 0) + 1);
  const n = chunkGrams.length;
  const idf = new Map();
  for (const [g, c] of df) idf.set(g, Math.log(1 + n / c));
  return idf;
}

function scoreChunk(chunkGrams, queryGrams, idf) {
  let score = 0;
  for (const g of queryGrams) if (chunkGrams.has(g)) score += idf.get(g) || 0;
  // หารด้วยรากของขนาดท่อน กันท่อนยาวได้เปรียบเพราะมี trigram เยอะกว่าเฉย ๆ
  return score / Math.sqrt(chunkGrams.size || 1);
}

/**
 * เลือกเฉพาะส่วนของเนื้องานที่เกี่ยวกับสิ่งที่นักเรียนพูด
 *
 * @param sourceText เนื้องานเต็ม
 * @param query      คำพูดของนักเรียน (transcript)
 * @param budget     จำนวนตัวอักษรที่ยอมให้ส่งเข้า prompt
 * @returns { text, usedChars, totalChars, picked, truncated }
 */
function selectRelevant(sourceText, query, budget) {
  const src = String(sourceText || "");

  // สั้นกว่าโควตาอยู่แล้ว ส่งทั้งฉบับไปเลย ไม่ต้องเสี่ยงตัดอะไรทิ้ง
  if (src.length <= budget) {
    return { text: src, usedChars: src.length, totalChars: src.length, picked: 0, truncated: false };
  }

  const chunks = chunk(src);
  const chunkGrams = chunks.map((c) => trigrams(c.text));
  const idf = buildIdf(chunkGrams);
  const queryGrams = trigrams(query);

  const ranked = chunks
    .map((c, i) => ({ ...c, i, score: scoreChunk(chunkGrams[i], queryGrams, idf) }))
    .sort((a, b) => b.score - a.score);

  // ท่อนแรกของเอกสารติดไปด้วยเสมอ — มักเป็นชื่อเรื่อง/โจทย์/คำสั่งงาน
  // ซึ่งโมเดลต้องใช้ตัดสินว่า "งานชิ้นนี้คือเรื่องอะไร" ต่อให้คำพูดนักเรียนไม่ตรงกับท่อนนี้เลย
  const chosen = new Map();
  if (chunks.length) chosen.set(0, chunks[0]);
  let used = chunks[0]?.text.length || 0;

  for (const c of ranked) {
    if (chosen.has(c.i)) continue;
    if (used + c.text.length > budget) continue;
    chosen.set(c.i, c);
    used += c.text.length;
  }

  // เรียงกลับตามลำดับในเอกสารจริง ไม่ใช่เรียงตามคะแนน
  // เพราะเนื้อหาที่สลับลำดับกันอ่านแล้วสับสน และโมเดลอาจตีความลำดับขั้นตอนผิด
  const ordered = [...chosen.values()].sort((a, b) => a.start - b.start);

  // คั่นด้วยเครื่องหมายบอกว่าตรงนี้ข้ามเนื้อหาไป กันโมเดลเข้าใจว่าสองท่อนต่อกันจริง
  let text = "";
  let prevEnd = null;
  for (const c of ordered) {
    if (prevEnd !== null && c.start > prevEnd) text += "\n[…ข้ามส่วนที่ไม่เกี่ยวกับที่นักเรียนพูด…]\n";
    text += c.text;
    prevEnd = c.start + c.text.length;
  }

  return {
    text,
    usedChars: text.length,
    totalChars: src.length,
    picked: ordered.length,
    truncated: true,
  };
}

module.exports = { selectRelevant, chunk, trigrams, normalize };
