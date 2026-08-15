/* ลิงก์ค้นหาไปยังฐานข้อมูลวิชาการที่อ้างอิงได้
   ต่างจาก readings ตรงที่ไม่ได้ดึงเนื้อหามาแสดง — Google Scholar ไม่มี public API
   และบล็อกการดึงข้อมูลอัตโนมัติ ส่วน TCI ThaiJo ก็เปลี่ยนหน้าเว็บบ่อย
   จึงสร้างเป็น "คำค้นที่พร้อมกด" แทน ระบบไม่ต้องเดาชื่อบทความ จึงอ้างผิดไม่ได้เลย */

const SOURCES = [
  {
    id: "scholar",
    source: "Google Scholar",
    title: "ค้นงานวิจัยใน Google Scholar",
    hint: "งานวิจัยและบทความวิชาการทั่วโลก ดูจำนวนการอ้างอิงได้",
    build: (q) => `https://scholar.google.com/scholar?hl=th&as_sdt=0%2C5&q=${encodeURIComponent(q)}`,
  },
  {
    id: "thaijo",
    source: "TCI ThaiJo",
    title: "ค้นบทความไทยใน TCI ThaiJo",
    hint: "วารสารไทยที่ผ่านการประเมินคุณภาพจาก TCI ส่วนใหญ่อ่านฉบับเต็มได้ฟรี",
    // ⚠ ห้ามเปลี่ยนกลับไปใช้ /index.php/index/search/search?query= แบบ OJS เดิม
    // ThaiJo ย้ายไปเว็บใหม่แล้ว path นั้นตอบ 404 ส่วนพารามิเตอร์ต้องเป็น q เท่านั้น
    // (ลองแล้ว search= กับ keyword= ได้หน้าเปล่า "No results found")
    build: (q) => `https://www.tci-thaijo.org/en/articles?q=${encodeURIComponent(q)}`,
  },
];

/* คำค้นมาจาก topic กับ keywords ที่โมเดลสกัดไว้แล้ว (ตัวเดียวกับที่ใช้หา readings)
   ตัดคำซ้ำและคำสั้นเกินไปทิ้ง เพราะคำเดียวโดด ๆ ทำให้ผลค้นกว้างจนไม่มีประโยชน์ */
function buildQuery(topic, keywords = []) {
  const seen = new Set();
  const parts = [];
  for (const raw of [topic, ...keywords]) {
    const term = String(raw || "").trim();
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(term);
    if (parts.length >= 4) break;
  }
  return parts.join(" ").slice(0, 200);
}

/* คืน [] เมื่อไม่มีคำค้น ดีกว่าส่งลิงก์เปล่าที่กดแล้วเจอหน้าค้นหาว่าง */
function buildScholarLinks(topic, keywords = []) {
  const query = buildQuery(topic, keywords);
  if (!query) return [];
  return SOURCES.map((s) => ({
    id: s.id,
    kind: "search",
    title: s.title,
    source: s.source,
    query,
    whyRelevant: s.hint,
    url: s.build(query),
    citation: `ค้นด้วยคำว่า “${query}”`,
  }));
}

/* คำสำคัญจากเนื้องานที่ดึงมาจาก Drive — ใช้ตอนที่ยังไม่มีนักเรียนส่งงาน
   จึงยังไม่มี keywords ที่โมเดลสกัดไว้ให้ใช้ (ดู coach.js)

   ภาษาไทยไม่มีช่องว่างระหว่างคำ การตัดคำจริงต้องใช้ dictionary ที่โปรเจกต์นี้ไม่มี
   จึงตัดตามช่องว่างและวรรคตอนแทน แล้วจัดอันดับตามความถี่ — หยาบแต่พอสำหรับคำค้น
   และไม่ต้องพึ่งโมเดล จึงทำงานได้ทันทีตอนสร้างงาน */
const STOPWORDS = new Set([
  "และ", "หรือ", "ของ", "ที่", "ใน", "การ", "ความ", "เป็น", "ได้", "ให้", "จาก", "กับ",
  "แล้ว", "ต้อง", "นี้", "นั้น", "มี", "ไม่", "จะ", "ก็", "ด้วย", "เพื่อ", "อย่าง", "ๆ",
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "you", "your",
]);

function keywordsFromText(text, limit = 3) {
  const counts = new Map();
  for (const raw of String(text || "").split(/[\s .,;:!?()[\]{}"'“”‘’\/\\|—–-]+/)) {
    const term = raw.trim();
    // ตัวเลขล้วนและคำสั้นเกินไปทำให้ผลค้นกว้างจนไม่มีประโยชน์
    if (term.length < 3 || /^[\d.]+$/.test(term)) continue;
    const key = term.toLowerCase();
    if (STOPWORDS.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

module.exports = { buildScholarLinks, buildQuery, keywordsFromText, SOURCES };
