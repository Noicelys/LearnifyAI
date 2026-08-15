// Web Search Module — ค้นหาข้อมูลและแหล่งอ้างอิงจากอินเทอร์เน็ตจริง (Real-time Web Search)
//
// มีสองทางเพราะทางเดียวไม่พอ:
//   - วิกิพีเดีย: API จริง มี JSON ชัดเจน ไม่มีวันโดนบล็อก และเนื้อหาตรงกับหัวข้อวิชาโดยธรรมชาติ
//     จึงเป็นทางหลัก
//   - ขูดหน้า HTML ของ DuckDuckGo: ได้เว็บนอกวิกิ แต่เปราะ — ปัจจุบันมันตอบ HTTP 202
//     เป็นหน้ากันบอตแทนผลค้นเมื่อยิงจากเซิร์ฟเวอร์ จึงใช้เป็นของแถมเท่านั้น
//     ห้ามให้ฟีเจอร์ใดพังเมื่อทางนี้คืนลิสต์ว่าง

const TIMEOUT_MS = 10000;
// นโยบายของวิกิมีเดียกำหนดให้ระบุตัวตนของแอปที่เรียก ไม่ใช่ปลอมเป็นเบราว์เซอร์
// ⚠ ค่า header ต้องเป็น ASCII ล้วน ใส่ภาษาไทยแล้ว fetch จะโยน ByteString error ทันที
const WIKI_UA = "EducationAI-VerificationPlatform/1.0 (student work verification, Thailand)";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function cleanText(htmlStr) {
  return String(htmlStr || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isAdUrl(url) {
  return /duckduckgo\.com\/y\.js|bing\.com\/aclick|doubleclick\.net|googleadservices|ebay\.com/i.test(url);
}

function parseUrl(rawHref) {
  if (!rawHref) return "";
  try {
    if (rawHref.includes("uddg=")) {
      const match = rawHref.match(/uddg=([^&]+)/);
      if (match && match[1]) {
        const decoded = decodeURIComponent(match[1]);
        if (!isAdUrl(decoded)) return decoded;
        return "";
      }
    }
    if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) {
      if (isAdUrl(rawHref)) return "";
      return rawHref;
    }
    if (rawHref.startsWith("//")) {
      const full = "https:" + rawHref;
      if (isAdUrl(full)) return "";
      return full;
    }
  } catch {
    // fallback
  }
  return "";
}

/**
 * ค้นหาข้อมูลจริงบนอินเทอร์เน็ต
 * @param {string} query คำค้นหา
 * @param {number} limit จำนวนผลลัพธ์ที่ต้องการ (ค่าตั้งต้น 5)
 */
async function searchWeb(query, limit = 5) {
  const q = String(query || "").trim();
  if (!q) return [];

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return [];
    const html = await res.text();

    const results = [];
    const resultRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
      const href = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3];

      const url = parseUrl(href);
      const title = cleanText(rawTitle);
      const excerpt = cleanText(rawSnippet);

      if (url && title && excerpt) {
        let domain = "";
        try {
          domain = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          domain = url;
        }

        results.push({
          title,
          excerpt,
          url,
          citation: `แหล่งข้อมูลทางอินเทอร์เน็ต (${domain})`,
          source: domain,
        });
      }
    }

    return results;
  } catch (err) {
    console.warn("Web search failed:", err.message);
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// วิกิพีเดียตอบ 429 เมื่อคำขอถี่เกินไป และเดิมมันกลืนหายเป็นลิสต์ว่าง
// ทำให้ดูเหมือน "ไม่มีบทความ" ทั้งที่บทความมีอยู่ จึงต้องเข้าคิวทีละคำขอ
// เว้นจังหวะคงที่ แล้วลองใหม่แบบถอยห่างขึ้นเรื่อย ๆ
const WIKI_MIN_GAP_MS = 220;
const WIKI_RETRY_DELAYS = [700, 1800];
let wikiChain = Promise.resolve();
let wikiLastAt = 0;

function wikiQueue(task) {
  const run = wikiChain.then(async () => {
    const wait = WIKI_MIN_GAP_MS - (Date.now() - wikiLastAt);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      wikiLastAt = Date.now();
    }
  });
  // คิวต้องเดินต่อแม้คำขอก่อนหน้าจะพัง
  wikiChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function wikiFetch(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await wikiQueue(() =>
      fetch(url, { headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    );
    if (res.status !== 429 || attempt >= WIKI_RETRY_DELAYS.length) return res;

    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : WIKI_RETRY_DELAYS[attempt]);
  }
}

/**
 * ค้นบทความวิกิพีเดียที่ตรงกับหัวข้อ
 *
 * ใช้ API จริง (action=query&list=search) ไม่ใช่การขูดหน้าเว็บ ผลจึงเสถียร
 * ลองภาษาไทยก่อนเพราะนักเรียนอ่านไทย ถ้าไม่เจอค่อยลองอังกฤษ (ศัพท์เทคนิคบางคำมีแต่หน้าอังกฤษ)
 *
 * @param {string} query คำค้น
 * @param {number} limit จำนวนผลลัพธ์
 * @param {string} lang รหัสภาษาของวิกิ
 */
async function searchWikipedia(query, limit = 4, lang = "th") {
  const q = String(query || "").trim();
  if (!q) return [];

  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&srnamespace=0&format=json`;

  try {
    const res = await wikiFetch(url);
    if (!res.ok) {
      console.warn(`Wikipedia search HTTP ${res.status} (${lang}): ${q}`);
      return [];
    }

    const hits = (await res.json())?.query?.search || [];
    return hits
      .filter((h) => h && h.title)
      .map((h) => ({
        title: h.title,
        excerpt: cleanText(h.snippet),
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, "_"))}`,
        citation: `วิกิพีเดีย${lang === "th" ? "ภาษาไทย" : "ภาษาอังกฤษ"} — บทความ "${h.title}"`,
        source: `${lang}.wikipedia.org`,
      }));
  } catch (err) {
    console.warn("Wikipedia search failed:", err.message);
    return [];
  }
}

/**
 * ดึง "ข้อความจริงจากหน้าบทความ" ของวิกิพีเดีย (ส่วนนำ) ทีละหลายบทความในคำขอเดียว
 *
 * จำเป็นเพราะ snippet จากหน้าผลค้นเป็นข้อความที่เสิร์ชตัดมาให้ ไม่ใช่ย่อหน้าจริงในบทความ
 * ถ้าเอา snippet ไปแปะให้นักเรียนโดยบอกว่า "ข้อความจากหน้านี้" ก็เท่ากับอ้างผิด
 * ผู้เรียกจึงต้องมีข้อความจริงไว้ตรวจก่อนยกมาอ้าง (ดู coach.fetchTopicReadings)
 *
 * @param {string[]} titles ชื่อบทความ (สูงสุด 20 ต่อคำขอตามข้อกำหนดของ API)
 * @param {string} lang รหัสภาษาของวิกิ
 * @returns {Promise<Map<string, string>>} ชื่อบทความ -> ข้อความส่วนนำแบบไม่มี HTML
 */
async function fetchWikipediaExtracts(titles, lang = "th") {
  const list = [...new Set((titles || []).map((t) => String(t || "").trim()).filter(Boolean))].slice(0, 20);
  const out = new Map();
  if (!list.length) return out;

  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
    `&explaintext=1&exintro=1&exlimit=20&redirects=1&format=json` +
    `&titles=${encodeURIComponent(list.join("|"))}`;

  try {
    const res = await wikiFetch(url);
    if (!res.ok) {
      console.warn(`Wikipedia extract HTTP ${res.status} (${lang})`);
      return out;
    }

    const json = await res.json();
    const pages = json?.query?.pages || {};
    // API ตอบชื่อที่ normalize แล้ว ต้องแมปกลับไปหาชื่อที่เราส่งไป ไม่งั้นจับคู่ไม่ติด
    const alias = new Map();
    for (const n of json?.query?.normalized || []) alias.set(n.to, n.from);
    for (const r of json?.query?.redirects || []) alias.set(r.to, r.from);

    for (const page of Object.values(pages)) {
      const text = String(page?.extract || "").replace(/\s+\n/g, "\n").trim();
      if (!page?.title || !text) continue;
      out.set(page.title, text);
      const original = alias.get(page.title);
      if (original) out.set(original, text);
    }
    return out;
  } catch (err) {
    console.warn("Wikipedia extract failed:", err.message);
    return out;
  }
}

/**
 * ค้นวิกิพีเดียด้วยคำค้นหลายชุดและหลายภาษาพร้อมกัน แล้วรวมผลแบบไม่ซ้ำ
 *
 * ภาษาอังกฤษจำเป็นจริงสำหรับสายอาชีพ — ศัพท์เทคนิคจำนวนมากไม่มีบทความภาษาไทย
 * ยิงพร้อมกันทั้งหมดเพราะทางที่ช้าหรือพังไม่ควรถ่วงทางอื่น
 */
async function searchWikipediaMany(queries, { langs = ["th", "en"], perQuery = 4, limit = 12 } = {}) {
  const qs = [...new Set((queries || []).map((q) => String(q || "").trim()).filter(Boolean))].slice(0, 4);
  if (!qs.length) return [];

  const seen = new Set();
  const perLang = new Map();
  const collect = (lang, items) => {
    const bucket = perLang.get(lang) || [];
    for (const item of items) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      bucket.push(item);
    }
    perLang.set(lang, bucket);
  };

  // ยิงทีละภาษา ไม่ยิงรวดเดียวทั้งหมด — วิกิพีเดียตอบ 429 เมื่อคำขอพร้อมกันเยอะ
  // แล้วผลว่างจะดูเหมือน "ไม่มีบทความ" ทั้งที่โดนจำกัดอัตราเฉย ๆ
  // ต้องค้นครบทุกภาษาเสมอ ห้ามหยุดเมื่อภาษาไทยได้ผลครบจำนวน — หัวข้อสายเทคนิคหลายเรื่อง
  // (เช่น Arduino, SMAW) วิกิไทยคืนบทความที่แค่เอ่ยถึงคำนั้นผ่าน ๆ มาเต็มโควตา
  // แล้วบทความอังกฤษที่ตรงเรื่องจริงจะไม่มีวันถูกค้นเลย
  for (const lang of langs) {
    const settled = await Promise.allSettled(qs.map((q) => searchWikipedia(q, perQuery, lang)));
    for (const r of settled) if (r.status === "fulfilled") collect(lang, r.value);
  }

  // สลับภาษากันคนละใบ ไม่ต่อท้ายกัน — ถ้าเรียงไทยก่อนแล้วตัดตามจำนวน
  // บทความอังกฤษที่ตรงเรื่องกว่าจะถูกตัดทิ้งทั้งชุดในหัวข้อที่วิกิไทยมีของคล้าย ๆ เยอะ
  const buckets = langs.map((lang) => perLang.get(lang) || []);
  const merged = [];
  for (let i = 0; merged.length < limit; i++) {
    const before = merged.length;
    for (const bucket of buckets) {
      if (i < bucket.length && merged.length < limit) merged.push(bucket[i]);
    }
    if (merged.length === before) break;
  }
  return merged;
}

/**
 * ค้นแหล่งอ่านเพิ่มเติมสำหรับหัวข้อของงานนักเรียน
 *
 * ใช้วิกิพีเดียอย่างเดียว: API จริง ตรวจที่มาได้ ดึงข้อความจริงในหน้ามาตรวจซ้ำได้
 * (เดิมพ่วงการขูดหน้า DuckDuckGo ไว้ด้วย แต่มันตอบหน้ากันบอตเมื่อยิงจากเซิร์ฟเวอร์
 * จึงคืนลิสต์ว่างเกือบตลอด และตอนที่มันคืนผลมา regex ก็จับคู่ชื่อเรื่องกับคำโปรย
 * ข้ามผลลัพธ์กันได้ ซึ่งอันตรายกว่าไม่มีผลเลย)
 *
 * ผู้เรียกมีหน้าที่กรองความตรงกับเนื้อหาอีกชั้น (ดู coach.fetchTopicReadings)
 */
async function searchReadings(topic, extraTerms = [], limit = 6) {
  const base = String(topic || "").trim();
  const withTerms = [base, ...extraTerms].join(" ").trim();
  const queries = [base, withTerms !== base ? withTerms : ""].filter(Boolean);
  return searchWikipediaMany(queries, { limit });
}

module.exports = {
  searchWeb,
  searchWikipedia,
  searchWikipediaMany,
  fetchWikipediaExtracts,
  searchReadings,
};
