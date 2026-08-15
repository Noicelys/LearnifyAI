// จัดการ OAuth token ของ Google สำหรับเรียก Classroom/Drive แทนครู
//
// แยกจาก auth.js เพราะคนละเรื่องกัน:
//   auth.js      = เซสชันของแอปเรา (ครูล็อกอินอยู่ไหม)
//   googleAuth.js = สิทธิ์ที่ครูมอบให้เราไปคุยกับ Google แทน
//
// ครูเชื่อมต่อครั้งเดียว เราเก็บ refresh token ไว้ แล้วต่ออายุ access token เองเรื่อยๆ
// จะได้ไม่ต้องกดอนุญาตใหม่ทุกครั้งที่จะโคลนงาน

const crypto = require("node:crypto");
const pgdb = require("./pg");
const { SCOPES } = require("./classroom");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const LOGIN_SCOPES = ["openid", "email", "profile"];

// state ป้องกัน CSRF — เซ็นด้วย SESSION_SECRET แล้วแนบไปกับ redirect
// ถ้ามีคนหลอกให้ครูเปิด callback ปลอม state จะไม่ผ่านการตรวจ
// ห้าม fallback เป็นค่าว่างเด็ดขาด เพราะ state จะยัง verify ผ่านทั้งที่ไม่มีคีย์จริง = ปิดการป้องกันแบบเงียบ ๆ
function stateSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("ยังไม่ได้ตั้งค่า SESSION_SECRET");
  return s;
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString("base64url");
  const mac = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  if (!state) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;

  const expected = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (Date.now() - Number(parsed.t) > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

// mode "login"     = เข้าสู่ระบบอย่างเดียว ขอแค่ข้อมูลโปรไฟล์
// mode "classroom" = ขอสิทธิ์อ่าน Classroom/Drive เพิ่ม (ขอตอนครูกดเชื่อมต่อเท่านั้น
//                    ไม่ยัดใส่หน้าล็อกอิน เพราะจะทำให้คนที่แค่อยากเข้าระบบเจอจอขออนุญาตยาวเหยียด)
function buildAuthUrl({ redirectUri, mode = "login", extraState = {} }) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID ใน .env");

  const wantsClassroom = mode === "classroom";
  const scopes = wantsClassroom ? [...LOGIN_SCOPES, ...SCOPES] : LOGIN_SCOPES;

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", signState({ mode, ...extraState }));

  if (wantsClassroom) {
    // ต้องมีทั้งคู่ถึงจะได้ refresh token:
    // offline = ขอสิทธิ์ใช้ตอนครูไม่ได้เปิดเว็บอยู่, consent = บังคับให้จอขออนุญาตขึ้นอีกครั้ง
    // (Google ส่ง refresh token ให้เฉพาะตอนผู้ใช้กดอนุญาตจริงๆ เท่านั้น)
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("prompt", "select_account");
  }

  return url.toString();
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`แลกโทเคนกับ Google ไม่สำเร็จ: ${detail}`);
  }
  return data;
}

const exchangeCode = ({ code, redirectUri }) =>
  postToken({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

const refreshAccessToken = (refreshToken) =>
  postToken({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

// ข้อความ error นี้ถูกใช้เป็นสัญญาณให้ฝั่งหน้าเว็บชวนครูกดเชื่อมต่อใหม่
const NEEDS_CONNECT = "ยังไม่ได้เชื่อมต่อ Google Classroom — กดปุ่ม “เชื่อมต่อ Google Classroom” ก่อน";

// คืน access token ที่ใช้ได้แน่ๆ ต่ออายุให้อัตโนมัติถ้าใกล้หมด
async function getValidAccessToken(userId) {
  if (!userId) throw new Error(NEEDS_CONNECT);

  const tokens = await pgdb.getGoogleTokens(userId);
  if (!tokens?.refreshToken && !tokens?.accessToken) throw new Error(NEEDS_CONNECT);

  if (tokens.stillValid && tokens.accessToken) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new Error("สิทธิ์เข้าถึง Google หมดอายุ — กรุณากดเชื่อมต่อ Google Classroom ใหม่อีกครั้ง");
  }

  let fresh;
  try {
    fresh = await refreshAccessToken(tokens.refreshToken);
  } catch (err) {
    // ครูถอนสิทธิ์ในบัญชี Google หรือ refresh token ถูกเพิกถอน — ล้างทิ้งแล้วให้เชื่อมใหม่
    await pgdb.clearGoogleTokens(userId).catch(() => {});
    throw new Error(`สิทธิ์เข้าถึง Google ใช้ไม่ได้แล้ว — กรุณาเชื่อมต่อใหม่ (${err.message})`);
  }

  await pgdb.saveGoogleTokens(userId, {
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token || null, // รอบต่ออายุมักไม่ส่งกลับมา
    expiresIn: fresh.expires_in,
    scope: fresh.scope,
  });

  return fresh.access_token;
}

// ครูเคยกดอนุญาตครบทุก scope ที่ Classroom ต้องใช้หรือยัง
function hasClassroomScopes(scopeString = "") {
  const granted = new Set(String(scopeString).split(/\s+/).filter(Boolean));
  return SCOPES.every((s) => {
    if (granted.has(s)) return true;
    const broader = s.replace(/\.readonly$/, "");
    return granted.has(broader);
  });
}

module.exports = {
  LOGIN_SCOPES,
  NEEDS_CONNECT,
  buildAuthUrl,
  signState,
  verifyState,
  exchangeCode,
  refreshAccessToken,
  getValidAccessToken,
  hasClassroomScopes,
};
