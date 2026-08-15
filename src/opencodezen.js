// OpenCodeZen Integration (DeepSeek V4 & Free AI Models)
// หน้าที่: ค้นหาข้อมูลบนอินเทอร์เน็ตจริง (Real-time Web Search) และสรุปเนื้อหาให้เป็นภาษาไทยที่เป็นธรรมชาติ ฟังเหมือนมนุษย์เขียนจริงมากที่สุด

const { searchWeb } = require("./webSearch");

const BASE_URL = process.env.OPENCODEZEN_BASE_URL || "https://opencode.ai/zen/v1";
// ไม่มีค่า fallback โดยตั้งใจ — คีย์ต้องมาจาก .env เท่านั้น กันคีย์จริงหลุดขึ้น repo
const API_KEY = process.env.OPENCODEZEN_API_KEY || "";
const TIMEOUT_MS = Number(process.env.OPENCODEZEN_TIMEOUT_MS || 60000);

const MODEL_CANDIDATES = Array.from(
  new Set([
    process.env.OPENCODEZEN_MODEL || "deepseek-v4-flash-free",
    "deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "north-mini-code-free",
    "nemotron-3-ultra-free",
    "laguna-s-2.1-free",
    "ling-3.0-flash-free",
  ])
);

const SYSTEM_SUMMARIZE_PROMPT = `คุณคือผู้ช่วย AI (OpenCodeZen DeepSeek V4) ที่เชี่ยวชาญด้านการค้นหาข้อมูลและสรุปเนื้อหาภาษาไทย
หน้าที่สำคัญที่สุดของคุณคือ: สรุปข้อมูลให้อ่านเข้าใจง่าย เรียบเนียน ฟังดูเหมือน "มนุษย์สรุปให้มนุษย์ฟัง" มากที่สุด

หลักการสรุปให้เป็นมนุษย์ (Human-like Summarization):
1. ภาษาธรรมชาติ: ใช้ภาษาไทยที่สละสลวย ลื่นไหล อ่านเพลิน หลีกเลี่ยงภาษาหุ่นยนต์ ภาษาแปลตรงตัว หรือสำนวนแปลจากต่างประเทศ
2. กระชับ ได้ใจความ: สรุปเฉพาะประเด็นสำคัญและสาระหลักอย่างตรงจุด ไม่เยิ่นเย้อ
3. น้ำเสียงเป็นมิตรและเป็นกันเอง: ฟังดูเหมือนเพื่อนร่วมงานหรือผู้เชี่ยวชาญเล่าสรุปให้ฟัง
4. ความถูกต้อง: ยึดตามข้อมูลจากผลการค้นหาอินเทอร์เน็ตและบริบทที่ได้รับจริงเท่านั้น ห้ามแต่งเติมข้อเท็จจริงขึ้นเอง
5. โครงสร้างอ่านง่าย: แบ่งย่อหน้าหรือใช้หัวข้อย่อยเฉพาะเมื่อจำเป็น เพื่อให้อ่านสบายตา
6. แหล่งอ้างอิง: อ้างอิงจากข้อมูลผลการค้นหาอินเทอร์เน็ตที่ได้รับจริงเท่านั้น ห้ามแต่งชื่อผู้เขียน หรือ URL ปลอมขึ้นมาเอง`;

async function callOpenAiCompat(baseUrl, apiKey, model, messages, { temperature = 0.4, maxTokens = 2500 } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json();
  const msgObj = json.choices?.[0]?.message;
  const content = String(msgObj?.content || msgObj?.reasoning || msgObj?.reasoning_content || "").trim();

  if (!content) {
    throw new Error("ไม่ได้รับคำตอบจาก OpenCodeZen");
  }
  return content;
}

async function chat(messages, options = {}) {
  const key = process.env.OPENCODEZEN_API_KEY || API_KEY;
  if (!key) {
    throw new Error("ยังไม่ได้ตั้งค่า OPENCODEZEN_API_KEY");
  }

  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      return await callOpenAiCompat(BASE_URL, key, model, messages, options);
    } catch (err) {
      lastError = err;
      console.warn(`OpenCodeZen free model fallback (${model} -> next):`, err.message);
    }
  }

  throw new Error(`ต่อ OpenCodeZen ไม่ได้: ${lastError?.message || "ไม่ทราบสาเหตุ"}`);
}

/**
 * ค้นหาข้อมูลบนอินเทอร์เน็ตสด (Real-time Web Search) และสรุปให้เป็นภาษาไทยที่เป็นธรรมชาติที่สุด
 * @param {string} query คำค้นหา หรือ คำถาม
 * @param {string} context บริบทข้อมูล หรือ เนื้อหาเอกสาร (ถ้ามี)
 */
async function searchAndSummarize(query, context = "") {
  let webResults = [];
  try {
    const searchQuery = query || (context ? context.slice(0, 60) : "");
    if (searchQuery) {
      webResults = await searchWeb(searchQuery, 5);
    }
  } catch (err) {
    console.warn("Web search error in opencodezen:", err.message);
  }

  let webContextText = "";
  if (webResults && webResults.length > 0) {
    webContextText = webResults
      .map((r, i) => `[แหล่งข้อมูลอินเทอร์เน็ตที่ ${i + 1}]: ${r.title}\nรายละเอียด: ${r.excerpt}\nURL: ${r.url}`)
      .join("\n\n");
  }

  let userPrompt = "";
  if (context && context.trim()) {
    userPrompt += `=== ข้อมูล/เอกสารบริบทเพิ่มเติม ===\n${context.slice(0, 8000)}\n\n`;
  }
  if (webContextText) {
    userPrompt += `=== ผลการค้นหาจากอินเทอร์เน็ตสดแบบ Real-time ===\n${webContextText}\n\n`;
  }
  userPrompt += `=== คำสั่งค้นหา/ประเด็นที่ต้องการสรุป ===\n${query || "กรุณาสรุปเนื้อหาสำคัญและแหล่งข้อมูล"}`;

  const summary = await chat([
    { role: "system", content: SYSTEM_SUMMARIZE_PROMPT },
    { role: "user", content: userPrompt }
  ], { temperature: 0.4, maxTokens: 2500 });

  return {
    query,
    summary,
    references: webResults,
    provider: "OpenCodeZen",
    model: MODEL_CANDIDATES[0]
  };
}

/**
 * สรุปข้อความยาวๆ ให้เป็นภาษาไทยที่เป็นมนุษย์ที่สุด พร้อมอ้างอิงข้อมูลบนอินเทอร์เน็ต
 * @param {string} text ข้อความต้นฉบับที่ต้องการสรุป
 */
async function summarizeHumanlike(text) {
  return searchAndSummarize("กรุณาสรุปเนื้อหานี้ให้เข้าใจง่าย เป็นธรรมชาติ ฟังดูเหมือนมนุษย์สรุปมากที่สุด", text);
}

// ── ผู้ช่วยหาแหล่งอ่านให้ตรงเนื้อหา ────────────────────────
//
// โมเดลทำสองอย่างที่มันทำได้ดีจริง และไม่ทำอย่างที่มันทำแล้วพัง:
//   ทำ  — ตั้งคำค้น (รู้ว่า "รอยเชื่อมเกยกัน" ควรค้นว่า lap joint welding ด้วย)
//          และคัดว่าบทความไหนพูดเรื่องเดียวกับงานจริง
//   ไม่ทำ — แต่ง URL หรือชื่อบทความเอง ทุก URL มาจากผลค้นวิกิพีเดียเท่านั้น

// โมเดลฟรีชอบห่อ JSON ด้วย ```json หรือพ่นคำอธิบายนำหน้า — ตัดออกก่อนแล้วค่อย parse
function parseJsonLoose(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[{[]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* ตกไปกู้แบบตัดปลายด้านล่าง */
      }
    }
    // คำตอบถูกตัดกลางคันเพราะชน max_tokens — ปิดวงเล็บที่ค้างแล้วลองใหม่
    // ได้ของที่โมเดลพิมพ์ครบแล้วกลับมา ดีกว่าทิ้งทั้งก้อน
    return salvageTruncatedJson(cleaned.slice(start < 0 ? 0 : start));
  }
}

function salvageTruncatedJson(text) {
  const cutAt = Math.max(text.lastIndexOf('"'), text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (cutAt < 0) return null;

  let body = text.slice(0, cutAt + 1);
  // ตัดสมาชิกตัวสุดท้ายที่ค้างอยู่ทิ้ง แล้วปิดวงเล็บตามลำดับที่เปิดไว้
  if (!/["\]}]$/.test(body)) return null;

  const stack = [];
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inString) body += '"';
  body = body.replace(/,\s*$/, "");

  try {
    return JSON.parse(body + stack.reverse().join(""));
  } catch {
    return null;
  }
}

const QUERY_PLANNER_PROMPT = `คุณคือบรรณารักษ์ที่ช่วยหาบทความวิกิพีเดียสำหรับ "เนื้อหาวิชา" ของงานนักเรียน

หน้าที่: อ่านหัวข้อและเนื้อหางาน แล้วตั้งคำค้นสำหรับค้นบทความวิกิพีเดีย

กติกา:
1. ค้นเรื่องที่งานสอน ไม่ใช่คำเกี่ยวกับการประเมิน การพูด ชื่อไฟล์ ชื่อโรงเรียน หรือชื่อครู
2. คำค้นภาษาไทยต้องเป็นชื่อเรื่องที่บทความน่าจะใช้จริง เช่น "การเชื่อมอาร์กโลหะแก๊สคลุม" ไม่ใช่ประโยคยาว
3. คำค้นภาษาอังกฤษสำคัญมากสำหรับศัพท์เทคนิค เพราะหลายเรื่องไม่มีบทความภาษาไทย
4. คำค้นละ 1-4 คำ ยาวไม่เกิน 40 ตัวอักษร ห้ามเป็นประโยคอธิบาย ห้ามใส่เครื่องหมายคำถาม
   ถูก: "การเชื่อมอาร์กโลหะด้วยมือ" · ผิด: "การเชื่อมไฟฟ้าคือกระบวนการที่ใช้ความร้อนจากอาร์ก…"
5. ห้ามแต่ง URL หรืออ้างว่ามีบทความชื่อใด — หน้าที่คุณคือคำค้นเท่านั้น

ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:
{"th": ["คำค้นไทย 1", "คำค้นไทย 2"], "en": ["english query 1", "english query 2"]}`;

/**
 * ตั้งคำค้นจากเนื้อหางาน (คืน null เมื่อโมเดลใช้ไม่ได้ ผู้เรียกต้องมีทางสำรองเสมอ)
 */
async function planSearchQueries({ topic, keywords = [], sourceText = "" }) {
  const t = String(topic || "").trim();
  if (!t && !sourceText.trim()) return null;

  const userPrompt = [
    `หัวข้อของงาน: ${t || "(ไม่ระบุ)"}`,
    keywords.length ? `คำสำคัญที่ดึงมาจากงาน: ${keywords.join(" · ")}` : "",
    `เนื้อหางาน (บางส่วน):\n${String(sourceText || "").slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const raw = await chat(
      [
        { role: "system", content: QUERY_PLANNER_PROMPT },
        { role: "user", content: `${userPrompt}\n\nตอบเป็น JSON เท่านั้น` },
      ],
      { temperature: 0.2, maxTokens: 1200 }
    );
    const parsed = parseJsonLoose(raw);
    if (!parsed) return null;

    // คำค้นที่ยาวเกินคือประโยคอธิบาย ไม่ใช่ชื่อบทความ — ยิงไปวิกิพีเดียแล้วไม่เจออะไร
    // ตัดทิ้งดีกว่าตัดให้สั้นลง เพราะประโยคที่ถูกตัดกลางคันยิ่งค้นไม่เจอ
    const clean = (list) =>
      (Array.isArray(list) ? list : [])
        .map((x) => String(x || "").trim())
        .filter((x) => x.length >= 2 && x.length <= 60)
        .slice(0, 3);

    const th = clean(parsed.th);
    const en = clean(parsed.en);
    return th.length || en.length ? { th, en } : null;
  } catch (err) {
    console.warn("ตั้งคำค้นด้วยโมเดลไม่สำเร็จ:", err.message);
    return null;
  }
}

const READING_PICKER_PROMPT = `คุณคือบรรณารักษ์ที่คัดบทความให้นักเรียนอ่านต่อ

คุณจะได้หัวข้อของงาน และรายการบทความวิกิพีเดียพร้อมย่อหน้าแรกจริงของแต่ละบทความ

หน้าที่: เลือกบทความที่ "พูดเรื่องเดียวกับเนื้อหางาน" มากที่สุด ไม่เกิน 3 บทความ
แล้วยกข้อความจากย่อหน้าที่ให้มา 1 ประโยคที่อธิบายเรื่องนั้นได้ดีที่สุด

กติกาที่ห้ามผิด:
1. เลือกได้เฉพาะจากรายการที่ให้มา อ้างถึงด้วยเลข index เท่านั้น
2. ข้อความที่ยก ต้องคัดลอกมาจากย่อหน้าของบทความนั้นแบบคำต่อคำ ห้ามเรียบเรียงใหม่ ห้ามแต่งเพิ่ม
3. บทความที่แค่เอ่ยถึงคำเดียวกันแต่เป็นคนละเรื่อง ให้ตัดทิ้ง — คืนลิสต์ว่างดีกว่าเลือกผิด
4. ห้ามใส่ URL
5. why เขียนสั้น ไม่เกิน 20 คำ

⚠ ตอบเป็น JSON บรรทัดเดียวทันที ห้ามอธิบายวิธีคิด ห้ามเขียนข้อความก่อนหรือหลัง JSON:
{"picks": [{"index": 0, "quote": "ประโยคที่คัดลอกมาคำต่อคำ", "why": "เกี่ยวกับงานยังไงสั้น ๆ"}]}`;

/**
 * คัดบทความที่ตรงกับเนื้อหางาน (คืน null เมื่อโมเดลใช้ไม่ได้)
 * @param {{topic:string, candidates:{title:string, extract:string, source:string}[]}} input
 */
async function pickReadings({ topic, candidates = [] }) {
  if (!candidates.length) return null;

  const listText = candidates
    .map((c, i) => `[${i}] ${c.title} (${c.source})\n${String(c.extract || "").slice(0, 450)}`)
    .join("\n\n");

  try {
    // โมเดลฟรีชอบไล่ความคิดยาวก่อนตอบ ถ้าเพดานโทเคนต่ำมันจะโดนตัดก่อนถึง JSON
    // แล้วเรากลายเป็นไม่ได้อะไรเลย จึงต้องเผื่อเพดานไว้มากกว่าความยาวคำตอบจริงหลายเท่า
    const raw = await chat(
      [
        { role: "system", content: READING_PICKER_PROMPT },
        { role: "user", content: `หัวข้อของงาน: ${String(topic || "").trim() || "(ไม่ระบุ)"}\n\n=== บทความที่ค้นมาได้ ===\n${listText}\n\nตอบเป็น JSON เท่านั้น` },
      ],
      { temperature: 0.1, maxTokens: 2000 }
    );
    const parsed = parseJsonLoose(raw);
    const picks = Array.isArray(parsed?.picks) ? parsed.picks : Array.isArray(parsed) ? parsed : null;
    if (!picks) return null;

    return picks
      .map((p) => ({
        index: Number(p?.index),
        quote: String(p?.quote || "").trim(),
        why: String(p?.why || "").trim().slice(0, 160),
      }))
      .filter((p) => Number.isInteger(p.index) && p.index >= 0 && p.index < candidates.length)
      .slice(0, 3);
  } catch (err) {
    console.warn("คัดแหล่งอ่านด้วยโมเดลไม่สำเร็จ:", err.message);
    return null;
  }
}

/**
 * ตรวจสอบความพร้อมของบริการ OpenCodeZen
 */
async function checkHealth() {
  const key = process.env.OPENCODEZEN_API_KEY || API_KEY;
  if (!key) {
    return { ok: false, provider: "OpenCodeZen", model: MODEL_CANDIDATES[0], error: "ยังไม่ได้ใส่ OPENCODEZEN_API_KEY" };
  }

  try {
    const reply = await chat([
      { role: "system", content: "ตอบกลับสั้นๆ เพียงคำว่า 'OK'" },
      { role: "user", content: "Test health check" }
    ], { maxTokens: 100, temperature: 0 });

    return reply
      ? { ok: true, provider: "OpenCodeZen", model: MODEL_CANDIDATES[0] }
      : { ok: false, provider: "OpenCodeZen", model: MODEL_CANDIDATES[0], error: "ไม่มีคำตอบกลับ" };
  } catch (err) {
    return { ok: false, provider: "OpenCodeZen", model: MODEL_CANDIDATES[0], error: err.message };
  }
}

module.exports = {
  searchAndSummarize,
  summarizeHumanlike,
  planSearchQueries,
  pickReadings,
  checkHealth,
  chat
};
