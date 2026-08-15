// ดึงเนื้องานจากลิงก์ Google Drive แบบ public
// ไฟล์/โฟลเดอร์ต้อง share เป็น "Anyone with the link" ไม่งั้นดึงไม่ได้

const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const mammoth = require("mammoth");

const GOOGLE_MIME_TO_KIND = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.presentation": "presentation",
  "application/vnd.google-apps.spreadsheet": "spreadsheets",
};

function classifyFileType(f) {
  const name = (f.name || "").toLowerCase();
  const mime = (f.mimeType || "").toLowerCase();

  if (mime === "application/vnd.google-apps.folder") return "folder";
  if (mime === "application/vnd.google-apps.document") return "gdoc";
  if (mime === "application/vnd.google-apps.spreadsheet") return "gsheet";
  if (mime === "application/vnd.google-apps.presentation") return "gslides";

  if (mime.startsWith("audio/") || /\.(mp3|m4a|wav|aac|flac|ogg|wma)$/i.test(name)) return "audio";
  if (mime.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm|flv|wmv)$/i.test(name)) return "video";

  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (mime.includes("wordprocessingml") || name.endsWith(".docx")) return "docx";
  if (mime.includes("msword") || name.endsWith(".doc")) return "doc";
  if (mime.startsWith("text/") || mime.includes("csv") || /\.(txt|csv|md|rtf)$/i.test(name)) return "txt";

  return "other";
}

// รองรับทุกรูปแบบของ Google Drive URL (folders, file/d, doc/d, ?id=)
function parseDriveUrl(url) {
  if (!url) return null;
  const str = String(url).trim();

  const folderMatch = str.match(/\/folders\/([\w-]+)/);
  if (folderMatch) return { kind: "folder", id: folderMatch[1] };

  const fileMatch = str.match(/\/file\/d\/([\w-]+)/);
  if (fileMatch) return { kind: "file", id: fileMatch[1] };

  const docMatch = str.match(/\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
  if (docMatch) return { kind: docMatch[1], id: docMatch[2] };

  const idMatch = str.match(/[?&]id=([\w-]+)/);
  if (idMatch) return { kind: "file", id: idMatch[1] };

  return null;
}

function normalizeDriveSharingUrl(url) {
  const parsed = parseDriveUrl(url);
  if (!parsed) return url;
  if (parsed.kind === "folder") {
    return `https://drive.google.com/drive/folders/${parsed.id}?usp=sharing`;
  }
  return `https://drive.google.com/file/d/${parsed.id}/view?usp=sharing`;
}

function downloadUrl({ kind, id }) {
  switch (kind) {
    case "document":
      return `https://docs.google.com/document/d/${id}/export?format=txt`;
    case "presentation":
      return `https://docs.google.com/presentation/d/${id}/export/txt`;
    case "spreadsheets":
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
    default:
      return `https://drive.google.com/uc?export=download&id=${id}`;
  }
}

const SHARING_HINT =
  'ดึงไฟล์ไม่ได้ — ตรวจสอบว่าตั้งค่า sharing เป็น "Anyone with the link" แล้วหรือยัง';

async function extractTextFromBuffer(buffer, filename = "", mimeType = "") {
  const name = filename.toLowerCase();
  const mime = mimeType.toLowerCase();

  // DOCX
  if (name.endsWith(".docx") || mime.includes("wordprocessingml")) {
    try {
      const res = await mammoth.extractRawText({ buffer });
      return (res.value || "").trim();
    } catch (err) {
      console.error("Error extracting docx text:", err);
    }
  }

  // PDF
  if (name.endsWith(".pdf") || mime.includes("pdf")) {
    const { text } = await pdfParse(buffer);
    return (text || "").trim();
  }

  // Text / CSV
  if (mime.startsWith("text/") || mime.includes("csv") || /\.(txt|csv|md)$/i.test(name)) {
    return buffer.toString("utf8").trim();
  }

  return null;
}

async function fetchFileText({ kind, id, mimeType, filename = "" }) {
  const res = await fetch(downloadUrl({ kind, id }), { redirect: "follow" });
  if (!res.ok) throw new Error(`${SHARING_HINT} (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") || mimeType || "";
  if (contentType.includes("text/html")) throw new Error(SHARING_HINT);

  if (kind === "document" || kind === "presentation" || kind === "spreadsheets") {
    return (await res.text()).trim();
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const text = await extractTextFromBuffer(buf, filename, contentType);
  return text;
}

// ยิง files.list จนหมดทุกหน้า — auth เป็น Bearer token ของครู หรือ API key แบบ public
async function driveFilesList(folderId, { accessToken, apiKey }) {
  const files = [];
  let pageToken;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (!accessToken && apiKey) url.searchParams.set("key", apiKey);

    const res = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new Error(authError(res.status, await res.text().catch(() => "")));

    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

async function listFolderFiles(folderId, accessToken = null) {
  const apiKey = process.env.GOOGLE_API_KEY;
  let rawFiles = [];

  if (accessToken || apiKey) {
    try {
      rawFiles = await driveFilesList(folderId, { accessToken, apiKey });
    } catch (e) {
      console.error("Drive folder API list notice:", e.message);
      rawFiles = [];
    }
  }

  // Fallback 1: Embedded folder view HTML scraping
  if (!rawFiles.length) {
    try {
      const embedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;
      const embedListUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
      
      for (const targetUrl of [embedListUrl, embedUrl]) {
        if (rawFiles.length) break;
        const htmlRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "th,en-US;q=0.9,en;q=0.8",
          },
        });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const SCRAPE_MIME = {
            document: "application/vnd.google-apps.document",
            presentation: "application/vnd.google-apps.presentation",
            spreadsheets: "application/vnd.google-apps.spreadsheet",
          };
          
          const map = new Map();

          // Regex Match 1: стандарт /file/d/ID หรือ /document/d/ID ตามด้วยชื่อ
          const m1 = [...html.matchAll(/\/(file|document|presentation|spreadsheets)\/d\/([\w-]+)[^>]*>(?:<[^>]+>)*\s*([^<]+)/g)];
          for (const m of m1) {
            const id = m[2];
            const name = m[3].trim();
            if (id && name && name.length > 1 && !map.has(id)) {
              map.set(id, { id, name, mimeType: SCRAPE_MIME[m[1]] || "" });
            }
          }

          // Regex Match 2: drive-item-title หรือ JSON payload
          if (map.size === 0) {
            const m2 = [...html.matchAll(/"id":"([\w-]+)".*?"title":"([^"]+)"/g)];
            for (const m of m2) {
              const id = m[1];
              const name = m[2].trim();
              if (id && name && !map.has(id)) {
                map.set(id, { id, name, mimeType: "" });
              }
            }
          }

          if (map.size > 0) {
            rawFiles = Array.from(map.values());
          }
        }
      }
    } catch (e) {
      console.error("Folder scraping fallback error:", e);
    }
  }

  // Fallback 2: Direct public folder view page scraping
  if (!rawFiles.length) {
    try {
      const publicUrl = `https://drive.google.com/drive/folders/${folderId}`;
      const pubRes = await fetch(publicUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (pubRes.ok) {
        const html = await pubRes.text();
        const map = new Map();
        const matches = [...html.matchAll(/\["([\w-]+)",\["([^"]+)"/g)];
        for (const m of matches) {
          const id = m[1];
          const name = m[2];
          if (id && name && id.length > 15 && !map.has(id)) {
            map.set(id, { id, name, mimeType: "" });
          }
        }
        if (map.size > 0) {
          rawFiles = Array.from(map.values());
        }
      }
    } catch (e) {
      console.error("Public folder scraping fallback error:", e);
    }
  }

  return rawFiles.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType || "",
    category: classifyFileType(f),
  }));
}

async function fetchFolderText(folderId, accessToken = null) {
  const files = (await listFolderFiles(folderId, accessToken)).filter(
    (f) => f.category !== "folder" && f.category !== "audio" && f.category !== "video"
  );

  if (!files.length) {
    throw new Error("โฟลเดอร์นี้ไม่มีไฟล์เอกสารที่รองรับ (รองรับ PDF, DOCX, DOC, Google Docs/Slides/Sheets และไฟล์ข้อความ)");
  }

  const sections = [];
  const skipped = [];

  for (const f of files) {
    const kind = GOOGLE_MIME_TO_KIND[f.mimeType] || "file";
    try {
      const text = accessToken
        ? await fetchFileTextAuth(f.id, accessToken)
        : await fetchFileText({ kind, id: f.id, mimeType: f.mimeType, filename: f.name });
      if (text) sections.push(`--- ${f.name} ---\n${text}`);
      else skipped.push(f.name);
    } catch {
      skipped.push(f.name);
    }
  }

  if (!sections.length) {
    throw new Error(
      `ดึงเนื้อหาจากไฟล์ในโฟลเดอร์ไม่ได้เลย (${skipped.join(", ")}) — รองรับ Google Docs/Slides/Sheets, PDF, DOCX และไฟล์ข้อความเท่านั้น`
    );
  }

  return sections.join("\n\n");
}

// ดาวน์โหลดไฟล์เดี่ยว (เช่นไฟล์เสียง) จาก Drive มาเก็บไว้ในเครื่อง server โดยตรง
// ใช้ตอนครูเลือกไฟล์จากรายการโฟลเดอร์ — ไม่ต้องผ่านเบราว์เซอร์ของครูเลย
async function downloadFileToDisk(fileId, destDir) {
  const res = await fetch(downloadUrl({ kind: "file", id: fileId }), { redirect: "follow" });
  if (!res.ok) throw new Error(`${SHARING_HINT} (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) throw new Error(SHARING_HINT);

  const destPath = path.join(destDir, crypto.randomBytes(16).toString("hex"));
  await fsp.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  return destPath;
}

async function fetchAssignmentText(url, accessToken = null) {
  const parsed = parseDriveUrl(url);
  if (!parsed) throw new Error("ลิงก์ไม่ใช่รูปแบบ Google Drive ที่รองรับ");

  if (parsed.kind === "folder") return fetchFolderText(parsed.id, accessToken);

  const text = accessToken
    ? await fetchFileTextAuth(parsed.id, accessToken)
    : await fetchFileText(parsed);
  if (text != null) return text;

  throw new Error("ยังไม่รองรับไฟล์ชนิดนี้ — รองรับ Google Docs, PDF, DOCX และไฟล์ข้อความ");
}

// ══════════════════════════════════════════════════════════
// เข้าถึง Drive แบบใช้ token ของครู (สำหรับไฟล์จาก Google Classroom)
//
// ไฟล์ที่นักเรียนแนบใน Classroom แชร์เฉพาะครูกับเจ้าของงาน ไม่ใช่ "Anyone with link"
// ทางลัด uc?export=download ด้านบนจึงใช้ไม่ได้เลย ต้องยิง Drive API พร้อม Bearer token
// ══════════════════════════════════════════════════════════

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

// Google Docs/Sheets/Slides ไม่มีไฟล์ไบนารีให้โหลด ต้อง export เป็นฟอร์แมตอื่นก่อน
const GOOGLE_EXPORT_AS = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

function authError(status, detail = "") {
  if (status === 401) return "สิทธิ์เข้าถึง Google หมดอายุ — กรุณาเชื่อมต่อ Google Classroom ใหม่อีกครั้ง";
  if (status === 403) return `ไม่มีสิทธิ์เข้าถึงไฟล์นี้ใน Google Drive — บัญชีครูอาจไม่ได้รับสิทธิ์ดูไฟล์ (${detail || status})`;
  if (status === 404) return "ไม่พบไฟล์ใน Google Drive (อาจถูกลบหรือย้ายไปแล้ว)";
  return `ดึงไฟล์จาก Google Drive ไม่สำเร็จ (HTTP ${status})`;
}

async function getFileMetaAuth(fileId, accessToken) {
  const url = `${DRIVE_API}/${fileId}?fields=id,name,mimeType,size&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(authError(res.status, await res.text().catch(() => "")));
  return res.json();
}

// คืน Buffer ของไฟล์ พร้อม metadata — ใช้ต่อได้ทั้งเขียนลงดิสก์และแกะข้อความ
async function fetchDriveFileAuth(fileId, accessToken, meta = null) {
  const info = meta || (await getFileMetaAuth(fileId, accessToken));
  const exportAs = GOOGLE_EXPORT_AS[info.mimeType];

  const url = exportAs
    ? `${DRIVE_API}/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${DRIVE_API}/${fileId}?alt=media&supportsAllDrives=true`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(authError(res.status, await res.text().catch(() => "")));

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    name: info.name,
    // ไฟล์ที่ export แล้วเป็น text/csv ไม่ใช่ mime เดิมของ Google Docs อีกต่อไป
    mimeType: exportAs || info.mimeType,
    originalMimeType: info.mimeType,
  };
}

// โหลดไฟล์เสียง/วิดีโอจาก Classroom ลงดิสก์ เพื่อส่งต่อให้ Whisper
//
// สตรีมลงไฟล์ ไม่โหลดเข้าหน่วยความจำก่อน — คลิปที่นักเรียนอัดจากมือถือมักหลายร้อย MB
// ถ้า buffer ทั้งก้อนบน VPS ที่มี RAM 1-2GB จะล้มทั้งเครื่อง
const MAX_FILE_MB = Number(process.env.GC_MAX_FILE_MB || 200);

async function downloadFileToDiskAuth(fileId, accessToken, destDir, meta = null) {
  const info = meta || (await getFileMetaAuth(fileId, accessToken));

  const sizeMb = Number(info.size || 0) / (1024 * 1024);
  if (sizeMb > MAX_FILE_MB) {
    throw new Error(
      `ไฟล์ "${info.name}" ใหญ่เกินไป (${sizeMb.toFixed(0)} MB เกินขีดจำกัด ${MAX_FILE_MB} MB) — ข้ามไฟล์นี้`
    );
  }

  // Google Docs ฯลฯ ไม่มีไฟล์ไบนารีให้สตรีม ต้อง export ซึ่งไฟล์เล็กอยู่แล้ว
  if (GOOGLE_EXPORT_AS[info.mimeType]) {
    const file = await fetchDriveFileAuth(fileId, accessToken, info);
    const destPath = path.join(destDir, crypto.randomBytes(16).toString("hex"));
    await fsp.writeFile(destPath, file.buffer);
    return destPath;
  }

  const res = await fetch(`${DRIVE_API}/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(authError(res.status, await res.text().catch(() => "")));

  const destPath = path.join(destDir, crypto.randomBytes(16).toString("hex"));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return destPath;
}

// แกะข้อความจากไฟล์งานของนักเรียน คืน null ถ้าเป็นชนิดที่อ่านไม่ได้ (รูป/วิดีโอ/ฟอร์ม)
async function fetchFileTextAuth(fileId, accessToken, meta = null) {
  const file = await fetchDriveFileAuth(fileId, accessToken, meta);

  if (file.mimeType.startsWith("text/") || file.mimeType.includes("csv")) {
    return file.buffer.toString("utf8").trim();
  }
  return extractTextFromBuffer(file.buffer, file.name, file.mimeType);
}

module.exports = {
  fetchAssignmentText,
  parseDriveUrl,
  normalizeDriveSharingUrl,
  listFolderFiles,
  downloadFileToDisk,
  extractTextFromBuffer,
  fetchFileText,
  fetchFolderText,
  classifyFileType,
  // เวอร์ชันที่ใช้ token ของครู — สำหรับไฟล์จาก Google Classroom
  getFileMetaAuth,
  fetchDriveFileAuth,
  downloadFileToDiskAuth,
  fetchFileTextAuth,
};

