const crypto = require("node:crypto");

const COOKIE = "eduai_teacher";
const MAX_AGE_SEC = 60 * 60 * 12; // 12 ชั่วโมง — พอดีหนึ่งวันทำงาน

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("ยังไม่ได้ตั้งค่า SESSION_SECRET");
  return s;
}

function signSession(data = { role: "teacher" }) {
  const expiresAt = Date.now() + MAX_AGE_SEC * 1000;
  const payloadStr = Buffer.from(JSON.stringify({ ...data, expiresAt })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(payloadStr).digest("hex");
  return `${payloadStr}.${mac}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadStr, mac] = parts;

  // เลกาซีโทเคน (expiresAt.mac)
  if (/^\d+$/.test(payloadStr)) {
    const expected = crypto.createHmac("sha256", secret()).update(payloadStr).digest("hex");
    const a = Buffer.from(mac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b) && Number(payloadStr) > Date.now()) {
      return { role: "teacher" };
    }
    return null;
  }

  // โทเคนรูปแบบใหม่ (JSON base64url)
  const expected = crypto.createHmac("sha256", secret()).update(payloadStr).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8"));
    if (Number(parsed.expiresAt) > Date.now()) {
      return parsed;
    }
  } catch {}
  return null;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((c) => c.trim().split("="))
      .filter(([k, v]) => k && v)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
  );
}

function getUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return verifyToken(token);
}

const TEACHER_ROLES = new Set(["teacher", "admin"]);

// โทเคนเลกาซีไม่มี role มาด้วย ถือว่าเป็นครูตามเดิม (verifyToken เติม role ให้แล้ว)
function isTeacher(req) {
  const user = getUser(req);
  return Boolean(user) && TEACHER_ROLES.has(user.role || "teacher");
}

function setSessionCookie(res, data) {
  const token = signSession(data);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: MAX_AGE_SEC * 1000,
    secure: process.env.COOKIE_SECURE === "true",
  });
}

function login(res, password) {
  const expected = process.env.TEACHER_PASSWORD;
  if (!expected) throw new Error("ยังไม่ได้ตั้งค่า TEACHER_PASSWORD ใน .env");

  // hash ทั้งสองฝั่งก่อนเทียบ ได้ความยาวเท่ากันเสมอ จึงไม่รั่วความยาวรหัสผ่านจริงออกไป
  const a = crypto.createHash("sha256").update(String(password)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return false;

  setSessionCookie(res, { role: "teacher", loginType: "password" });
  return true;
}

function logout(res) {
  res.clearCookie(COOKIE);
}

function requireTeacher(req, res, next) {
  if (!isTeacher(req)) return res.status(401).json({ error: "ต้องเข้าสู่ระบบก่อน" });
  next();
}

module.exports = { isTeacher, getUser, setSessionCookie, signSession, login, logout, requireTeacher };

