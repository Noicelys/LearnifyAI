// เรียก Google Classroom API v1 ด้วย access token ของครูที่ล็อกอินอยู่
//
// ต่างจาก drive.js ตรงที่ตัวนี้ต้องใช้ OAuth เสมอ — ข้อมูลชั้นเรียนและงานที่นักเรียนส่ง
// เป็นข้อมูลส่วนตัว ไม่มีทางเข้าถึงด้วย API key แบบไฟล์ public ได้
//
// scope ที่ต้องได้รับอนุญาตก่อนเรียก:
//   classroom.courses.readonly                     — รายชื่อวิชา
//   classroom.coursework.students.readonly         — งานที่สั่ง
//   classroom.rosters.readonly                     — รายชื่อนักเรียน
//   classroom.student-submissions.students.readonly— งานที่นักเรียนส่ง

const BASE = "https://classroom.googleapis.com/v1";

const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  // แยกจาก courses.readonly — ถ้าไม่ขอตัวนี้ courses.topics.list จะ 403
  // แล้วงานทุกชิ้นจะตกไปอยู่ถังรวม "งานที่ไม่ได้จัดหัวข้อ" ทั้งหมด
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly",
  // ต้องใช้โหลดไฟล์แนบของนักเรียน — ไฟล์พวกนี้แชร์เฉพาะครูกับเจ้าของ ไม่ใช่ public
  // (ไม่ขอ classroom.profile.emails/photos — ใช้แค่ชื่อ ไม่ต้องเก็บอีเมลเด็ก)
  "https://www.googleapis.com/auth/drive.readonly",
];

function describeError(status, body) {
  const reason = body?.error?.status || "";
  const detail = body?.error?.message || `HTTP ${status}`;

  if (status === 401) {
    return "สิทธิ์เข้าถึง Google หมดอายุ — กรุณาเชื่อมต่อ Google Classroom ใหม่อีกครั้ง";
  }
  if (status === 403) {
    if (/SERVICE_DISABLED|has not been used/i.test(detail)) {
      return "ยังไม่ได้เปิดใช้ Google Classroom API ในโปรเจกต์ Google Cloud — เปิดที่ APIs & Services > Library แล้วลองใหม่";
    }
    if (/insufficient|scope/i.test(detail)) {
      return "สิทธิ์ที่ได้รับไม่ครบ — กรุณาเชื่อมต่อ Google Classroom ใหม่แล้วกดอนุญาตให้ครบทุกข้อ";
    }
    return `Google ปฏิเสธคำขอ — บัญชีนี้อาจไม่ได้เป็นครูของชั้นเรียนนี้ (${detail})`;
  }
  if (status === 404) return "ไม่พบข้อมูลใน Google Classroom (อาจถูกลบไปแล้ว)";
  if (status === 429) return "เรียก Google Classroom ถี่เกินไป — รอสักครู่แล้วลองใหม่";

  return `Google Classroom API ตอบกลับผิดพลาด: ${detail}${reason ? ` (${reason})` : ""}`;
}

async function callApi(path, accessToken, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(describeError(res.status, body));
    err.status = res.status;
    throw err;
  }
  return body || {};
}

// Classroom แบ่งหน้าเสมอ — ต้องไล่ nextPageToken ให้ครบ ไม่งั้นวิชาที่มีงานเยอะจะโคลนมาไม่หมด
// จำกัดจำนวนหน้าไว้กันหลุดเป็น loop ไม่รู้จบถ้า API ส่ง token เดิมกลับมา
async function listAll(path, accessToken, params, key, maxPages = 40) {
  const items = [];
  let pageToken;

  for (let page = 0; page < maxPages; page++) {
    const data = await callApi(path, accessToken, { ...params, pageSize: 100, pageToken });
    if (Array.isArray(data[key])) items.push(...data[key]);
    if (!data.nextPageToken || data.nextPageToken === pageToken) break;
    pageToken = data.nextPageToken;
  }
  return items;
}

// ── ชั้นเรียน ────────────────────────────────────────────
// teacherId=me → เฉพาะวิชาที่บัญชีนี้เป็นครู (ไม่เอาวิชาที่เป็นนักเรียน)
const listCourses = (accessToken) =>
  listAll("/courses", accessToken, { teacherId: "me", courseStates: "ACTIVE" }, "courses");

const getCourse = (accessToken, courseId) => callApi(`/courses/${courseId}`, accessToken);

// ── หัวข้อในชั้นเรียน ────────────────────────────────────
const listTopics = (accessToken, courseId) =>
  listAll(`/courses/${courseId}/topics`, accessToken, {}, "topic");

// ── งานที่สั่ง ───────────────────────────────────────────
// เอาเฉพาะที่เผยแพร่แล้ว — ฉบับร่างของครูยังไม่ถือว่าสั่งนักเรียน
async function listCourseWork(accessToken, courseId) {
  const work = await listAll(`/courses/${courseId}/courseWork`, accessToken, {}, "courseWork");
  return work.filter((w) => w.state === "PUBLISHED");
}

// ── รายชื่อนักเรียน ──────────────────────────────────────
const listStudents = (accessToken, courseId) =>
  listAll(`/courses/${courseId}/students`, accessToken, {}, "students");

// ── งานที่นักเรียนส่ง ────────────────────────────────────
// userId=- คือขอของนักเรียนทุกคนในงานชิ้นนั้น
const listSubmissions = (accessToken, courseId, courseWorkId) =>
  listAll(
    `/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions`,
    accessToken,
    { userId: "-" },
    "studentSubmissions"
  );

// ── ตัวช่วยอ่านโครงสร้างที่ Classroom ส่งกลับมา ──────────

// ดึงไฟล์ Drive ออกจาก materials ของงาน (ข้าม link/วิดีโอ/ฟอร์มที่อ่านเนื้อหาไม่ได้)
function driveFilesFromMaterials(materials = []) {
  return materials
    .map((m) => m?.driveFile?.driveFile)
    .filter((f) => f?.id)
    .map((f) => ({ id: f.id, name: f.title || "ไฟล์แนบ", alternateLink: f.alternateLink }));
}

// ดึงไฟล์ Drive ออกจากงานที่นักเรียนส่ง
function driveFilesFromSubmission(submission) {
  return (submission?.assignmentSubmission?.attachments || [])
    .map((a) => a?.driveFile)
    .filter((f) => f?.id)
    .map((f) => ({ id: f.id, name: f.title || "ไฟล์แนบ", alternateLink: f.alternateLink }));
}

// ชื่อนักเรียนจาก roster — ใช้ fullName ก่อน ถ้าไม่มีค่อยประกอบเอง
function studentDisplayName(student) {
  const p = student?.profile?.name;
  const full = (p?.fullName || "").trim();
  if (full) return full;

  const composed = [p?.givenName, p?.familyName].filter(Boolean).join(" ").trim();
  return composed || student?.profile?.emailAddress || "ไม่ทราบชื่อ";
}

module.exports = {
  SCOPES,
  listCourses,
  getCourse,
  listTopics,
  listCourseWork,
  listStudents,
  listSubmissions,
  driveFilesFromMaterials,
  driveFilesFromSubmission,
  studentDisplayName,
};
