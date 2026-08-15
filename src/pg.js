const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);

const fs = require("node:fs");
const path = require("node:path");

try {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || "").trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch {}

const pool = new Pool({
  host: process.env.POSTGRES_HOST || (process.env.NODE_ENV === "production" ? "postgres" : "localhost"),
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "Education_AI",
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD || "postgres",
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
});

async function query(text, params) {
  return pool.query(text, params);
}

// ── รหัสผ่าน ─────────────────────────────────────────────
// ใช้ scrypt ที่มากับ Node — แข็งแรงพอสำหรับรหัสผ่าน และไม่ต้องพึ่ง native module
// เก็บเป็น "scrypt$<salt hex>$<hash hex>" จะได้เปลี่ยนอัลกอริทึมทีหลังได้โดยไม่ต้องล้างฐาน
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  // เทียบแบบ timing-safe กันการเดารหัสจากเวลาที่ใช้ตอบ
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ── ผู้ใช้ ───────────────────────────────────────────────
const PUBLIC_FIELDS = "id, email, full_name, picture_url, role, title, department, created_at";

async function findUserByEmail(email) {
  const res = await query(
    `SELECT ${PUBLIC_FIELDS}, password_hash, google_id FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return res.rows[0] || null;
}

async function findUserById(id) {
  if (!id) return null;
  const res = await query(
    `SELECT ${PUBLIC_FIELDS}, password_hash, google_id FROM users WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function createUser({ email, password, fullName, role = "teacher" }) {
  const passwordHash = await hashPassword(password);
  const res = await query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES (lower($1), $2, $3, $4)
     RETURNING ${PUBLIC_FIELDS}`,
    [email, passwordHash, fullName, role]
  );
  return res.rows[0];
}

async function updateUserProfile(id, { fullName, title, department, pictureUrl }) {
  const res = await query(
    `UPDATE users 
     SET full_name = COALESCE($2, full_name),
         title = COALESCE($3, title),
         department = COALESCE($4, department),
         picture_url = COALESCE($5, picture_url),
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${PUBLIC_FIELDS}`,
    [id, fullName || null, title || null, department || null, pictureUrl || null]
  );
  return res.rows[0] || null;
}

async function upsertGoogleUser({ email, name, picture, googleId = null }) {
  if (!email) return null;
  const fullName = (name || email.split("@")[0] || "คุณครู").trim();
  const sql = `
    INSERT INTO users (email, full_name, picture_url, google_id, role)
    VALUES (lower($1), $2, $3, $4, 'teacher')
    ON CONFLICT (email) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
      google_id = COALESCE(EXCLUDED.google_id, users.google_id),
      updated_at = NOW()
    RETURNING ${PUBLIC_FIELDS};
  `;
  try {
    const res = await query(sql, [email, fullName, picture || null, googleId || null]);
    return res.rows[0];
  } catch (err) {
    console.error("Error upserting Google user in PostgreSQL:", err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// โทเคน Google OAuth (สำหรับเรียก Classroom / Drive แทนครู)
// ══════════════════════════════════════════════════════════

// refresh token ใช้ขอสิทธิ์ใหม่ได้เรื่อยๆ จนกว่าครูจะถอนสิทธิ์ — อันตรายกว่ารหัสผ่าน
// จึงเข้ารหัสไว้ก่อนลงฐาน ใครหลุด dump ฐานข้อมูลไปก็ใช้ต่อไม่ได้ถ้าไม่มี SESSION_SECRET
function tokenKey() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("ยังไม่ได้ตั้งค่า SESSION_SECRET");
  return crypto.createHash("sha256").update(s).digest(); // 32 ไบต์พอดีสำหรับ aes-256
}

function encryptToken(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

function decryptToken(stored) {
  if (!stored) return null;
  const [ver, ivB64, tagB64, dataB64] = stored.split(".");
  if (ver !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // SESSION_SECRET เปลี่ยนไป หรือข้อมูลเสีย — ให้ถือว่าไม่มีโทเคน ครูจะถูกขอเชื่อมต่อใหม่
    return null;
  }
}

// เพิ่มคอลัมน์เก็บโทเคนแบบ idempotent ให้เหมือนแนวทาง migration ของ SQLite ใน db.js
// ตาราง users มีอยู่แล้วจาก data/schema.sql ซึ่งไม่ได้รันอัตโนมัติ จึงต้องเติมเองตอนบูต
async function ensureGoogleTokenColumns() {
  await query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_access_token  TEXT,
      ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS google_token_expiry  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS google_scopes        TEXT,
      ADD COLUMN IF NOT EXISTS title                TEXT,
      ADD COLUMN IF NOT EXISTS department           TEXT
  `);
}

async function saveGoogleTokens(userId, { accessToken, refreshToken, expiresIn, scope }) {
  if (!userId) return false;

  // Google ส่ง refresh_token กลับมาเฉพาะครั้งแรกที่กด "อนุญาต" — ครั้งถัดไปจะไม่มี
  // จึงต้อง COALESCE ไม่งั้นการต่ออายุรอบเดียวจะลบของเดิมทิ้ง
  await query(
    `UPDATE users SET
       google_access_token  = $2,
       google_refresh_token = COALESCE($3, users.google_refresh_token),
       google_token_expiry  = NOW() + ($4 || ' seconds')::interval,
       google_scopes        = COALESCE($5, users.google_scopes),
       updated_at = NOW()
     WHERE id = $1`,
    [userId, encryptToken(accessToken), encryptToken(refreshToken), String(expiresIn || 3600), scope || null]
  );
  return true;
}

async function getGoogleTokens(userId) {
  if (!userId) return null;
  const res = await query(
    `SELECT google_access_token, google_refresh_token, google_scopes,
            google_token_expiry,
            (google_token_expiry > NOW() + interval '2 minutes') AS still_valid
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = res.rows[0];
  if (!row) return null;

  return {
    accessToken: decryptToken(row.google_access_token),
    refreshToken: decryptToken(row.google_refresh_token),
    scopes: row.google_scopes || "",
    expiry: row.google_token_expiry,
    stillValid: Boolean(row.still_valid),
  };
}

async function clearGoogleTokens(userId) {
  if (!userId) return;
  await query(
    `UPDATE users SET google_access_token = NULL, google_refresh_token = NULL,
            google_token_expiry = NULL, google_scopes = NULL, updated_at = NOW()
     WHERE id = $1`,
    [userId]
  );
}

module.exports = {
  pool,
  query,
  hashPassword,
  verifyPassword,
  ensureGoogleTokenColumns,
  saveGoogleTokens,
  getGoogleTokens,
  clearGoogleTokens,
  findUserByEmail,
  findUserById,
  createUser,
  updateUserProfile,
  upsertGoogleUser,
};
