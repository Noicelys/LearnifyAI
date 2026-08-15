// วิเคราะห์ transcript เทียบกับเนื้องานจริงด้วยโมเดล Typhoon ผ่าน API แบบ OpenAI-compatible
//
// รองรับสองทาง ใช้โค้ดชุดเดียวกันเพราะหน้า API เหมือนกัน ต่างแค่ปลายทาง:
//   1) Ollama ในเครื่องเรา (ค่าตั้งต้น) — ไม่ต้องมีคีย์ งานนักเรียนไม่ออกนอกเซิร์ฟเวอร์
//   2) Typhoon Cloud — เร็วกว่ามาก แต่ต้องมี TYPHOON_API_KEY และข้อมูลถูกส่งออกไปข้างนอก
//
// หมายเหตุ: ทั้งสองทางไม่มี SLA — ทุก error ต้องโยนออกไปให้ชัด
// ห้าม fallback เป็นคะแนนมั่วๆ เด็ดขาด เพราะครูจะเอาไปตัดสินนักเรียนจริง

// เลือกทางด้วย AI_PROVIDER เท่านั้น ไม่เดาจาก URL — ชื่อโมเดลของสองระบบใช้แทนกันไม่ได้
// (คลาวด์ใช้ "typhoon-v2.5-30b-a3b-instruct" ส่วน Ollama ใช้ "scb10x/typhoon2.5-qwen3-4b")
// จึงต้องแยกตัวแปรกันคนละชุด ไม่งั้นสลับทีต้องแก้หลายค่าและพลาดง่าย
const { selectRelevant } = require("./retrieve");
const { renderRubricForPrompt, WEIGHTS } = require("./rubric");

const IS_LOCAL = (process.env.AI_PROVIDER || "cloud").toLowerCase() === "ollama";
const PROVIDER = IS_LOCAL ? "Ollama (ในเครื่อง)" : "Typhoon Cloud";

const BASE_URL = IS_LOCAL
  ? process.env.OLLAMA_BASE_URL || "http://ollama:11434/v1"
  : process.env.TYPHOON_BASE_URL || "https://api.opentyphoon.ai/v1";

// Ollama: ดูรายชื่อโมเดลด้วย `docker compose exec ollama ollama list`
// Cloud:  เช็ครายชื่อที่ใช้ได้จริง GET https://api.opentyphoon.ai/v1/models
const MODEL = IS_LOCAL
  ? process.env.OLLAMA_MODEL || "scb10x/typhoon2.5-qwen3-4b"
  : process.env.TYPHOON_MODEL || "typhoon-v2.5-30b-a3b-instruct";

// รันบน CPU ช้ากว่าคลาวด์หลายเท่า ฝั่งในเครื่องจึงเผื่อไว้ 5 นาที
const TIMEOUT_MS = IS_LOCAL
  ? Number(process.env.OLLAMA_TIMEOUT_MS || 300000)
  : Number(process.env.TYPHOON_TIMEOUT_MS || 60000);

const SYSTEM_PROMPT = `คุณคือกรรมการสอบปากเปล่าที่เข้มงวด ประเมินว่า "นักเรียนเข้าใจงานที่ตัวเองทำจริงหรือไม่"
โดยเทียบคำอธิบายด้วยเสียงของนักเรียน (transcript) กับเนื้องานที่ส่งมาจริง

แกนของการวิเคราะห์คือ "เนื้องานที่ยกมาให้" ไม่ใช่ความรู้ทั่วไปของหัวข้อ:
- ห้ามประเมินจากความรู้ของคุณเองเกี่ยวกับหัวข้อนี้ ทุกอย่างต้องอ้างกลับไปที่เนื้องานที่ยกมา
- ลำดับการทำงานบังคับ: (1) อ่านเนื้องานที่ยกมา แล้วสรุปประเด็นหลักของงานชิ้นนี้ 3-6 ข้อ
  (2) ไล่ทีละประเด็นว่านักเรียนพูดถึงหรือไม่ ครบหรือแค่แตะ (3) ค่อยให้คะแนนทั้ง 5 ด้าน
- ประเด็นหลัก = สิ่งที่งานชิ้นนี้ทำจริง (หัวข้อ วิธี ขั้นตอน ข้อมูล/ตัวเลข ผลลัพธ์ ข้อสรุป)
  ไม่ใช่หัวข้อกว้างที่งานไหนก็มี และต้องเขียนด้วยคำที่ปรากฏในเนื้องานจริง
- content_match ต้องสอดคล้องกับผลการไล่ประเด็นข้างต้น ไม่ใช่ความรู้สึกรวม ๆ ว่าพูดตรงเรื่องไหม
- specificity / reasoning / ownership ให้ตัดสินเฉพาะเมื่อคำพูดผูกกับสิ่งที่มีอยู่ในเนื้องาน
  เรื่องที่ฟังดูดีแต่ไม่มีอะไรในเนื้องานรองรับ ไม่นับเป็นหลักฐาน

หลักการที่อยู่เหนือทุกข้อ — คะแนนต้องมาจากหลักฐานในคำพูดเท่านั้น:
- เริ่มทุกด้านที่ 0 แล้วไต่ขึ้นเฉพาะเมื่อมีข้อความที่นักเรียน "พูดจริง" รองรับ
- สิ่งที่นักเรียนไม่ได้พูด = ไม่มีหลักฐาน = ไม่ได้คะแนน ห้ามเดาหรือเติมให้แทนเขา
- ห้ามให้คะแนนเพราะฟังดูมั่นใจ พูดเยอะ ตั้งใจ หรือเพราะอยากให้กำลังใจ
- ทดสอบเสมอว่า "คำอธิบายนี้เอาไปใช้กับงานหัวข้อเดียวกันของนักเรียนคนอื่นได้เลยหรือไม่"
  ถ้าใช้ได้โดยไม่ต้องแก้อะไร แปลว่ายังไม่ได้พิสูจน์ว่าทำงานชิ้นนี้เอง

ให้คะแนน 5 ด้าน ด้านละ 0-100 ช่วง 90-100 สงวนไว้สำหรับกรณีที่หาที่ติแทบไม่ได้ — โดยปกติไม่ควรให้

${renderRubricForPrompt()}

กติกาความเป็นธรรม — เข้มงวดได้ แต่ห้ามละเมิดข้อเหล่านี้:
- ห้ามหักคะแนนจากคำที่ถอดเสียงเพี้ยน สะกดผิด หรือประโยคขาดหาย (transcript มาจากการถอดเสียง)
- ห้ามหักคะแนนจากสำเนียง ความประหม่า พูดช้า พูดติดขัด หรือเสียงเบา — ตัดสินที่เนื้อหา ไม่ใช่วิธีพูด
- ห้ามหักคะแนนเพราะเรื่องที่พูดไม่ปรากฏในเนื้องานส่วนที่ยกมาให้ (อาจอยู่ในส่วนที่ระบบไม่ได้ยกมา)

ตอบกลับเป็น JSON เท่านั้น รูปแบบ:
{"key_points":["ประเด็นหลักที่สรุปจากเนื้องานที่ยกมา 3-6 ข้อ ข้อละไม่เกิน 20 คำ"],
 "coverage":[{"point":"ประเด็นหลักข้อนั้น (ต้องตรงกับข้อความใน key_points)",
              "covered":"yes | partial | no",
              "quote":"คำพูดจาก transcript ที่แสดงว่าพูดถึงประเด็นนี้ คัดลอกคำต่อคำ (ถ้า no ให้ใส่ \\"\\")"}],
 "content_match":0-100,"specificity":0-100,"reasoning":0-100,"ownership":0-100,"own_words":0-100,
 "evidence":[{"dimension":"ชื่อด้าน","quote":"คำพูดจริงคัดลอกคำต่อคำจาก transcript"}],
 "missing":["ประเด็นสำคัญในเนื้องานที่นักเรียนไม่ได้พูดถึงเลย 0-3 ข้อ"],
 "reasons":["เหตุผลภาษาไทย 3-4 ข้อ"],"flags":["ข้อสังเกตเตือนถ้ามี"]}

key_points ต้องมาจากเนื้องานที่ยกมาเท่านั้น ห้ามเติมประเด็นที่ไม่ปรากฏในเนื้องาน
coverage ต้องมีครบทุกข้อของ key_points เรียงลำดับเดียวกัน หนึ่งข้อต่อหนึ่งประเด็น
covered = "yes" เฉพาะเมื่อมี quote จาก transcript รองรับจริง — พูดผ่าน ๆ หรือแตะชื่อประเด็นเฉย ๆ คือ "partial"
missing ต้องเป็นเฉพาะประเด็นที่ coverage เป็น "no" ห้ามใส่เรื่องที่ไม่ได้อยู่ใน key_points
reasons อย่างน้อย 2 ข้อ ต้องอ้างถึงประเด็นในเนื้องานตรง ๆ ว่าพูดถึงข้อไหนได้ดี และข้ามข้อไหนไป

evidence ต้องมี 3-5 ข้อ คัดลอกจาก transcript คำต่อคำ ห้ามเรียบเรียงใหม่ ห้ามแต่งขึ้นเอง
ทุกด้านที่ให้ตั้งแต่ 70 ขึ้นไป ต้องมี evidence ของด้านนั้นอย่างน้อย 1 ข้อ ถ้าหา quote รองรับไม่ได้ ให้ลดคะแนนด้านนั้นลง
reasons ต้องมี 3-4 ข้อ ข้อละไม่เกิน 25 คำ ระบุให้ตรงว่าหลักฐานที่มีคืออะไร และที่ยังขาดคืออะไร
flags ใส่เมื่อพบสัญญาณว่าอาจไม่ได้ทำเอง (0-3 ข้อ) เช่น อธิบายเหมือนอ่านนิยาม
ไม่รู้ที่มาของสิ่งที่อยู่ในงานตัวเอง หรือตอบกว้างจนใช้กับงานใครก็ได้`;

// โควตาเนื้องานที่ส่งเข้า prompt
//
// ⚠ ลดลงจาก 12000 เป็น 6000 โดยตั้งใจ — ไม่ใช่การประหยัดโทเคน แต่เพื่อความแม่นยำ
// เดิมส่งช่วงต้น 12000 ตัวอักษรไปดื้อ ๆ ซึ่งส่วนใหญ่ไม่เกี่ยวกับที่นักเรียนพูด
// โมเดลต้องหาเองว่าตรงไหนสำคัญ ยิ่งมีเนื้อหาไม่เกี่ยวปนเยอะ ยิ่งตัดสินเพี้ยน
// ตอนนี้ retrieve.selectRelevant คัดมาให้เฉพาะท่อนที่ตรงกับคำพูด (ดู src/retrieve.js)
// 6000 ตัวอักษรที่ "ตรงเรื่อง" ให้ผลดีกว่า 12000 ที่เจือจาง และรองรับเอกสารยาวได้ไม่จำกัด
// เพราะไม่ได้ตัดท้ายทิ้งแล้ว แต่เลือกจากทั้งฉบับ
const SOURCE_LIMIT = IS_LOCAL
  ? Number(process.env.OLLAMA_SOURCE_LIMIT || 5000)
  : Number(process.env.SOURCE_LIMIT || 6000);

function buildUserPrompt(sourceText, transcript) {
  const picked = selectRelevant(sourceText, transcript, SOURCE_LIMIT);

  // บอกโมเดลตรง ๆ ว่านี่เป็นเอกสารบางส่วน ไม่ใช่ทั้งฉบับ
  // ไม่งั้นมันจะหักคะแนน content_match เพราะ "นักเรียนพูดถึงเรื่องที่ไม่มีในงาน"
  // ทั้งที่เรื่องนั้นอยู่ในท่อนที่เราไม่ได้ส่งไปเอง
  const note = picked.truncated
    ? `(เอกสารฉบับเต็มยาว ${picked.totalChars} ตัวอักษร ด้านล่างคือส่วนที่ระบบคัดมาว่าเกี่ยวกับสิ่งที่นักเรียนพูด — ` +
      `ถ้านักเรียนพูดถึงเรื่องที่ไม่ปรากฏด้านล่าง อย่าเพิ่งสรุปว่าพูดนอกเรื่อง อาจอยู่ในส่วนที่ไม่ได้ยกมา)\n`
    : "";

  // เนื้องานมาก่อน transcript โดยตั้งใจ — โมเดลต้องตั้งหลักจาก "งานคืออะไร"
  // ก่อนอ่านคำพูด ไม่งั้นมันจะอ่าน transcript แล้วไปหาเหตุผลสนับสนุนสิ่งที่นักเรียนพูดย้อนหลัง
  return `=== เนื้องานจริงของนักเรียน (แกนหลักของการวิเคราะห์) ===
${note}${picked.text}

=== คำอธิบายด้วยเสียงของนักเรียน (transcript) ===
${transcript}

=== สิ่งที่ต้องทำ ===
1. สรุปประเด็นหลักของงานจากเนื้องานด้านบน 3-6 ข้อ ลง key_points
2. ไล่ทีละข้อว่า transcript พูดถึงหรือไม่ ลง coverage พร้อม quote คำต่อคำ
3. ให้คะแนน 5 ด้านโดยอิงผลจากข้อ 2 เป็นหลัก`;
}

// ดึงเฉพาะตัว JSON ออกมาจากคำตอบดิบ
// โมเดลตระกูล Qwen3 (ซึ่ง typhoon2.5-qwen3 ใช้เป็นฐาน) ชอบคิดออกมาเป็น <think>…</think> ก่อน
// และบางตัวห่อคำตอบด้วย ```json … ``` ถ้าไม่ลอกออกก่อน JSON.parse จะพังทันที
function stripToJson(raw) {
  let s = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")   // เผื่อ <think> เปิดค้างไว้ไม่มีตัวปิดคู่
    .replace(/```(?:json)?/gi, "")
    .trim();

  // ยังมีข้อความห้อยหน้า/หลังอยู่ ให้ตัดเอาเฉพาะช่วงวงเล็บปีกกาชั้นนอกสุด
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start > 0 || (end !== -1 && end < s.length - 1)) {
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

function clamp(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

// เกณฑ์ระดับความน่าเชื่อถือ — ยกขึ้นจากเดิม (เขียว 70 / เหลือง 45) เพราะเกณฑ์เดิมหลวมเกินไป
// "เขียว" ต้องแปลว่าครูข้ามไปได้โดยไม่ต้องถามอะไรอีก ไม่ใช่แค่ "พอใช้ได้"
// ตั้งค่าใน .env ได้ตอน pilot เพราะเกณฑ์ที่เหมาะจริงต้องจูนจากข้อมูลของแต่ละวิชา
const GREEN_MIN = Number(process.env.TRUST_GREEN_MIN || 80);
const YELLOW_MIN = Number(process.env.TRUST_YELLOW_MIN || 60);

function toTrustLevel(score) {
  if (score >= GREEN_MIN) return "green";
  if (score >= YELLOW_MIN) return "yellow";
  return "red";
}

// ── กติกาที่บังคับหลังโมเดลให้คะแนน ────────────────────────────────────
// โมเดลภาษามีอคติ "ให้คะแนนใจดี" ติดตัวมา ต่อให้สั่งในพรอมป์ว่าให้เข้มแค่ไหนก็ยังเผลอ
// ส่วนนี้จึงเป็นตัวคุมที่คำนวณจากตัวเลขตรง ๆ โมเดลเถียงไม่ได้ และครูกดซ้ำได้ผลเดิมเสมอ
//
// ทุกกติกาเป็นแบบ "เพดาน" ไม่ใช่ "หักคะแนน" — เพราะเพดานอธิบายกับนักเรียนได้ว่า
// ต้องทำอะไรเพิ่มถึงจะทะลุขึ้นไปได้ ต่างจากการหักลบที่บอกไม่ได้ว่าหายไปไหน
const squeeze = (s) => String(s || "").replace(/\s+/g, "");

// quote ที่โมเดลยกมาต้องมีอยู่ใน transcript จริง ๆ (เทียบแบบตัดช่องว่างทิ้ง
// เพราะตัวถอดเสียงวางช่องว่างไม่แน่นอน) — quote ที่หาไม่เจอคือโมเดลแต่งขึ้นเอง
function countVerifiedEvidence(evidence, transcript) {
  if (!Array.isArray(evidence)) return 0;
  const hay = squeeze(transcript);
  return evidence.filter((e) => {
    const q = squeeze(e && (e.quote ?? e));
    return q.length >= 8 && hay.includes(q);
  }).length;
}

// ── ผลไล่ประเด็นของเนื้องาน ────────────────────────────────────────────
// โมเดลสรุปประเด็นหลักจากเนื้องานที่คัดมา (key_points) แล้วบอกว่าพูดถึงข้อไหนบ้าง (coverage)
// ตรงนี้ทำสองอย่าง: จัดรูปให้สม่ำเสมอ และ "ตรวจสอบ" quote เหมือนที่ทำกับ evidence
// เพราะ covered:"yes" ที่ยก quote ซึ่งไม่มีอยู่ใน transcript คือโมเดลกรอกให้ผ่านเอง
function normalizeCoverage(rawPoints, rawCoverage, transcript) {
  const hay = squeeze(transcript);
  const rows = Array.isArray(rawCoverage) ? rawCoverage : [];
  const points = Array.isArray(rawPoints) ? rawPoints.map((p) => String(p || "").trim()) : [];

  // coverage คือแหล่งความจริง — แต่ถ้าโมเดลส่งมาแค่ key_points ให้ถือว่าทุกข้อยังไม่พูดถึง
  const list = rows.length
    ? rows
    : points.map((p) => ({ point: p, covered: "no", quote: "" }));

  return list
    .slice(0, 8)
    .map((row) => {
      const point = String(row?.point || "").trim();
      if (!point) return null;

      const quote = String(row?.quote || "").trim();
      const verified = squeeze(quote).length >= 8 && hay.includes(squeeze(quote));

      let covered = String(row?.covered || "no").toLowerCase();
      if (!["yes", "partial", "no"].includes(covered)) covered = "no";
      // อ้างว่าพูดถึงแต่หา quote ในคำพูดจริงไม่เจอ ให้ลดชั้นลงหนึ่งขั้น
      if (!verified) covered = covered === "yes" ? "partial" : "no";

      return { point: point.slice(0, 160), covered, quote: verified ? quote : "" };
    })
    .filter(Boolean);
}

// สัดส่วนประเด็นในเนื้องานที่พูดถึงจริง (พูดครบ = 1, แตะผ่าน = 0.5)
// null เมื่อไล่ประเด็นไม่ได้เลย — กติกาที่อิงค่านี้จะถูกข้ามไป ไม่ใช่ลงโทษ
function coverageRatio(coverage) {
  if (!coverage.length) return null;
  const got = coverage.reduce((sum, c) => sum + (c.covered === "yes" ? 1 : c.covered === "partial" ? 0.5 : 0), 0);
  return got / coverage.length;
}

function applyStrictRules({ weighted, dims, transcript, verifiedEvidence, ratio }) {
  const { contentMatch, specificity, reasoning, ownership, ownWords } = dims;
  let score = weighted;
  const notes = [];

  const cap = (limit, note) => {
    if (score > limit) {
      score = Math.max(0, Math.round(limit));
      notes.push(note);
    }
  };

  // 1) ห่วงโซ่อ่อนสุด — คะแนนรวมวิ่งหนี ownership ไปไกลไม่ได้
  //    งานที่ลอกมาทั้งดุ้นมักได้ content_match สูงลิ่ว (เพราะอ่านงานแล้วเล่าตาม)
  //    แต่ ownership ต่ำ ถ้าเฉลี่ยตรง ๆ ด้านที่สูงจะกลบด้านที่เป็นสัญญาณอันตรายพอดี
  cap(ownership + 8, "คะแนนถูกจำกัดโดยด้านร่องรอยการลงมือทำ");
  cap((contentMatch + specificity) / 2 + 10, "คะแนนถูกจำกัดโดยความตรงงานและความเจาะจง");

  // 2) ความยาวคำอธิบาย — สั้นเกินไปคือ "ยังไม่มีหลักฐานพอให้ตัดสิน" ไม่ใช่ "ผ่าน"
  //    นับแบบตัดช่องว่าง เพราะภาษาไทยไม่เว้นวรรคระหว่างคำ
  const len = squeeze(transcript).length;
  if (len < 150) cap(30, "คำอธิบายสั้นเกินกว่าจะพิสูจน์ความเข้าใจได้");
  else if (len < 350) cap(55, "คำอธิบายสั้น หลักฐานยังไม่พอ");
  else if (len < 700) cap(78, "คำอธิบายค่อนข้างสั้น ยังไม่ครอบคลุมพอจะให้ระดับเขียว");

  // 3) คำพูดอ้างอิงที่ตรวจสอบแล้ว — กันโมเดลให้คะแนนสูงโดยอ้างคำพูดที่ไม่มีอยู่จริง
  if (verifiedEvidence === 0) cap(60, "โมเดลยกคำพูดสนับสนุนคะแนนไม่ได้เลย");
  else if (verifiedEvidence < 2) cap(75, "มีคำพูดสนับสนุนคะแนนน้อยเกินไป");

  // 3.5) ครอบคลุมประเด็นในเนื้องานแค่ไหน — คะแนนรวมต้องไม่วิ่งหนีเนื้องานที่สรุปมา
  //      อธิบายลื่นแต่พูดถึงงานตัวเองแค่สองในห้าประเด็น ยังไม่ใช่ "เข้าใจงานชิ้นนี้"
  //      เพดาน 45 + 55*ratio: พูดครบทุกประเด็นถึงจะแตะ 100 ได้ พูดครึ่งเดียวเพดานอยู่ราว 72
  // ratio เป็น null/undefined เมื่อไล่ประเด็นไม่ได้ (หรือผู้เรียกรุ่นเก่าไม่ได้ส่งมา) — ข้ามกติกานี้ ไม่ลงโทษ
  if (Number.isFinite(ratio)) {
    cap(45 + 55 * ratio, `พูดถึงประเด็นในเนื้องานราว ${Math.round(ratio * 100)}% ของทั้งหมด`);
  }

  // 4) ด้านใดด้านหนึ่งพังหนัก ห้ามได้เขียว — ค่าเฉลี่ยกลบรูโหว่ใหญ่ ๆ ไม่ได้
  const minDim = Math.min(contentMatch, specificity, reasoning, ownership, ownWords);
  if (minDim < 35) cap(GREEN_MIN - 5, "มีด้านที่คะแนนต่ำมากอย่างน้อยหนึ่งด้าน");

  // 5) ประตูสู่ระดับเขียว — เขียวต้องแข็งครบทั้งแกนหลัก ไม่ใช่ได้ดีแค่ด้านที่ปลอมง่าย
  if (score >= GREEN_MIN && (ownership < 65 || contentMatch < 60 || reasoning < 55)) {
    cap(GREEN_MIN - 1, "ยังไม่ผ่านเกณฑ์ระดับเขียว (ต้องแข็งทั้งการลงมือทำ ความตรงงาน และเหตุผล)");
  }

  return { score: Math.round(score), notes };
}

// ── ตัวยิงคำถามไปโมเดลแล้วคืน JSON ที่ parse แล้ว ──────────────────────
// แยกออกมาเพราะ coach.js ต้องยิงไปทางเดียวกันเป๊ะ (provider เดียวกัน คีย์เดียวกัน
// ข้อความ error ชุดเดียวกัน) ถ้าปล่อยให้ copy ไปอีกไฟล์ วันที่เปลี่ยน provider
// จะต้องไล่แก้สองที่และลืมที่หนึ่งแน่นอน
//
// maxTokens แยกให้ตั้งได้ เพราะคำแนะนำเชิงสอนยาวกว่าผลให้คะแนนหลายเท่า
//
// temperature ค่าตั้งต้น 0.2 คือของงานให้คะแนน ห้ามขยับ — ครูกดตรวจซ้ำแล้วต้องได้ผลใกล้เดิม
// ไม่งั้นนักเรียนคนเดิมงานเดิมจะได้คนละคะแนนทุกครั้งที่กด ซึ่งเถียงกับครูไม่ได้เลย
// ส่วนงานเขียนคำแนะนำต้องการภาษาที่ฟังเป็นคน จึงตั้งสูงกว่านี้ได้ (ดู coach.js)
async function chatJson(systemPrompt, userPrompt, { maxTokens = 2000, temperature = 0.2 } = {}) {
  const apiKey = process.env.TYPHOON_API_KEY;
  if (!apiKey && !IS_LOCAL) {
    throw new Error("ยังไม่ได้ตั้งค่า TYPHOON_API_KEY ใน .env (จำเป็นเมื่อใช้ Typhoon Cloud)");
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Ollama ไม่ตรวจคีย์ แต่ใส่ค่าหลอกไว้ให้ผ่านตัวแปลง OpenAI-compat
        Authorization: `Bearer ${apiKey || "ollama"}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        // ภาษาไทยกินโทเคนต่อตัวอักษรสูงกว่าอังกฤษมาก เผื่อไว้เยอะหน่อย
        // ไม่งั้น JSON จะขาดกลางคันแล้ว parse ไม่ผ่าน
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // แยกกรณี "ต่อไม่ติด" ออกจาก "ตอบช้าเกิน" เพราะวิธีแก้คนละเรื่องกัน
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(
        `${PROVIDER} ใช้เวลาเกิน ${Math.round(TIMEOUT_MS / 1000)} วินาที — ` +
          (IS_LOCAL ? "เครื่องอาจแรงไม่พอ ลองใช้โมเดลเล็กลงหรือเพิ่ม TYPHOON_TIMEOUT_MS" : "ลองกดวิเคราะห์ใหม่อีกครั้ง")
      );
    }
    throw new Error(`ต่อ ${PROVIDER} ที่ ${BASE_URL} ไม่ได้: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text();
    // Ollama ตอบ 404 เมื่อยังไม่ได้โหลดโมเดล — บอกวิธีแก้ไปเลย ครูจะได้ไม่ต้องไปหาเอง
    if (IS_LOCAL && res.status === 404) {
      throw new Error(`ยังไม่มีโมเดล "${MODEL}" ใน Ollama — รัน: docker compose exec ollama ollama pull ${MODEL}`);
    }
    throw new Error(`${PROVIDER} ตอบกลับ HTTP ${res.status}: ${body}`);
  }

  const choice = (await res.json()).choices?.[0];
  const raw = choice?.message?.content ?? "";

  // โดนตัดกลางคันเพราะชน max_tokens — บอกตรงๆ ดีกว่าให้ครูงงกับ JSON parse error
  if (choice?.finish_reason === "length") {
    throw new Error(`${PROVIDER} ตอบยาวเกินโควตา ผลไม่สมบูรณ์ — ลองกดวิเคราะห์ใหม่อีกครั้ง`);
  }

  try {
    return JSON.parse(stripToJson(raw));
  } catch {
    throw new Error(`${PROVIDER} ตอบกลับไม่ใช่ JSON ที่อ่านได้: ${raw.slice(0, 200)}`);
  }
}

// ── แก้คำเพี้ยนจากการถอดเสียง ──────────────────────────────────────────
//
// ขั้นนี้สำคัญกว่าที่เห็น เพราะข้อความที่ออกจากตรงนี้คือข้อความที่ใช้ให้คะแนน
// และใช้ตรวจ quote ทั้งหมด (evidence/coverage) — แก้พลาดหนึ่งคำ = หลักฐานหายไปหนึ่งชิ้น
// จึงออกแบบให้ "แก้น้อยแต่แม่น" ดีกว่า "แก้เยอะแต่เสี่ยงเรียบเรียงใหม่"

const CORRECT_SEGMENT_CHARS = 1500;   // ความยาวต่อรอบเรียก — ยาวกว่านี้คำตอบมักโดนตัดกลาง
const CORRECT_CONTEXT_CHARS = 3000;   // โควตาเนื้องานที่ยกไปเป็นบริบทศัพท์
const GLOSSARY_MAX = 40;

// คำอังกฤษที่เจอทั่วไปในเอกสารไทย ไม่ใช่ศัพท์เฉพาะของงาน — ใส่ไปมีแต่รบกวน
const GLOSSARY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has", "are", "was", "were",
  "you", "your", "not", "but", "all", "can", "will", "our", "out", "use", "used", "using",
  "page", "http", "https", "www", "com", "docx", "pdf", "doc",
]);

/**
 * รายชื่อศัพท์เฉพาะที่สะกดแบบไหนในเนื้องาน
 *
 * ตัวถอดเสียงพลาดศัพท์อังกฤษหนักที่สุด (Weak AI กลายเป็น "วีคเอไอ", PDPA กลายเป็น "พีดีพีเอ")
 * ให้โมเดลเห็นตัวสะกดที่ถูกจากเนื้องานตรง ๆ จะแก้กลับได้ตรงกว่าปล่อยให้เดาเอง
 *
 * ⚠ ต่างจาก initial_prompt ของ whisper ที่ห้ามเป็นลิสต์คำเด็ดขาด (ดู src/whisper.js)
 *   ตรงนั้นคือ decoder ที่ยึดลิสต์แล้วหลุดภาษา ส่วนตรงนี้เป็น LLM ที่อ่านลิสต์เป็นข้อมูลอ้างอิงได้
 */
function extractGlossary(sourceText, limit = GLOSSARY_MAX) {
  const freq = new Map();   // key ตัวพิมพ์เล็ก -> { term, n } เก็บตัวสะกดที่เจอครั้งแรกไว้
  for (const m of String(sourceText || "").matchAll(/[A-Za-z][A-Za-z0-9+#._-]{1,}/g)) {
    const term = m[0].replace(/[._-]+$/, "");
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (GLOSSARY_STOPWORDS.has(key)) continue;
    const hit = freq.get(key);
    if (hit) hit.n++;
    else freq.set(key, { term, n: 1 });
  }

  return [...freq.values()]
    .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((v) => v.term);
}

// หั่น transcript เป็นท่อนโดยไม่ให้ทับกัน — ท่อนที่ทับกันจะทำให้ข้อความซ้ำตอนต่อกลับ
// ตัดที่ช่องว่าง/ขึ้นบรรทัดในช่วงท้ายท่อน เพื่อไม่ให้คำขาดครึ่งแล้วโมเดลเดาผิดคำ
function splitTranscript(text, size = CORRECT_SEGMENT_CHARS) {
  const s = String(text || "");
  if (s.length <= size) return s.trim() ? [s] : [];

  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const from = i + Math.floor(size * 0.7);
      const window = s.slice(from, end);
      const br = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      if (br > 0) end = from + br + 1;
    }
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

const CORRECT_SYSTEM_PROMPT = `คุณคือระบบแก้คำเพี้ยนจากการถอดเสียงภาษาไทย (Thai ASR post-processor)
งานของคุณคือ "แก้คำที่ถอดมาผิด" เท่านั้น ไม่ใช่เรียบเรียงข้อความใหม่

แก้เฉพาะกรณีเหล่านี้:
- คำที่ออกเสียงใกล้เคียงแต่ถอดมาผิดคำ เช่น "ค่าเฉลี่ยกำลังส่อง" ที่ควรเป็น "ค่าเฉลี่ยกำลังสอง"
- ศัพท์เฉพาะ/ชื่อเฉพาะ/ตัวย่อ ที่ถอดเป็นคำอ่านไทย ให้เขียนตามตัวสะกดที่ปรากฏในเนื้องาน
  เช่น "พีดีพีเอ" -> "PDPA" เมื่อเนื้องานสะกดว่า PDPA
- คำไทยที่สะกดผิดจนไม่ใช่คำในภาษาไทย ให้แก้เป็นคำที่ใกล้เสียงที่สุดและเข้ากับบริบทของเนื้องาน
- ตัวเลข/หน่วยที่ถอดเป็นคำอ่าน ให้คงรูปเดิมไว้ ห้ามแปลงเป็นตัวเลข

ห้ามเด็ดขาด:
- ห้ามสรุป ย่อ ขยาย เรียบเรียงประโยคใหม่ หรือสลับลำดับข้อความ
- ห้ามเติมเนื้อหา ข้อมูล หรือคำอธิบายที่นักเรียนไม่ได้พูด
- ห้ามลบคำซ้ำ คำติดอ่าง คำเชื่อมพูด ("เอ่อ" "แบบว่า" "ก็คือ") — เป็นหลักฐานว่าพูดสด
- ห้ามแก้ไวยากรณ์ ห้ามเปลี่ยนคำพูดให้เป็นภาษาเขียน ห้ามเพิ่มเครื่องหมายวรรคตอน
- ห้ามแปลภาษา และห้ามใช้อักษรของภาษาอื่นที่ไม่ใช่ไทย/อังกฤษ
- ถ้าคำไหนไม่แน่ใจ ให้คงคำเดิมไว้ — คงคำเดิมปลอดภัยกว่าเดาผิด

ข้อความที่คืนต้องยาวใกล้เคียงข้อความเดิม และเรียงลำดับเหมือนเดิมทุกประโยค

ตอบกลับเป็น JSON เท่านั้น รูปแบบ:
{"correctedText":"ข้อความที่แก้คำเพี้ยนแล้ว ความยาวใกล้เคียงเดิม",
 "corrections":["คำเดิม -> คำที่แก้ (เหตุผลสั้น ๆ)"]}
ถ้าไม่มีคำไหนต้องแก้เลย ให้คืนข้อความเดิมทั้งดุ้นและ corrections เป็น []`;

// แก้ทีละท่อน — ถ้าท่อนไหนผลลัพธ์น่าสงสัย ใช้ของเดิมของท่อนนั้นแทน ไม่ทิ้งทั้งฉบับ
async function correctSegment(segment, context, glossary) {
  const parts = [];
  if (context) parts.push(`=== เนื้องานจริง (ใช้เทียบบริบทและตัวสะกดศัพท์เฉพาะ) ===\n${context}`);
  if (glossary.length) {
    parts.push(`=== ตัวสะกดศัพท์เฉพาะที่ใช้ในเนื้องาน (ถ้าพบคำอ่านไทยของศัพท์เหล่านี้ ให้แก้กลับเป็นตัวสะกดนี้) ===\n${glossary.join(" · ")}`);
  }
  parts.push(`=== ข้อความถอดเสียงที่ต้องแก้คำเพี้ยน (${segment.length} ตัวอักษร) ===\n${segment}`);

  // เผื่อโควตาไว้ ~1.6 เท่าของความยาวท่อน บวกส่วนของรายการ corrections
  const maxTokens = Math.min(4000, Math.round(segment.length * 1.6) + 600);

  // temperature 0 — ข้อความที่ใช้ให้คะแนนต้องเหมือนเดิมทุกครั้งที่ครูกดตรวจซ้ำ
  const parsed = await chatJson(CORRECT_SYSTEM_PROMPT, parts.join("\n\n"), { maxTokens, temperature: 0 });

  const out = typeof parsed.correctedText === "string" ? parsed.correctedText.trim() : "";
  if (!out) return { text: segment, corrections: [], rejected: "โมเดลไม่ได้คืนข้อความ" };

  // กันโมเดลเรียบเรียงใหม่/ตัดทิ้ง/ตอบเป็นเนื้องานแทน — วัดจากความยาวที่ตัดช่องว่างแล้ว
  // ±25% ครอบคลุมการแก้คำอ่านไทยเป็นตัวย่ออังกฤษ (สั้นลงมาก) โดยยังจับการย่อความได้
  const before = squeeze(segment).length;
  const after = squeeze(out).length;
  if (before > 0 && (after < before * 0.75 || after > before * 1.25)) {
    return { text: segment, corrections: [], rejected: "ผลลัพธ์ยาวผิดปกติ ใช้ข้อความเดิมแทน" };
  }

  const corrections = (Array.isArray(parsed.corrections) ? parsed.corrections : [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 20);

  return { text: out, corrections, rejected: null };
}

async function correctThaiTranscript(transcript, sourceText = "") {
  if (!transcript || !transcript.trim()) {
    return { correctedText: "", corrections: [] };
  }

  // เดิมยกเนื้องาน 3000 ตัวอักษรแรกมาดื้อ ๆ ซึ่งมักเป็นปกและคำนำ ไม่มีศัพท์ที่นักเรียนพูดถึง
  // ใช้ตัวคัดชุดเดียวกับตอนให้คะแนนแทน จะได้ท่อนที่ตรงกับคำพูดจริง (ดู src/retrieve.js)
  const picked = selectRelevant(sourceText, transcript, CORRECT_CONTEXT_CHARS);
  const context = picked.text.trim();
  // glossary ดึงจากเนื้องาน "ทั้งฉบับ" ไม่ใช่เฉพาะท่อนที่คัดมา — ศัพท์ที่ถอดเพี้ยนจนคัดไม่ติด
  // คือศัพท์ที่ต้องการความช่วยเหลือมากที่สุดพอดี
  const glossary = extractGlossary(sourceText);

  const segments = splitTranscript(transcript);
  const corrections = [];
  const notes = [];

  try {
    const results = [];
    // ทำทีละท่อนตามลำดับ — โมเดลในเครื่องรับงานขนานไม่ไหว และลำดับผลต้องตรงกับลำดับข้อความ
    for (const seg of segments) {
      results.push(await correctSegment(seg, context, glossary));
    }

    for (const r of results) {
      corrections.push(...r.corrections);
      if (r.rejected) notes.push(r.rejected);
    }

    const correctedText = results.map((r) => r.text).join("");
    return {
      correctedText: correctedText.trim() || transcript,
      corrections: corrections.slice(0, 40),
      // ท่อนที่ถูกปฏิเสธไม่ใช่ error ของทั้งงาน แต่ครูควรรู้ว่ามีท่อนที่ไม่ได้แก้
      warning: notes.length ? [...new Set(notes)].join(" · ") : undefined,
    };
  } catch (err) {
    // แก้คำเพี้ยนไม่สำเร็จ ไม่ควรทำให้การตรวจล้ม — ใช้ข้อความดิบต่อไปตามเดิม
    return { correctedText: transcript, corrections: [], error: err.message };
  }
}

async function analyze(sourceText, transcript) {
  // กรองและแก้ไขคำภาษาไทยที่เพี้ยนจากการถอดเสียงก่อนประเมินคะแนน
  const filterRes = await correctThaiTranscript(transcript, sourceText);
  const effectiveTranscript = filterRes.correctedText || transcript;

  // 3000 แทนค่าตั้งต้น 2000 — คำตอบมี key_points กับ coverage เพิ่มเข้ามา
  // ถ้าโควตาไม่พอ JSON จะขาดกลางคันแล้วทั้งงานกลายเป็น error ทั้งที่ตรวจไปแล้ว
  const parsed = await chatJson(SYSTEM_PROMPT, buildUserPrompt(sourceText, effectiveTranscript), {
    maxTokens: 3000,
  });

  const coverage = normalizeCoverage(parsed.key_points, parsed.coverage, effectiveTranscript);
  const ratio = coverageRatio(coverage);

  const contentMatch = clamp(parsed.content_match);
  const specificity = clamp(parsed.specificity);
  const reasoning = clamp(parsed.reasoning);
  const ownership = clamp(parsed.ownership);
  const ownWords = clamp(parsed.own_words);

  // ถ่วงน้ำหนักไปทางด้านที่ "ปลอมยาก" ถ้าไม่ได้ทำงานเอง — ค่าน้ำหนักอยู่ใน rubric.js
  // ที่เดียวกับเกณฑ์ เพราะหน้าเว็บต้องอธิบายให้ครูได้ว่าคะแนนรวมคิดมาจากอะไร
  // (content_match หนักสุด 28% เพราะการตรวจนี้ยึดเนื้องานที่สรุปมาเป็นแกน ถัดมา ownership 24%
  //  ส่วน own_words เบาสุด 12% เพราะซ้อมมาพูดให้ฟังลื่นได้ง่ายที่สุด)
  const weighted =
    ownership * WEIGHTS.ownership +
    contentMatch * WEIGHTS.content_match +
    specificity * WEIGHTS.specificity +
    reasoning * WEIGHTS.reasoning +
    ownWords * WEIGHTS.own_words;

  let flags = Array.isArray(parsed.flags) ? parsed.flags.slice(0, 3).map(String) : [];

  const verifiedEvidence = countVerifiedEvidence(parsed.evidence, effectiveTranscript);

  const strict = applyStrictRules({
    weighted,
    dims: { contentMatch, specificity, reasoning, ownership, ownWords },
    transcript: effectiveTranscript,
    verifiedEvidence,
    ratio,
  });
  let trustScore = strict.score;

  // อ่านสคริปต์มาพูด — เกณฑ์เดิม (ownership<30 และ ownWords<35) แคบจนแทบไม่เคยเข้าเงื่อนไข
  // เปลี่ยนเป็น "หรือ" และยกระดับขึ้น เพราะกรณีที่น่าสงสัยจริงมักติดแค่ด้านเดียว
  if (ownership < 50 || ownWords < 45) {
    trustScore = Math.max(0, trustScore - 8);
    if (!flags.some((f) => f.includes("สคริปต์") || f.includes("เขียน"))) {
      flags.push("คำอธิบายมีลักษณะเตรียมมาอ่าน — ควรถามสดเพิ่มก่อนตัดสิน");
    }
  }

  // ประเด็นในเนื้องานที่นักเรียนไม่ได้พูดถึงเลย — ครูเอาไปตั้งเป็นคำถามตามได้ทันที
  // เอาจากผลไล่ประเด็นก่อน เพราะ coverage ถูกตรวจ quote มาแล้ว ต่างจาก missing ที่โมเดลเขียนลอย ๆ
  // ใช้ missing เป็นตัวสำรองเฉพาะตอนที่ไล่ประเด็นไม่ได้เลย (เช่นโมเดลไม่ส่ง key_points มา)
  const uncovered = coverage.filter((c) => c.covered === "no").map((c) => c.point);
  const missingPoints = uncovered.length
    ? uncovered
    : coverage.length
      ? []
      : (Array.isArray(parsed.missing) ? parsed.missing : []);
  for (const m of missingPoints.slice(0, 3)) {
    const text = String(m || "").trim();
    if (text) flags.push(`ไม่ได้พูดถึง: ${text}`);
  }

  // เหตุผลที่คะแนนโดนจำกัดต้องโชว์ให้ครูเห็นเสมอ ไม่งั้นครูจะงงว่าทำไมคะแนนรายด้านสูงแต่คะแนนรวมไม่ขึ้น
  // และห้ามล้าง flags ทิ้งเมื่อได้เขียวเหมือนโค้ดเดิม — ข้อสังเกตที่เจอแล้วต้องไปถึงครูทุกกรณี
  flags.push(...strict.notes);

  const trustLevel = toTrustLevel(trustScore);

  return {
    contentMatch,
    specificity,
    reasoning,
    ownership,
    ownWords,
    trustScore,
    trustLevel,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
    flags: flags.slice(0, 6),
    // ทุกเคสที่ไม่เขียวควรถามเพิ่ม รวมถึงเคสที่คะแนนรวมสวยแต่มีด้านใดด้านหนึ่งต่ำ
    needsFollowup:
      trustLevel !== "green" ||
      Math.min(contentMatch, specificity, reasoning, ownership, ownWords) < 45 ||
      strict.notes.length > 0 ||
      // ข้ามประเด็นในเนื้องานไปเกินหนึ่งในสาม ต้องถามเพิ่มเสมอ ต่อให้คะแนนสวย
      (Number.isFinite(ratio) && ratio < 0.67),
    verifiedEvidence,
    // ผลไล่ประเด็นของเนื้องาน — ครูเห็นเป็นรายข้อว่างานพูดถึงอะไรไปแล้วและข้ามอะไรไป
    coverage,
    coverageRatio: ratio,
    originalTranscript: transcript,
    correctedTranscript: effectiveTranscript,
    corrections: filterRes.corrections,
  };

}

// เช็คว่าตัววิเคราะห์พร้อมใช้จริงไหม — ใช้ในหน้าสถานะระบบด้านบนของหน้าเว็บ
async function checkHealth() {
  if (!IS_LOCAL) {
    return process.env.TYPHOON_API_KEY
      ? { ok: true, provider: PROVIDER, model: MODEL }
      : { ok: false, provider: PROVIDER, model: MODEL, error: "ยังไม่ได้ใส่ TYPHOON_API_KEY" };
  }

  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, provider: PROVIDER, model: MODEL, error: `HTTP ${res.status}` };

    const ids = ((await res.json()).data || []).map((m) => m.id);
    // Ollama เติม :latest ต่อท้ายเวลาไม่ได้ระบุแท็ก เทียบแบบตัดแท็กออกก่อน
    const bare = (s) => String(s).replace(/:latest$/, "");
    const ready = ids.some((id) => bare(id) === bare(MODEL));

    return ready
      ? { ok: true, provider: PROVIDER, model: MODEL }
      : { ok: false, provider: PROVIDER, model: MODEL, error: `ยังไม่ได้โหลดโมเดล (มีอยู่: ${ids.join(", ") || "ไม่มีเลย"})` };
  } catch (err) {
    return { ok: false, provider: PROVIDER, model: MODEL, error: err.message };
  }
}

module.exports = {
  analyze,
  correctThaiTranscript,
  toTrustLevel,
  checkHealth,
  stripToJson,
  chatJson,
  applyStrictRules,
  countVerifiedEvidence,
  normalizeCoverage,
  coverageRatio,
  extractGlossary,
  splitTranscript,
  SOURCE_LIMIT,
  GREEN_MIN,
  YELLOW_MIN,
};

