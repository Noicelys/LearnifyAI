// ข้อมูลหลักของระบบ: รายวิชา > บทเรียน > งาน > การส่งงาน + รายชื่อนักเรียน
//
// เดิมใช้ SQLite (better-sqlite3) แบบ synchronous ตอนนี้ย้ายมา PostgreSQL ทั้งหมด
// ใช้ connection pool ตัวเดียวกับ ./pg (ตาราง users / โทเคน Google) จะได้ไม่เปิดสองพูล
//
// API เลียนแบบของเดิมไว้ (get / all / run) แต่เป็น async — ผู้เรียกต้อง await
//   run() คืน { changes, lastInsertRowid } เหมือน better-sqlite3
//   คำสั่ง INSERT จะถูกเติม RETURNING id ให้อัตโนมัติ ถ้ายังไม่ได้เขียนเอง

const { pool } = require("./pg");

// ── แปลง placeholder ? ของ SQLite เป็น $1,$2,… ของ PostgreSQL ──
// ข้าม ? ที่อยู่ในเครื่องหมายคำพูดเดี่ยว เพราะนั่นคือข้อความ ไม่ใช่ตัวแปร
function toPgParams(sql) {
  let out = "";
  let n = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // '' ซ้อนกันคือเครื่องหมาย ' ตัวเดียวในข้อความ ไม่ใช่การปิดสตริง
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inString = !inString;
      out += c;
      continue;
    }
    if (c === "?" && !inString) { out += `$${++n}`; continue; }
    out += c;
  }
  return out;
}

// ตัวรันจริง — รับ "ผู้ยิงคำสั่ง" มาเป็นพารามิเตอร์ จะเป็นทั้งพูล หรือ client เดี่ยวใน transaction ก็ได้
function bind(runner) {
  const all = async (sql, params = []) => (await runner.query(toPgParams(sql), params)).rows;
  const get = async (sql, params = []) => (await all(sql, params))[0];

  const run = async (sql, params = []) => {
    let text = toPgParams(sql);
    // เติม RETURNING id ให้ INSERT อัตโนมัติ เพื่อให้ lastInsertRowid ใช้ได้เหมือน better-sqlite3
    // ตารางที่ไม่มีคอลัมน์ id (เช่น subject_students ที่ใช้คีย์ผสม) ต้องเขียน RETURNING เองในคำสั่ง
    const wantsId = /^\s*insert\s/i.test(text) && !/\breturning\b/i.test(text);
    if (wantsId) text += " RETURNING id";

    const res = await runner.query(text, params);
    return { changes: res.rowCount, lastInsertRowid: wantsId ? res.rows[0]?.id : undefined };
  };

  return { all, get, run };
}

const { all, get, run } = bind(pool);

// รันหลายคำสั่งให้สำเร็จหรือล้มเหลวไปด้วยกัน
// เช่น "สร้างนักเรียนแล้วใส่เข้าห้อง" ถ้าขั้นที่สองพัง ต้องไม่เหลือนักเรียนลอยที่ไม่อยู่ห้องไหน
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(bind(client));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── โครงสร้างตาราง ───────────────────────────────────────
// ยกมาจาก SQLite เดิมแบบตรงตัว (id เป็นเลขจำนวนเต็ม) เพื่อให้ฝั่งหน้าเว็บ
// ที่เทียบ id ด้วย === และแปลงด้วย Number() ใช้งานได้เหมือนเดิมทุกจุด
const SCHEMA = `
  -- บัญชีครู (ฝั่ง ./pg ใช้ตารางนี้) — เดิมมีอยู่ได้เพราะรัน data/schema.sql ด้วยมือเท่านั้น
  -- ย้ายมาสร้างตอนบูตด้วย จะได้ deploy เครื่องใหม่แล้วสมัคร/ล็อกอินได้เลย
  CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    full_name     VARCHAR(150) NOT NULL,
    picture_url   TEXT,
    google_id     VARCHAR(100),
    role          VARCHAR(20) NOT NULL DEFAULT 'teacher'
                  CHECK (role IN ('teacher', 'student', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    user_id             TEXT,
    classroom_course_id TEXT,
    classroom_synced_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id                 SERIAL PRIMARY KEY,
    subject_id         INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    classroom_topic_id TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id                      SERIAL PRIMARY KEY,
    lesson_id               INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL,
    drive_url               TEXT NOT NULL,
    -- เนื้อหางานที่ดึงจาก Drive ไว้ใช้เทียบกับคำอธิบายของนักเรียน
    source_text             TEXT,
    -- เวลาและลายนิ้วมือของเนื้อหาที่ดึงล่าสุด ใช้รีเฟรชอัตโนมัติเมื่อครูแก้ไฟล์ใน Drive
    source_fetched_at       TIMESTAMPTZ,
    source_hash             TEXT,
    classroom_coursework_id TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- รายชื่อนักเรียนของครูแต่ละคน ใช้อ้างอิงตอนจับคู่ไฟล์เสียงกับเจ้าของงาน
  CREATE TABLE IF NOT EXISTS students (
    id          SERIAL PRIMARY KEY,
    student_no  TEXT NOT NULL,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    class_level TEXT,
    room        TEXT,
    user_id     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id                      SERIAL PRIMARY KEY,
    assignment_id           INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id              INTEGER REFERENCES students(id) ON DELETE SET NULL,
    student_name            TEXT NOT NULL,
    audio_path              TEXT,
    transcript              TEXT,
    -- awaiting | transcribing | analyzing | done | error
    status                  TEXT NOT NULL DEFAULT 'transcribing',
    error_message           TEXT,
    content_match           INTEGER,
    specificity             INTEGER,
    reasoning               INTEGER,
    -- สองด้านนี้คือตัวแยก "เข้าใจจริง" ออกจาก "ท่องมาพูด" (ดู SYSTEM_PROMPT ใน typhoon.js)
    ownership               INTEGER,
    own_words               INTEGER,
    flags                   TEXT,      -- JSON array — สัญญาณเตือนที่ตรวจเจอ
    trust_score             INTEGER,
    trust_level             TEXT,      -- green | yellow | red
    reasons                 TEXT,      -- JSON array — Trust Score ต้องมีเหตุผลกำกับเสมอ
    -- เก็บเป็น 0/1 ไม่ใช่ boolean เพื่อให้ JSON ที่ส่งให้หน้าเว็บหน้าตาเหมือนเดิม
    needs_followup          INTEGER NOT NULL DEFAULT 0,
    -- ครู override ได้เสมอ AI ไม่ตัดสินขาด
    teacher_score           INTEGER,
    teacher_note            TEXT,
    -- voice = อัดเสียง, text = พิมพ์ตอบ
    input_mode              TEXT NOT NULL DEFAULT 'voice',
    classroom_submission_id TEXT,
    classroom_user_id       TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- นักเรียนคนเดียวเรียนได้หลายห้อง จึงแยก "ความเป็นสมาชิกห้อง" ออกมาเป็นตารางเชื่อม
  -- แทนที่จะยัด subject_id ลงในตาราง students ตรง ๆ ซึ่งจะบังคับให้ต้องกรอกชื่อซ้ำทุกห้อง
  CREATE TABLE IF NOT EXISTS subject_students (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject_id, student_id)
  );

  CREATE INDEX IF NOT EXISTS idx_subject_students_student ON subject_students(student_id);
  CREATE INDEX IF NOT EXISTS idx_lessons_subject       ON lessons(subject_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_lesson    ON assignments(lesson_id);
  CREATE INDEX IF NOT EXISTS idx_subjects_user         ON subjects(user_id);
  CREATE INDEX IF NOT EXISTS idx_students_user         ON students(user_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_student    ON submissions(student_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_students_no ON students(user_id, student_no);

  -- unique แบบมีเงื่อนไข: แถวที่ครูสร้างเองมีค่าเป็น NULL จึงมีได้หลายแถวโดยไม่ชนกัน
  -- ผูกกับ user_id ด้วย ครูสองคนที่ import คอร์สเดียวกันจะได้แยกวิชากันคนละแถว
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_course
    ON subjects(user_id, classroom_course_id) WHERE classroom_course_id IS NOT NULL;

  -- หัวข้อซ้ำชื่อกันข้ามวิชาได้ จึงต้องผูกกับ subject_id ด้วย
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_topic
    ON lessons(subject_id, classroom_topic_id) WHERE classroom_topic_id IS NOT NULL;

  -- งานเดียวกันจาก Classroom ถูกโคลนได้หลายวิชา (ครูละแถว) จึงต้องคู่กับ lesson_id
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_coursework
    ON assignments(lesson_id, classroom_coursework_id) WHERE classroom_coursework_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_classroom
    ON submissions(classroom_submission_id) WHERE classroom_submission_id IS NOT NULL;
`;

// ── เก็บกวาดตารางร่างเก่าจาก data/schema.sql ─────────────
// schema.sql เคยถูกรันมือไว้ สร้าง assignments/submissions คนละหน้าตากับที่โค้ดใช้ (UUID)
// ถ้าปล่อยทิ้งไว้ CREATE TABLE IF NOT EXISTS จะข้ามไปเงียบ ๆ แล้วทุก query พังหมด
//
// ลบให้เฉพาะตอนที่ "ว่างทุกตาราง" เท่านั้น — ถ้ามีข้อมูลจริงแม้แถวเดียวจะไม่แตะ
// แล้วโยน error ออกไปให้คนตัดสินใจเอง ดีกว่าลบข้อมูลของใครทิ้งโดยไม่ถาม
const LEGACY_TABLES = [
  "assignment_drive_files",
  "evaluation_results",
  "followup_questions",
  "assignments",
  "submissions",
  "classes",
];

async function dropLegacyScaffoldIfEmpty() {
  // ตารางร่างเก่าดูออกจากการที่ assignments ไม่มีคอลัมน์ lesson_id
  const marker = await get(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='assignments'`
  );
  if (!marker) return;

  const hasLessonId = await get(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='assignments' AND column_name='lesson_id'`
  );
  if (hasLessonId) return; // เป็นตารางของเราอยู่แล้ว ไม่ต้องทำอะไร

  const present = [];
  for (const t of LEGACY_TABLES) {
    const exists = await get(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=?`,
      [t]
    );
    if (exists) present.push(t);
  }

  const nonEmpty = [];
  for (const t of present) {
    const row = await get(`SELECT COUNT(*)::int AS c FROM "${t}"`);
    if (row.c > 0) nonEmpty.push(`${t} (${row.c} แถว)`);
  }

  if (nonEmpty.length) {
    throw new Error(
      `ตารางร่างเก่าจาก data/schema.sql ยังมีข้อมูลอยู่: ${nonEmpty.join(", ")} — ` +
        `กรุณาสำรองและลบเองก่อน แล้วค่อยสตาร์ทระบบใหม่`
    );
  }

  console.log(`db: ลบตารางร่างเก่าที่ว่างเปล่าออก (${present.join(", ")})`);
  await pool.query(`DROP TABLE IF EXISTS ${present.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

// ── ปรับโครงเพิ่มเติมสำหรับฐานที่สร้างไว้ก่อนหน้า ────────
// CREATE TABLE IF NOT EXISTS ไม่เติมคอลัมน์ให้ตารางที่มีอยู่แล้ว ต้องสั่ง ALTER แยก
// ทุกคำสั่งมี IF NOT EXISTS จึงรันซ้ำกี่รอบก็ปลอดภัย
const MIGRATIONS = `
  -- หน้าตาห้องเรียนที่ครูปรับเองได้ (ว่าง = ใช้สีประจำวิชาที่ระบบสุ่มให้ตามเดิม)
  ALTER TABLE subjects ADD COLUMN IF NOT EXISTS theme_color TEXT;
  ALTER TABLE subjects ADD COLUMN IF NOT EXISTS bg_image    TEXT;
  -- multer เก็บไฟล์เป็นชื่อสุ่มไม่มีนามสกุล เดาชนิดไฟล์ตอนส่งกลับไม่ได้ จึงต้องจำไว้เอง
  ALTER TABLE subjects ADD COLUMN IF NOT EXISTS bg_mime     TEXT;

  -- เกณฑ์ให้คะแนนแบบละเอียด: เพิ่มด้าน ownership / own_words ไว้จับการท่องมาพูด
  -- แถวเก่าที่ตรวจไว้ก่อนหน้านี้จะเป็น NULL — หน้าเว็บซ่อนแถบที่เป็น NULL ให้เอง
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS ownership INTEGER;
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS own_words INTEGER;
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS flags     TEXT;

  -- คอลัมน์เพิ่มเติมสำหรับตารางนักเรียน
  ALTER TABLE students ADD COLUMN IF NOT EXISTS department  TEXT;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS roll_no     TEXT;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS status      TEXT DEFAULT 'กำลังศึกษา';
  ALTER TABLE students ADD COLUMN IF NOT EXISTS note        TEXT;

  -- คำแนะนำเชิงสอน: บอกว่าคำอธิบายที่ดีควรเป็นยังไง ไม่ใช่แค่บอกคะแนน (ดู src/coach.js)
  -- แยก error ออกมาคนละคอลัมน์กับ error_message เพราะคำแนะนำพังไม่ใช่การตรวจพัง
  -- คะแนนที่ตรวจสำเร็จแล้วต้องอยู่ครบเสมอ ไม่ว่าขั้นสอนจะล้มเหลวยังไง
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS coaching       TEXT;
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS coaching_error TEXT;

  -- ผลไล่ประเด็นของเนื้องาน: JSON array ของ {point, covered, quote} (ดู src/typhoon.js)
  -- แถวที่ตรวจก่อนหน้านี้เป็น NULL — หน้าเว็บซ่อนบล็อกนี้ให้เองเมื่อไม่มีข้อมูล
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS coverage       TEXT;

  -- ลิงก์ที่ครูสร้างให้นักเรียนเปิดอ่านคำแนะนำเองโดยไม่ต้องล็อกอิน (ยกเลิกได้ = ตั้งกลับเป็น NULL)
  ALTER TABLE submissions ADD COLUMN IF NOT EXISTS share_token    TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_share
    ON submissions(share_token) WHERE share_token IS NOT NULL;

  -- เดิม unique ที่ระดับ global ทำให้ครูสองคนที่โคลนคอร์สเดียวกันใช้แถวร่วมกันและทับกันเอง
  -- CREATE INDEX IF NOT EXISTS ไม่แก้นิยามของ index เดิมที่ชื่อซ้ำ ต้อง DROP ก่อน
  DROP INDEX IF EXISTS idx_subjects_course;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_course
    ON subjects(user_id, classroom_course_id) WHERE classroom_course_id IS NOT NULL;

  -- ร่องรอยการดึงเนื้อหาจาก Drive ครั้งล่าสุด ใช้ตัดสินว่าควรดึงซ้ำไหม
  -- hash ไว้เทียบว่าเนื้อหาเปลี่ยนจริงหรือไม่ จะได้ไม่แจ้งครูทุกครั้งที่ดึงซ้ำ
  -- แถวเก่าเป็น NULL = ยังไม่เคยรีเฟรช ระบบจะถือว่าเก่าและดึงใหม่ให้รอบแรก
  ALTER TABLE assignments ADD COLUMN IF NOT EXISTS source_fetched_at TIMESTAMPTZ;
  ALTER TABLE assignments ADD COLUMN IF NOT EXISTS source_hash       TEXT;

  DROP INDEX IF EXISTS idx_assignments_coursework;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_coursework
    ON assignments(lesson_id, classroom_coursework_id) WHERE classroom_coursework_id IS NOT NULL;
`;

async function init() {
  await dropLegacyScaffoldIfEmpty();
  await pool.query(SCHEMA);
  await pool.query(MIGRATIONS);
}

module.exports = { get, all, run, tx, init, pool, toPgParams };
