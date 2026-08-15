-- ═══════════════════════════════════════════════════════════════════════════
-- Education AI — โครงฐานข้อมูล PostgreSQL ทั้งหมด (สถานะปัจจุบัน)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ ไฟล์นี้เป็น "เอกสารอ้างอิง" ไม่ใช่ตัวที่ระบบใช้จริง
--
-- ตัวจริงถูกสร้างตอนบูตจากโค้ด ไม่ได้อ่านไฟล์ .sql ใด ๆ:
--   src/db.js  → SCHEMA (CREATE TABLE ทั้งหมด) + MIGRATIONS (ALTER เพิ่มคอลัมน์ภายหลัง)
--   src/pg.js  → ensureGoogleTokenColumns() (ALTER เพิ่มคอลัมน์โทเคน Google ใน users)
-- เรียกจาก init() ตอน server.js สตาร์ต ทุกคำสั่งเป็น IF NOT EXISTS จึงรันซ้ำได้
--
-- ไฟล์นี้รวมผลลัพธ์สุดท้ายของทั้งสามแหล่งไว้ที่เดียว คอลัมน์ที่โค้ดเติมด้วย ALTER
-- ถูกย้ายมาอยู่ใน CREATE TABLE ให้อ่านง่าย — ผลลัพธ์เหมือนกันแต่ลำดับคอลัมน์จริงต่างออกไป
--
-- 🔴 อย่ารันไฟล์นี้กับฐานที่ระบบใช้อยู่โดยไม่จำเป็น และห้ามตั้งชื่อเป็น data/schema.sql
--    เพราะเคยมีไฟล์ชื่อนั้นที่สร้างตารางคนละหน้าตา (id เป็น UUID) แล้วทำให้ทุก query พัง
--    db.js:205 มีตัวตรวจจับและลบตารางร่างชุดนั้นทิ้งอยู่ (เฉพาะตอนที่ยังว่าง)
--
-- ใช้ไฟล์นี้เมื่อ: ต้องการดูโครงทั้งหมดในหน้าเดียว, ตั้งฐานเปล่าสำหรับทดสอบ,
--                 หรือส่งให้คนอื่นรีวิวโดยไม่ต้องเปิดโค้ด
-- เมื่อแก้โครงในโค้ด: ต้องมาแก้ไฟล์นี้ตามด้วย ไม่มีตัวซิงก์อัตโนมัติ
--
-- เวอร์ชัน PostgreSQL: 16 (postgres:16-alpine ใน docker-compose.yml)
-- gen_random_uuid() เป็นฟังก์ชันในตัวตั้งแต่ PG 13 ไม่ต้องลง extension pgcrypto
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1) users — บัญชีครู
-- ───────────────────────────────────────────────────────────────────────────
-- เป็นตารางเดียวที่ใช้ UUID เป็นคีย์ ที่เหลือใช้ SERIAL (integer)
-- เพราะฝั่งหน้าเว็บเทียบ id ด้วย === และแปลงด้วย Number() ตั้งแต่สมัยที่ยังใช้ SQLite
--
-- โทเคน Google เก็บแบบเข้ารหัส AES-256-GCM ด้วยคีย์ที่ได้จาก SESSION_SECRET
-- (ดู encryptToken/decryptToken ใน src/pg.js) — dump ฐานไปเฉย ๆ ใช้ต่อไม่ได้
-- ⚠ ถ้า SESSION_SECRET เปลี่ยน โทเคนเดิมถอดไม่ออกทั้งหมด ครูทุกคนต้องเชื่อม Google ใหม่
CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                VARCHAR(255) UNIQUE NOT NULL,   -- เก็บเป็น lower() เสมอตอน INSERT
  password_hash        VARCHAR(255),                   -- NULL ได้ = สมัครผ่าน Google ล้วน
                                                       -- รูปแบบ "scrypt$<salt hex>$<hash hex>"
  full_name            VARCHAR(150) NOT NULL,
  picture_url          TEXT,
  google_id            VARCHAR(100),
  role                 VARCHAR(20) NOT NULL DEFAULT 'teacher'
                       CHECK (role IN ('teacher', 'student', 'admin')),
                       -- ตอนนี้ใช้จริงแค่ 'teacher' — ยังไม่มี flow ของนักเรียน/แอดมิน

  -- เพิ่มภายหลังโดย src/pg.js → ensureGoogleTokenColumns()
  title                TEXT,                           -- คำนำหน้า/ตำแหน่ง เช่น "ครู"
  department           TEXT,                           -- กลุ่มสาระ/แผนก
  google_access_token  TEXT,                           -- เข้ารหัสไว้ (v1.<iv>.<tag>.<data>)
  google_refresh_token TEXT,                           -- เข้ารหัสไว้ อันตรายกว่ารหัสผ่าน
  google_token_expiry  TIMESTAMPTZ,
  google_scopes        TEXT,                           -- scope ที่ครูกดอนุญาตไว้ คั่นด้วยเว้นวรรค

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 2) subjects — รายวิชา (ห้องเรียน)
-- ───────────────────────────────────────────────────────────────────────────
-- ⚠ user_id เป็น TEXT ไม่ใช่ UUID และไม่มี FOREIGN KEY ไป users
--   เป็นผลจากการยกโครงมาจาก SQLite ตรง ๆ — ลบครูทิ้งแล้ววิชาจะค้างเป็นเด็กกำพร้า
--   โค้ดกันด้วยการเทียบ user_id ในทุก query แทน (ดู ownedSubject ใน src/server.js)
CREATE TABLE IF NOT EXISTS subjects (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  user_id             TEXT,                            -- = users.id (UUID ที่เก็บเป็นข้อความ)
  classroom_course_id TEXT,                            -- id คอร์สจาก Google Classroom (ถ้า import มา)
  classroom_synced_at TIMESTAMPTZ,

  -- เพิ่มภายหลังโดย MIGRATIONS ใน src/db.js
  theme_color         TEXT,                            -- ว่าง = ระบบสุ่มสีให้ตามเดิม
  bg_image            TEXT,                            -- ชื่อไฟล์ใน UPLOAD_DIR
  bg_mime             TEXT,                            -- multer เก็บไฟล์ไม่มีนามสกุล ต้องจำชนิดเอง

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 3) lessons — บทเรียน/หัวข้อ ภายในวิชา
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lessons (
  id                 SERIAL PRIMARY KEY,
  subject_id         INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  classroom_topic_id TEXT,                             -- id หัวข้อจาก Google Classroom
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 4) assignments — งานที่มอบหมาย
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  id                      SERIAL PRIMARY KEY,
  lesson_id               INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  drive_url               TEXT NOT NULL,
  source_text             TEXT,                        -- เนื้องานที่ดึงจาก Drive ไว้เทียบกับคำอธิบาย
                                                       -- ของนักเรียน (ตัดที่ 9,000-12,000 ตัวอักษร
                                                       -- ตอนส่งเข้าโมเดล ดู SOURCE_LIMIT ใน typhoon.js)
  source_fetched_at       TIMESTAMPTZ,                 -- เวลาที่ดึงเนื้อหาจาก Drive ล่าสุด
  source_hash             TEXT,                        -- sha1 ของ source_text ใช้ดูว่าไฟล์ถูกแก้จริงไหม
  classroom_coursework_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 5) students — รายชื่อนักเรียนของครูแต่ละคน
-- ───────────────────────────────────────────────────────────────────────────
-- ไม่ใช่บัญชีผู้ใช้ — เป็นแค่รายชื่อไว้จับคู่ไฟล์เสียงกับเจ้าของงาน
-- นักเรียนยังไม่มี login ของตัวเอง (ทุก endpoint ปัจจุบันเป็น requireTeacher)
CREATE TABLE IF NOT EXISTS students (
  id          SERIAL PRIMARY KEY,
  student_no  TEXT NOT NULL,                           -- รหัสนักเรียน unique ต่อครูหนึ่งคน
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  class_level TEXT,                                    -- ระดับชั้น
  room        TEXT,                                    -- ห้อง
  user_id     TEXT,                                    -- = users.id (ไม่มี FK เหมือน subjects)

  -- เพิ่มภายหลังโดย MIGRATIONS ใน src/db.js
  department  TEXT,
  roll_no     TEXT,                                    -- เลขที่ในห้อง
  status      TEXT DEFAULT 'กำลังศึกษา',
  note        TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 6) submissions — การส่งงานหนึ่งครั้ง + ผลตรวจ
-- ───────────────────────────────────────────────────────────────────────────
-- ตารางใจกลางของระบบ หนึ่งแถว = นักเรียนหนึ่งคนส่งงานหนึ่งชิ้นหนึ่งครั้ง
--
-- วงจรของ status: transcribing → analyzing → done
--                              ↘ error (พร้อม error_message ที่อ่านรู้เรื่องเป็นภาษาไทย)
-- แม้จะ error ตอนวิเคราะห์ transcript ก็ยังถูกบันทึกไว้ ครูอ่านเอง/ฟังเองแล้วให้คะแนนมือได้
CREATE TABLE IF NOT EXISTS submissions (
  id                      SERIAL PRIMARY KEY,
  assignment_id           INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id              INTEGER REFERENCES students(id) ON DELETE SET NULL,
  student_name            TEXT NOT NULL,               -- เก็บชื่อซ้ำไว้ เผื่อกรอกอิสระโดยไม่ผูกรายชื่อ
  audio_path              TEXT,                        -- path ไฟล์เสียงใน UPLOAD_DIR
  transcript              TEXT,                        -- ผลถอดเสียงจาก whisper
  status                  TEXT NOT NULL DEFAULT 'transcribing',
                          -- awaiting | transcribing | analyzing | done | error
  error_message           TEXT,

  -- ── คะแนน 5 ด้าน ด้านละ 0-100 จากโมเดล (ดู SYSTEM_PROMPT ใน src/typhoon.js) ──
  content_match           INTEGER,                     -- พูดตรงกับเนื้องานจริงแค่ไหน
  specificity             INTEGER,                     -- เจาะจงกับงานชิ้นนี้ หรือพูดกว้าง ๆ
  reasoning               INTEGER,                     -- อธิบาย "ทำไม" ได้ไหม
  ownership               INTEGER,                     -- ⚠ ร่องรอยว่าลงมือทำเอง (เพิ่มภายหลัง)
  own_words               INTEGER,                     -- ⚠ ใช้ภาษาตัวเองหรือท่องนิยามมา (เพิ่มภายหลัง)
                                                       -- สองด้านนี้คือตัวแยก "เข้าใจจริง" ออกจาก "ท่องมา"
                                                       -- แถวที่ตรวจก่อนเพิ่มคอลัมน์จะเป็น NULL
                                                       -- หน้าเว็บซ่อนแถบที่เป็น NULL ให้เอง

  -- ── ผลสรุป ──
  trust_score             INTEGER,                     -- ถ่วงน้ำหนักด้านละ 0.2 เท่ากันหมด
                                                       -- แล้วถูกกดเหลือ ≤44 ถ้าเข้าเงื่อนไข "ท่องมา"
                                                       -- (recited / parroting ใน typhoon.js)
  trust_level             TEXT,                        -- green ≥75 | yellow ≥45 | red
  reasons                 TEXT,                        -- JSON array ของเหตุผลภาษาไทย (3-4 ข้อ)
  flags                   TEXT,                        -- JSON array ของสัญญาณเตือน (0-3 ข้อ)
                                                       -- หน้าเว็บแสดงเป็นกล่องเตือนสีเหลือง
                                                       -- ⚠ เก็บ JSON เป็น TEXT ไม่ใช่ JSONB
                                                       --   query เข้าไปข้างในไม่ได้ ต้อง parse ที่ Node
  needs_followup          INTEGER NOT NULL DEFAULT 0,  -- 0/1 ไม่ใช่ boolean เพื่อให้ JSON ที่ส่งให้
                                                       -- หน้าเว็บหน้าตาเหมือนเดิมสมัย SQLite
                                                       -- ⚠ คำนวณและเก็บไว้ แต่ยังไม่มี flow ถามตามจริง

  -- ── ครูตัดสินใจสุดท้ายเสมอ AI ไม่ตัดสินขาด ──
  teacher_score           INTEGER,
  teacher_note            TEXT,

  input_mode              TEXT NOT NULL DEFAULT 'voice',   -- voice = อัดเสียง | text = พิมพ์ตอบ
  classroom_submission_id TEXT,
  classroom_user_id       TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 7) subject_students — นักเรียนอยู่ห้องไหนบ้าง (many-to-many)
-- ───────────────────────────────────────────────────────────────────────────
-- แยกออกมาเป็นตารางเชื่อม เพราะนักเรียนคนเดียวเรียนได้หลายวิชา
-- ถ้ายัด subject_id ลงตาราง students ตรง ๆ จะต้องกรอกชื่อซ้ำทุกห้อง
-- ⚠ ตารางนี้ไม่มีคอลัมน์ id — db.run() ใน src/db.js เติม RETURNING id ให้ INSERT อัตโนมัติ
--   จึงต้องเขียน RETURNING เองในคำสั่งที่ INSERT ลงตารางนี้
CREATE TABLE IF NOT EXISTS subject_students (
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subject_id, student_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- ดัชนี
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ดัชนีทั่วไป: เร่ง query ที่กรองตามเจ้าของ/ความสัมพันธ์ ──
CREATE INDEX IF NOT EXISTS idx_subject_students_student ON subject_students(student_id);
CREATE INDEX IF NOT EXISTS idx_lessons_subject          ON lessons(subject_id);
CREATE INDEX IF NOT EXISTS idx_assignments_lesson       ON assignments(lesson_id);
CREATE INDEX IF NOT EXISTS idx_subjects_user            ON subjects(user_id);
CREATE INDEX IF NOT EXISTS idx_students_user            ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment   ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student      ON submissions(student_id);

-- ── ดัชนีบังคับความไม่ซ้ำ ──

-- รหัสนักเรียนห้ามซ้ำ แต่ซ้ำข้ามครูได้ (ครูคนละคนมีรายชื่อของตัวเอง)
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_no ON students(user_id, student_no);

-- ── unique แบบมีเงื่อนไข (partial index) ──
-- แถวที่ครูสร้างเองมี classroom_* เป็น NULL จึงมีได้หลายแถวโดยไม่ชนกัน
-- บังคับความไม่ซ้ำเฉพาะแถวที่ import มาจาก Google Classroom เท่านั้น
--
-- ⚠ ทั้งสองตัวนี้ถูก DROP แล้ว CREATE ใหม่ใน MIGRATIONS ของ src/db.js ทุกครั้งที่บูต
--   เพราะรุ่นแรกผูก unique ที่ระดับ global (ไม่มี user_id / lesson_id) ทำให้ครูสองคน
--   ที่โคลนคอร์สเดียวกันไปใช้แถวร่วมกันแล้วทับกันเอง — และ CREATE INDEX IF NOT EXISTS
--   ไม่แก้นิยามของ index เดิมที่ชื่อซ้ำให้ ต้อง DROP ก่อนเท่านั้น

-- ครูสองคน import คอร์สเดียวกันได้ แยกเป็นคนละวิชา
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_course
  ON subjects(user_id, classroom_course_id) WHERE classroom_course_id IS NOT NULL;

-- หัวข้อชื่อซ้ำกันข้ามวิชาได้ จึงผูกกับ subject_id ด้วย
CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_topic
  ON lessons(subject_id, classroom_topic_id) WHERE classroom_topic_id IS NOT NULL;

-- งานเดียวกันจาก Classroom ถูกโคลนได้หลายบทเรียน จึงผูกกับ lesson_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_coursework
  ON assignments(lesson_id, classroom_coursework_id) WHERE classroom_coursework_id IS NOT NULL;

-- การส่งงานจาก Classroom ห้ามซ้ำ กัน import รอบสองแล้วได้แถวซ้ำ
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_classroom
  ON submissions(classroom_submission_id) WHERE classroom_submission_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- ภาคผนวก ก: ตารางร่างเก่าที่ระบบจะลบทิ้งให้อัตโนมัติ
-- ═══════════════════════════════════════════════════════════════════════════
-- ไฟล์ data/schema.sql รุ่นเก่าเคยถูกรันด้วยมือ แล้วสร้าง assignments/submissions
-- คนละหน้าตากับที่โค้ดใช้ (คีย์เป็น UUID) ผลคือ CREATE TABLE IF NOT EXISTS ข้ามไปเงียบ ๆ
-- แล้วทุก query พังหมด
--
-- dropLegacyScaffoldIfEmpty() ใน src/db.js:214 ตรวจตอนบูตว่า assignments มีคอลัมน์
-- lesson_id ไหม ถ้าไม่มี = เป็นตารางร่างเก่า แล้วลบตารางกลุ่มนี้ทิ้ง:
--     assignment_drive_files, evaluation_results, followup_questions,
--     assignments, submissions, classes
-- ลบให้เฉพาะตอนที่ "ว่างทุกตาราง" เท่านั้น ถ้ามีข้อมูลแม้แถวเดียวจะโยน error
-- ออกไปให้คนตัดสินใจเอง ดีกว่าลบข้อมูลของใครทิ้งโดยไม่ถาม
--
-- 📌 followup_questions อยู่ในลิสต์นี้ = ฟีเจอร์ถามตามยังไม่ได้ทำ ทั้งที่ submissions
--    คำนวณ needs_followup เก็บไว้แล้ว ถ้าจะทำจริงต้องสร้างตารางใหม่ชื่ออื่น
--    หรือเอาชื่อนี้ออกจาก LEGACY_TABLES ก่อน ไม่งั้นจะโดนลบตอนบูต


-- ═══════════════════════════════════════════════════════════════════════════
-- ภาคผนวก ข: query ที่ใช้บ่อย (ไว้ debug / ตรวจสอบด้วยมือ)
-- ═══════════════════════════════════════════════════════════════════════════
-- เข้า psql:  docker compose exec postgres psql -U postgres -d Education_AI

-- ดูภาพรวมผลตรวจของงานชิ้นหนึ่ง
--   SELECT s.student_name, s.status, s.trust_level, s.trust_score,
--          s.content_match, s.specificity, s.reasoning, s.ownership, s.own_words,
--          s.teacher_score, s.error_message
--   FROM submissions s
--   WHERE s.assignment_id = <id>
--   ORDER BY s.trust_score NULLS FIRST;

-- เทียบคะแนน AI กับคะแนนที่ครูให้เอง — ตัวเลขตั้งต้นสำหรับวัดว่าระบบแม่นแค่ไหน
-- (ยิ่งครูแก้คะแนนบ่อยและแก้เยอะ แปลว่ายิ่งเชื่อ AI ไม่ได้)
--   SELECT trust_level,
--          COUNT(*)                                        AS ทั้งหมด,
--          COUNT(teacher_score)                            AS ครูให้คะแนนเอง,
--          ROUND(AVG(teacher_score - trust_score), 1)      AS ส่วนต่างเฉลี่ย
--   FROM submissions
--   WHERE status = 'done'
--   GROUP BY trust_level;

-- หางานที่ตรวจไม่ผ่าน พร้อมเหตุผล (ใช้ไล่ปัญหาถอดเสียง/ต่อโมเดลไม่ติด)
--   SELECT id, student_name, error_message, created_at
--   FROM submissions WHERE status = 'error' ORDER BY created_at DESC LIMIT 20;

-- ไฟล์เสียงที่ยังค้างอยู่ในดิสก์ (ยังไม่มีระบบลบตามอายุ — ดูหมายเหตุ PDPA ท้ายไฟล์)
--   SELECT COUNT(*), MIN(created_at) AS เก่าสุด
--   FROM submissions WHERE audio_path IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- ภาคผนวก ค: ข้อสังเกตเรื่องโครงฐานข้อมูล (ยังไม่ได้แก้)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. subjects.user_id และ students.user_id เป็น TEXT ไม่มี FK ไป users(id)
--    ลบครูทิ้ง → วิชาและรายชื่อนักเรียนค้างเป็นเด็กกำพร้า ไม่มีอะไรกวาดให้
--    แก้ได้ด้วยการเปลี่ยนชนิดเป็น UUID แล้วเพิ่ม REFERENCES users(id) ON DELETE CASCADE
--    แต่ต้องแปลงข้อมูลเดิมและตรวจว่าไม่มีค่าที่ชี้ไปหาผู้ใช้ที่ไม่มีอยู่จริงก่อน
--
-- 2. flags / reasons เก็บ JSON เป็น TEXT ไม่ใช่ JSONB
--    query เข้าไปข้างในไม่ได้ เช่นถามว่า "มีกี่คนที่ติดธง 'ไม่เล่าขั้นตอนที่ตัวเองทำ'"
--    ต้องดึงทุกแถวมา parse ที่ Node เอา ถ้าจะทำสถิติควรย้ายเป็น JSONB
--
-- 3. needs_followup เป็น INTEGER 0/1 แทน BOOLEAN (มรดกจาก SQLite)
--
-- 4. ไม่มี index บน submissions(status) — หน้าที่ไล่ดูงานที่ยังตรวจไม่เสร็จ
--    จะสแกนทั้งตารางเมื่อข้อมูลเยอะขึ้น
--
-- 5. ไม่มีนโยบายลบข้อมูลตามอายุ เสียงนักเรียนเป็นข้อมูลส่วนบุคคลตาม PDPA
--    ทั้ง audio_path (ไฟล์จริงใน uploads/) และ transcript อยู่ถาวรจนกว่าจะลบงานทิ้ง
--    ควรมี job ลบไฟล์เสียงหลัง N วัน โดยเก็บผลตรวจไว้
--
-- 6. ไม่มีตารางบันทึกประวัติการแก้คะแนนของครู — teacher_score ถูกเขียนทับ
--    ถ้าอยากรู้ว่าครูแก้จากเท่าไหร่เป็นเท่าไหร่ (ข้อมูลสำคัญสำหรับวัดความแม่นของ AI)
--    ต้องเพิ่มตาราง audit แยก
