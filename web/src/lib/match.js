/* จับคู่ชื่อไฟล์กับนักเรียนในรายชื่อ

   ครูตั้งชื่อไฟล์กันคนละแบบ: "68319080012.mp3", "เลขที่ 12 สมชาย.m4a",
   "ม.6-1_somchai_ใบงาน3.pdf", "voice-สมชาย ใจดี(1).mp3"
   เดิมใช้กฎเรียงกันแล้วกฎแรกที่เจอชนะ ซึ่งพลาดง่ายเมื่อชื่อไฟล์มีทั้งเลขห้องและรหัส

   ที่นี่เปลี่ยนเป็นให้คะแนนผู้สมัครทุกคนแล้วเลือกคนที่คะแนนนำห่างพอ
   หลักการเดิมยังอยู่: จับผิดคนแย่กว่าไม่จับ — คะแนนไม่ถึงเกณฑ์ หรือสองคนคะแนนไล่กัน
   จะคืน null ให้ครูเลือกเอง */

/* คำนำหน้าชื่อ ไม่ใช่ตัวชื่อ ต้องตัดก่อนเทียบ ไม่งั้น "ด.ช.สมชาย" ไม่ตรงกับ "สมชาย"
   ฝั่งอังกฤษต้องมีขอบคำ ไม่งั้น "somsak" โดนตัด "ms" ตรงกลางกลายเป็น "so ak" */
const TITLE_RE = /(เด็กชาย|เด็กหญิง|ด\.?ช\.?|ด\.?ญ\.?|นางสาว|น\.?ส\.?|นาย|นาง)|\b(mr|mrs|ms|miss)\.?\b/gi;

// ชั้นเรียน ห้อง และคำที่ครูใส่ในชื่อไฟล์เป็นประจำ — ไม่ช่วยระบุตัวคน
const NOISE_RE =
  /(ม\.?\s?[1-6]\s?[/\-]\s?\d+|ปวช\.?\s?\d?|ปวส\.?\s?\d?|ห้อง\s?\d+|ชั้น\s?\d+|audio|voice|speech|record(ing)?|report|work|assignment|final|draft|copy|งาน|ใบงาน|เสียง|คำอธิบาย|อัด|ส่ง)/gi;

// เลขที่ต้องมีคำกำกับ ตัวเลขโดด ๆ ในชื่อไฟล์เป็นอะไรก็ได้ (ลำดับ วันที่ เวอร์ชัน)
const ROLL_HINT_RE = /(เลขที่|เลขที|no\.?|#)\s*(\d{1,3})\b/i;

const stripExt = (s) => String(s || "").replace(/\.[a-z0-9]{1,5}$/i, "");
const stripZeros = (s) => String(s || "").replace(/^0+/, "");
// เทียบแบบไม่สนช่องว่างและวรรคตอน ชื่อไทยในไฟล์มักติดกันหรือคั่นด้วย _
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9ก-๙]/gi, "");

export function deriveStudentName(filename) {
  const cleaned = stripExt(filename)
    .replace(NOISE_RE, " ")
    .replace(TITLE_RE, " ")
    // เลขนำหน้าคือลำดับไฟล์ เลขท้ายในวงเล็บคือสำเนาซ้ำของเบราว์เซอร์
    .replace(/^[\d]+[\s._-]*/, " ")
    .replace(/\(\d+\)\s*$/, " ")
    .replace(/\d{4,}/g, " ")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || stripExt(filename) || String(filename);
}

/* ความคล้ายแบบ Dice บนไตรแกรม — รับมือสะกดเพี้ยนหนึ่งสองตัวได้
   ภาษาไทยไม่มีช่องว่างระหว่างคำ การเทียบทีละตัวอักษรจึงพลาดง่ายกว่าไตรแกรม */
function trigrams(s) {
  const t = squash(s);
  const out = new Set();
  if (t.length < 3) return t ? new Set([t]) : out;
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}

function dice(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/* คะแนนความมั่นใจว่าไฟล์นี้เป็นของนักเรียนคนนี้
   ตัวเลขเลือกให้ "รหัสนักเรียนตรงเป๊ะ" ชนะทุกอย่าง และ "ชื่อจริงอย่างเดียว" ไม่พอชนะขาด */
function scoreStudent(student, ctx, strategy) {
  const { base, squashed, numbers, guess, rollHint } = ctx;
  let score = 0;
  const why = [];

  if (strategy !== "name_only") {
    const no = String(student.student_no || "").trim();
    if (no) {
      const cleanNo = stripZeros(no);
      const exact = numbers.some((n) => n === no || (cleanNo && stripZeros(n) === cleanNo));
      // ตรงเป๊ะทั้งก้อน — ไม่มีอะไรน่าเชื่อกว่านี้
      if (exact) {
        score = Math.max(score, 100);
        why.push(`รหัส ${no}`);
      } else if (
        new RegExp(`(^|[^0-9])${cleanNo || no}([^0-9]|$)`).test(base)
      ) {
        // รหัสฝังอยู่ในชื่อไฟล์โดยไม่ได้ถูกตัดเป็นก้อนตัวเลขเดี่ยว
        score = Math.max(score, 92);
        why.push(`รหัส ${no} ในชื่อไฟล์`);
      } else {
        // ครูหลายคนพิมพ์แค่ท้ายรหัส — ต้อง 4 หลักขึ้นไป
        // สามหลักชนกับเลขลำดับไฟล์อย่าง "012.mp3" ได้ง่ายเกินไป
        const suffix = numbers.some((n) => n.length >= 4 && (no.endsWith(n) || stripZeros(no).endsWith(stripZeros(n))));
        if (suffix) {
          score = Math.max(score, 74);
          why.push("ท้ายรหัสตรงกัน");
        }
      }
    }

    const roll = String(student.roll_no || "").trim();
    if (roll && rollHint && stripZeros(rollHint) === stripZeros(roll)) {
      score = Math.max(score, 70);
      why.push(`เลขที่ ${roll}`);
    }
  }

  if (strategy === "id_only") return { score, why };

  const first = squash(student.first_name);
  const last = squash(student.last_name);
  const full = squash(student.full_name) || first + last;
  const guessSquashed = squash(guess);

  // ชื่อกับนามสกุลอยู่ครบในชื่อไฟล์ = แทบไม่มีทางเป็นคนอื่น
  if (first && last && squashed.includes(first) && squashed.includes(last)) {
    score = Math.max(score, 96);
    why.push("ชื่อและนามสกุลตรงกัน");
  } else if (full && guessSquashed && (full === guessSquashed || squashed.includes(full))) {
    score = Math.max(score, 94);
    why.push("ชื่อเต็มตรงกัน");
  } else if (last && last.length >= 3 && squashed.includes(last)) {
    // นามสกุลซ้ำกันน้อยกว่าชื่อจริงมาก จึงให้น้ำหนักสูงกว่า
    score = Math.max(score, 66);
    why.push("นามสกุลตรงกัน");
  } else if (first && first.length >= 2 && squashed.includes(first)) {
    score = Math.max(score, 56);
    why.push("ชื่อจริงตรงกัน");
  }

  /* สะกดเพี้ยนเล็กน้อย เช่นพิมพ์ตกหนึ่งตัว
     ถ้ามีหลักฐานอื่นอยู่แล้วให้เป็นแค่โบนัสเล็ก ๆ — ไม่งั้นไฟล์ "สมชาย.mp3"
     ที่ในห้องมีสมชายสองคน จะถูกความคล้ายดันให้คนหนึ่งชนะทั้งที่ข้อมูลไม่พอแยก */
  if (guessSquashed && full) {
    const sim = dice(guessSquashed, full);
    if (sim >= 0.55) {
      score = score > 0 ? score + Math.round(10 * sim) : Math.round(40 + 55 * sim);
      why.push(`ชื่อใกล้เคียง ${Math.round(sim * 100)}%`);
    }
  }

  return { score, why };
}

// คะแนนต่ำกว่านี้ถือว่าเดา — ปล่อยให้ครูจับเอง
const MIN_SCORE = 55;
// ที่หนึ่งต้องนำที่สองเท่านี้ ไม่งั้นถือว่าแยกไม่ออก (ชื่อซ้ำกันในห้อง)
const MIN_MARGIN = 12;

/* คืนผลจับคู่พร้อมคะแนนและเหตุผล — ใช้เวลาต้องการอธิบายให้ครูเห็นว่าจับคู่จากอะไร
   strategy: "smart" (ค่าตั้งต้น) | "id_only" | "name_only" */
export function matchStudentDetailed(filename, roster, strategy = "smart") {
  if (!roster?.length) return null;

  const base = stripExt(filename);
  const guess = deriveStudentName(filename);
  const ctx = {
    base,
    squashed: squash(base.replace(TITLE_RE, " ")),
    numbers: base.match(/\d+/g) || [],
    guess,
    rollHint: (base.match(ROLL_HINT_RE) || [])[2] || "",
  };

  const ranked = roster
    .map((student) => ({ student, ...scoreStudent(student, ctx, strategy) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < MIN_SCORE) return null;
  // คะแนนเท่ากันหรือไล่กัน = ข้อมูลในชื่อไฟล์ไม่พอแยกคน ตอบผิดแย่กว่าไม่ตอบ
  if (ranked[1] && best.score - ranked[1].score < MIN_MARGIN) return null;

  return { student: best.student, score: best.score, why: best.why };
}

export function matchStudent(filename, roster, strategy = "smart") {
  return matchStudentDetailed(filename, roster, strategy)?.student || null;
}
