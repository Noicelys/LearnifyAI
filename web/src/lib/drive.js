/* Normalize every Google Drive URL shape into the canonical sharing link
   the server knows how to fetch. */
export function toSharingUrl(rawUrl) {
  if (!rawUrl) return "";
  const str = String(rawUrl).trim();

  const folder = str.match(/\/folders\/([\w-]+)/);
  if (folder) return `https://drive.google.com/drive/folders/${folder[1]}?usp=sharing`;

  const file = str.match(/\/file\/d\/([\w-]+)/);
  if (file) return `https://drive.google.com/file/d/${file[1]}/view?usp=sharing`;

  const doc = str.match(/\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
  if (doc) return `https://drive.google.com/file/d/${doc[2]}/view?usp=sharing`;

  const byId = str.match(/[?&]id=([\w-]+)/);
  if (byId) return `https://drive.google.com/file/d/${byId[1]}/view?usp=sharing`;

  return str;
}

export function autoConvertOnInput(input) {
  if (!input) return;
  const normalize = () => {
    const converted = toSharingUrl(input.value);
    if (converted && converted !== input.value) input.value = converted;
  };
  input.addEventListener("paste", () => setTimeout(normalize, 30));
  input.addEventListener("blur", normalize);
  input.addEventListener("change", normalize);
}

const AUDIO_RE = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm|mkv|avi|3gp)$/i;
const WORK_RE = /\.(pdf|docx?|txt|md|rtf|odt|pptx?|xlsx?|csv)$/i;

export function isAudioFile(f) {
  const name = (f.name || "").toLowerCase();
  const type = (f.type || f.mimeType || "").toLowerCase();
  return type.startsWith("audio/") || type.startsWith("video/") || AUDIO_RE.test(name);
}

export function isWorkFile(f) {
  const name = (f.name || "").toLowerCase();
  const type = (f.type || f.mimeType || "").toLowerCase();
  return (
    WORK_RE.test(name) ||
    type.includes("pdf") ||
    type.includes("word") ||
    type.includes("document") ||
    type.includes("presentation") ||
    type.includes("sheet") ||
    type.startsWith("text/")
  );
}
