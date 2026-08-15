// ย้ายข้อมูลชุดเดิมจาก SQLite (data/eduai.sqlite) ขึ้น PostgreSQL — รันครั้งเดียวจบ
//
//   docker compose exec app node scripts/migrate-sqlite-to-pg.js
//
// รันซ้ำได้ปลอดภัย: ถ้าตารางปลายทางมีข้อมูลอยู่แล้วจะข้ามตารางนั้นไป
// ไม่แตะไฟล์ SQLite เดิมเลย ถ้าพลาดยังย้อนกลับไปดูของเดิมได้

const path = require("node:path");
const fs = require("node:fs");

const db = require("../src/db");
const { pool } = require("../src/pg");

const SQLITE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "eduai.sqlite");

// ลำดับสำคัญ — ตารางลูกต้องมาหลังตารางแม่ ไม่งั้นติด foreign key
const TABLES = [
  { name: "subjects", cols: ["id", "name", "user_id", "classroom_course_id", "classroom_synced_at", "created_at"] },
  { name: "lessons", cols: ["id", "subject_id", "title", "classroom_topic_id", "created_at"] },
  { name: "assignments", cols: ["id", "lesson_id", "title", "drive_url", "source_text", "classroom_coursework_id", "created_at"] },
  { name: "students", cols: ["id", "student_no", "first_name", "last_name", "class_level", "room", "user_id", "created_at"] },
  {
    name: "submissions",
    cols: [
      "id", "assignment_id", "student_id", "student_name", "audio_path", "transcript",
      "status", "error_message", "content_match", "specificity", "reasoning",
      "trust_score", "trust_level", "reasons", "needs_followup", "teacher_score",
      "teacher_note", "input_mode", "classroom_submission_id", "classroom_user_id", "created_at",
    ],
  },
];

// SQLite เก็บเวลาเป็นข้อความ 'YYYY-MM-DD HH:MM:SS' ซึ่งเป็นเวลา UTC
// ต้องเติม Z ให้ PostgreSQL รู้ว่าเป็น UTC ไม่งั้นจะถูกตีความเป็นเวลาท้องถิ่นแล้วเพี้ยนไปหลายชั่วโมง
function toTimestamp(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  return `${String(v).replace(" ", "T")}Z`;
}

const TIME_COLS = new Set(["created_at", "classroom_synced_at"]);

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`ไม่พบไฟล์ SQLite ที่ ${SQLITE_PATH} — ไม่มีอะไรต้องย้าย`);
    return;
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    console.error(
      "อ่านไฟล์ SQLite ไม่ได้เพราะไม่มีโมดูล better-sqlite3 ในสภาพแวดล้อมนี้\n" +
        "ให้รันสคริปต์นี้ในคอนเทนเนอร์ app (ซึ่งยังมีโมดูลติดตั้งอยู่):\n" +
        "  docker compose exec app node scripts/migrate-sqlite-to-pg.js"
    );
    process.exitCode = 1;
    return;
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  await db.init();

  for (const { name, cols } of TABLES) {
    const dest = await db.get(`SELECT COUNT(*)::int AS c FROM ${name}`);
    if (dest.c > 0) {
      console.log(`ข้าม ${name} — ปลายทางมีอยู่แล้ว ${dest.c} แถว`);
      continue;
    }

    // ตาราง SQLite เดิมอาจไม่มีคอลัมน์ครบทุกตัว (สร้างมาคนละรุ่นของ migration)
    const present = new Set(sqlite.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    const use = cols.filter((c) => present.has(c));
    const rows = sqlite.prepare(`SELECT ${use.join(", ")} FROM ${name}`).all();

    if (!rows.length) {
      console.log(`ข้าม ${name} — ต้นทางไม่มีข้อมูล`);
      continue;
    }

    for (const row of rows) {
      const values = use.map((c) => (TIME_COLS.has(c) ? toTimestamp(row[c]) : row[c]));
      await db.run(
        `INSERT INTO ${name} (${use.join(", ")}) VALUES (${use.map(() => "?").join(",")})`,
        values
      );
    }

    // id ถูกยัดมาตรง ๆ ตัวนับของ SERIAL จึงยังค้างอยู่ที่ 1 ต้องดันไปให้พ้นค่าสูงสุด
    // ไม่งั้นแถวถัดไปที่ระบบสร้างเองจะชนกับ primary key ทันที
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${name}', 'id'), COALESCE((SELECT MAX(id) FROM ${name}), 1))`
    );

    console.log(`ย้าย ${name} แล้ว ${rows.length} แถว`);
  }

  sqlite.close();
  console.log("\nย้ายข้อมูลครบแล้ว — ตรวจหน้าเว็บอีกรอบ ถ้าปกติดีค่อยลบ data/eduai.sqlite ทิ้ง");
}

main()
  .catch((err) => {
    console.error("ย้ายข้อมูลไม่สำเร็จ:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
