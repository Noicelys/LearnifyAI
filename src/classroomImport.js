// โคลนชั้นเรียนจาก Google Classroom เข้ามาเป็น รายวิชา > หัวข้อ > งาน > การส่งของนักเรียน
//
// การโคลนใช้เวลานาน (ยิง API หลายสิบครั้ง + โหลดไฟล์ + ถอดเสียง + วิเคราะห์)
// จึงทำเป็นงานเบื้องหลังแล้วให้หน้าเว็บ poll ความคืบหน้า แทนที่จะให้ครูค้างรอหน้าขาว

const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");
const classroom = require("./classroom");
const { getValidAccessToken } = require("./googleAuth");
const { fail, processAudio } = require("./pipeline");
const {
  downloadFileToDiskAuth,
  fetchFileTextAuth,
  getFileMetaAuth,
} = require("./drive");

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

// ── ทะเบียนงานโคลน (เก็บในหน่วยความจำ) ──────────────────
// ไม่ต้องลงฐานข้อมูลเพราะเป็นข้อมูลชั่วคราวระหว่างโคลนเท่านั้น
// ถ้า container restart กลางคัน งานที่โคลนไปแล้วยังอยู่ใน SQLite ครบ ครูแค่กดโคลนซ้ำได้
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function createJob(userId, courseName) {
  const id = crypto.randomBytes(9).toString("base64url");
  const job = {
    id,
    userId,
    courseName,
    status: "running", // running | done | error
    phase: "กำลังเริ่ม…",
    error: null,
    counts: { lessons: 0, assignments: 0, submissions: 0, audioQueued: 0, awaitingAudio: 0, skipped: 0 },
    warnings: [],
    subjectId: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);

  // เก็บกวาดงานเก่าออกกันหน่วยความจำบวม
  for (const [key, j] of jobs) {
    if (j.finishedAt && Date.now() - j.finishedAt > JOB_TTL_MS) jobs.delete(key);
  }
  return job;
}

const getJob = (id) => jobs.get(id) || null;

// เตือนได้ แต่ไม่ให้ยาวจนอ่านไม่ไหว
function warn(job, message) {
  if (job.warnings.length < 25) job.warnings.push(message);
  else if (job.warnings.length === 25) job.warnings.push("… (ยังมีรายการที่ข้ามอีก)");
}

// ── คิวถอดเสียงแบบเรียงทีละไฟล์ ─────────────────────────
// ถ้าปล่อยให้ยิง Whisper พร้อมกัน 30 คน container ที่จำกัด RAM ไว้ 2GB จะล้ม
// ทำเป็นคิวต่อคิวไป ช้ากว่าแต่ไม่พัง และครูเห็นผลทยอยขึ้นอยู่แล้ว
const audioQueue = [];
let queueRunning = false;

function enqueueAudio(task) {
  audioQueue.push(task);
  if (!queueRunning) drainQueue();
}

async function drainQueue() {
  queueRunning = true;
  while (audioQueue.length) {
    const task = audioQueue.shift();
    try {
      await task();
    } catch (err) {
      console.error("classroom import audio task failed:", err.message);
    }
  }
  queueRunning = false;
}

// ── upsert แต่ละชั้น ────────────────────────────────────
// ทุกตัวยึด id ฝั่ง Classroom เป็นหลัก โคลนซ้ำจึงอัปเดตของเดิมแทนการสร้างใหม่

// ต้องหาเฉพาะวิชาของครูคนนี้ ไม่งั้นครูสองคนที่ import คอร์สเดียวกันจะใช้แถวร่วมกันและทับกันเอง
async function upsertSubject(course, userId) {
  const existing = await db.get(
    "SELECT id FROM subjects WHERE classroom_course_id = ? AND user_id = ?",
    [course.id, userId]
  );
  const name = [course.name, course.section].filter(Boolean).join(" · ");

  if (existing) {
    await db.run("UPDATE subjects SET name = ?, classroom_synced_at = NOW() WHERE id = ?", [name, existing.id]);
    return existing.id;
  }
  const info = await db.run(
    "INSERT INTO subjects (name, classroom_course_id, classroom_synced_at, user_id) VALUES (?,?,NOW(),?)",
    [name, course.id, userId]
  );
  return info.lastInsertRowid;
}

async function upsertLesson(subjectId, topicId, title) {
  const existing = await db.get(
    "SELECT id FROM lessons WHERE subject_id = ? AND classroom_topic_id = ?",
    [subjectId, topicId]
  );

  if (existing) {
    await db.run("UPDATE lessons SET title = ? WHERE id = ?", [title, existing.id]);
    return existing.id;
  }
  const info = await db.run(
    "INSERT INTO lessons (subject_id, title, classroom_topic_id) VALUES (?,?,?)",
    [subjectId, title, topicId]
  );
  return info.lastInsertRowid;
}

async function upsertAssignment({ courseWorkId, title, driveUrl, sourceText, lessonId }) {
  const existing = await db.get(
    "SELECT id FROM assignments WHERE classroom_coursework_id = ? AND lesson_id = ?",
    [courseWorkId, lessonId]
  );

  if (existing) {
    await db.run(
      "UPDATE assignments SET title = ?, drive_url = ?, source_text = ?, lesson_id = ? WHERE id = ?",
      [title, driveUrl, sourceText, lessonId, existing.id]
    );
    return existing.id;
  }
  const info = await db.run(
    `INSERT INTO assignments (title, drive_url, source_text, lesson_id, classroom_coursework_id)
     VALUES (?,?,?,?,?)`,
    [title, driveUrl, sourceText, lessonId, courseWorkId]
  );
  return info.lastInsertRowid;
}

// ── แยกประเภทไฟล์แนบ ────────────────────────────────────
const AUDIO_MIME = /^(audio|video)\//;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|opus|aac|flac|webm|mp4|mov|mkv|avi|3gp)$/i;
const isAudioAttachment = (meta) =>
  AUDIO_MIME.test(meta?.mimeType || "") || AUDIO_EXT.test(meta?.name || "");

// ── เนื้องานของงานที่ครูสั่ง ─────────────────────────────
// รวมคำสั่งงาน + เนื้อหาไฟล์แนบของครู ใช้เป็นฐานเทียบเวลาไม่มีไฟล์งานรายคน
async function buildAssignmentSource(work, accessToken, job) {
  const parts = [];
  if (work.description?.trim()) parts.push(work.description.trim());

  for (const f of classroom.driveFilesFromMaterials(work.materials)) {
    try {
      const text = await fetchFileTextAuth(f.id, accessToken);
      if (text) parts.push(`--- ${f.name} ---\n${text}`);
    } catch (err) {
      warn(job, `อ่านไฟล์แนบ "${f.name}" ของงาน "${work.title}" ไม่ได้: ${err.message}`);
    }
  }

  // ไม่มีคำอธิบายและไฟล์แนบเลย — ใช้ชื่องานไปก่อน ดีกว่าปล่อยว่างจน AI ไม่มีอะไรเทียบ
  return parts.join("\n\n").trim() || work.title;
}

// ── โคลนงานที่นักเรียนส่ง ───────────────────────────────
async function importSubmissionsFor({ job, accessToken, courseId, work, assignmentId, assignmentSource, roster }) {
  let submissions;
  try {
    submissions = await classroom.listSubmissions(accessToken, courseId, work.id);
  } catch (err) {
    warn(job, `ดึงงานที่ส่งของ "${work.title}" ไม่ได้: ${err.message}`);
    return;
  }

  for (const sub of submissions) {
    // ยังไม่ส่งจริง — ไม่ต้องสร้างแถวให้รก
    const turnedIn = ["TURNED_IN", "RETURNED", "STUDENT_EDITED_AFTER_TURN_IN"].includes(sub.state);
    const files = classroom.driveFilesFromSubmission(sub);
    if (!turnedIn && !files.length) continue;

    const studentName = roster.get(sub.userId) || "ไม่ทราบชื่อ";

    // แยกไฟล์เสียง/วิดีโอ (คำอธิบายปากเปล่า) ออกจากไฟล์งาน (เอกสาร)
    let audio = null;
    const workFiles = [];
    for (const f of files) {
      let meta;
      try {
        meta = await getFileMetaAuth(f.id, accessToken);
      } catch (err) {
        warn(job, `อ่านข้อมูลไฟล์ "${f.name}" ของ ${studentName} ไม่ได้: ${err.message}`);
        continue;
      }
      if (isAudioAttachment(meta) && !audio) audio = { ...f, meta };
      else workFiles.push({ ...f, meta });
    }

    // ข้อความงานของนักเรียนคนนี้ ใช้เป็นฐานเทียบที่ตรงตัวกว่าคำสั่งงานรวม
    let studentWorkText = "";
    for (const wf of workFiles) {
      try {
        const text = await fetchFileTextAuth(wf.id, accessToken, wf.meta);
        if (text) studentWorkText += `${studentWorkText ? "\n\n" : ""}--- ${wf.name} ---\n${text}`;
      } catch (err) {
        warn(job, `อ่านไฟล์งาน "${wf.name}" ของ ${studentName} ไม่ได้: ${err.message}`);
      }
    }

    const targetSource = studentWorkText
      ? `=== เนื้องานเฉพาะของนักเรียน (${studentName}) ===\n${studentWorkText}\n\n=== โจทย์/เนื้องานรวมของคลาส ===\n${assignmentSource}`
      : assignmentSource;

    const existing = await db.get(
      "SELECT id, audio_path FROM submissions WHERE classroom_submission_id = ?",
      [sub.id]
    );

    // ไม่มีไฟล์เสียง = ยังอธิบายปากเปล่าไม่ได้ บันทึกไว้ให้ครูเห็นว่ารออยู่
    if (!audio) {
      if (existing) {
        job.counts.skipped++;
        continue; // ของเดิมมีอยู่แล้ว อย่าทับผลวิเคราะห์ที่ทำไปแล้ว
      }
      await db.run(
        `INSERT INTO submissions (assignment_id, student_name, transcript, status, input_mode,
                                  classroom_submission_id, classroom_user_id)
         VALUES (?,?,?,'awaiting','voice',?,?)`,
        [assignmentId, studentName, studentWorkText || null, sub.id, sub.userId]
      );
      job.counts.submissions++;
      job.counts.awaitingAudio++;
      continue;
    }

    // มีไฟล์เสียงแล้ว และเคยวิเคราะห์สำเร็จไปแล้ว — ไม่ต้องทำซ้ำให้เปลืองโควตา
    if (existing?.audio_path) {
      job.counts.skipped++;
      continue;
    }

    let submissionId;
    if (existing) {
      await db.run("UPDATE submissions SET student_name = ?, status = 'transcribing' WHERE id = ?", [
        studentName,
        existing.id,
      ]);
      submissionId = existing.id;
    } else {
      const info = await db.run(
        `INSERT INTO submissions (assignment_id, student_name, status, input_mode,
                                  classroom_submission_id, classroom_user_id)
         VALUES (?,?, 'transcribing','voice',?,?)`,
        [assignmentId, studentName, sub.id, sub.userId]
      );
      submissionId = info.lastInsertRowid;
    }

    if (!existing) job.counts.submissions++;
    job.counts.audioQueued++;

    // โหลดไฟล์ + ถอดเสียง + วิเคราะห์ ทำในคิวเรียงทีละคน
    enqueueAudio(async () => {
      try {
        const token = await getValidAccessToken(job.userId); // อาจหมดอายุระหว่างรอคิว
        const audioPath = await downloadFileToDiskAuth(audio.id, token, UPLOAD_DIR, audio.meta);
        await db.run("UPDATE submissions SET audio_path = ? WHERE id = ?", [audioPath, submissionId]);
        await processAudio(submissionId, targetSource, audioPath);
      } catch (err) {
        await fail(submissionId, `ดึงไฟล์เสียงจาก Classroom ไม่สำเร็จ: ${err.message}`);
      }
    });
  }
}

// ── ตัวโคลนหลัก ─────────────────────────────────────────
async function runImport(job, { courseId, includeSubmissions }) {
  const accessToken = await getValidAccessToken(job.userId);

  job.phase = "กำลังอ่านข้อมูลชั้นเรียน…";
  const course = await classroom.getCourse(accessToken, courseId);
  const subjectId = await upsertSubject(course, job.userId);
  job.subjectId = subjectId;
  job.courseName = course.name;

  job.phase = "กำลังโคลนหัวข้อ…";
  const topics = await classroom.listTopics(accessToken, courseId);
  const lessonByTopic = new Map();
  for (const t of topics) {
    lessonByTopic.set(t.topicId, await upsertLesson(subjectId, t.topicId, t.name));
    job.counts.lessons++;
  }

  job.phase = "กำลังโคลนงานที่สั่ง…";
  const courseWork = await classroom.listCourseWork(accessToken, courseId);

  // Classroom ให้สั่งงานโดยไม่ผูกหัวข้อได้ ฝั่งเราต้องมีหัวข้อเสมอ จึงทำถังรวมไว้
  let fallbackLessonId = null;
  const getFallbackLesson = async () => {
    if (!fallbackLessonId) {
      fallbackLessonId = await upsertLesson(subjectId, `__no_topic__${courseId}`, "งานที่ไม่ได้จัดหัวข้อ");
      job.counts.lessons++;
    }
    return fallbackLessonId;
  };

  const roster = new Map();
  if (includeSubmissions) {
    job.phase = "กำลังอ่านรายชื่อนักเรียน…";
    try {
      for (const s of await classroom.listStudents(accessToken, courseId)) {
        roster.set(s.userId, classroom.studentDisplayName(s));
      }
    } catch (err) {
      warn(job, `อ่านรายชื่อนักเรียนไม่ได้ (จะใช้ชื่อว่า "ไม่ทราบชื่อ" แทน): ${err.message}`);
    }
  }

  for (const [i, work] of courseWork.entries()) {
    job.phase = `กำลังโคลนงาน ${i + 1}/${courseWork.length}: ${work.title}`;

    const lessonId = (work.topicId && lessonByTopic.get(work.topicId)) || (await getFallbackLesson());
    const sourceText = await buildAssignmentSource(work, accessToken, job);

    const assignmentId = await upsertAssignment({
      courseWorkId: work.id,
      title: work.title,
      // drive_url ห้ามว่าง — ใช้ลิงก์งานใน Classroom ซึ่งครูกดกลับไปดูต้นทางได้จริง
      driveUrl: work.alternateLink || `https://classroom.google.com/c/${courseId}`,
      sourceText,
      lessonId,
    });
    job.counts.assignments++;

    if (includeSubmissions) {
      await importSubmissionsFor({
        job, accessToken, courseId, work, assignmentId, assignmentSource: sourceText, roster,
      });
    }
  }

  job.phase = "เสร็จแล้ว";
  job.status = "done";
  job.finishedAt = Date.now();
}

function startImport({ userId, courseId, courseName, includeSubmissions = true }) {
  const job = createJob(userId, courseName);

  runImport(job, { courseId, includeSubmissions }).catch((err) => {
    console.error("Classroom import failed:", err);
    job.status = "error";
    job.error = err.message;
    job.phase = "หยุดกลางคัน";
    job.finishedAt = Date.now();
  });

  return job;
}

module.exports = { startImport, getJob };
