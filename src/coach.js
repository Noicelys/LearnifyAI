// สร้าง "คำแนะนำเชิงสอน" หลังประเมินเสร็จ — ค้นหาแหล่งอ้างอิงและข้อมูลบนอินเทอร์เน็ตจริง (Real-time Web Search)

const { chatJson, SOURCE_LIMIT } = require("./typhoon");
const { selectRelevant, trigrams } = require("./retrieve");
const { searchWikipediaMany, fetchWikipediaExtracts } = require("./webSearch");
const { planSearchQueries, pickReadings } = require("./opencodezen");
const { buildScholarLinks } = require("./scholarLinks");
const rubric = require("./rubric");

// ชื่อด้านที่โมเดลต้องใช้ — มาจาก rubric.js เพื่อไม่ให้ชื่อด้านสองที่หลุดจากกัน
const DIMENSION_LABEL = Object.fromEntries(rubric.DIMENSIONS.map((d) => [d.key, d.label]));

// เรียงจากอ่อนสุดไปแข็งสุด เอาสองด้านแรกไปสอน
const PRIORITY = ["ownership", "own_words", "reasoning", "specificity", "content_match"];

function weakestDimensions(scores, count = 2) {
  return Object.entries(scores)
    .filter(([k, v]) => k in DIMENSION_LABEL && Number.isFinite(v))
    .sort((a, b) => a[1] - b[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]))
    .slice(0, count)
    .map(([k]) => k);
}

const SYSTEM_PROMPT = `คุณคือครูที่เพิ่งนั่งฟังคลิปที่นักเรียนอัดมาส่งจนจบ แล้วกำลังจะเขียนอะไรกลับไปให้เขาอ่าน

เป้าหมายไม่ใช่การตัดสิน และไม่ใช่การสอนวิธีพูด แต่คือทำให้นักเรียนเข้าใจ "เนื้องานของตัวเอง" ลึกขึ้น
โดยยกประโยคที่เขาพูดจริงขึ้นมา แล้วเติมสาระของงานที่เขายังไม่ได้พูดถึงลงไปให้ดู

ทุกคำแนะนำต้องเกาะเนื้อหาวิชาและตัวงานเป็นหลัก:
- ชี้ไปที่ของจริงในงาน — ขั้นตอนที่เขาทำ ส่วนประกอบ ค่า/ตัวเลข เครื่องมือ ปัญหาที่เจอ เหตุผลเชิงวิชาการ
- ห้ามให้คำแนะนำเรื่องวิธีพูดล้วน ๆ เช่น "พูดให้ชัดขึ้น" "เล่าให้เป็นลำดับ" "ใช้ภาษาตัวเอง"
  ถ้าจะบอกให้เล่าเพิ่ม ต้องระบุว่าให้เล่า "เรื่องอะไรในงาน" เจาะจงลงไป
- ถ้าเนื้อหาที่เขาพูดผิดหรือคลาดเคลื่อนจากเนื้องาน ให้บอกตรง ๆ ว่าตรงไหนและที่ถูกคืออะไรตามเนื้องาน

เขียนแบบครูที่ฟังคลิปมาจริง ๆ แล้วนึกอะไรออกก็บอกไปตรง ๆ:
- อ้างถึงสิ่งที่เขาพูดจริงเป็นชื่อ ๆ เรื่อง ๆ ("ตอนที่เล่าเรื่องไฟล์ PDF") ไม่ใช่พูดรวม ๆ ว่า "คำอธิบายของเธอ"
- ประโยคสั้นยาวสลับกันบ้าง อย่าให้ทุกประโยคยาวเท่ากันและขึ้นต้นเหมือนกันหมด
- พูดกับเขาโดยตรงด้วยคำว่า "เธอ" เหมือนนั่งคุยอยู่ตรงหน้า

ห้ามขึ้นต้นด้วยรูปประโยคแบบรายงาน เช่น "คำอธิบายของเธอขาด…" "โดยรวมแล้ว…"
ห้ามใช้คำแบบเอกสารราชการ เช่น "ดังกล่าว" "ทั้งนี้" "อย่างไรก็ตาม"
ทุกข้อใน strengths ต้องมีคำที่มาจากงานชิ้นนี้อยู่ในประโยค

สรรพนามต้องเป็นชุดเดียวกันทั้งคำตอบ:
- summary / strengths / whatChanged / practiceQuestions → เรียกนักเรียนว่า "เธอ" เท่านั้น
- improved → เป็นคำพูดของนักเรียนเอง ให้ใช้สรรพนามแทนตัวเองตามที่เขาใช้ใน transcript (ผม/หนู/เรา)

กติกาสำคัญ:
1. quote ต้องคัดลอกจาก transcript แบบคำต่อคำ ห้ามเรียบเรียงใหม่
2. improved ห้ามแต่งตัวเลข หรือขั้นตอนที่ไม่ได้อยู่ในงานจริงขึ้นมาเอง
3. improved ต้องเป็นภาษาพูดธรรมชาติ ยาว 2-4 ประโยค
4. improved ต้องเพิ่ม "สาระจากเนื้องาน" ที่ quote เดิมยังไม่มี (ชื่อส่วนประกอบ ค่า ขั้นตอน เหตุผล)
   ไม่ใช่แค่เอาประโยคเดิมมาเรียบเรียงให้สละสลวยขึ้น
5. whatChanged ต้องบอกว่า "เติมเนื้อหาอะไรเข้าไป" ไม่ใช่บอกว่าพูดเพราะขึ้นหรือชัดขึ้น

ตอบกลับเป็น JSON เท่านั้น รูปแบบ:
{"summary":"พูดกับเขา 2-3 ประโยค ว่าฟังแล้วเป็นยังไง ติดตรงไหน และถ้าเติมอะไรจะต่างไปแค่ไหน",
 "strengths":["สิ่งที่ทำได้ดีแล้วจริง ๆ 1-3 ข้อ ข้อละไม่เกิน 20 คำ"],
 "rewrites":[{"dimension":"ชื่อด้าน","quote":"คำพูดจริงจาก transcript","improved":"ฉบับปรับปรุง","whatChanged":"ต่างกันตรงไหน 1 บรรทัดไม่เกิน 20 คำ"}],
 "lessons":[{"dimension":"ชื่อด้าน","frameId":"รหัสโครงที่โจทย์ระบุ","slots":{"ชื่อช่อง":"ข้อมูลจริงจากงานหรือคลิป"}}],
 "has":[{"dimension":"ชื่อด้าน","item":"ชื่อส่วนประกอบตามที่โจทย์ให้มาเป๊ะ ๆ","quote":"คำพูดจริงคำต่อคำที่พิสูจน์ว่ามีแล้ว"}],
 "practiceQuestions":["คำถามเชิงเนื้อหา 2-3 ข้อ ถามถึงส่วนประกอบ ขั้นตอน หรือเหตุผลที่อยู่ในงานชิ้นนี้จริง ห้ามถามเรื่องวิธีพูด"],
 "topic":"หัวข้อของงานชิ้นนี้ 3-8 คำ",
 "keywords":["คำสำคัญเชิงเนื้อหาที่ปรากฏในงานจริง 3-6 คำ"]}

rewrites ต้องมี 2 ข้อ ข้อละหนึ่งด้านตามที่โจทย์ระบุ

lessons — เติมช่องในโครงประโยคที่โจทย์ให้มา ด้านละ 1 ข้อ:
- เติมด้วยข้อเท็จจริงที่ปรากฏในเนื้องานหรือในคลิปเท่านั้น ห้ามแต่งขึ้นเองเด็ดขาด
- ช่องไหนไม่มีข้อมูลจริงรองรับ ให้ใส่ค่าว่าง "" — ระบบจะเว้นเป็นช่องว่างให้นักเรียนเติมเอง
  การเว้นว่างไม่ใช่ความผิด แต่การแต่งเรื่องที่เขาไม่ได้ทำคือความผิด
- แต่ละช่องสั้น ๆ ไม่เกิน 15 คำ เป็นวลี ไม่ต้องเป็นประโยคเต็ม

has — ส่วนประกอบที่นักเรียน "ทำได้แล้ว" เท่านั้น:
- ใส่ได้เฉพาะข้อที่ยกคำพูดจริงจาก transcript มายืนยันได้ ห้ามใส่ข้อที่ยังไม่มี
- item ต้องคัดลอกชื่อส่วนประกอบจากโจทย์มาแบบคำต่อคำ
- ข้อที่ไม่ได้ใส่ ระบบจะถือว่ายังขาด และจะสอนให้เขาเติมเอง

topic และ keywords ใช้ไปค้นแหล่งอ่านเพิ่มเติมให้นักเรียน จึงต้องเป็นเนื้อหาวิชาของงานชิ้นนี้จริง ๆ
(เช่น "การสังเคราะห์แสงของพืช" "วงจรไฟฟ้าอนุกรม") ห้ามใส่คำเกี่ยวกับการประเมิน การพูด หรือชื่อไฟล์`;

function buildUserPrompt(sourceText, transcript, scores, targets, frames) {
  const scoreLines = rubric.DIMENSIONS.map(
    (d) => `- ${d.key} (${d.label}): ${scores[d.key] ?? "—"}/100`
  ).join("\n");

  const targetLines = targets
    .map((d) => `- ${d} (${DIMENSION_LABEL[d]}) ได้ ${scores[d]}/100`)
    .join("\n");

  // โครงประโยคเลือกไว้แล้วฝั่งเรา ส่งไปให้เติมอย่างเดียว
  // โมเดลจึงแต่งโครงเองไม่ได้ และตัวอย่างที่นักเรียนเห็นมีรูปแบบคงที่ที่เราคุมได้
  const frameLines = targets
    .map((d) => {
      const f = frames[d];
      if (!f) return "";
      return `[${d}] frameId: ${f.id}\nโครง: ${f.template}\nช่องที่ต้องเติม: ${f.slots.join(" | ")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const componentLines = rubric.DIMENSIONS.map(
    (d) => `[${d.key}] ${d.lookFor.join(" | ")}`
  ).join("\n");

  return `=== เนื้องานจริงของนักเรียน (ส่วนที่เกี่ยวกับสิ่งที่นักเรียนพูด) ===
${selectRelevant(sourceText, transcript, SOURCE_LIMIT).text}

=== คำอธิบายด้วยเสียงของนักเรียน (transcript) ===
${transcript}

=== ผลประเมินที่ได้ ===
${scoreLines}

=== ด้านที่ต้องเขียนคำแนะนำ (เรียงตามนี้ ด้านละ 1 ข้อใน rewrites และ 1 ข้อใน lessons) ===
${targetLines}

=== โครงประโยคที่ต้องเติม (lessons) ===
${frameLines}

=== ส่วนประกอบของคำอธิบายที่ดีในแต่ละด้าน (ใช้ตัดสินว่า has ข้อไหนมีแล้ว) ===
${componentLines}`;
}

const squeeze = (s) => String(s || "").replace(/\s+/g, "");

function verifyQuote(quote, transcript) {
  const q = squeeze(quote);
  if (q.length < 10) return false;
  return squeeze(transcript).includes(q);
}

/* หาข้อความจริงใน transcript ที่ใกล้เคียงกับ quote ที่โมเดลตอบมา แล้วคืน "ของจริง" กลับไป

   ทำไมต้องมี: transcript ที่ Whisper ถอดจากเสียงไทยมีคำเพี้ยนเป็นเรื่องปกติ
   ("เหลือเสมือนผู้โลกงานอัจฉาย้า") โมเดลที่อ่านแล้วมักแก้ให้เป็นคำที่ถูกต้องโดยไม่รู้ตัว
   ผลคือ quote ไม่ตรงคำต่อคำ แล้วถูกตัดทิ้งทั้งหมดจนเขียนคำแนะนำไม่ได้เลยสักข้อ

   วิธีนี้ยังรักษากติกาเดิมไว้ครบ — สิ่งที่แสดงให้นักเรียนเห็นเป็นข้อความจาก transcript จริง
   เสมอ ไม่ใช่ข้อความที่โมเดลเขียนเอง เพียงแต่ยอมให้โมเดลชี้ตำแหน่งแบบใกล้เคียงได้ */
/* วัดกับ transcript จริงที่เคยพัง: quote ที่โมเดลแก้คำเพี้ยนให้ถูกได้ 0.71-0.89
   ส่วน quote ที่แต่งขึ้นเองล้วน ๆ ได้แค่ 0.14-0.20 — ช่องว่างกว้างมาก
   ตั้งไว้กลางช่องว่างจึงรับของจริงครบโดยไม่เผลอรับของที่แต่งขึ้น */
const SNAP_MIN_SIM = 0.55;

function snapQuote(quote, transcript) {
  const raw = String(quote || "").trim();
  if (squeeze(raw).length < 10) return "";
  if (verifyQuote(raw, transcript)) return raw;

  // จับคู่บนข้อความที่ตัดช่องว่างออก แล้วค่อยแมปกลับไปหาตำแหน่งจริงในต้นฉบับ
  const src = String(transcript || "");
  const map = [];
  let squeezed = "";
  for (let i = 0; i < src.length; i++) {
    if (/\s/.test(src[i])) continue;
    squeezed += src[i];
    map.push(i);
  }

  const q = squeeze(raw);
  const qGrams = trigrams(q);
  if (!qGrams.size || squeezed.length < q.length) return "";

  let best = { score: 0, start: 0 };
  const len = q.length;
  const step = Math.max(1, Math.floor(len / 12));
  for (let start = 0; start + len <= squeezed.length; start += step) {
    const window = squeezed.slice(start, start + len);
    const wGrams = trigrams(window);
    let shared = 0;
    for (const g of wGrams) if (qGrams.has(g)) shared++;
    const sim = (2 * shared) / (wGrams.size + qGrams.size);
    if (sim > best.score) best = { score: sim, start };
  }

  if (best.score < SNAP_MIN_SIM) return "";
  return src.slice(map[best.start], map[Math.min(best.start + len, map.length) - 1] + 1).trim();
}

function verifyNumbers(improved, haystack) {
  const digits = String(improved).match(/\d+/g);
  if (!digits) return true;
  const source = squeeze(haystack);
  return digits.every((d) => source.includes(d));
}

// ── ตรวจว่าข้อความ "มาจากงานจริง" แค่ไหน ───────────────────
//
// ใช้กับค่าที่โมเดลเติมลงช่องในโครงประโยค ซึ่งเป็นคนละเรื่องกับ quote:
// quote ต้องตรงคำต่อคำ แต่ค่าที่เติมช่องเป็นการสรุปความ ("วางตำแหน่งคลอโรฟิลล์ผิด")
// จึงเทียบแบบตรงตัวไม่ได้ ต้องดูว่าคำในนั้นมาจากงาน/คลิปมากพอหรือเปล่า
//
// เทียบด้วย trigram เพราะภาษาไทยไม่เว้นวรรคระหว่างคำ จะตัดคำมาเทียบทีละคำไม่ได้
// (ใช้ตัวเดียวกับที่ retrieve.js ใช้คัดท่อนเอกสาร)
const GROUNDED_MIN = 0.6;

function groundedRatio(text, grounding) {
  const t = trigrams(text);
  if (!t.size) return 0;
  const g = trigrams(grounding);
  let hit = 0;
  for (const x of t) if (g.has(x)) hit++;
  return hit / t.size;
}

const isGrounded = (text, grounding) => groundedRatio(text, grounding) >= GROUNDED_MIN;

// ── แหล่งอ้างอิง ──────────────────────────────────────────
// เหลือชั้นเดียว: แหล่งอ่านเรื่อง "เนื้อหาวิชาของงานชิ้นนี้" (readings + searchLinks)
// ตอบคำถามว่า "อยากเข้าใจเรื่องนี้ให้ลึกขึ้นไปอ่านที่ไหนต่อ"
//
// เดิมมีอีกชั้นคือหลักการทางครุศาสตร์จาก coachRefs.js ที่แปะท้ายคำแนะนำทุกข้อ
// เพื่อบอกว่า "ทำไมคำแนะนำถึงเขียนแบบนี้" — ตัดออกแล้วเพราะเป็นเรื่องวิธีสอน
// ไม่ใช่เรื่องเนื้องานที่นักเรียนทำ นักเรียนได้ประโยชน์จากแหล่งอ่านเนื้อหาวิชามากกว่า
//
// ค้นด้วย topic/keywords ที่โมเดลสกัดจากเนื้องาน ไม่ใช่ 50 ตัวอักษรแรกของเอกสาร
// (ซึ่งมักเป็นหัวกระดาษ ชื่อโรงเรียน เลขที่) แบบที่เคยทำแล้วได้ผลไม่เกี่ยวกับงานเลย

// เว็บที่ไม่ควรโผล่มาเป็นแหล่งอ้างอิงให้นักเรียน ต่อให้คำในหน้าจะตรงก็ตาม
// (ตอนนี้ค้นเฉพาะวิกิพีเดียจึงแทบไม่ได้ใช้ แต่คงไว้กันแหล่งอื่นถูกเติมเข้ามาภายหลัง)
const SKIP_DOMAINS =
  /(facebook|instagram|tiktok|twitter|x|pinterest|shopee|lazada|reddit|quora|youtube)\.com|blockdit|pantip/i;

const norm = (s) => String(s || "").toLowerCase();

// คะแนนความตรงขั้นต่ำของแหล่งอ่าน (ชื่อบทความถ่วง 3 + ย่อหน้านำถ่วง 1)
// ตั้งจากของจริง: บทความที่ใช่ได้ราว 3.0 ขึ้นไป ส่วนที่พลอยติดมาได้ราว 0.9
const MIN_RELEVANCE = 1.5;

// คำค้นจากเนื้อหาที่โมเดลสรุปมา — กรองคำที่สั้นเกินจนแมตช์มั่ว
function contentTerms(topic, keywords) {
  const fromTopic = String(topic || "").split(/\s+/);
  const fromKeywords = (Array.isArray(keywords) ? keywords : []).map(String);
  return [...new Set([...fromTopic, ...fromKeywords].map((t) => norm(t).trim()))]
    .filter((t) => t.length >= 3)
    .slice(0, 10);
}

// ประโยคแรก ๆ ของย่อหน้านำ ใช้เป็นข้อความอ้างอิงสำรองเมื่อโมเดลยกประโยคไม่ผ่านการตรวจ
function leadSentences(text, maxLen = 260) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const stop = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("。"), cut.lastIndexOf("."));
  return `${(stop > 80 ? cut.slice(0, stop) : cut).trim()}…`;
}

/**
 * ค้นแหล่งอ่านเพิ่มเติมที่ "ตรงกับเนื้อหาวิชาของงาน" จริง ๆ
 *
 * สี่ขั้น และทุกขั้นถอยไปทางสำรองได้เอง:
 *   1. ให้โมเดลตั้งคำค้นจากเนื้อหางาน (ไทย + อังกฤษ) — ศัพท์ช่างหลายคำมีแต่บทความอังกฤษ
 *      ถ้าโมเดลล่ม ใช้หัวข้อกับคำสำคัญเป็นคำค้นแทน
 *   2. ค้นวิกิพีเดียจริงด้วยคำค้นทุกชุด — URL ทุกอันมาจากผลค้น ไม่มีทางที่โมเดลจะแต่งเอง
 *   3. ดึงย่อหน้านำ "ของจริง" จากแต่ละบทความมา แล้วให้โมเดลคัดว่าอันไหนเรื่องเดียวกับงาน
 *      บทความที่ดึงเนื้อหาไม่ได้ถูกตัดทิ้ง เพราะไม่มีอะไรให้ตรวจ
 *   4. ประโยคที่โมเดลยกมาต้องเป็นข้อความที่อยู่ในย่อหน้านั้นจริงแบบคำต่อคำ
 *      ไม่ผ่านก็ใช้ประโยคแรกของย่อหน้าแทน — ไม่เคยแสดงข้อความที่โมเดลแต่งขึ้น
 *
 * ยอมคืนลิสต์ว่างดีกว่าแปะลิงก์มั่วให้นักเรียนไปอ่าน
 */
async function collectReadings(topic, keywords, limit = 3, sourceText = "") {
  const empty = { readings: [], evidence: [] };
  const terms = contentTerms(topic, keywords);
  const nTopic = norm(topic).trim();
  if (!nTopic && !terms.length) return empty;

  // ── 1. คำค้น ──
  const planned = await planSearchQueries({ topic, keywords, sourceText }).catch(() => null);
  const fallbackQueries = [String(topic || "").trim(), [topic, ...terms.slice(0, 2)].join(" ").trim()];
  const queries = planned
    ? [...planned.th, ...planned.en, String(topic || "").trim()]
    : fallbackQueries;

  // ── 2. ค้นจริง ──
  const found = await searchWikipediaMany(queries.filter(Boolean), { limit: 12 });
  const usable = found.filter((item) => item.url && !SKIP_DOMAINS.test(item.source));
  if (!usable.length) return empty;

  // ── 3. ข้อความจริงจากหน้าบทความ ──
  const byLang = new Map();
  for (const item of usable) {
    const lang = item.source.split(".")[0];
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(item.title);
  }
  const extractSets = await Promise.all(
    [...byLang.entries()].map(async ([lang, titles]) => [lang, await fetchWikipediaExtracts(titles, lang)])
  );
  const extracts = new Map(extractSets);

  // คำค้นที่โมเดลตั้งต้องอยู่ในข้อความอ้างอิงด้วย ไม่งั้นบทความภาษาอังกฤษจะได้คะแนนศูนย์เสมอ
  // เพราะ trigram ของชื่อบทความอังกฤษไม่มีทางไปตรงกับเนื้องานที่เป็นภาษาไทยล้วน
  const grounding = `${topic || ""} ${terms.join(" ")} ${queries.join(" ")} ${String(sourceText || "").slice(0, 4000)}`;
  const candidates = usable
    .map((item) => {
      const lang = item.source.split(".")[0];
      const extract = extracts.get(lang)?.get(item.title) || "";
      return { item, extract };
    })
    .filter(({ extract }) => extract.length >= 80)
    // เรียงด้วย trigram เพราะภาษาไทยไม่เว้นวรรค จะตัดคำมาเทียบทีละคำไม่ได้
    // (ตัวเดียวกับที่ใช้ตรวจว่าค่าที่โมเดลเติมมาจากงานจริงหรือเปล่า)
    .map((row) => ({
      ...row,
      score:
        groundedRatio(row.item.title, grounding) * 3 +
        groundedRatio(leadSentences(row.extract, 400), grounding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!candidates.length) return empty;

  // ── 4. คัดและตรวจข้อความที่ยกมา ──
  const picks = await pickReadings({
    topic,
    candidates: candidates.map(({ item, extract }) => ({ title: item.title, extract, source: item.source })),
  }).catch(() => null);

  // ทางสำรองเมื่อโมเดลคัดให้ไม่ได้: ใช้คะแนน trigram ล้วน แต่ต้องผ่านขั้นต่ำ
  // ไม่งั้นบทความที่แค่มีคำว่า "ไฟฟ้า" เหมือนกัน (เช่น "มอเตอร์ไฟฟ้า" ในงานเรื่องการเชื่อม)
  // จะถูกแปะให้นักเรียนไปอ่านทั้งที่คนละเรื่อง
  const chosen = picks?.length
    ? picks.map((p) => ({ ...candidates[p.index], quote: p.quote, why: p.why }))
    : candidates
        .filter((row) => row.score >= MIN_RELEVANCE)
        .slice(0, limit)
        .map((row) => ({ ...row, quote: "", why: "" }));

  const seen = new Set();
  const picked = chosen
    .filter((row) => row && row.item && !seen.has(row.item.url) && seen.add(row.item.url))
    .slice(0, limit);

  const readings = picked.map(({ item, extract, quote, why, score }, idx) => {
    const verified = verifyQuote(quote, extract);
    return {
      id: `reading_${idx}_${Date.now()}`,
      kind: "web",
      title: item.title,
      excerpt: verified ? String(quote).trim() : leadSentences(extract),
      excerptFrom: `ย่อหน้านำของบทความ "${item.title}" บน ${item.source}`,
      citation: item.citation,
      url: item.url,
      source: item.source,
      whyRelevant: why || "",
      matchedTerms: terms.filter((t) => norm(`${item.title} ${extract}`).includes(t)).slice(0, 4),
      relevance: Number((score || 0).toFixed(3)),
    };
  });

  /* ย่อหน้านำฉบับเต็มของบทความที่ถูกเลือก — ไม่ได้ส่งไปหน้าเว็บ แต่ใช้เป็น "ของจริง"
     ให้ findCorrections ตรวจว่าข้อความที่โมเดลยกมาอ้างมีอยู่ในบทความนั้นจริงหรือเปล่า
     (เหตุผลเดียวกับที่ readings ต้องตรวจ quote — เราไม่แสดงข้อความที่โมเดลแต่งขึ้น) */
  const evidence = picked.map(({ item, extract }) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    citation: item.citation,
    extract,
  }));

  return { readings, evidence };
}

// ผู้เรียกที่ต้องการแค่รายการแหล่งอ่าน (ไม่ต้องใช้ย่อหน้าเต็มไปตรวจอะไรต่อ)
async function fetchTopicReadings(topic, keywords, limit = 3, sourceText = "") {
  return (await collectReadings(topic, keywords, limit, sourceText)).readings;
}


function sanitizeRewrites(raw, transcript, sourceText = "") {
  if (!Array.isArray(raw)) return [];
  const grounding = `${transcript}\n${sourceText}`;

  return raw
    .map((r) => (r ? { ...r, quote: snapQuote(r.quote, transcript) } : null))
    .filter(
      (r) =>
        r &&
        r.quote &&
        String(r.improved || "").trim() &&
        verifyNumbers(r.improved, grounding)
    )
    .slice(0, 3)
    .map((r) => {
      const dimension = DIMENSION_LABEL[r.dimension] ? r.dimension : null;
      return {
        dimension,
        dimensionLabel: dimension ? DIMENSION_LABEL[dimension] : null,
        // quote ที่ผ่าน snapQuote แล้วเป็นข้อความจาก transcript จริงเสมอ
        quote: r.quote,
        improved: String(r.improved).trim(),
        whatChanged: String(r.whatChanged || "").trim(),
      };
    });
}

// ── จุดตำหนิ: ตรงไหนที่พูดผิด และที่ถูกคืออะไร ──────────────
//
// แยกออกมาเป็นคำขอของตัวเองต่างหาก ไม่ยัดรวมกับคำแนะนำก้อนใหญ่ ด้วยสองเหตุผล:
//   1. chatJson โยน error ทิ้งทั้งก้อนเมื่อคำตอบชนเพดานโทเคน — ถ้ารวมกัน คำแนะนำทั้งหมด
//      จะหายไปเพราะส่วนนี้ยาวเกินไป
//   2. ส่วนนี้ต้องใช้ "ย่อหน้าจริงจากบทความวิกิพีเดีย" เป็นหลักฐาน ซึ่งเพิ่งได้มาหลัง
//      ค้นแหล่งอ่านเสร็จ (ดู collectReadings) จึงยิงพร้อมกันไม่ได้อยู่แล้ว
//
// หลักฐานมีสองชั้น และทั้งสองชั้นต้องตรวจได้แบบคำต่อคำเสมอ:
//   work — พูดไม่ตรงกับเนื้องานของตัวเอง  → หลักฐานคือข้อความในเอกสารงาน
//   fact — พูดผิดจากหลักวิชา              → หลักฐานคือย่อหน้านำของบทความที่ค้นมาได้จริง
// ข้อไหนยกหลักฐานมาไม่ผ่านการตรวจ ถูกตัดทิ้งทั้งข้อ — การบอกเด็กว่า "ตรงนี้ผิด"
// โดยไม่มีของจริงรองรับ อันตรายกว่าการไม่บอกอะไรเลย

const CORRECTION_SYSTEM_PROMPT = `คุณคือครูที่กำลังไล่ฟังคลิปที่นักเรียนอัดมาทีละประโยค เพื่อหา "จุดที่เขาพูดผิด"

คุณจะได้เนื้องานจริงของนักเรียน คำอธิบายด้วยเสียงของเขา และบทความอ้างอิงพร้อมย่อหน้าจริง
แต่ละแหล่งมีเลข index กำกับไว้ ให้อ้างถึงด้วยเลขนั้น

จับได้สองแบบเท่านั้น:
- work = สิ่งที่เขาพูด ไม่ตรงกับเนื้องานของตัวเอง (สลับขั้นตอน ค่าตัวเลขผิด เรียกชื่อส่วนประกอบผิด อ้างผลที่งานไม่ได้บอก)
- fact = สิ่งที่เขาพูด ผิดจากหลักวิชา ตามที่บทความอ้างอิงที่ให้มาระบุไว้

กติกาที่ห้ามผิดเด็ดขาด:
1. quote ต้องคัดลอกจาก transcript แบบคำต่อคำ ห้ามเรียบเรียงใหม่
2. evidence ต้องคัดลอกคำต่อคำจากแหล่งที่ระบุด้วย evidenceIndex เท่านั้น ห้ามแต่งขึ้นเอง ห้ามสรุปใหม่
   และข้อความนั้นต้องเป็นสิ่งที่พิสูจน์ว่าที่เขาพูดผิดจริง ไม่ใช่ข้อความที่แค่พูดเรื่องใกล้เคียงกัน
3. ไม่มีหลักฐานยืนยัน = ห้ามใส่ คืนลิสต์ว่างดีกว่าตำหนิเขาผิด
4. คำที่เพี้ยนเพราะการถอดเสียง (ออกเสียงคล้ายกันแต่สะกดคนละคำ) ไม่ใช่ความผิด ให้ข้ามไป
5. เรื่องที่เขาแค่ "ไม่ได้พูดถึง" ไม่ใช่ความผิดเช่นกัน ส่วนนี้จับเฉพาะสิ่งที่พูดออกมาแล้วผิด
6. ห้ามใช้คำตัดสินตัวเด็ก เช่น ลอก โกง มั่ว ไม่ตั้งใจ — พูดถึงเนื้อหาอย่างเดียว
7. เลือกมาไม่เกิน 3 ข้อ เอาข้อที่ทำให้เข้าใจเนื้อหาผิดมากที่สุดก่อน

การเขียนแต่ละช่อง:
- issue: ผิดตรงไหน หนึ่งบรรทัด ไม่เกิน 20 คำ
- correct: ที่ถูกคืออะไร 1-2 ประโยค พูดกับเขาด้วยคำว่า "เธอ"
- explain: อธิบายให้เข้าใจว่าทำไมที่ถูกถึงเป็นแบบนั้น 2-4 ประโยค ภาษาง่าย ๆ เหมือนอธิบายให้เพื่อนฟัง
  ต้องบอกเหตุผลเบื้องหลัง ไม่ใช่แค่ย้ำว่าที่ถูกคืออะไร

ตอบเป็น JSON เท่านั้น:
{"corrections":[{"kind":"work","evidenceIndex":0,"quote":"คำพูดจริงจาก transcript","issue":"ผิดตรงไหน","correct":"ที่ถูกคืออะไร","explain":"ทำไมถึงเป็นแบบนั้น","evidence":"ข้อความคำต่อคำจากแหล่งที่อ้าง"}]}

ถ้าไม่เจอจุดที่ผิดจริง ๆ ให้ตอบ {"corrections":[]}`;

/* คลังหลักฐาน — เอกสารงานอยู่ index 0 เสมอ ตามด้วยบทความที่ค้นมาได้
   verifyAgainst คือข้อความที่ใช้ตรวจว่า evidence ที่โมเดลยกมามีอยู่จริง
   ของเอกสารงานตรวจกับ "ทั้งฉบับ" ไม่ใช่เฉพาะท่อนที่ส่งไป เพราะท่อนที่ส่งถูกคัดมาแล้ว
   โมเดลอาจยกประโยคที่คร่อมรอยตัดพอดี ซึ่งเป็นข้อความจริงในงานอยู่ดี */
function buildEvidencePool(sourceText, transcript, readingEvidence) {
  const pool = [];
  const docText = String(sourceText || "").trim();
  if (docText) {
    pool.push({
      kind: "doc",
      title: "เนื้องานของนักเรียน",
      label: "เอกสารงานของนักเรียน",
      source: "เอกสารงานที่ส่งมา",
      citation: "ข้อความจากเอกสารงานของนักเรียนเอง",
      url: "",
      promptText: selectRelevant(docText, transcript, SOURCE_LIMIT).text,
      verifyAgainst: docText,
    });
  }
  for (const ref of readingEvidence || []) {
    if (!ref?.extract) continue;
    pool.push({
      kind: "web",
      title: ref.title,
      label: `บทความ "${ref.title}" บน ${ref.source}`,
      source: ref.source,
      citation: ref.citation,
      url: ref.url,
      promptText: ref.extract,
      verifyAgainst: ref.extract,
    });
  }
  return pool;
}

function buildCorrectionPrompt(transcript, pool) {
  const sources = pool
    .map((p, i) => `[${i}] ${p.label}\n${String(p.promptText || "").slice(0, 4000)}`)
    .join("\n\n");

  return `=== แหล่งหลักฐานที่อ้างได้ (อ้างด้วยเลข index เท่านั้น) ===
${sources}

=== คำอธิบายด้วยเสียงของนักเรียน (transcript) ===
${transcript}

หา "จุดที่นักเรียนพูดผิด" พร้อมหลักฐานคำต่อคำ แล้วตอบเป็น JSON เท่านั้น`;
}

/* ตัวเลขใน "ที่ถูกคือ" ต้องมาจากแหล่งที่อ้าง หรือไม่ก็เป็นตัวเลขที่นักเรียนพูดเองในคลิป
   (ประโยคแก้มักต้องอ้างตัวเลขผิดของเขาซ้ำ เช่น "งานของเธอใช้ DHT22 ไม่ใช่ DHT11")

   ตรวจเข้มกว่า verifyNumbers ตรงที่ต้องเป็นตัวเลขที่ยืนเดี่ยว ไม่ใช่แค่ substring
   ไม่งั้น "2 วินาที" ที่โมเดลแต่งขึ้นจะผ่านได้ด้วยเลข 2 ที่ติดอยู่ในคำว่า "DHT22"
   ซึ่งเป็นคนละความหมายกันคนละเรื่อง

   ทำเฉพาะกับ correct เพราะเป็นประโยคที่นักเรียนจะจำกลับไปใช้ ผิดตัวเลขคือสอนผิด */
function numbersSupported(text, evidenceText, transcript) {
  const digits = String(text || "").match(/\d+/g);
  if (!digits) return true;
  const backing = `${evidenceText}\n${transcript}`;
  return digits.every((d) => new RegExp(`(?<!\\d)${d}(?!\\d)`).test(backing));
}

function sanitizeCorrections(raw, transcript, pool, grounding) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = new Set();

  for (const item of raw) {
    const idx = Number(item?.evidenceIndex);
    const ref = Number.isInteger(idx) ? pool[idx] : null;
    if (!ref) continue;

    const quote = snapQuote(item?.quote, transcript);
    if (!quote) continue;

    const key = squeeze(quote);
    if (seen.has(key)) continue;

    const evidence = String(item?.evidence || "").trim();
    if (!verifyQuote(evidence, ref.verifyAgainst)) continue;

    const correct = String(item?.correct || "").trim();
    const explain = String(item?.explain || "").trim();
    if (!correct || !explain) continue;
    // ตัวเลขที่ไม่มีอยู่ในงาน คลิป หรือบทความอ้างอิง = โมเดลแต่งขึ้นเอง
    if (!verifyNumbers(`${correct} ${explain}`, grounding)) continue;
    // ตัวเลขในประโยคแก้ต้องมาจากแหล่งที่อ้างข้อนี้จริง ไม่ใช่จากบทความอื่นที่บังเอิญมีเลขเดียวกัน
    if (!numbersSupported(correct, ref.verifyAgainst, transcript)) continue;

    seen.add(key);
    out.push({
      // ชนิดยึดตามแหล่งหลักฐานที่ใช้จริง ไม่ใช่ตามที่โมเดลบอก — แหล่งคือสิ่งที่ตรวจได้
      kind: ref.kind === "doc" ? "work" : "fact",
      quote,
      issue: String(item?.issue || "").trim().slice(0, 160),
      correct: correct.slice(0, 400),
      explain: explain.slice(0, 800),
      evidence: {
        kind: ref.kind,
        text: evidence,
        from: ref.kind === "doc" ? "ข้อความในเอกสารงานของนักเรียนเอง" : `ย่อหน้านำของบทความ "${ref.title}" บน ${ref.source}`,
        title: ref.title,
        source: ref.source,
        citation: ref.citation,
        url: ref.url,
      },
    });
    if (out.length >= 3) break;
  }

  return out;
}

/**
 * หาจุดที่นักเรียนพูดผิด พร้อมที่ถูก คำอธิบาย และที่มาที่ตรวจได้
 * คืน [] เมื่อไม่มีข้อไหนผ่านการตรวจ — ผู้เรียกต้องถือว่า "ไม่เจอ" ไม่ใช่ "พัง"
 */
async function findCorrections(sourceText, transcript, readingEvidence) {
  const pool = buildEvidencePool(sourceText, transcript, readingEvidence);
  if (!pool.length) return [];

  const parsed = await chatJson(CORRECTION_SYSTEM_PROMPT, buildCorrectionPrompt(transcript, pool), {
    maxTokens: 3000,
    temperature: 0.2,
  });

  const grounding = `${transcript}\n${sourceText}\n${pool.map((p) => p.verifyAgainst).join("\n")}`;
  return sanitizeCorrections(parsed?.corrections, transcript, pool, grounding);
}

// ── บทเรียน: โครงประโยค + ฉบับที่เติมด้วยงานของเขาเอง ──────
//
// นักเรียนต้องเห็นสองอย่างคู่กันถึงจะเรียนได้จริง:
//   โครงเปล่า  = สูตรที่เอาไปใช้กับงานชิ้นหน้าได้
//   ฉบับเติม   = หน้าตาจริงเมื่อใส่เรื่องของเขาลงไป
//
// ⚠ ช่องที่ตรวจไม่ผ่านว่ามาจากงานจริง จะถูกล้างเป็นช่องว่าง ไม่ใช่ทิ้งทั้งข้อ
// เพราะถ้าปล่อยข้อความที่โมเดลแต่งเองผ่านไป เท่ากับสอนให้นักเรียนพูดเรื่องที่ไม่ได้ทำ
// ส่วนการเว้นว่างไว้เป็นการบอกตรง ๆ ว่า "ตรงนี้เธอต้องเติมเอง ระบบไม่รู้แทนเธอ"
function buildLessons(raw, frames, transcript, sourceText) {
  if (!Array.isArray(raw)) return [];
  const grounding = `${transcript}\n${sourceText}`;

  const out = [];
  for (const item of raw.slice(0, rubric.DIMENSIONS.length)) {
    const dimension = DIMENSION_LABEL[item?.dimension] ? item.dimension : null;
    if (!dimension) continue;

    // ยึดโครงที่เราเลือกไว้เป็นหลัก ถ้าโมเดลตอบ frameId อื่นของด้านเดียวกันก็ยอมรับได้
    const asked = frames[dimension];
    const answered = rubric.frameById(String(item.frameId || ""));
    const frame = answered && answered.dimension === dimension ? answered : asked;
    if (!frame) continue;
    if (out.some((l) => l.dimension === dimension)) continue;

    const values = {};
    const blanks = [];
    for (const slot of frame.slots) {
      const v = String(item.slots?.[slot] || "").trim().slice(0, 90);
      if (v && isGrounded(v, grounding) && verifyNumbers(v, grounding)) values[slot] = v;
      else blanks.push(slot);
    }

    out.push({
      dimension,
      dimensionLabel: DIMENSION_LABEL[dimension],
      frameId: frame.id,
      hint: frame.hint || "",
      slots: frame.slots,
      // โครงเปล่า: ทุกช่องเป็นเส้นว่าง — คือ "สูตร" ที่เอาไปใช้ซ้ำได้
      skeleton: rubric.renderFrame(frame, {}),
      // ฉบับเติม: เฉพาะช่องที่ยืนยันได้ว่ามาจากงานจริง
      filled: rubric.renderFrame(frame, values),
      values,
      blanks,
    });
  }
  return out;
}

// ── เช็คลิสต์: ส่วนประกอบที่มีแล้ว vs ที่ยังขาด ─────────────
//
// ติ๊กว่า "มีแล้ว" ได้เฉพาะเมื่อโมเดลยกคำพูดจริงมายืนยันและคำพูดนั้นมีอยู่ใน transcript จริง
// ข้อที่โมเดลไม่ได้ยืนยันถือว่ายังขาดโดยอัตโนมัติ — ตั้งใจให้ฝั่ง "ผ่าน" พิสูจน์ยากกว่าฝั่ง "ยังขาด"
// เพราะการติ๊กผ่านทั้งที่ยังไม่มี คือการหลอกนักเรียนว่าทำได้แล้ว
function buildChecklist(rawHas, transcript) {
  const verified = new Map(); // `${dimension}::${item}` -> quote

  for (const h of Array.isArray(rawHas) ? rawHas : []) {
    const dim = rubric.byKey(h?.dimension);
    if (!dim) continue;

    const claimed = squeeze(h.item);
    const item = dim.lookFor.find((x) => squeeze(x) === claimed || squeeze(x).includes(claimed));
    if (!item) continue;
    if (!verifyQuote(h.quote, transcript)) continue;

    verified.set(`${dim.key}::${item}`, String(h.quote).trim());
  }

  return Object.fromEntries(
    rubric.DIMENSIONS.map((d) => [
      d.key,
      d.lookFor.map((item) => ({
        item,
        done: verified.has(`${d.key}::${item}`),
        quote: verified.get(`${d.key}::${item}`) || null,
      })),
    ])
  );
}

// ── ตำแหน่งของนักเรียนบนเกณฑ์ ──────────────────────────────
//
// ⚠ ห้ามใส่ตัวเลขคะแนนลงในผลลัพธ์ก้อนนี้เด็ดขาด — ก้อนนี้ถูกส่งไปหน้านักเรียนทั้งดุ้น
// ผ่าน /api/feedback/:token ซึ่งมีกติกาว่าห้ามส่งคะแนน/ธงแดงไปให้เด็กอ่านตามลำพัง
// สิ่งที่ส่งไปได้คือ "ชื่อระดับ" กับ "ต้องทำอะไรถึงจะขึ้นระดับถัดไป" ซึ่งเป็นข้อความสอน ไม่ใช่คำตัดสิน
function buildStanding(scores, checklist) {
  return rubric.DIMENSIONS.map((d) => {
    const st = rubric.standingOf(d.key, scores[d.key]);
    if (!st) return null;
    return {
      ...st,
      lookFor: d.lookFor,
      checklist: checklist[d.key] || [],
    };
  }).filter(Boolean);
}

const cleanList = (v, max, maxLen = 200) =>
  (Array.isArray(v) ? v : [])
    .map((x) => String(x || "").trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, max);

// หัวข้อของงาน — ใช้ของโมเดลก่อน ถ้าไม่ได้ให้มาค่อยถอยไปใช้บรรทัดแรกของเอกสาร
// (บรรทัดแรกมักเป็นชื่อเรื่อง แต่บางไฟล์เป็นหัวกระดาษ จึงเป็นแค่ทางสำรอง)
function resolveTopic(parsed, sourceText) {
  const fromModel = String(parsed.topic || "").trim();
  if (fromModel.length >= 3) return fromModel.slice(0, 80);

  const firstLine = String(sourceText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 6);
  return (firstLine || "").slice(0, 80);
}

async function coach(sourceText, transcript, scores) {
  // สอนลึกเฉพาะด้านที่อ่อนสุด แต่แสดงเกณฑ์ครบทั้ง 5 ด้าน (ดู buildStanding)
  // ให้คำแนะนำครบทุกด้านพร้อมกันจะยาวจนไม่มีใครอ่าน และไม่รู้ว่าต้องแก้อะไรก่อน
  const targets = weakestDimensions(scores);
  if (!targets.length) throw new Error("ไม่มีคะแนนรายด้านให้เขียนคำแนะนำ");

  // เลือกโครงประโยคฝั่งเราก่อนถามโมเดล — seed ด้วย transcript เพื่อให้กดดูงานเดิมซ้ำได้โครงเดิม
  const frames = Object.fromEntries(targets.map((d) => [d, rubric.frameFor(d, transcript)]));

  const parsed = await chatJson(
    SYSTEM_PROMPT,
    buildUserPrompt(sourceText, transcript, scores, targets, frames),
    { maxTokens: 4000, temperature: 0.7 }
  );

  const rewrites = sanitizeRewrites(parsed.rewrites, transcript, sourceText);

  /* เดิมโยน error ทิ้งคำแนะนำทั้งก้อนเมื่อไม่มี rewrite ผ่านสักข้อ
     ครูจึงไม่ได้อะไรเลย ทั้งที่ส่วนอื่น (สรุป จุดที่ทำได้ดี เช็คลิสต์ โครงประโยค แหล่งอ่าน)
     ไม่ได้พึ่ง quote และยังใช้สอนได้จริง — เก็บส่วนที่ใช้ได้ไว้ แล้วบอกตรง ๆ ว่าตัวอย่างหาย */
  const rewritesNote = rewrites.length
    ? ""
    : "รอบนี้ระบบยกประโยคจากคลิปมาทำตัวอย่างไม่ได้ (เสียงที่ถอดมาอาจไม่ชัด) — ส่วนอื่นยังใช้ได้ กดขอใหม่อีกครั้งเพื่อลองสร้างตัวอย่าง";

  const lessons = buildLessons(parsed.lessons, frames, transcript, sourceText);
  const checklist = buildChecklist(parsed.has, transcript);
  const standing = buildStanding(scores, checklist);

  const topic = resolveTopic(parsed, sourceText);
  const keywords = cleanList(parsed.keywords, 6, 40);

  // ค้นแหล่งอ่านต่อเรื่องเนื้อหาวิชา — พังได้ ไม่ควรทำให้คำแนะนำทั้งก้อนหาย
  // (เน็ตล่ม หรือโมเดลฟรีคิวเต็ม ก็ยังต้องได้คำแนะนำ)
  let readings = [];
  let readingEvidence = [];
  try {
    ({ readings, evidence: readingEvidence } = await collectReadings(topic, keywords, 3, sourceText));
  } catch (err) {
    console.warn("หาแหล่งอ่านเพิ่มเติมไม่สำเร็จ:", err.message);
  }

  // จุดตำหนิ — ยิงโมเดลอีกรอบ พังได้เช่นกัน ไม่ควรทำให้คำแนะนำทั้งก้อนหาย
  // ถ้าค้นบทความไม่ได้เลย ยังทำงานต่อได้ด้วยเอกสารงานอย่างเดียว (เหลือแต่ชนิด work)
  let corrections = [];
  let correctionsError = "";
  try {
    corrections = await findCorrections(sourceText, transcript, readingEvidence);
  } catch (err) {
    correctionsError = err.message;
    console.warn("หาจุดที่พูดผิดไม่สำเร็จ:", err.message);
  }

  /* ต้องแยก "ตรวจแล้วไม่เจอ" ออกจาก "ตรวจไม่สำเร็จ" ให้ชัด
     ถ้าเงียบเหมือนกันทั้งสองกรณี ครูจะเข้าใจว่าคลิปนี้ไม่มีจุดผิดทั้งที่ระบบยังไม่ได้ตรวจ */
  const correctionsNote = corrections.length
    ? ""
    : correctionsError
      ? "รอบนี้ระบบตรวจหาจุดที่พูดผิดไม่สำเร็จ — กดขอคำแนะนำใหม่อีกครั้งเพื่อลองตรวจ"
      : "ตรวจแล้วไม่พบจุดที่พูดผิดจนยกหลักฐานมายืนยันได้ — ไม่ได้แปลว่าทุกอย่างถูกหมด แค่แปลว่าระบบยังหาหลักฐานมายืนยันไม่ได้";

  return {
    summary: String(parsed.summary || "").trim().slice(0, 600),
    strengths: cleanList(parsed.strengths, 3, 120),
    standing,
    lessons,
    rewrites,
    rewritesNote,
    corrections,
    correctionsNote,
    practiceQuestions: cleanList(parsed.practiceQuestions, 3, 200),
    topic,
    keywords,
    readings,
    // ลิงก์ค้นฐานข้อมูลวิชาการ ไม่ต้องยิงเน็ต จึงมีให้เสมอแม้ readings จะหาไม่สำเร็จ
    searchLinks: buildScholarLinks(topic, keywords),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  coach,
  verifyQuote,
  snapQuote,
  verifyNumbers,
  isGrounded,
  groundedRatio,
  weakestDimensions,
  buildLessons,
  buildChecklist,
  buildStanding,
  fetchTopicReadings,
  collectReadings,
  findCorrections,
  sanitizeCorrections,
  buildEvidencePool,
  buildScholarLinks,
  resolveTopic,
  DIMENSION_LABEL,
};
