const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");

const db = require("./db");
const auth = require("./auth");
const pgdb = require("./pg");
const { upsertGoogleUser } = pgdb;
const {
  fetchAssignmentText,
  parseDriveUrl,
  listFolderFiles,
  downloadFileToDisk,
  extractTextFromBuffer,
  fetchFileText,
  fetchFolderText,
  classifyFileType,
  getFileMetaAuth,
  fetchFileTextAuth,
  downloadFileToDiskAuth,
} = require("./drive");
const { refreshAssignmentSource, sourceHash } = require("./assignmentSource");
const { buildScholarLinks, keywordsFromText } = require("./scholarLinks");
const { fail, processAudio, runAnalysis, generateCoaching } = require("./pipeline");
const googleAuth = require("./googleAuth");
const classroom = require("./classroom");
const classroomImport = require("./classroomImport");
const csvParser = require("./csvParser");
const opencodezen = require("./opencodezen");
const typhoon = require("./typhoon");


const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const AVATAR_DIR = path.join(UPLOAD_DIR, "avatars");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

// เปลี่ยนทุกครั้งที่ container สตาร์ทใหม่ — ใช้ต่อท้าย URL ของ js/css
// กันเบราว์เซอร์ครูค้าง cache ไฟล์เก่าหลัง deploy จนไม่เห็นฟีเจอร์ใหม่
const app = express();
app.set("trust proxy", 1); // อยู่หลัง Caddy ตอน production

// Express 4 ไม่รู้จัก handler ที่เป็น async — ถ้า promise reject จะไม่มีใครจับ
// คำขอค้างจนหมดเวลาแทนที่จะได้ 500 พร้อมข้อความ ตอนย้ายมา PostgreSQL ทุก handler
// กลายเป็น async หมด จึงห่อให้อัตโนมัติทีเดียวตรงนี้ ดีกว่าใส่ try/catch ซ้ำทุกเส้นทาง
for (const method of ["get", "post", "patch", "put", "delete", "use"]) {
  const original = app[method].bind(app);
  app[method] = (...args) =>
    original(
      ...args.map((a) =>
        // ข้าม error middleware (มี 4 พารามิเตอร์) ไม่งั้น Express จะเลิกมองว่าเป็นตัวจับ error
        typeof a === "function" && a.length < 4
          ? function wrapped(req, res, next) {
              try {
                const out = a(req, res, next);
                if (out && typeof out.catch === "function") out.catch(next);
              } catch (err) {
                next(err);
              }
            }
          : a
      )
    );
}
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(require("cookie-parser")());

// index.html และไฟล์ static ต้องไม่ถูก browser cache ค้าง เพื่อให้โหลดโค้ดใหม่ล่าสุดเสมอ
app.get("/", (_req, res) => {
  const buildId = Date.now().toString(36);
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
    .replace(/__BUILD_ID__/g, buildId);
  res.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0").type("html").send(html);
});

app.use((req, res, next) => {
  if (req.path.endsWith(".js") || req.path.endsWith(".css")) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// ไฟล์ที่รับเข้ามาถูกส่งต่อให้ ffmpeg/pdf-parse/mammoth ประมวลผล จึงต้องกรองชนิดตั้งแต่ต้นทาง
const ALLOWED_UPLOAD_EXT = {
  audio: /\.(mp3|m4a|wav|ogg|opus|aac|flac|webm|mp4|mov|mkv|avi|3gp)$/i,
  workFile: /\.(pdf|docx?|txt|md|rtf|odt|pptx?|xlsx?|csv)$/i,
  image: /\.(jpe?g|png|webp|gif)$/i,
};

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_UPLOAD_EXT[file.fieldname];
    if (allowed && !allowed.test(file.originalname || "")) {
      return cb(Object.assign(new Error("ชนิดไฟล์นี้ไม่รองรับ"), { code: "UNSUPPORTED_FILE_TYPE", field: file.fieldname }));
    }
    cb(null, true);
  },
});
const submissionUpload = upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "workFile", maxCount: 1 },
]);

/* ลิงก์ค้นฐานข้อมูลวิชาการถูกเก็บลง coaching ตอนสร้าง คำแนะนำเก่าจึงค้างลิงก์รูปแบบเก่าไว้
   (ThaiJo ย้ายเว็บ ลิงก์เดิมกลายเป็น 404) — สร้างใหม่ทุกครั้งที่ส่งออกจาก topic/keywords
   ที่เก็บไว้ ลิงก์เสียจึงหายไปเองโดยครูไม่ต้องกดขอคำแนะนำใหม่ */
function withFreshLinks(coaching) {
  if (!coaching?.topic) return coaching;
  return { ...coaching, searchLinks: buildScholarLinks(coaching.topic, coaching.keywords || []) };
}

const rowToJson = (r) => ({
  ...r,
  reasons: r.reasons ? JSON.parse(r.reasons) : [],
  flags: r.flags ? JSON.parse(r.flags) : [],
  // ผลไล่ประเด็นของเนื้องาน — แถวที่ตรวจก่อนมีคอลัมน์นี้จะเป็น NULL จึงได้ [] ไป
  coverage: r.coverage ? JSON.parse(r.coverage) : [],
  // null = ยังไม่มีคำแนะนำ (ต่างจาก [] ของสองตัวบน) หน้าเว็บใช้แยกว่า "ยังไม่มา" กับ "ไม่มี"
  coaching: r.coaching ? withFreshLinks(JSON.parse(r.coaching)) : null,
});

// งานเบื้องหลังเริ่มหลังตอบ 202 ไปแล้ว จะโยน error ให้ error middleware ไม่ได้ (headers ส่งไปแล้ว)
// ต้องบันทึกสถานะ error ลง submission แทน ครูจะได้เห็นว่าพังและกดวิเคราะห์ใหม่ได้
function runInBackground(submissionId, task) {
  Promise.resolve()
    .then(task)
    .catch(async (err) => {
      console.error(`background task failed (submission ${submissionId}):`, err);
      try {
        await fail(submissionId, `ประมวลผลไม่สำเร็จ: ${err.message}`);
      } catch (dbErr) {
        console.error("ไม่สามารถบันทึกสถานะ error ได้:", dbErr);
      }
    });
}

// ทุกเส้นทางที่ใช้ :id อ้างถึง primary key ที่เป็นตัวเลข
// SQLite เดิมรับ id เพี้ยน ๆ มาแล้วคืนผลว่าง (กลายเป็น 404) แต่ PostgreSQL จะปฏิเสธทันทีเป็น 500
// ดักตั้งแต่ต้นทางให้ตอบ 404 เหมือนเดิม — id ที่ไม่ใช่ตัวเลขก็คือของที่ไม่มีอยู่จริง
for (const name of ["id", "studentId"]) {
  app.param(name, (req, res, next, value) => {
    if (!/^\d+$/.test(String(value))) return res.status(404).json({ error: "ไม่พบรายการที่ระบุ" });
    next();
  });
}

// จำกัดจำนวนครั้งที่ลองรหัสผ่านต่อ IP — กันไล่เดารหัสผ่านรวมที่ตั้งไว้ใน .env
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function loginRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || "unknown";

  for (const [key, entry] of loginAttempts) {
    if (now - entry.startedAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }

  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { startedAt: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    const waitMin = Math.ceil((LOGIN_WINDOW_MS - (now - entry.startedAt)) / 60000);
    return res.status(429).json({ error: `ลองเข้าสู่ระบบบ่อยเกินไป กรุณารออีก ${waitMin} นาที` });
  }
  next();
}

// ── สุขภาพระบบ ───────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// เผยชื่อผู้ให้บริการ AI, รุ่นโมเดล และข้อความ error ดิบจาก upstream — ต้องล็อกอินก่อน
app.get("/api/health/deps", auth.requireTeacher, async (_req, res) => {
  const [stt, ai, zen] = await Promise.all([
    require("./whisper").checkHealth(),
    typhoon.checkHealth(),
    opencodezen.checkHealth(),
  ]);
  res.json({
    whisper: stt.ok ? "up" : "down",
    sttProvider: stt.provider,
    sttModel: stt.model,
    sttError: stt.error || null,
    typhoon: ai.ok ? "ready" : "down",
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiError: ai.error || null,
    opencodezen: zen.ok ? "ready" : "down",
    zenProvider: zen.provider,
    zenModel: zen.model,
    zenError: zen.error || null,
  });
});

// ── AI ค้นหา & สรุปแบบมนุษย์ (OpenCodeZen DeepSeek V4) ────
app.post("/api/ai/search-summarize", auth.requireTeacher, async (req, res) => {
  const query = (req.body?.query || "").trim();
  const context = (req.body?.context || "").trim();
  if (!query && !context) {
    return res.status(400).json({ error: "กรุณาระบุคำค้นหาหรือข้อความที่ต้องการสรุป" });
  }

  const result = await opencodezen.searchAndSummarize(query || "สรุปเนื้อหาแบบมนุษย์", context);
  res.json({ ok: true, ...result });
});

// ── กรองคำภาษาไทยที่เพี้ยนจากการถอดเสียง (Typhoon) ─────────
app.post("/api/ai/correct-transcript", auth.requireTeacher, async (req, res) => {
  const transcript = (req.body?.transcript || "").trim();
  const sourceText = (req.body?.sourceText || "").trim();
  if (!transcript) {
    return res.status(400).json({ error: "กรุณาระบุข้อความ transcript ที่ต้องการกรองคำเพี้ยน" });
  }

  const result = await typhoon.correctThaiTranscript(transcript, sourceText);
  res.json({ ok: true, ...result });
});


// ── ล็อกอินครู & Google OAuth ───────────────────────────
app.get("/api/me", async (req, res) => {
  const user = auth.getUser(req);
  if (!user) {
    return res.json({
      teacher: false,
      user: null,
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      passwordConfigured: Boolean(process.env.TEACHER_PASSWORD),
    });
  }

  let dbUser = null;
  if (user?.email) {
    dbUser = await pgdb.findUserByEmail(user.email).catch(() => null);
  }

  res.json({
    teacher: true,
    user: {
      dbId: dbUser?.id || user.dbId || null,
      email: dbUser?.email || user.email || "",
      name: dbUser?.full_name || user.name || "คุณครู",
      title: dbUser?.title || "",
      department: dbUser?.department || "",
      picture: dbUser?.picture_url || user.picture || null,
      role: dbUser?.role || "teacher",
    },
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    passwordConfigured: Boolean(process.env.TEACHER_PASSWORD),
  });
});

// อัปเดตโปรไฟล์คุณครู (ชื่อ, ตำแหน่ง, แผนกวิชา)
app.patch("/api/user/profile", auth.requireTeacher, async (req, res) => {
  const userId = await teacherDbId(req);
  if (!userId) return res.status(400).json({ error: "ไม่พบข้อมูลบัญชีผู้ใช้งาน" });

  const fullName = (req.body?.fullName || "").trim();
  const title = (req.body?.title || "").trim();
  const department = (req.body?.department || "").trim();

  if (!fullName) return res.status(400).json({ error: "กรุณาระบุชื่อ-นามสกุล" });

  const updated = await pgdb.updateUserProfile(userId, {
    fullName,
    title,
    department,
  });

  res.json({
    ok: true,
    user: {
      dbId: updated.id,
      email: updated.email,
      name: updated.full_name,
      title: updated.title || "",
      department: updated.department || "",
      picture: updated.picture_url || null,
    },
  });
});

// อัปโหลดรูปโปรไฟล์คุณครู (Avatar)
const avatarMulter = multer({
  dest: AVATAR_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).single("avatar");

app.post("/api/user/avatar", auth.requireTeacher, avatarMulter, async (req, res) => {
  const userId = await teacherDbId(req);
  const cleanup = () => { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); };
  if (!userId) { cleanup(); return res.status(400).json({ error: "ไม่พบข้อมูลบัญชีผู้ใช้งาน" }); }
  if (!req.file) return res.status(400).json({ error: "กรุณาเลือกไฟล์รูปภาพ" });

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(req.file.mimetype)) {
    cleanup();
    return res.status(415).json({ error: "รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WebP หรือ GIF" });
  }

  const previous = await pgdb.findUserById(userId).catch(() => null);
  const avatarUrl = `/api/user/avatar/${req.file.filename}`;
  await pgdb.updateUserProfile(userId, { pictureUrl: avatarUrl });
  removeAvatarFile(previous?.picture_url);

  res.json({ ok: true, pictureUrl: avatarUrl });
});

app.delete("/api/user/avatar", auth.requireTeacher, async (req, res) => {
  const userId = await teacherDbId(req);
  if (!userId) return res.status(400).json({ error: "ไม่พบข้อมูลบัญชีผู้ใช้งาน" });

  const previous = await pgdb.findUserById(userId).catch(() => null);
  await pgdb.query("UPDATE users SET picture_url = NULL, updated_at = NOW() WHERE id = $1", [userId]);
  removeAvatarFile(previous?.picture_url);
  res.json({ ok: true });
});

// รูปเก่าต้องถูกลบทิ้งด้วย ไม่งั้นดิสก์บวมจากรูปที่ไม่มีใครอ้างถึงแล้ว
// เฉพาะไฟล์ที่เราเก็บเองเท่านั้น รูปจาก Google เป็น URL ภายนอก ไม่มีไฟล์ให้ลบ
function removeAvatarFile(pictureUrl) {
  if (!pictureUrl?.startsWith("/api/user/avatar/")) return;
  const name = path.basename(pictureUrl);
  fs.rm(path.join(AVATAR_DIR, name), { force: true }, () => {});
}

// multer ตั้งชื่อไฟล์เป็น hash ล้วน ไม่มีนามสกุล express เลยเดาชนิดไฟล์ไม่ออก
// แล้วส่ง application/octet-stream ออกไป เบราว์เซอร์จึงไม่ยอมวาดเป็นรูป (โปรไฟล์ขึ้นเป็นช่องว่าง)
// อ่าน magic bytes เองแล้วประกาศชนิดให้ชัด ใช้ได้กับไฟล์เก่าที่อัปโหลดไว้ก่อนหน้าด้วย
const IMAGE_SIGNATURES = [
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/gif", test: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
  {
    type: "image/webp",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

function sniffImageType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    return IMAGE_SIGNATURES.find((sig) => sig.test(head))?.type || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

app.get("/api/user/avatar/:filename", (req, res) => {
  const filePath = path.join(AVATAR_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const type = sniffImageType(filePath);
  if (!type) return res.status(404).end(); // ไม่ใช่รูป ก็ไม่ต้องส่งให้เบราว์เซอร์เดาเอง
  res.type(type);
  res.sendFile(filePath);
});

app.get("/api/auth/google/config", (_req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

const callbackUri = (req) => {
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${protocol}://${host}/api/auth/google/callback`;
};

// Google OAuth 2.0 Redirect Flow
// ?mode=classroom = ขอสิทธิ์อ่าน Classroom/Drive เพิ่ม (ใช้ตอนครูกดเชื่อมต่อเท่านั้น)
// ไม่รวมไว้ในการล็อกอินปกติ เพราะคนที่แค่อยากเข้าระบบไม่ควรเจอจอขออนุญาตยาวเหยียด
app.get("/api/auth/google", (req, res) => {
  try {
    res.redirect(
      googleAuth.buildAuthUrl({
        redirectUri: callbackUri(req),
        mode: req.query.mode === "classroom" ? "classroom" : "login",
      })
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("ไม่พบโค้ดสิทธิ์จาก Google");

  // state ป้องกันไม่ให้คนอื่นหลอกให้ครูเปิด callback ที่แนบ code ของบัญชีตัวเองมา
  const state = googleAuth.verifyState(req.query.state);
  if (!state) return res.status(400).send("คำขอไม่ถูกต้องหรือหมดอายุ — กรุณาเริ่มเข้าสู่ระบบใหม่");

  try {
    const tokenData = await googleAuth.exchangeCode({ code, redirectUri: callbackUri(req) });

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) throw new Error("ดึงข้อมูลโปรไฟล์จาก Google ไม่สำเร็จ");
    const profile = await userRes.json();

    // บันทึก/อัปเดตผู้ใช้ลงในฐานข้อมูล PostgreSQL (ตาราง users)
    const dbUser = await upsertGoogleUser({
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      googleId: profile.id || profile.sub,
    });

    // เก็บโทเคนไว้ใช้เรียก Classroom/Drive แทนครูภายหลัง (เฉพาะรอบที่ขอสิทธิ์เพิ่ม)
    if (state.mode === "classroom") {
      if (!dbUser?.id) {
        throw new Error("เชื่อมต่อฐานข้อมูลผู้ใช้ไม่ได้ จึงเก็บสิทธิ์ Google ไม่ได้ — ลองใหม่อีกครั้ง");
      }
      await pgdb.saveGoogleTokens(dbUser.id, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        scope: tokenData.scope,
      });
    }

    auth.setSessionCookie(res, {
      role: "teacher",
      loginType: "google",
      dbId: dbUser?.id || null,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Authenticating...</title></head>
      <body>
        <script>
          if (window.opener) {
            window.opener.location.href = "/";
            window.close();
          } else {
            window.location.href = "/";
          }
        </script>
        <p style="font-family:sans-serif;text-align:center;padding-top:40px">เข้าสู่ระบบสำเร็จ กำลังกลับสู่หน้าหลัก...</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(500).send(`เข้าสู่ระบบด้วย Google ไม่สำเร็จ: ${err.message}`);
  }
});

// Google Identity Services (One-Tap / Credential ID Token)
app.post("/api/auth/google/credential", async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "ไม่มีโทเคน credential" });

  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifyRes.ok) return res.status(401).json({ error: "โทเคน Google ไม่ถูกต้องหรือหมดอายุ" });

    const payload = await verifyRes.json();
    if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: "Client ID ไม่ตรงกัน" });
    }

    // บันทึก/อัปเดตผู้ใช้ลงในฐานข้อมูล PostgreSQL (ตาราง users)
    const dbUser = await upsertGoogleUser({
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      googleId: payload.sub,
    });

    auth.setSessionCookie(res, {
      role: "teacher",
      loginType: "google",
      dbId: dbUser?.id || null,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    });

    res.json({ ok: true, name: payload.name, email: payload.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── สมัครสมาชิก / เข้าสู่ระบบด้วยอีเมล ───────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post("/api/register", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password ?? "";
  const fullName = (req.body?.fullName || "").trim();

  if (!fullName) return res.status(400).json({ error: "กรุณากรอกชื่อ-นามสกุล" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "รูปแบบอีเมลไม่ถูกต้อง" });
  if (password.length < 8) return res.status(400).json({ error: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร" });

  try {
    const existing = await pgdb.findUserByEmail(email);
    if (existing) {
      // ถ้าเคยสมัครผ่าน Google มาก่อน บอกให้ชัดว่าต้องใช้ปุ่ม Google ไม่ใช่ว่าอีเมลนี้ใช้ไม่ได้
      return res.status(409).json({
        error: existing.google_id
          ? "อีเมลนี้เคยเข้าใช้ผ่าน Google แล้ว — กดปุ่ม “เข้าสู่ระบบด้วย Google” ได้เลย"
          : "อีเมลนี้มีบัญชีอยู่แล้ว",
      });
    }

    const user = await pgdb.createUser({ email, password, fullName });
    auth.setSessionCookie(res, {
      role: user.role,
      loginType: "password",
      dbId: user.id,
      email: user.email,
      name: user.full_name,
      picture: user.picture_url,
    });
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ error: "สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่" });
  }
});

app.post("/api/login", loginRateLimit, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password ?? "";

  // ยังไม่ได้กรอกอีเมล = ใช้รหัสผ่านรวมแบบเดิม (เผื่อ .env ตั้ง TEACHER_PASSWORD ไว้)
  if (!email) {
    try {
      if (!auth.login(res, password)) {
        return res.status(401).json({ error: "รหัสผ่านไม่ถูกต้อง" });
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const user = await pgdb.findUserByEmail(email);
    // ข้อความเดียวกันทั้งกรณีไม่มีบัญชีและรหัสผิด กันคนไล่เดาว่าอีเมลไหนมีในระบบ
    const wrong = { error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" };
    if (!user) return res.status(401).json(wrong);

    if (!user.password_hash) {
      return res.status(401).json({
        error: "บัญชีนี้เข้าใช้ผ่าน Google — กดปุ่ม “เข้าสู่ระบบด้วย Google” ได้เลย",
      });
    }
    if (!(await pgdb.verifyPassword(password, user.password_hash))) {
      return res.status(401).json(wrong);
    }

    auth.setSessionCookie(res, {
      role: user.role,
      loginType: "password",
      dbId: user.id,
      email: user.email,
      name: user.full_name,
      picture: user.picture_url,
    });
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่" });
  }
});

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.full_name, picture: u.picture_url, role: u.role,
});

app.post("/api/logout", (_req, res) => {
  auth.logout(res);
  res.json({ ok: true });
});

// ── Google Classroom ─────────────────────────────────────
// ใช้ 428 ไม่ใช่ 401 สำหรับ "ยังไม่ได้เชื่อมต่อ" — ฝั่งหน้าเว็บถือว่า 401 คือเซสชันหมดอายุ
// แล้วเด้งกลับหน้าล็อกอินทันที ครูจะงงว่าทำไมกดนำเข้าแล้วหลุดออกจากระบบ
const NEEDS_CONNECT_STATUS = 428;

function classroomError(res, err) {
  if (err.message === googleAuth.NEEDS_CONNECT || /เชื่อมต่อ Google|สิทธิ์เข้าถึง Google/.test(err.message)) {
    return res.status(NEEDS_CONNECT_STATUS).json({ error: err.message, code: "GOOGLE_REAUTH" });
  }
  return res.status(502).json({ error: err.message });
}

// หา user id ใน Postgres จากเซสชัน — ต้องมีเพราะโทเคนผูกกับแถวผู้ใช้
async function teacherDbId(req) {
  const user = auth.getUser(req);
  if (user?.dbId) return user.dbId;

  // เข้าระบบด้วยรหัสผ่านรวม (TEACHER_PASSWORD) จะไม่มี dbId ในคุกกี้
  if (user?.email) {
    const row = await pgdb.findUserByEmail(user.email).catch(() => null);
    if (row?.id) return row.id;
  }
  return null;
}

// token ของครูสำหรับอ่าน Drive — คืน null ถ้ายังไม่ได้เชื่อมต่อ เพื่อให้ผู้เรียกถอยไปใช้ทางสาธารณะแทน
async function teacherDriveToken(req) {
  try {
    return await googleAuth.getValidAccessToken(await teacherDbId(req));
  } catch {
    return null;
  }
}

app.get("/api/classroom/status", auth.requireTeacher, async (req, res) => {
  try {
    const userId = await teacherDbId(req);
    if (!userId) return res.json({ connected: false, reason: "no_account" });

    const tokens = await pgdb.getGoogleTokens(userId);
    if (!tokens?.refreshToken && !tokens?.accessToken) {
      return res.json({ connected: false, reason: "not_connected" });
    }
    if (!googleAuth.hasClassroomScopes(tokens.scopes)) {
      return res.json({ connected: false, reason: "missing_scopes" });
    }
    res.json({ connected: true, expiresAt: tokens.expiry, scopes: tokens.scopes });
  } catch (err) {
    res.json({ connected: false, reason: "error", error: err.message });
  }
});

app.post("/api/classroom/disconnect", auth.requireTeacher, async (req, res) => {
  const userId = await teacherDbId(req);
  if (userId) await pgdb.clearGoogleTokens(userId).catch(() => {});
  res.json({ ok: true });
});

app.get("/api/classroom/courses", auth.requireTeacher, async (req, res) => {
  try {
    const token = await googleAuth.getValidAccessToken(await teacherDbId(req));
    const courses = await classroom.listCourses(token);

    // บอกด้วยว่าวิชาไหนเคยนำเข้าแล้ว จะได้ไม่ต้องเดา
    const imported = new Map(
      (
        await db.all(
          "SELECT id, classroom_course_id, classroom_synced_at FROM subjects WHERE classroom_course_id IS NOT NULL"
        )
      ).map((r) => [r.classroom_course_id, r])
    );

    res.json(
      courses.map((c) => ({
        id: c.id,
        name: c.name,
        section: c.section || "",
        room: c.room || "",
        alternateLink: c.alternateLink,
        imported: imported.get(c.id)
          ? { subjectId: imported.get(c.id).id, syncedAt: imported.get(c.id).classroom_synced_at }
          : null,
      }))
    );
  } catch (err) {
    classroomError(res, err);
  }
});

app.post("/api/classroom/import", auth.requireTeacher, async (req, res) => {
  const courseId = (req.body?.courseId || "").trim();
  if (!courseId) return res.status(400).json({ error: "ไม่ได้ระบุชั้นเรียนที่จะนำเข้า" });

  try {
    const userId = await teacherDbId(req);
    await googleAuth.getValidAccessToken(userId); // เช็คสิทธิ์ก่อน จะได้ไม่สร้างงานที่ล้มทันที

    const job = classroomImport.startImport({
      userId,
      courseId,
      courseName: req.body?.courseName || "",
      includeSubmissions: req.body?.includeSubmissions !== false,
    });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    classroomError(res, err);
  }
});

app.get("/api/classroom/import/:jobId", auth.requireTeacher, async (req, res) => {
  const job = classroomImport.getJob(req.params.jobId);
  // job id เดาได้ ต้องเทียบเจ้าของก่อน ไม่งั้นครูคนอื่นอ่านความคืบหน้าและชื่อคอร์สของเราได้
  if (!job || job.userId !== (await teacherDbId(req))) {
    return res.status(404).json({ error: "ไม่พบงานนำเข้านี้ (อาจหมดอายุแล้ว)" });
  }

  res.json({
    id: job.id,
    status: job.status,
    phase: job.phase,
    error: job.error,
    counts: job.counts,
    warnings: job.warnings,
    subjectId: job.subjectId,
    courseName: job.courseName,
  });
});

async function getTeacherKeys(req) {
  const user = auth.getUser(req);
  if (!user) return ["default_teacher"];
  const keys = new Set();
  if (user.dbId) keys.add(String(user.dbId));
  if (user.email) keys.add(String(user.email));

  if (user.email) {
    const row = await pgdb.findUserByEmail(user.email).catch(() => null);
    if (row?.id) keys.add(String(row.id));
  }
  if (!keys.size) keys.add("default_teacher");
  return Array.from(keys);
}

// คีย์ที่ใช้ "เขียน" เจ้าของลงแถวใหม่ ต้องเป็นหนึ่งในชุดที่ getTeacherKeys คืนเสมอ
// ไม่งั้นของที่สร้างตอนล็อกอินแบบหนึ่งจะมองไม่เห็นตอนล็อกอินอีกแบบ
function getTeacherKey(req) {
  const user = auth.getUser(req);
  if (!user) return "default_teacher";
  if (user.dbId) return String(user.dbId);
  if (user.email) return String(user.email);
  return "default_teacher";
}

// ── ตรวจสิทธิ์ความเป็นเจ้าของ ────────────────────────────
// ทุกอย่างห้อยอยู่ใต้ subject: subject > lesson > assignment > submission
// เช็คที่ต้นสายที่เดียว เส้นทางลูกจึงไม่ต้องเขียน SQL เช็คเจ้าของซ้ำกันเอง

async function ownedSubject(req, subjectId, columns = "id") {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  return db.get(
    `SELECT ${columns} FROM subjects WHERE id = ? AND user_id IN (${placeholders})`,
    [subjectId, ...keys]
  );
}

async function ownedLesson(req, lessonId) {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  return db.get(
    `SELECT l.id, l.subject_id FROM lessons l
     JOIN subjects sj ON sj.id = l.subject_id
     WHERE l.id = ? AND sj.user_id IN (${placeholders})`,
    [lessonId, ...keys]
  );
}

async function ownedAssignment(req, assignmentId, columns = "a.*") {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  return db.get(
    `SELECT ${columns} FROM assignments a
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects sj ON sj.id = l.subject_id
     WHERE a.id = ? AND sj.user_id IN (${placeholders})`,
    [assignmentId, ...keys]
  );
}

/* เนื้องานล่าสุดสำหรับ submission แถวหนึ่ง — ดึงจาก Drive ซ้ำถ้าของที่เก็บไว้เก่าแล้ว
   row ต้อง select a.id AS assignment_id, a.drive_url, a.source_text, a.source_fetched_at, a.source_hash มาด้วย
   ล้มเหลวแล้วคืนของเดิม เพราะการตรวจงานสำคัญกว่าความสดของเนื้อหา */
async function sourceForSubmission(req, row, opts = {}) {
  const assignment = {
    id: row.assignment_id,
    drive_url: row.drive_url,
    source_text: row.source_text,
    source_fetched_at: row.source_fetched_at,
    source_hash: row.source_hash,
  };
  try {
    const result = await refreshAssignmentSource(assignment, await teacherDriveToken(req), opts);
    if (result.error) console.warn(`รีเฟรชเนื้องาน #${assignment.id} ไม่สำเร็จ:`, result.error);
    return result.sourceText;
  } catch (err) {
    console.warn(`รีเฟรชเนื้องาน #${assignment.id} ไม่สำเร็จ:`, err.message);
    return row.source_text;
  }
}

async function ownedStudent(req, studentId, columns = "*") {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  return db.get(
    `SELECT ${columns} FROM students WHERE id = ? AND user_id IN (${placeholders})`,
    [studentId, ...keys]
  );
}

async function ownedSubmission(req, submissionId, columns = "s.*") {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  return db.get(
    `SELECT ${columns} FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects sj ON sj.id = l.subject_id
     LEFT JOIN students st ON st.id = s.student_id
     WHERE s.id = ? AND sj.user_id IN (${placeholders})`,
    [submissionId, ...keys]
  );
}

// ── รายวิชา ──────────────────────────────────────────────
app.post("/api/subjects", auth.requireTeacher, async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "กรุณาใส่ชื่อรายวิชา" });
  const userKey = getTeacherKey(req);

  const info = await db.run("INSERT INTO subjects (name, user_id) VALUES (?, ?)", [name, userKey]);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

// แก้ได้ทั้งชื่อและหน้าตาห้องเรียน — ส่งมาเฉพาะฟิลด์ที่อยากเปลี่ยนก็ได้
app.patch("/api/subjects/:id", auth.requireTeacher, async (req, res) => {
  const current = await ownedSubject(req, req.params.id, "*");
  if (!current) return res.status(404).json({ error: "ไม่พบรายวิชานี้ หรือไม่มีสิทธิ์แก้ไข" });

  let name = current.name;
  if (req.body?.name !== undefined) {
    name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "กรุณาใส่ชื่อรายวิชา" });
  }

  // รับเฉพาะรหัสสี HEX เท่านั้น เพราะค่านี้ถูกเอาไปใส่ใน style ของหน้าเว็บโดยตรง
  let themeColor = current.theme_color;
  if (req.body?.themeColor !== undefined) {
    const v = String(req.body.themeColor || "").trim();
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) {
      return res.status(400).json({ error: "รหัสสีต้องอยู่ในรูปแบบ #RRGGBB" });
    }
    themeColor = v || null; // ว่าง = กลับไปใช้สีที่ระบบเลือกให้
  }

  await db.run("UPDATE subjects SET name = ?, theme_color = ? WHERE id = ?", [name, themeColor, current.id]);
  res.json({ ok: true, name, themeColor });
});

// ── รูปพื้นหลังห้องเรียน ─────────────────────────────────
const bgUpload = upload.single("image");
const BG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

app.post("/api/subjects/:id/background", auth.requireTeacher, bgUpload, async (req, res) => {
  const cleanup = () => { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); };

  const subject = await ownedSubject(req, req.params.id, "id, bg_image");
  if (!subject) { cleanup(); return res.status(404).json({ error: "ไม่พบห้องเรียนนี้" }); }
  if (!req.file) return res.status(400).json({ error: "ยังไม่ได้เลือกรูป" });

  if (!BG_TYPES.includes(req.file.mimetype)) {
    cleanup();
    return res.status(415).json({ error: "รองรับเฉพาะไฟล์รูป JPG, PNG, WebP หรือ GIF" });
  }

  const old = subject.bg_image;
  await db.run("UPDATE subjects SET bg_image = ?, bg_mime = ? WHERE id = ?", [
    req.file.path,
    req.file.mimetype,
    subject.id,
  ]);
  // ลบรูปเดิมหลังบันทึกรูปใหม่สำเร็จแล้วเท่านั้น กันกรณีเขียนฐานไม่ผ่านแล้วรูปหายทั้งคู่
  if (old && old !== req.file.path) fs.rm(old, { force: true }, () => {});

  res.status(201).json({ ok: true });
});

app.delete("/api/subjects/:id/background", auth.requireTeacher, async (req, res) => {
  const subject = await ownedSubject(req, req.params.id, "id, bg_image");
  if (!subject) return res.status(404).json({ error: "ไม่พบห้องเรียนนี้" });

  await db.run("UPDATE subjects SET bg_image = NULL, bg_mime = NULL WHERE id = ?", [subject.id]);
  if (subject.bg_image) fs.rm(subject.bg_image, { force: true }, () => {});
  res.json({ ok: true });
});

// ส่งไฟล์รูปพื้นหลังออกไป — เก็บนอก public จึงต้องผ่าน endpoint นี้
app.get("/api/subjects/:id/background", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubject(req, req.params.id, "bg_image, bg_mime");
  if (!row?.bg_image || !fs.existsSync(row.bg_image)) return res.status(404).end();
  // ยึด mime ที่ผ่านการตรวจตอนอัปโหลดเท่านั้น ไม่ส่ง Content-Type ที่ client เคยกำหนดมาเองต่อ
  res
    .type(BG_TYPES.includes(row.bg_mime) ? row.bg_mime : "image/jpeg")
    .set("Cache-Control", "private, max-age=60")
    .sendFile(path.resolve(row.bg_image));
});

app.delete("/api/subjects/:id", auth.requireTeacher, async (req, res) => {
  const subject = await ownedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: "ไม่พบรายวิชานี้ หรือไม่มีสิทธิ์ลบ" });

  // ลบทั้งสาย: รายวิชา > บทเรียน > งาน > การส่ง — เก็บกวาดไฟล์เสียงก่อนกันดิสก์เต็ม
  const orphans = await db.all(
    `SELECT s.audio_path FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN lessons l ON l.id = a.lesson_id
     WHERE l.subject_id = ? AND s.audio_path IS NOT NULL`,
    [req.params.id]
  );
  for (const r of orphans) fs.rm(r.audio_path, { force: true }, () => {});

  await db.run("DELETE FROM subjects WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

// ── บทเรียน ──────────────────────────────────────────────
app.post("/api/lessons", auth.requireTeacher, async (req, res) => {
  const title = (req.body?.title || "").trim();
  const subjectId = Number(req.body?.subjectId);
  if (!title) return res.status(400).json({ error: "กรุณาใส่ชื่อบทเรียน" });
  if (!Number.isFinite(subjectId) || !(await ownedSubject(req, subjectId))) {
    return res.status(404).json({ error: "ไม่พบรายวิชาที่ระบุ" });
  }

  const info = await db.run("INSERT INTO lessons (subject_id, title) VALUES (?,?)", [subjectId, title]);
  res.status(201).json({ id: info.lastInsertRowid, title, subjectId });
});

app.patch("/api/lessons/:id", auth.requireTeacher, async (req, res) => {
  const title = (req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "กรุณาใส่ชื่อบทเรียน" });

  const lesson = await ownedLesson(req, req.params.id);
  if (!lesson) return res.status(404).json({ error: "ไม่พบบทเรียนนี้" });

  await db.run("UPDATE lessons SET title = ? WHERE id = ?", [title, lesson.id]);
  res.json({ ok: true });
});

// ลบบทเรียนแล้ว cascade ไปถึงงานและผลตรวจทั้งหมด — ต้องยืนยันเจ้าของก่อนเสมอ
app.delete("/api/lessons/:id", auth.requireTeacher, async (req, res) => {
  const lesson = await ownedLesson(req, req.params.id);
  if (!lesson) return res.status(404).json({ error: "ไม่พบบทเรียนนี้" });

  const orphans = await db.all(
    `SELECT s.audio_path FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     WHERE a.lesson_id = ? AND s.audio_path IS NOT NULL`,
    [req.params.id]
  );
  for (const r of orphans) fs.rm(r.audio_path, { force: true }, () => {});

  await db.run("DELETE FROM lessons WHERE id = ?", [lesson.id]);
  res.json({ ok: true });
});

// โครงสร้างทั้งหมดในครั้งเดียว — แถบข้างต้องใช้ทั้งต้นไม้ ยิงทีละชั้นจะช้าและกระพริบ
app.get("/api/tree", auth.requireTeacher, async (req, res) => {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  const subjects = await db.all(
    `SELECT id, name, theme_color,
            (bg_image IS NOT NULL) AS has_bg,
            (SELECT COUNT(*)::int FROM subject_students ss WHERE ss.subject_id = subjects.id) AS student_count
     FROM subjects WHERE user_id IN (${placeholders}) ORDER BY lower(name)`,
    keys
  );
  const lessons = await db.all(
    `SELECT l.id, l.subject_id, l.title FROM lessons l
     JOIN subjects sj ON sj.id = l.subject_id
     WHERE sj.user_id IN (${placeholders}) ORDER BY l.id`,
    keys
  );
  const assignments = await db.all(
    // drive_url ต้องมาด้วย — หน้างานใช้เปิดดูไฟล์ต้นฉบับ เติมช่องลิงก์ตอนแก้ไข
    // และเติมให้ wizard ตอนเพิ่มงานที่นักเรียนส่ง
    `SELECT a.id, a.lesson_id, a.title, a.drive_url,
            (SELECT COUNT(*)::int FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
     FROM assignments a
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects sj ON sj.id = l.subject_id
     WHERE sj.user_id IN (${placeholders}) ORDER BY a.id`,
    keys
  );

  res.json(
    subjects.map((s) => ({
      ...s,
      lessons: lessons
        .filter((l) => l.subject_id === s.id)
        .map((l) => ({ ...l, assignments: assignments.filter((a) => a.lesson_id === l.id) })),
    }))
  );
});

// ── รายชื่อนักเรียน ──────────────────────────────────────
const fullName = (s) => `${s.first_name} ${s.last_name}`.trim();

// รายชื่อนักเรียน
//   ?subjectId=N            → เฉพาะคนที่อยู่ในห้องเรียนนั้น
//   ?subjectId=N&notIn=1    → คนที่ยังไม่อยู่ในห้องนั้น (ใช้ตอนเลือกเพิ่มเข้าห้อง)
//   ไม่ใส่อะไร               → รายชื่อรวมทั้งหมดของครูคนนี้
app.get("/api/students", auth.requireTeacher, async (req, res) => {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  const q = (req.query?.q || "").trim();
  const subjectId = Number(req.query?.subjectId) || null;
  const department = (req.query?.department || "").trim();
  const classLevel = (req.query?.classLevel || "").trim();
  const room = (req.query?.room || "").trim();
  const status = (req.query?.status || "").trim();
  const notIn = req.query?.notIn === "1";

  const where = [`s.user_id IN (${placeholders})`];
  const params = [...keys];

  if (subjectId) {
    const member = "SELECT 1 FROM subject_students ss WHERE ss.student_id = s.id AND ss.subject_id = ?";
    where.push(notIn ? `NOT EXISTS (${member})` : `EXISTS (${member})`);
    params.push(subjectId);
  }

  if (department) {
    where.push("s.department = ?");
    params.push(department);
  }

  if (classLevel) {
    where.push("s.class_level = ?");
    params.push(classLevel);
  }

  if (room) {
    where.push("s.room = ?");
    params.push(room);
  }

  if (status) {
    where.push("s.status = ?");
    params.push(status);
  }

  // ILIKE = LIKE แบบไม่สนตัวพิมพ์ใหญ่เล็ก
  if (q) {
    where.push(`(s.student_no ILIKE ? OR s.first_name ILIKE ? OR s.last_name ILIKE ?
                 OR (s.first_name || ' ' || s.last_name) ILIKE ? OR s.department ILIKE ?)`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = await db.all(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM subject_students ss WHERE ss.student_id = s.id) AS classroom_count,
            (SELECT COUNT(*)::int FROM submissions sub WHERE sub.student_id = s.id) AS submission_count
     FROM students s
     WHERE ${where.join(" AND ")}
     ORDER BY s.department NULLS LAST, s.class_level NULLS LAST, s.room NULLS LAST,
              CASE WHEN s.roll_no ~ '^[0-9]+$' THEN s.roll_no::int ELSE 99999 END, lower(s.student_no)`,
    params
  );

  res.json(rows.map((s) => ({ ...s, full_name: fullName(s) })));
});

// เอานักเรียนที่มีอยู่แล้วเข้าห้องเรียน — คนเดิมอยู่ได้หลายห้องพร้อมกัน
app.post("/api/subjects/:id/students", auth.requireTeacher, async (req, res) => {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  const subject = await ownedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: "ไม่พบห้องเรียนนี้ หรือไม่มีสิทธิ์แก้ไข" });

  const ids = (Array.isArray(req.body?.studentIds) ? req.body.studentIds : [req.body?.studentId])
    .map(Number)
    .filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ error: "ยังไม่ได้เลือกนักเรียน" });

  let added = 0;
  for (const sid of ids) {
    // ต้องเป็นนักเรียนของครูคนนี้เท่านั้น กันการดึงรายชื่อของครูคนอื่นเข้าห้องตัวเอง
    const owned = await db.get(
      `SELECT id FROM students WHERE id = ? AND user_id IN (${placeholders})`,
      [sid, ...keys]
    );
    if (!owned) continue;

    // อยู่ในห้องอยู่แล้วก็ข้ามไปเงียบ ๆ กดซ้ำไม่ควรเป็น error
    const r = await db.run(
      // ต้องเขียน RETURNING เอง เพราะตารางนี้ไม่มีคอลัมน์ id ให้ db.run เติมให้อัตโนมัติ
      "INSERT INTO subject_students (subject_id, student_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING subject_id",
      [subject.id, sid]
    );
    added += r.changes;
  }

  res.status(201).json({ ok: true, added });
});

// เอาออกจากห้องเรียน — ตัวนักเรียนยังอยู่ในรายชื่อรวมและห้องอื่นตามเดิม
app.delete("/api/subjects/:id/students/:studentId", auth.requireTeacher, async (req, res) => {
  const subject = await ownedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: "ไม่พบห้องเรียนนี้ หรือไม่มีสิทธิ์แก้ไข" });

  const info = await db.run(
    "DELETE FROM subject_students WHERE subject_id = ? AND student_id = ?",
    [subject.id, req.params.studentId]
  );
  if (!info.changes) return res.status(404).json({ error: "นักเรียนคนนี้ไม่ได้อยู่ในห้องนี้" });
  res.json({ ok: true });
});

// PostgreSQL แจ้ง unique violation ด้วยรหัส 23505 (เดิม SQLite ใช้ข้อความ ...CONSTRAINT...)
const isUniqueViolation = (err) => err?.code === "23505";

app.post("/api/students", auth.requireTeacher, async (req, res) => {
  const studentNo = (req.body?.studentNo || "").trim();
  const firstName = (req.body?.firstName || "").trim();
  const lastName = (req.body?.lastName || "").trim();
  const department = (req.body?.department || "").trim() || null;
  const classLevel = (req.body?.classLevel || "").trim() || null;
  const room = (req.body?.room || "").trim() || null;
  const rollNo = (req.body?.rollNo || req.body?.roll_no || "").trim() || null;
  const status = (req.body?.status || "").trim() || "กำลังศึกษา";
  const note = (req.body?.note || "").trim() || null;

  if (!studentNo) return res.status(400).json({ error: "กรุณาใส่รหัสประจำตัวนักเรียน" });
  if (!firstName || !lastName) return res.status(400).json({ error: "กรุณาใส่ชื่อและนามสกุล" });

  const subjectId = Number(req.body?.subjectId) || null;

  try {
    const id = await db.tx(async (t) => {
      const info = await t.run(
        `INSERT INTO students (student_no, first_name, last_name, department, class_level, room, roll_no, status, note, user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [studentNo, firstName, lastName, department, classLevel, room, rollNo, status, note, getTeacherKey(req)]
      );
      if (subjectId) {
        await t.run(
          "INSERT INTO subject_students (subject_id, student_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING subject_id",
          [subjectId, info.lastInsertRowid]
        );
      }
      return info.lastInsertRowid;
    });
    res.status(201).json({ id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: `รหัส ${studentNo} มีอยู่ในรายชื่อแล้ว — ใช้ปุ่ม “เพิ่มจากรายชื่อที่มีอยู่” เพื่อดึงเข้าห้องนี้`,
      });
    }
    throw err;
  }
});

app.patch("/api/students/:id", auth.requireTeacher, async (req, res) => {
  const current = await ownedStudent(req, req.params.id);
  if (!current) return res.status(404).json({ error: "ไม่พบนักเรียนคนนี้" });

  const pick = (key, fallback) => {
    const v = req.body?.[key];
    return v === undefined ? fallback : String(v).trim();
  };
  const studentNo = pick("studentNo", current.student_no);
  const firstName = pick("firstName", current.first_name);
  const lastName = pick("lastName", current.last_name);

  if (!studentNo) return res.status(400).json({ error: "กรุณาใส่รหัสประจำตัวนักเรียน" });
  if (!firstName || !lastName) return res.status(400).json({ error: "กรุณาใส่ชื่อและนามสกุล" });

  try {
    await db.run(
      `UPDATE students
       SET student_no=?, first_name=?, last_name=?, department=?, class_level=?, room=?, roll_no=?, status=?, note=?
       WHERE id=?`,
      [
        studentNo,
        firstName,
        lastName,
        pick("department", current.department) || null,
        pick("classLevel", current.class_level) || null,
        pick("room", current.room) || null,
        pick("rollNo", current.roll_no) || null,
        pick("status", current.status) || "กำลังศึกษา",
        pick("note", current.note) || null,
        current.id,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `รหัส ${studentNo} มีอยู่ในรายชื่อแล้ว` });
    }
    throw err;
  }
});

// ดูรายละเอียดนักเรียนรายบุคคล (ประวัติการส่งงาน + ห้องเรียนที่ลงเรียน)
app.get("/api/students/:id/details", auth.requireTeacher, async (req, res) => {
  const student = await ownedStudent(req, req.params.id);
  if (!student) return res.status(404).json({ error: "ไม่พบนักเรียนคนนี้" });

  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");

  const subjects = await db.all(
    `SELECT sj.id, sj.name, sj.theme_color
     FROM subject_students ss
     JOIN subjects sj ON sj.id = ss.subject_id
     WHERE ss.student_id = ? AND sj.user_id IN (${placeholders})`,
    [student.id, ...keys]
  );

  const submissions = await db.all(
    `SELECT sub.*, a.title AS assignment_title, sj.name AS subject_name
     FROM submissions sub
     JOIN assignments a ON a.id = sub.assignment_id
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects sj ON sj.id = l.subject_id
     WHERE sub.student_id = ? AND sj.user_id IN (${placeholders})
     ORDER BY sub.id DESC`,
    [student.id, ...keys]
  );

  res.json({
    student: { ...student, full_name: fullName(student) },
    subjects,
    submissions: submissions.map(rowToJson),
  });
});

// นำเข้าข้อมูลนักเรียนจากไฟล์ CSV อัจฉริยะ (Universal CSV Import)
const csvMulter = multer({ limits: { fileSize: 20 * 1024 * 1024 } }).single("file");

app.post("/api/students/import-csv", auth.requireTeacher, csvMulter, async (req, res) => {
  const userKey = getTeacherKey(req);
  const requestedSubjectId = Number(req.body?.subjectId) || null;
  // ผูกเข้าห้องได้เฉพาะห้องของครูคนนี้ ไม่งั้นนำเข้าทีเดียวก็ยัดนักเรียนเข้าห้องครูคนอื่นได้
  const subjectId = requestedSubjectId && (await ownedSubject(req, requestedSubjectId))
    ? requestedSubjectId
    : null;
  if (requestedSubjectId && !subjectId) {
    return res.status(404).json({ error: "ไม่พบห้องเรียนที่ระบุ หรือไม่มีสิทธิ์แก้ไข" });
  }
  let items = [];

  // หากเป็นไฟล์ CSV อัปโหลด
  if (req.file) {
    try {
      const buffer = fs.readFileSync(req.file.path);
      fs.rm(req.file.path, { force: true }, () => {});

      // รับค่า custom mapping หากผู้ใช้ปรับดร็อปดาวน์ในหน้าเว็บ
      let customMapping = null;
      if (req.body?.mapping) {
        try { customMapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping; } catch {}
      }

      const parsed = csvParser.parseStudentCSV(buffer);
      const mapping = customMapping || parsed.mapping;
      
      // ถ้ามีการระบุ custom mapping ให้นำเข้าใหม่ด้วย mapping นั้น
      if (customMapping) {
        const text = csvParser.decodeCSVBuffer(buffer);
        const rows = csvParser.parseCSVRows(text);
        let headerIdx = 0;
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
          if (rows[i].length >= 2) { headerIdx = i; break; }
        }
        items = csvParser.mapRowsToStudents(rows, mapping, headerIdx);
      } else {
        items = parsed.students;
      }
    } catch (err) {
      return res.status(400).json({ error: `อ่านไฟล์ CSV ไม่สำเร็จ: ${err.message}` });
    }
  } else if (Array.isArray(req.body?.items)) {
    // ส่งเป็นรายการ JSON มาโดยตรงจากการพรีวิว
    items = req.body.items;
  } else if (req.body?.csvText) {
    // ส่งเป็นข้อความ CSV
    try {
      const parsed = csvParser.parseStudentCSV(req.body.csvText);
      items = parsed.students;
    } catch (err) {
      return res.status(400).json({ error: `วิเคราะห์ CSV ไม่สำเร็จ: ${err.message}` });
    }
  } else {
    return res.status(400).json({ error: "ไม่พบข้อมูล CSV หรือไฟล์สำหรับนำเข้า" });
  }

  if (!items || items.length === 0) {
    return res.status(400).json({ error: "ไม่พบรายการนักเรียนในข้อมูลที่นำเข้า" });
  }

  const importKeys = await getTeacherKeys(req);
  const importPlaceholders = importKeys.map(() => "?").join(",");

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const warnings = [];

  for (const item of items) {
    const studentNo = (item.studentNo || item.student_no || "").trim();
    const firstName = (item.firstName || item.first_name || "").trim();
    const lastName = (item.lastName || item.last_name || "").trim();
    const department = (item.department || "").trim() || null;
    const classLevel = (item.classLevel || item.class_level || "").trim() || null;
    const room = (item.room || "").trim() || null;
    const rollNo = (item.rollNo || item.roll_no || "").trim() || null;
    const status = (item.status || "").trim() || "กำลังศึกษา";
    const note = (item.note || "").trim() || null;

    if (!studentNo || (!firstName && !lastName)) {
      skippedCount++;
      warnings.push(`แถวที่มีรหัส "${studentNo || "ไม่ระบุ"}": ไม่มีข้อมูลชื่อ-นามสกุล`);
      continue;
    }

    try {
      // ตรวจสอบว่ามีนักเรียนรหัสนี้อยู่แล้วหรือไม่ — ต้องหาให้ครบทุกคีย์ของครูคนนี้
      // ไม่งั้นคนที่สร้างไว้ตอนล็อกอินอีกแบบจะถูกสร้างซ้ำแล้วชน unique constraint
      const existing = await db.get(
        `SELECT id FROM students WHERE student_no = ? AND user_id IN (${importPlaceholders})`,
        [studentNo, ...importKeys]
      );

      let targetStudentId = null;

      if (existing) {
        // อัปเดตข้อมูลนักเรียนเดิม
        await db.run(
          `UPDATE students
           SET first_name = ?, last_name = ?,
               department = COALESCE(?, department),
               class_level = COALESCE(?, class_level),
               room = COALESCE(?, room),
               roll_no = COALESCE(?, roll_no),
               status = COALESCE(?, status),
               note = COALESCE(?, note)
           WHERE id = ?`,
          [firstName, lastName, department, classLevel, room, rollNo, status, note, existing.id]
        );
        targetStudentId = existing.id;
        updatedCount++;
      } else {
        // สร้างนักเรียนใหม่
        const info = await db.run(
          `INSERT INTO students (student_no, first_name, last_name, department, class_level, room, roll_no, status, note, user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [studentNo, firstName, lastName, department, classLevel, room, rollNo, status, note, userKey]
        );
        targetStudentId = info.lastInsertRowid;
        createdCount++;
      }

      // หากระบุ subjectId ให้ผูกนักเรียนเข้าห้องเรียนด้วย
      if (subjectId && targetStudentId) {
        await db.run(
          "INSERT INTO subject_students (subject_id, student_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING subject_id",
          [subjectId, targetStudentId]
        );
      }
    } catch (err) {
      skippedCount++;
      warnings.push(`รหัส ${studentNo}: ${err.message}`);
    }
  }

  res.json({
    ok: true,
    total: items.length,
    created: createdCount,
    updated: updatedCount,
    skipped: skippedCount,
    warnings,
    subjectId,
  });
});

// งานที่ส่งไปแล้วไม่หายไปด้วย — student_id เป็น NULL แต่ student_name ที่บันทึกไว้ยังอยู่
app.delete("/api/students/:id", auth.requireTeacher, async (req, res) => {
  const student = await ownedStudent(req, req.params.id, "id");
  if (!student) return res.status(404).json({ error: "ไม่พบนักเรียนคนนี้" });

  await db.run("DELETE FROM students WHERE id = ?", [student.id]);
  res.json({ ok: true });
});

// ── งาน ──────────────────────────────────────────────────
app.post("/api/assignments", auth.requireTeacher, async (req, res) => {
  const title = (req.body?.title || "").trim();
  const driveUrl = (req.body?.driveUrl || "").trim();
  const lessonId = Number(req.body?.lessonId);
  if (!title || !driveUrl) return res.status(400).json({ error: "ต้องใส่ชื่องานและลิงก์ Drive" });
  if (!Number.isFinite(lessonId) || !(await ownedLesson(req, lessonId))) {
    return res.status(404).json({ error: "ไม่พบบทเรียนที่ระบุ — เลือกบทเรียนก่อนเพิ่มงาน" });
  }

  try {
    const sourceText = await fetchAssignmentText(driveUrl, await teacherDriveToken(req));
    if (!sourceText) {
      return res.status(422).json({ error: "ดึงไฟล์ได้ แต่อ่านเนื้อหาไม่เจอ (ไฟล์ว่างหรือเป็นรูปสแกน?)" });
    }

    const info = await db.run(
      `INSERT INTO assignments (title, drive_url, source_text, source_hash, source_fetched_at, lesson_id)
       VALUES (?,?,?,?,NOW(),?)`,
      [title, driveUrl, sourceText, sourceHash(sourceText), lessonId]
    );

    res.status(201).json({
      id: info.lastInsertRowid,
      title,
      lessonId,
      charCount: sourceText.length,
      preview: sourceText.slice(0, 400),
      // ลิงก์ค้นแหล่งอ้างอิงพร้อมใช้ตั้งแต่สร้างงาน ไม่ต้องรอนักเรียนส่งงานก่อน
      searchLinks: buildScholarLinks(title, keywordsFromText(sourceText)),
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.get("/api/assignments", auth.requireTeacher, async (req, res) => {
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  res.json(
    await db.all(
      `SELECT a.id, a.title, a.drive_url, a.created_at, a.lesson_id,
              l.title AS lesson_title, sj.id AS subject_id, sj.name AS subject_name,
              length(a.source_text) AS char_count,
              (SELECT COUNT(*)::int FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
       FROM assignments a
       JOIN lessons l ON l.id = a.lesson_id
       JOIN subjects sj ON sj.id = l.subject_id
       WHERE sj.user_id IN (${placeholders})
       ORDER BY a.id DESC`,
      keys
    )
  );
});

// แก้ชื่องาน และ/หรือ เปลี่ยนลิงก์ Drive — ส่งมาเฉพาะฟิลด์ที่อยากแก้ก็ได้
app.patch("/api/assignments/:id", auth.requireTeacher, async (req, res) => {
  // ต้องดึง drive_url มาด้วย เพื่อเช็คว่าลิงก์เปลี่ยนจริงไหมก่อนจะไปดึงไฟล์ใหม่
  const assignment = await ownedAssignment(req, req.params.id, "a.id, a.drive_url");
  if (!assignment) return res.status(404).json({ error: "ไม่พบงานชิ้นนี้" });

  const hasTitle = typeof req.body?.title === "string";
  const hasUrl = typeof req.body?.driveUrl === "string";
  const title = hasTitle ? req.body.title.trim() : null;
  const driveUrl = hasUrl ? req.body.driveUrl.trim() : null;

  if (!hasTitle && !hasUrl) return res.status(400).json({ error: "ไม่มีข้อมูลที่จะแก้ไข" });
  if (hasTitle && !title) return res.status(400).json({ error: "กรุณาใส่ชื่องาน" });
  if (hasUrl && !driveUrl) return res.status(400).json({ error: "กรุณาใส่ลิงก์ Drive" });

  const fields = [];
  const values = [];
  if (hasTitle) { fields.push("title = ?"); values.push(title); }

  // เปลี่ยนลิงก์ = ต้องดึงเนื้อหาใหม่ ไม่งั้น source_text จะยังเป็นของไฟล์เดิม
  // ดึงให้สำเร็จก่อนค่อยเขียน DB — ถ้าลิงก์เสียจะไม่มีอะไรเปลี่ยน
  if (hasUrl && driveUrl !== assignment.drive_url) {
    try {
      const sourceText = await fetchAssignmentText(driveUrl, await teacherDriveToken(req));
      if (!sourceText) {
        return res.status(422).json({ error: "ดึงไฟล์ได้ แต่อ่านเนื้อหาไม่เจอ (ไฟล์ว่างหรือเป็นรูปสแกน?)" });
      }
      fields.push("drive_url = ?", "source_text = ?", "source_hash = ?", "source_fetched_at = NOW()");
      values.push(driveUrl, sourceText, sourceHash(sourceText));
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
  }

  if (fields.length) {
    values.push(assignment.id);
    await db.run(`UPDATE assignments SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  const row = await db.get(
    "SELECT id, title, drive_url, lesson_id, length(source_text) AS char_count FROM assignments WHERE id = ?",
    [assignment.id]
  );
  res.json({ ok: true, ...row });
});

app.delete("/api/assignments/:id", auth.requireTeacher, async (req, res) => {
  const assignment = await ownedAssignment(req, req.params.id, "a.id");
  if (!assignment) return res.status(404).json({ error: "ไม่พบงานชิ้นนี้" });

  // ลบไฟล์เสียงทิ้งด้วย ไม่งั้นดิสก์ VPS เต็ม
  const orphans = await db.all("SELECT audio_path FROM submissions WHERE assignment_id = ?", [assignment.id]);
  for (const r of orphans) {
    if (r.audio_path) fs.rm(r.audio_path, { force: true }, () => {});
  }
  await db.run("DELETE FROM assignments WHERE id = ?", [assignment.id]);
  res.json({ ok: true });
});

// เนื้อหาที่ระบบดึงมาจาก Drive จริง ๆ — ครูควรเห็นสิ่งที่ AI ใช้ตรวจ ไม่ใช่แค่จำนวนตัวอักษร
// ไฟล์สแกนหรือ PDF ที่แกะข้อความเพี้ยนจะดูออกทันทีตรงนี้
app.get("/api/assignments/:id/source", auth.requireTeacher, async (req, res) => {
  const assignment = await ownedAssignment(
    req,
    req.params.id,
    "a.id, a.title, a.drive_url, a.source_text, a.source_fetched_at"
  );
  if (!assignment) return res.status(404).json({ error: "ไม่พบงานชิ้นนี้" });

  const sourceText = assignment.source_text || "";
  res.json({
    id: assignment.id,
    title: assignment.title,
    driveUrl: assignment.drive_url,
    charCount: sourceText.length,
    sourceText,
    fetchedAt: assignment.source_fetched_at,
    searchLinks: buildScholarLinks(assignment.title, keywordsFromText(sourceText)),
  });
});

// ดึงเนื้อหาจาก Drive ใหม่ทันทีตามคำสั่งครู (ลิงก์เดิม แต่ไฟล์ถูกแก้)
app.post("/api/assignments/:id/refresh", auth.requireTeacher, async (req, res) => {
  const assignment = await ownedAssignment(
    req,
    req.params.id,
    "a.id, a.drive_url, a.source_text, a.source_fetched_at, a.source_hash"
  );
  if (!assignment) return res.status(404).json({ error: "ไม่พบงานชิ้นนี้" });

  const result = await refreshAssignmentSource(assignment, await teacherDriveToken(req), { force: true });
  if (result.error) return res.status(422).json({ error: result.error });

  res.json({
    ok: true,
    changed: result.changed,
    charCount: result.sourceText.length,
    fetchedAt: result.checkedAt,
    preview: result.sourceText.slice(0, 400),
  });
});

// ดึงเนื้อหาและพรีวิวไฟล์ Google Drive ให้แสดงผลในหน้าเว็บ
app.get("/api/drive/preview-file", auth.requireTeacher, async (req, res) => {
  const fileId = (req.query.id || "").trim();
  const rawUrl = (req.query.url || "").trim();

  let targetId = fileId;
  let targetKind = "file";

  if (rawUrl) {
    const parsed = parseDriveUrl(rawUrl);
    if (parsed) {
      targetId = parsed.id;
      targetKind = parsed.kind;
    }
  }

  if (!targetId) {
    return res.status(400).json({ error: "ไม่ได้ระบุ ID หรือ URL ของไฟล์ Google Drive" });
  }

  const accessToken = await teacherDriveToken(req);

  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    let fileName = (req.query.name || "").trim() || "ไฟล์ Google Drive";
    let mimeType = "";

    if (accessToken || apiKey) {
      const meta = accessToken
        ? await getFileMetaAuth(targetId, accessToken).catch(() => null)
        : await fetch(
            `https://www.googleapis.com/drive/v3/files/${targetId}?fields=id,name,mimeType,size&key=${apiKey}`
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);

      if (meta?.name) fileName = meta.name;
      if (meta?.mimeType) {
        mimeType = meta.mimeType;
        if (mimeType === "application/vnd.google-apps.folder") targetKind = "folder";
        else if (mimeType === "application/vnd.google-apps.document") targetKind = "document";
        else if (mimeType === "application/vnd.google-apps.presentation") targetKind = "presentation";
        else if (mimeType === "application/vnd.google-apps.spreadsheet") targetKind = "spreadsheets";
      }
    }

    let text = "";
    try {
      if (targetKind === "folder") {
        text = await fetchFolderText(targetId, accessToken);
      } else if (accessToken) {
        text = await fetchFileTextAuth(targetId, accessToken);
      } else {
        text = await fetchFileText({
          kind: targetKind,
          id: targetId,
          mimeType,
          filename: fileName,
        });
      }
    } catch (e) {
      text = `(ไม่สามารถดึงข้อความจากไฟล์/โฟลเดอร์อัตโนมัติได้: ${e.message})\n\nคุณสามารถกดปุ่ม "เปิดบน Google Drive ↗" ด้านบนเพื่อดูไฟล์ต้นฉบับได้โดยตรง`;
    }

    const driveUrl =
      targetKind === "folder"
        ? `https://drive.google.com/drive/folders/${targetId}`
        : `https://drive.google.com/file/d/${targetId}/view`;

    const embedUrl =
      targetKind === "folder"
        ? `https://drive.google.com/embeddedfolderview?id=${targetId}#list`
        : `https://drive.google.com/file/d/${targetId}/preview`;

    res.json({
      ok: true,
      id: targetId,
      name: fileName,
      kind: targetKind,
      mimeType,
      text: text || "(ไฟล์ว่างหรือไม่มีเนื้อหาข้อความ)",
      charCount: text ? text.length : 0,
      driveUrl,
      embedUrl,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ครูวางลิงก์โฟลเดอร์หรือลิงก์ไฟล์ Drive ระบบดึงรายชื่อไฟล์มาแสดงผล
app.get("/api/drive/folder-files", auth.requireTeacher, async (req, res) => {
  const parsed = parseDriveUrl((req.query.url || "").trim());
  if (!parsed) {
    return res.status(400).json({ error: "ต้องเป็นลิงก์ Google Drive (drive.google.com/...)" });
  }

  const accessToken = await teacherDriveToken(req);

  try {
    if (parsed.kind === "folder") {
      const files = await listFolderFiles(parsed.id, accessToken);
      if (!files.length) {
        return res.status(422).json({
          error: accessToken
            ? "ไม่พบไฟล์ในโฟลเดอร์นี้ หรือบัญชี Google ที่เชื่อมต่อไว้ไม่มีสิทธิ์เข้าถึงโฟลเดอร์นี้"
            : 'ไม่พบไฟล์ในโฟลเดอร์นี้ — กดปุ่ม "เชื่อมต่อ Google Classroom" เพื่อให้ระบบอ่านโฟลเดอร์ด้วยบัญชีของคุณ หรือเปิดแชร์โฟลเดอร์เป็น "Anyone with the link"',
        });
      }
      return res.json(files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, category: f.category })));
    }

    if (accessToken) {
      const meta = await getFileMetaAuth(parsed.id, accessToken);
      return res.json([
        { id: meta.id, name: meta.name, mimeType: meta.mimeType, category: classifyFileType(meta) },
      ]);
    }

    return res.json([{ id: parsed.id, name: "ไฟล์ Google Drive", mimeType: "", category: "gdoc" }]);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ── ส่งงานแทนนักเรียน (ครูอัปโหลดเอง — จากเครื่อง หรือเลือกจากลิงก์ Drive) ──
app.post("/api/assignments/:id/submissions", auth.requireTeacher, submissionUpload, async (req, res) => {
  const assignment = await ownedAssignment(req, req.params.id);
  if (!assignment) return res.status(404).json({ error: "ไม่พบงานชิ้นนี้" });

  // เลือกจากรายชื่อได้ (ผูก student_id) หรือพิมพ์ชื่ออิสระก็ยังส่งได้เหมือนเดิม
  // นักเรียนต้องเป็นของครูคนนี้ ไม่งั้นงานจะไปผูกกับแถวนักเรียนของครูคนอื่น
  const studentId = Number(req.body?.studentId) || null;
  const studentKeys = await getTeacherKeys(req);
  const student = studentId
    ? await db.get(
        `SELECT * FROM students WHERE id = ? AND user_id IN (${studentKeys.map(() => "?").join(",")})`,
        [studentId, ...studentKeys]
      )
    : null;

  const studentName = student ? fullName(student) : (req.body?.studentName || "").trim();
  const textAnswer = (req.body?.textAnswer || "").trim();
  const driveFileId = (req.body?.driveFileId || "").trim();
  // รับได้ทั้ง id ตรง ๆ และลิงก์ Drive ที่ครูก๊อปมาวาง — แกะ id ให้เองเหมือนช่องลิงก์ตอนสร้างงาน
  const workDriveUrl = (req.body?.workDriveUrl || "").trim();
  const workDriveFileId =
    (req.body?.workDriveFileId || "").trim() ||
    (() => {
      if (!workDriveUrl) return "";
      const parsed = parseDriveUrl(workDriveUrl);
      // โฟลเดอร์ไม่ใช่ชิ้นงานของนักเรียนคนเดียว ปฏิเสธไปเลยดีกว่าดึงมามั่ว
      return parsed?.kind === "file" ? parsed.id : "";
    })();
  if (workDriveUrl && !workDriveFileId) {
    return res.status(400).json({ error: "ลิงก์ต้องเป็นไฟล์เดี่ยวใน Google Drive (ไม่ใช่โฟลเดอร์)" });
  }

  const audioFile = req.files?.audio?.[0];
  const workFile = req.files?.workFile?.[0];

  if (!studentName) return res.status(400).json({ error: "กรุณากรอกชื่อนักเรียน" });
  if (!audioFile && !textAnswer && !driveFileId) {
    return res.status(400).json({ error: "ต้องมีไฟล์เสียง ไฟล์จาก Drive หรือข้อความคำอธิบายอย่างใดอย่างหนึ่ง" });
  }

  const driveToken = (driveFileId || workDriveFileId) ? await teacherDriveToken(req) : null;

  // ดึงเนื้องานของนักเรียนรายบุคคล (ถ้ามีการแนบไฟล์งานมาด้วย)
  let studentWorkText = "";
  if (workFile) {
    try {
      const buf = fs.readFileSync(workFile.path);
      const extracted = await extractTextFromBuffer(buf, workFile.originalname, workFile.mimetype);
      if (extracted) studentWorkText = extracted;
    } catch (err) {
      console.error("Error reading student work file:", err);
    } finally {
      fs.rm(workFile.path, { force: true }, () => {});
    }
  } else if (workDriveFileId) {
    try {
      const fetched = driveToken
        ? await fetchFileTextAuth(workDriveFileId, driveToken)
        : await fetchFileText({ kind: "file", id: workDriveFileId });
      if (fetched) studentWorkText = fetched;
    } catch (err) {
      console.error("Error fetching work file from drive:", err);
    }
  }

  // เนื้องานของคลาสอาจถูกครูแก้ใน Drive หลังสร้างงาน — ดึงซ้ำถ้าของที่เก็บไว้เก่าแล้ว
  // ล้มเหลวได้ (Drive ล่ม/สิทธิ์หมดอายุ) แล้วใช้ของเดิมต่อ การตรวจงานต้องไม่หยุดเพราะเรื่องนี้
  const classSource = await refreshAssignmentSource(assignment, driveToken || (await teacherDriveToken(req)))
    .then((r) => {
      if (r.error) console.warn(`รีเฟรชเนื้องาน #${assignment.id} ไม่สำเร็จ:`, r.error);
      return r.sourceText;
    })
    .catch(() => assignment.source_text);

  const targetSourceText = studentWorkText
    ? `=== เนื้องานเฉพาะของนักเรียน (${studentName}) ===\n${studentWorkText}\n\n=== โจทย์/เนื้องานรวมของคลาส ===\n${classSource}`
    : classSource;

  // เลือกไฟล์จากรายการ Drive — server ดึงมาเก็บเองโดยตรง ไม่ต้องผ่านเบราว์เซอร์ครู
  if (driveFileId) {
    let audioPath;
    try {
      audioPath = driveToken
        ? await downloadFileToDiskAuth(driveFileId, driveToken, UPLOAD_DIR)
        : await downloadFileToDisk(driveFileId, UPLOAD_DIR);
    } catch (err) {
      return res.status(422).json({ error: `ดึงไฟล์จาก Drive ไม่สำเร็จ: ${err.message}` });
    }
    const info = await db.run(
      "INSERT INTO submissions (assignment_id, student_id, student_name, audio_path, status, input_mode) VALUES (?,?,?,?,'transcribing','voice')",
      [assignment.id, student?.id ?? null, studentName, audioPath]
    );
    res.status(202).json({ id: info.lastInsertRowid });
    return runInBackground(info.lastInsertRowid, () => processAudio(info.lastInsertRowid, targetSourceText, audioPath));
  }

  // พิมพ์ตอบ: ข้ามขั้นตอนถอดเสียงไปวิเคราะห์เลย
  if (!audioFile) {
    const info = await db.run(
      "INSERT INTO submissions (assignment_id, student_id, student_name, transcript, status, input_mode) VALUES (?,?,?,?,'analyzing','text')",
      [assignment.id, student?.id ?? null, studentName, textAnswer]
    );
    res.status(202).json({ id: info.lastInsertRowid });
    return runInBackground(info.lastInsertRowid, () => runAnalysis(info.lastInsertRowid, targetSourceText, textAnswer));
  }

  // อัปโหลดไฟล์จากเครื่อง (ลาก-วางในเบราว์เซอร์)
  const info = await db.run(
    "INSERT INTO submissions (assignment_id, student_id, student_name, audio_path, status, input_mode) VALUES (?,?,?,?,'transcribing','voice')",
    [assignment.id, student?.id ?? null, studentName, audioFile.path]
  );

  res.status(202).json({ id: info.lastInsertRowid });
  runInBackground(info.lastInsertRowid, () => processAudio(info.lastInsertRowid, targetSourceText, audioFile.path));
});

// ── ผลลัพธ์ ──────────────────────────────────────────────
// ดึงข้อมูลนักเรียนจากรายชื่อมาด้วย เพื่อให้ฝั่งหน้าเว็บจัดกลุ่ม/กรองตามรหัสและชั้นเรียนได้
const SUBMISSION_SELECT = `
  SELECT s.*, st.student_no, st.class_level, st.room,
         st.first_name AS student_first_name, st.last_name AS student_last_name
  FROM submissions s
  LEFT JOIN students st ON st.id = s.student_id
  JOIN assignments a ON a.id = s.assignment_id
  JOIN lessons l ON l.id = a.lesson_id
  JOIN subjects sj ON sj.id = l.subject_id`;

app.get("/api/submissions", auth.requireTeacher, async (req, res) => {
  const { assignmentId, studentId } = req.query;

  // ค่าที่ไม่ใช่ตัวเลขจะทำให้ PostgreSQL โยน invalid input syntax กลายเป็น 500 แทนที่จะเป็น 400
  for (const [name, value] of [["assignmentId", assignmentId], ["studentId", studentId]]) {
    if (value != null && value !== "" && !/^\d+$/.test(String(value))) {
      return res.status(400).json({ error: `${name} ต้องเป็นตัวเลข` });
    }
  }

  // ผลตรวจมีทั้งเสียงและ transcript ของนักเรียน ต้องจำกัดให้เห็นเฉพาะห้องเรียนของตัวเอง
  const keys = await getTeacherKeys(req);
  const placeholders = keys.map(() => "?").join(",");
  const where = [`sj.user_id IN (${placeholders})`];
  const params = [...keys];
  if (assignmentId) { where.push("s.assignment_id = ?"); params.push(Number(assignmentId)); }
  if (studentId) { where.push("s.student_id = ?"); params.push(Number(studentId)); }

  const rows = await db.all(
    `${SUBMISSION_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.id DESC`,
    params
  );
  res.json(rows.map(rowToJson));
});

app.get("/api/submissions/:id", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(
    req,
    req.params.id,
    `s.*, st.student_no, st.class_level, st.room,
     st.first_name AS student_first_name, st.last_name AS student_last_name`
  );
  if (!row) return res.status(404).json({ error: "ไม่พบ" });
  res.json(rowToJson(row));
});

// ฟังเสียงจริงได้ — ครูควรตัดสินจากเสียงเอง ไม่ใช่เชื่อ AI อย่างเดียว
app.get("/api/submissions/:id/audio", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(req, req.params.id, "s.audio_path");
  if (!row?.audio_path || !fs.existsSync(row.audio_path)) {
    return res.status(404).json({ error: "ไม่มีไฟล์เสียง" });
  }
  res.sendFile(path.resolve(row.audio_path));
});

// Typhoon ล่ม/rate limit ได้ตลอด — ครูสั่งวิเคราะห์ใหม่ได้เองโดยไม่ต้องอัปโหลดซ้ำ
app.post("/api/submissions/:id/reanalyze", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(
    req,
    req.params.id,
    `s.id, s.transcript, s.audio_path, a.source_text,
     a.id AS assignment_id, a.drive_url, a.source_fetched_at, a.source_hash`
  );
  if (!row) return res.status(404).json({ error: "ไม่พบ" });

  // ครูมักกดวิเคราะห์ใหม่หลังไปแก้โจทย์ใน Drive — ดึงเนื้อหาล่าสุดมาก่อนเสมอ
  const sourceText = await sourceForSubmission(req, row, { force: true });

  // ถอดเสียงสำเร็จแล้วก็วิเคราะห์ซ้ำได้เลย ไม่ต้องถอดใหม่ให้เปลืองเวลา
  if (row.transcript) {
    await db.run("UPDATE submissions SET status='analyzing', error_message=NULL WHERE id=?", [row.id]);
    runInBackground(row.id, () => runAnalysis(row.id, sourceText, row.transcript));
    return res.json({ ok: true, from: "transcript" });
  }

  if (!row.audio_path || !fs.existsSync(row.audio_path)) {
    return res.status(422).json({ error: "ไม่มีทั้งข้อความและไฟล์เสียง วิเคราะห์ใหม่ไม่ได้" });
  }

  await db.run("UPDATE submissions SET status='transcribing', error_message=NULL WHERE id=?", [row.id]);
  runInBackground(row.id, () => processAudio(row.id, sourceText, row.audio_path));
  res.json({ ok: true, from: "audio" });
});

// ── คำแนะนำเชิงสอน ───────────────────────────────────────
// เคสเหลือง/แดงระบบเขียนให้เองหลังตรวจเสร็จ (ดู pipeline.runAnalysis)
// เส้นทางนี้ไว้ให้ครูกดขอเองสำหรับเคสเขียว และกดใหม่เมื่อครั้งก่อนพัง
app.post("/api/submissions/:id/coaching", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(
    req,
    req.params.id,
    `s.id, s.status, s.transcript, s.content_match, s.specificity, s.reasoning,
     s.ownership, s.own_words, a.source_text,
     a.id AS assignment_id, a.drive_url, a.source_fetched_at, a.source_hash`
  );
  if (!row) return res.status(404).json({ error: "ไม่พบ" });
  if (row.status !== "done") return res.status(422).json({ error: "ต้องตรวจให้เสร็จก่อนจึงจะขอคำแนะนำได้" });
  if (!row.transcript) return res.status(422).json({ error: "ไม่มีคำอธิบายของนักเรียนให้เขียนคำแนะนำ" });

  // คำแนะนำอ้างอิงเนื้องาน จึงต้องใช้ฉบับล่าสุดใน Drive ไม่ใช่ฉบับตอนสร้างงาน
  const sourceText = await sourceForSubmission(req, row);

  // ล้างของเก่าก่อน หน้าเว็บจะได้เห็นสถานะ "กำลังเขียน" แทนคำแนะนำรอบที่แล้ว
  await db.run("UPDATE submissions SET coaching = NULL, coaching_error = NULL WHERE id = ?", [row.id]);

  runInBackground(row.id, () =>
    generateCoaching(row.id, sourceText, row.transcript, {
      contentMatch: row.content_match,
      specificity: row.specificity,
      reasoning: row.reasoning,
      ownership: row.ownership,
      ownWords: row.own_words,
    })
  );
  res.json({ ok: true });
});

// ── ลิงก์ให้นักเรียนเปิดอ่านคำแนะนำเอง ────────────────────
// ระบบยังไม่มีล็อกอินนักเรียน จึงใช้โทเคนสุ่มยาวแทน (192 บิต เดาไม่ได้ในทางปฏิบัติ)
// ครูเป็นคนกดสร้างเอง ไม่สร้างอัตโนมัติ — จะได้ไม่มีลิงก์ที่เปิดอ่าน transcript ได้
// ลอยอยู่โดยที่ไม่มีใครตั้งใจสร้าง และยกเลิกได้ตลอดเวลา
app.post("/api/submissions/:id/share", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(req, req.params.id, "s.id, s.share_token");
  if (!row) return res.status(404).json({ error: "ไม่พบ" });

  let token = row.share_token;
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    await db.run("UPDATE submissions SET share_token = ? WHERE id = ?", [token, row.id]);
  }
  res.json({ ok: true, token, path: `/f/${token}` });
});

app.delete("/api/submissions/:id/share", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(req, req.params.id, "s.id");
  if (!row) return res.status(404).json({ error: "ไม่พบ" });
  await db.run("UPDATE submissions SET share_token = NULL WHERE id = ?", [row.id]);
  res.json({ ok: true });
});

// หน้าที่นักเรียนเปิด — ไม่ผ่าน requireTeacher โดยตั้งใจ
app.get("/f/:token", (_req, res) => {
  const buildId = Date.now().toString(36);
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, "feedback.html"), "utf8")
    .replace(/__BUILD_ID__/g, buildId);
  res
    .set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
    // ลิงก์มีคำอธิบายของนักเรียนอยู่ข้างใน ไม่ควรถูกเสิร์ชเอนจินเก็บไปทำดัชนี
    .set("X-Robots-Tag", "noindex, nofollow")
    .type("html")
    .send(html);
});

// ⚠ คืนเฉพาะสิ่งที่นักเรียนควรเห็น — ห้ามเพิ่ม trust_score / trust_level / flags / เสียง เข้ามาที่นี่
// flags คือข้อสงสัยเรื่องการลอกที่เขียนไว้ให้ "ครู" อ่านและเอาไปคุยกับนักเรียนเอง
// การส่งข้อความอย่าง "ไม่มีร่องรอยว่าทำเอง" ไปโผล่หน้าเด็กผ่านลิงก์โดยไม่มีครูอยู่ตรงนั้น
// คือการกล่าวหาที่ไม่มีบทสนทนารองรับ และตรงข้ามกับหลักที่ระบบนี้ใช้เขียนคำแนะนำ
// (ฟีดแบ็กต้องพูดถึงงานและก้าวต่อไป ไม่ใช่ตัวผู้เรียน — Hattie & Timperley, 2007)
// ส่วนคะแนนเป็นเรื่องที่ครูจะบอกเองในห้อง
app.get("/api/feedback/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return res.status(404).json({ error: "ลิงก์ไม่ถูกต้อง" });

  const row = await db.get(
    `SELECT s.transcript, s.coaching, s.student_name, a.title AS assignment_title
     FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     WHERE s.share_token = ?`,
    [token]
  );
  if (!row) return res.status(404).json({ error: "ลิงก์นี้ถูกยกเลิกแล้ว หรือไม่มีอยู่" });
  if (!row.coaching) return res.status(404).json({ error: "ยังไม่มีคำแนะนำสำหรับงานชิ้นนี้" });

  res.set("Cache-Control", "no-store").json({
    studentName: row.student_name,
    assignmentTitle: row.assignment_title,
    transcript: row.transcript,
    coaching: withFreshLinks(JSON.parse(row.coaching)),
  });
});

// ครู override คะแนนได้เสมอ — AI ไม่ตัดสินขาด
app.patch("/api/submissions/:id", auth.requireTeacher, async (req, res) => {
  const { teacherScore, teacherNote } = req.body || {};
  const score = teacherScore === "" || teacherScore == null ? null : Number(teacherScore);
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    return res.status(400).json({ error: "คะแนนต้องอยู่ระหว่าง 0-100" });
  }

  const owned = await ownedSubmission(req, req.params.id, "s.id");
  if (!owned) return res.status(404).json({ error: "ไม่พบ" });

  await db.run(
    "UPDATE submissions SET teacher_score = ?, teacher_note = ? WHERE id = ?",
    [score, teacherNote || null, owned.id]
  );
  res.json({ ok: true });
});

app.delete("/api/submissions/:id", auth.requireTeacher, async (req, res) => {
  const row = await ownedSubmission(req, req.params.id, "s.id, s.audio_path");
  if (!row) return res.status(404).json({ error: "ไม่พบ" });
  if (row.audio_path) fs.rm(row.audio_path, { force: true }, () => {});
  await db.run("DELETE FROM submissions WHERE id = ?", [row.id]);
  res.json({ ok: true });
});

// ตอบ error เป็น JSON เสมอ ให้หน้าเว็บอ่านข้อความไปแสดงได้
const FILE_LIMIT_TEXT = {
  audio: "ไฟล์เสียงใหญ่เกิน 100MB",
  workFile: "ไฟล์งานใหญ่เกิน 100MB",
  avatar: "รูปโปรไฟล์ใหญ่เกิน 10MB",
  image: "รูปพื้นหลังใหญ่เกิน 100MB",
  file: "ไฟล์ CSV ใหญ่เกิน 20MB",
};

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: FILE_LIMIT_TEXT[err.field] || "ไฟล์ที่อัปโหลดมีขนาดใหญ่เกินกำหนด" });
  }
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    return res.status(415).json({ error: err.message });
  }
  // body ที่ client ส่งมาพัง เป็นความผิดฝั่ง client ไม่ใช่ 500
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง" });
  }
  console.error(err);
  res.status(500).json({ error: "เกิดข้อผิดพลาดในระบบ" });
});

// Node 20 ปิดโปรเซสทิ้งเมื่อเจอ unhandled rejection — งานเบื้องหลังพลาดครั้งเดียวจะลาก container ตายทั้งตัว
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// เตรียมฐานข้อมูลให้เสร็จก่อนเปิดรับคำขอ — ไม่งั้นคำขอแรก ๆ จะเจอตารางที่ยังไม่มี
(async () => {
  try {
    await db.init();
    await pgdb.ensureGoogleTokenColumns();
    console.log("db: เชื่อมต่อ PostgreSQL และเตรียมตารางเรียบร้อย");
  } catch (err) {
    console.error("db: เตรียมฐานข้อมูลไม่สำเร็จ —", err.message);
    process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`eduai listening on http://0.0.0.0:${PORT}`));
})();
