// ประมวลผลเบื้องหลังของการส่งงาน: ถอดเสียง -> วิเคราะห์ -> บันทึกคะแนน
//
// แยกออกมาจาก server.js เพราะมีคนเรียกสองทาง (ครูอัปโหลดเอง และตัวโคลนจาก Classroom)
// ถ้าปล่อยไว้ใน server.js ตัวโคลนจะต้อง require("./server") ย้อนกลับ กลายเป็นวงกลม

const db = require("./db");
const { transcribe } = require("./whisper");
const { analyze } = require("./typhoon");
const { coach } = require("./coach");

async function fail(id, message) {
  await db.run("UPDATE submissions SET status = 'error', error_message = ? WHERE id = ?", [message, id]);
}

async function processAudio(id, sourceText, audioPath) {
  let transcript;
  let quality;
  try {
    // ส่งเนื้องานไปเป็นบริบทด้วย — whisper จะถอดศัพท์เฉพาะของงานชิ้นนี้ได้แม่นขึ้นมาก
    ({ text: transcript, quality } = await transcribe(audioPath, { contextText: sourceText }));
  } catch (err) {
    return fail(id, `ถอดเสียงไม่สำเร็จ: ${err.message}`);
  }

  await db.run("UPDATE submissions SET transcript = ?, status = 'analyzing' WHERE id = ?", [transcript, id]);

  if (!transcript) {
    return fail(id, "ถอดเสียงแล้วไม่ได้ข้อความ — ไฟล์เสียงอาจเงียบหรือเสียหาย");
  }

  // ถอดมาได้ข้อความ แต่เชื่อถือไม่ได้ — หยุดตรงนี้ ไม่ส่งต่อไปให้คะแนน
  // ถ้าปล่อยผ่าน นักเรียนจะได้ธงแดงเพราะคุณภาพเสียง ไม่ใช่เพราะไม่เข้าใจงาน
  // transcript ถูกบันทึกไว้แล้วด้านบน ครูยังกดอ่าน ฟังคลิป แล้วให้คะแนนเองได้
  if (quality && !quality.ok) {
    return fail(id, quality.reason);
  }

  return runAnalysis(id, sourceText, transcript);
}

async function runAnalysis(id, sourceText, transcript) {
  let r;
  try {
    r = await analyze(sourceText, transcript);
    const finalTranscript = r.correctedTranscript || transcript;
    await db.run(
      `UPDATE submissions SET status='done', transcript=?, content_match=?, specificity=?, reasoning=?,
              ownership=?, own_words=?, flags=?, coverage=?,
              trust_score=?, trust_level=?, reasons=?, needs_followup=?, error_message=NULL,
              coaching=NULL, coaching_error=NULL
       WHERE id = ?`,
      [
        finalTranscript,
        r.contentMatch, r.specificity, r.reasoning,
        r.ownership, r.ownWords, JSON.stringify(r.flags), JSON.stringify(r.coverage || []),
        r.trustScore, r.trustLevel, JSON.stringify(r.reasons), r.needsFollowup ? 1 : 0,
        id,
      ]
    );
  } catch (err) {

    // transcript ยังอยู่ในฐานข้อมูล ครูอ่านเองแล้วให้คะแนนมือได้ ไม่เสียของ
    return fail(id, `วิเคราะห์ไม่สำเร็จ: ${err.message}`);
  }

  // สร้างคำแนะนำเชิงสอนพร้อมค้นหาข้อมูลอ้างอิงบนอินเทอร์เน็ตให้อัตโนมัติสำหรับทุกงานส่ง
  await generateCoaching(id, sourceText, transcript, r);
}

// เขียนคำแนะนำเชิงสอนลงแถวเดิม
//
// ⚠ ห้ามแตะคอลัมน์ status เด็ดขาด — คะแนนตรวจเสร็จแล้ว การที่ขั้น "สอน" ล้มเหลว
// ไม่ควรทำให้ผลตรวจที่ใช้ได้อยู่แล้วกลายเป็น error ในสายตาครู
// (เจตนาเดียวกับที่ runAnalysis เก็บ transcript ไว้แม้วิเคราะห์ไม่ผ่าน)
async function generateCoaching(id, sourceText, transcript, scores) {
  try {
    const result = await coach(sourceText, transcript, {
      content_match: scores.contentMatch,
      specificity: scores.specificity,
      reasoning: scores.reasoning,
      ownership: scores.ownership,
      own_words: scores.ownWords,
    });
    await db.run("UPDATE submissions SET coaching = ?, coaching_error = NULL WHERE id = ?", [
      JSON.stringify(result),
      id,
    ]);
  } catch (err) {
    await db.run("UPDATE submissions SET coaching_error = ? WHERE id = ?", [
      `เขียนคำแนะนำไม่สำเร็จ: ${err.message}`,
      id,
    ]);
  }
}

module.exports = { fail, processAudio, runAnalysis, generateCoaching };
