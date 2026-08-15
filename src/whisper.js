// ถอดเสียงนักเรียนเป็นข้อความ
//
// รองรับสองทาง เลือกด้วย STT_PROVIDER เท่านั้น (ไม่เดาจาก URL — เหมือน AI_PROVIDER ใน typhoon.js):
//   1) local (ค่าตั้งต้น) — faster-whisper ผ่าน service `whisper` ใน docker-compose
//      เสียงนักเรียนไม่ออกนอกเซิร์ฟเวอร์ ไม่มีค่า API แต่กิน RAM ~2.2GB และ CPU หนักสุดในระบบ
//   2) cloud — ยิงไป API แบบ OpenAI-compatible ที่ POST /audio/transcriptions
//      เร็วกว่ามาก ไม่กินเครื่อง แต่ไฟล์เสียงถูกส่งออกไปข้างนอก และมีค่าใช้จ่ายต่อนาที
//
// ทางคลาวด์เขียนเป็น OpenAI-compatible ล้วน จึงใช้ได้ทั้ง Groq และ OpenAI โดยเปลี่ยนแค่ 3 ค่าใน .env
// (ค่าตั้งต้นชี้ไป Groq เพราะรัน whisper-large-v3 ตัวเดียวกับที่ใช้ในเครื่องอยู่แล้ว
//  ผลถอดเสียงจึงเทียบเคียงกันได้ ไม่ต้องจูน AUDIO_FILTER หรือเกณฑ์คุณภาพใหม่)
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const IS_CLOUD = (process.env.STT_PROVIDER || "local").toLowerCase() === "cloud";
const STT_PROVIDER_LABEL = IS_CLOUD ? "Whisper Cloud" : "Faster-Whisper (ในเครื่อง)";

const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:9000";

// ค่าฝั่งคลาวด์ — เช็ครายชื่อโมเดลที่ใช้ได้จริง: GET {STT_BASE_URL}/models (ใส่ Bearer key)
//   Groq:   https://api.groq.com/openai/v1  · whisper-large-v3 (แม่นสุด) หรือ whisper-large-v3-turbo (ถูก/เร็วกว่า)
//   OpenAI: https://api.openai.com/v1       · whisper-1
//           ⚠ อย่าใช้ gpt-4o-transcribe — ไม่รองรับ verbose_json จึงไม่ส่ง segments กลับมา
//             แปลว่า assessQuality() ตรวจคุณภาพไม่ได้เลย กลายเป็นปล่อยผ่านทุกคลิป
const STT_BASE_URL = process.env.STT_BASE_URL || "https://api.groq.com/openai/v1";
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3";
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 120000);

// ผู้ให้บริการจำกัดขนาดไฟล์ที่อัปโหลดได้ (Groq ฟรี 25MB · OpenAI 25MB)
// เช็คเองก่อนยิงจะได้บอกครูเป็นภาษาคนว่าต้องทำยังไง ดีกว่าปล่อยให้เจอ HTTP 413 ดิบ ๆ
const STT_MAX_UPLOAD_MB = Number(process.env.STT_MAX_UPLOAD_MB || 24);

// บางไฟล์ (โดยเฉพาะ .mp4 จากกล้องมือถือ) เก็บ moov atom ไว้ท้ายไฟล์ — ffmpeg ฝั่ง whisper
// อ่านผ่าน pipe (ไม่ seek ได้) แล้วหาโครงสร้างสตรีมไม่เจอ ทำให้ decode fail แม้ไฟล์จะไม่เสีย
// แปลงเป็น wav 16kHz mono ที่นี่ก่อนเสมอ กันปัญหานี้ทุกไฟล์ ไม่ต้องแยกเคสว่าไฟล์ไหนมีปัญหา
// นักเรียนอัดด้วยมือถือในห้องเรียน เสียงมักเบา ไกลไมค์ และมีเสียงฮัมความถี่ต่ำปน
// วัดจากไฟล์จริง: ยอดคลื่นอยู่ที่ -1.3 dB (เกือบชนเพดาน) แต่ค่าเฉลี่ยแค่ -25 dB
// = ช่วงไดนามิกกว้างมาก เสียงพูดจริงเบา แต่มีเสียงกระแทกดังเป็นครั้งคราว
//
// ⚠ acompressor ถูกถอดออกแล้ว — มันทำร้ายการถอดเสียง ทั้งที่เหตุผลเดิมฟังดูสมเหตุสมผล
//
// เหตุผลเดิมคือ "บีบไดนามิกก่อน แล้วค่อยดันระดับรวม" ซึ่งถูกถ้าเป้าหมายคือให้ *คนฟัง*
// ได้ยินชัด แต่เป้าหมายจริงของเราคือให้ *whisper* แยกเสียงพูดออกจากเสียงรบกวน
// สองอย่างนี้ต้องการคนละอย่างกัน: คนต้องการเสียงดังสม่ำเสมอ โมเดลต้องการ "ส่วนต่าง"
// ระหว่างช่วงพูดกับช่วงไม่พูด ยิ่งห่างยิ่งดี — compressor บีบส่วนต่างนั้นให้แคบลงโดยตรง
// พอ loudnorm ดันทั้งไฟล์ขึ้นตาม เสียงลมช่วงที่ไม่มีคนพูดจะถูกดันขึ้นมาใกล้ระดับเสียงพูด
// whisper เลยตีช่วงนั้นเป็นเสียงพูดแล้วเดาคำใส่มา = ที่มาของประโยคที่ไม่มีใครพูด
//
// วัดจากคลิปจริงในโฟลเดอร์ uploads (ยาว 143 วินาที) เทียบช่วงพูดดังสุดกับช่วงเงียบสุด:
//   ต้นฉบับ                     ช่วงเงียบอยู่ที่ -27.1 dB
//   ของเดิม (มี compressor)     ช่วงเงียบ -23.8 dB  ส่วนต่างพูด/เงียบ 3.2 dB  ← ดันเสียงลมขึ้น 3.3 dB
//   ใส่ afftdn แต่คง compressor  ช่วงเงียบ -24.7 dB  ส่วนต่าง 3.9 dB
//   ถอด compressor ออก          ช่วงเงียบ -25.4 dB  ส่วนต่าง 4.6 dB  ← ใช้อันนี้
// ระดับเสียงพูดเท่ากันทั้งสามแบบ (-20.8 dB) แปลว่าถอด compressor ออกไม่ได้เสียอะไรเลย
// loudnorm ทำหน้าที่ปรับระดับให้อยู่แล้ว (ยังได้ -16 LUFS ตามเป้า)
//
// ⚠ จูนจากคลิปเดียว — ไฟล์อื่นใน uploads สั้นเกินหรืออ่าน duration ไม่ได้
// ควรวัดซ้ำเมื่อมีคลิปจริงจากห้องเรียนหลายห้อง วิธีวัดอยู่ท้ายคอมเมนต์นี้
//
//   highpass 100Hz  ตัดลมปะทะไมค์/เสียงจับตัวเครื่อง/ฮัมแอร์ ซึ่งกินย่านต่ำกว่านี้เกือบหมด
//                   ของเดิม 80Hz ต่ำไป เสียงลมยังเล็ดลอดขึ้นมาถึง ~150Hz
//                   ไม่ขึ้นไปกว่านี้เพราะเสียงต่ำของเด็กผู้ชายอยู่แถว 110-140Hz จะโดนตัดไปด้วย
//   afftdn tn=1     ลดเสียงรบกวนแบบวิเคราะห์สเปกตรัม + ตามการเปลี่ยนแปลงของ noise (tn=1)
//                   ซึ่งจำเป็นเพราะลมมาเป็นระลอก ไม่ได้ดังคงที่ทั้งคลิป
//                   (nr=24 กับ nr=12 วัดแล้วได้ผลเท่ากันบนคลิปนี้ ใช้ 24 เผื่อคลิปที่ลมแรงกว่า)
//   loudnorm        ดันระดับรวมให้ได้มาตรฐาน -16 LUFS
//
// ลองแล้วไม่ช่วย: agate (ส่วนต่างได้ 4.0 ยังแพ้การถอด compressor) — และมีความเสี่ยง
// ตัดเสียงนักเรียนที่พูดเบาทิ้งด้วย จึงไม่ใช้
// เสียงกระทบปาก/เสียงคลิกจากการพูดไม่ถนัด (ร้อนใน เจ็บปาก) ถ้ายังกวนมาก ลองแทรก
// adeclick ก่อน loudnorm ได้ แต่กิน CPU สูงและทำให้เสียงพูดเพี้ยนถ้าใส่แรงไป
//
// วิธีวัดซ้ำกับคลิปใหม่ (ไม่ต้องมี docker):
//   ffmpeg -ss <วินาที> -t 3 -i <ไฟล์> -af volumedetect -f null -   แล้วดู mean_volume
//   หาช่วงพูดดังสุดกับช่วงเงียบสุด เทียบส่วนต่างก่อน/หลังใส่ฟิลเตอร์ ยิ่งห่างยิ่งดี
// เปลี่ยนได้จาก .env โดยไม่ต้อง rebuild
const AUDIO_FILTER =
  process.env.AUDIO_FILTER ||
  "highpass=f=100:poles=2,afftdn=nr=24:nf=-30:tn=1,loudnorm=I=-16:TP=-1.5";

// format: "wav" สำหรับ service ในเครื่อง (ส่งผ่าน network ภายใน ขนาดไม่สำคัญ)
//         "flac" สำหรับคลาวด์ — บีบแบบ lossless ข้อมูลเสียงเท่าเดิมเป๊ะ ผลถอดเสียงจึงไม่ต่างจาก wav
//         วัดจากคลิปจริงในโฟลเดอร์ uploads: 144KB → 132KB (เล็กลง ~9% เท่านั้น
//         เพราะ afftdn เหลือ noise floor ไว้พอสมควร flac เลยบีบได้ไม่มาก)
//         ไม่ได้ช่วยเรื่องเพดาน 25MB อย่างมีนัยสำคัญ (wav ~13 นาที · flac ~14 นาที)
//         แต่ไม่มีข้อเสียและเป็นรูปแบบที่ฝั่งคลาวด์แนะนำ จึงใช้ตัวนี้
//
// -vn = ทิ้งสตรีมวิดีโอทิ้งไปตั้งแต่ต้น นักเรียนอัดมาเป็น .mp4 กันเยอะ
// จำเป็นสำหรับ flac โดยเฉพาะ เพราะ flac รองรับ "ภาพปก" ได้ ffmpeg จึงพยายามยัดวิดีโอเข้าไป
// แล้วพังด้วย error ที่อ่านไม่รู้เรื่อง (เจอจริงกับไฟล์ mjpeg) ส่วน wav มุxเซอร์ทิ้งวิดีโอให้เอง
// ใส่ทั้งสองทางให้เหมือนกัน ไฟล์ที่ไม่มีเสียงจะได้ตกลงมาที่ข้อความภาษาไทยด้านล่างเสมอ
async function normalizeToAudio(inputPath, format) {
  const outputPath = `${inputPath}.norm.${format}`;
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", inputPath, "-vn",
      "-af", AUDIO_FILTER,
      "-ar", "16000", "-ac", "1", "-f", format, outputPath,
    ]);
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    if (stderr.includes("does not contain any stream")) {
      throw new Error("ไฟล์นี้ไม่มีเสียงอยู่ข้างใน (วิดีโอเงียบหรือไฟล์เสีย) — ถอดเสียงไม่ได้");
    }
    throw new Error(`แปลงไฟล์เสียงไม่สำเร็จ: ${stderr.slice(-300) || err.message}`);
  }
  return outputPath;
}

// Whisper รับ "initial_prompt" เป็นบริบทนำ แล้วจะเดาคำที่อยู่ในบริบทนั้นแม่นขึ้นมาก
// จุดที่ถอดเสียงพลาดบ่อยที่สุดคือศัพท์เฉพาะของงาน (เช่น Weak AI, PDPA, ชื่อทฤษฎี)
// เพราะโมเดลไม่รู้ว่ากำลังพูดเรื่องอะไร — ป้อนต้นเนื้องานจริงเข้าไปก่อนจึงช่วยได้ตรงจุด
//
// Whisper ตัด initial_prompt ที่ ~224 token ยาวกว่านั้นส่วนเกินถูกทิ้งเฉย ๆ
// จำกัดที่ 200 ตัวอักษรเพื่อให้อยู่ในโควตาแน่นอนแม้เป็นภาษาไทยที่กินโทเคนสูง
const PROMPT_FALLBACK = "ต่อไปนี้เป็นคำอธิบายงานด้วยเสียงของนักเรียนไทย พูดภาษาไทยผสมศัพท์วิชาการภาษาอังกฤษ";
const PROMPT_LEAD = "ต่อไปนี้เป็นคำอธิบายงานด้วยเสียงของนักเรียนไทย เนื้อหาเกี่ยวกับ ";
const PROMPT_MAX_CHARS = 220;

// ⚠ บริบทต้องเป็น "ประโยคไทยปกติ" เท่านั้น
// เคยลองใส่เป็นลิสต์ศัพท์คั่นด้วยจุลภาค ("ศัพท์ที่พูดถึง: Weak AI, Strong AI, PDPA")
// ผลคือ whisper หลุดไปภาษาอื่นกลางคัน โผล่คำจีน/ฝรั่งเศส/ตุรกีปนออกมา
// เพราะลิสต์คำไม่มีโครงสร้างประโยคให้ยึด โมเดลเลยเดาภาษาใหม่เรื่อย ๆ
// ต้องเป็นข้อความร้อยเรียงจากเนื้องานจริงเท่านั้น
//
// แต่ 200 ตัวอักษรแรกของใบงานมักเป็นหัวเรื่อง ไม่มีศัพท์ที่นักเรียนพูดถึงตอนกลางคลิป
// จึงเลือก "ช่วงที่มีศัพท์อังกฤษหนาแน่นที่สุด" มาแทนช่วงต้น — ยังเป็นประโยคปกติอยู่
function pickTermRichWindow(text, size) {
  if (text.length <= size) return text;

  const isTermChar = (c) => /[A-Za-z]/.test(c);
  let best = 0;
  let bestScore = -1;

  // เลื่อนทีละ 40 ตัวอักษรพอ ไม่ต้องละเอียดกว่านี้ ผลลัพธ์ไม่ต่างแต่ช้าขึ้นมาก
  for (let i = 0; i + size <= text.length; i += 40) {
    let score = 0;
    for (let j = i; j < i + size; j++) if (isTermChar(text[j])) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  // ไม่มีศัพท์อังกฤษเลย ใช้ช่วงต้นตามเดิม (มักเป็นใจความหลักของงาน)
  return bestScore <= 0 ? text.slice(0, size) : text.slice(best, best + size);
}

function buildInitialPrompt(contextText) {
  const clean = String(contextText || "").replace(/\s+/g, " ").trim();
  if (!clean) return PROMPT_FALLBACK;
  return PROMPT_LEAD + pickTermRichWindow(clean, PROMPT_MAX_CHARS - PROMPT_LEAD.length);
}

// ── ประเมินว่าผลถอดเสียงเชื่อถือได้พอจะเอาไปให้คะแนนไหม ──────────────
// whisper ส่งค่าความมั่นใจรายท่อนมาให้อยู่แล้วใน output=json แต่เดิมเราทิ้งไปหมด
// ใช้เอาไม่ได้ตอนไหน สำคัญพอ ๆ กับตัวข้อความ เพราะถ้าถอดมาเพี้ยนแล้วปล่อยให้วิเคราะห์ต่อ
// นักเรียนจะได้คะแนนต่ำเพราะไมค์ ไม่ใช่เพราะไม่เข้าใจงาน ซึ่งเป็นการตัดสินที่ผิดตัว
//
// เกณฑ์:
//   avg_logprob        ความมั่นใจเฉลี่ยของโมเดล ต่ำกว่า -1.0 คือค่าที่ whisper เองถือว่า "ถอดไม่ผ่าน"
//                      ตั้งไว้ -0.85 เพื่อให้เตือนก่อนถึงจุดนั้น (ถ่วงน้ำหนักตามความยาวท่อน
//                      ไม่งั้นท่อนสั้น ๆ ท่อนเดียวที่มั่นใจสูงจะดึงค่าเฉลี่ยขึ้นทั้งคลิป)
//   no_speech_prob     ความน่าจะเป็นว่าท่อนนั้นไม่มีคนพูด สูงทั้งคลิป = ได้แต่เสียงลม
//   ท่อนที่ข้อความซ้ำกัน  ลายเซ็นของอาการวนลูป ถ้ายังเหลืออยู่หลังปิด condition_on_previous_text
const MIN_AVG_LOGPROB = Number(process.env.WHISPER_MIN_AVG_LOGPROB || -0.85);
const MAX_NO_SPEECH_RATIO = Number(process.env.WHISPER_MAX_NO_SPEECH_RATIO || 0.6);

function assessQuality(segments, text) {
  // ไม่มี segments (เช่นเปลี่ยน image แล้วรูปแบบ json ต่างไป) = ไม่ตัดสิน ปล่อยผ่าน
  // ดีกว่าบล็อกงานนักเรียนทิ้งเพราะเราอ่านผลลัพธ์ไม่เป็น
  if (!Array.isArray(segments) || segments.length === 0) return { ok: true };

  let weighted = 0;
  let duration = 0;
  let noSpeech = 0;
  const seen = new Map();

  for (const seg of segments) {
    const span = Math.max(0.1, Number(seg.end) - Number(seg.start) || 0.1);
    if (Number.isFinite(seg.avg_logprob)) {
      weighted += seg.avg_logprob * span;
      duration += span;
    }
    if (Number(seg.no_speech_prob) > 0.5) noSpeech += 1;

    const key = String(seg.text || "").replace(/\s+/g, "").trim();
    if (key) seen.set(key, (seen.get(key) || 0) + 1);
  }

  const avgLogprob = duration > 0 ? weighted / duration : null;
  const noSpeechRatio = noSpeech / segments.length;
  const maxRepeat = Math.max(0, ...seen.values());

  if (avgLogprob !== null && avgLogprob < MIN_AVG_LOGPROB) {
    return {
      ok: false,
      avgLogprob,
      reason:
        `ถอดเสียงได้ไม่ชัดพอ (ความมั่นใจเฉลี่ย ${avgLogprob.toFixed(2)} ต่ำกว่าเกณฑ์ ${MIN_AVG_LOGPROB}) — ` +
        `ข้อความที่ได้อาจเพี้ยนจนใช้ตัดสินไม่ได้ ควรฟังคลิปเองหรือให้นักเรียนอัดใหม่ในที่เงียบกว่านี้`,
    };
  }

  if (noSpeechRatio > MAX_NO_SPEECH_RATIO) {
    return {
      ok: false,
      noSpeechRatio,
      reason:
        `คลิปนี้ส่วนใหญ่ไม่มีเสียงพูด (${Math.round(noSpeechRatio * 100)}% ของช่วงที่ตรวจ) — ` +
        `อาจอัดไม่ติด ไมค์โดนบัง หรือได้แต่เสียงลม`,
    };
  }

  // ท่อนเดียวกันซ้ำตั้งแต่ 3 ครั้งขึ้นไปไม่ใช่การพูดปกติ
  if (maxRepeat >= 3) {
    return {
      ok: false,
      maxRepeat,
      reason:
        `ผลถอดเสียงมีประโยคซ้ำกัน ${maxRepeat} ครั้ง ซึ่งเป็นอาการที่โมเดลวนลูปเวลาเสียงไม่ชัด — ` +
        `ข้อความที่ได้เชื่อถือไม่ได้ ควรฟังคลิปเอง`,
    };
  }

  // สั้นผิดปกติเทียบกับความยาวคลิป: พูดมาหลายนาทีแต่ถอดได้ไม่กี่คำ = ถอดไม่ติดเป็นส่วนใหญ่
  const spoken = segments[segments.length - 1]?.end || 0;
  if (spoken > 60 && text.replace(/\s+/g, "").length < spoken * 2) {
    return {
      ok: false,
      reason:
        `คลิปยาว ${Math.round(spoken)} วินาที แต่ถอดข้อความได้แค่ ${text.trim().length} ตัวอักษร — ` +
        `น่าจะมีช่วงที่ถอดไม่ติดเป็นจำนวนมาก ควรฟังคลิปเอง`,
    };
  }

  return { ok: true, avgLogprob };
}

// ── ทางที่ 1: faster-whisper ในเครื่อง ────────────────────────────────
async function transcribeLocal(wavPath, language, prompt) {
  const buf = await fs.readFile(wavPath);
  const form = new FormData();
  form.append("audio_file", new Blob([buf]), "audio.wav");

  const params = new URLSearchParams({
    task: "transcribe",
    language,
    output: "json",
    // ตัดช่วงเงียบออกก่อนถอด — ช่วงเงียบยาว ๆ ทำให้ whisper "หลอน" คำที่ไม่มีคนพูดขึ้นมา
    vad_filter: "true",
    initial_prompt: prompt,
  });

  const res = await fetch(`${WHISPER_URL}/asr?${params}`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Whisper ตอบกลับ HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return { text: (data.text || "").trim(), segments: data.segments };
}

// ── ทางที่ 2: คลาวด์ (OpenAI-compatible /audio/transcriptions) ─────────
async function transcribeCloud(flacPath, language, prompt) {
  const apiKey = process.env.STT_API_KEY;
  if (!apiKey) {
    throw new Error("ยังไม่ได้ตั้งค่า STT_API_KEY ใน .env (จำเป็นเมื่อใช้ STT_PROVIDER=cloud)");
  }

  const buf = await fs.readFile(flacPath);
  const sizeMb = buf.length / 1024 / 1024;
  if (sizeMb > STT_MAX_UPLOAD_MB) {
    throw new Error(
      `คลิปนี้ยาวเกินไปสำหรับการถอดเสียงบนคลาวด์ (${sizeMb.toFixed(1)}MB เกินเพดาน ${STT_MAX_UPLOAD_MB}MB) — ` +
        `ให้นักเรียนอัดใหม่ให้สั้นลง หรือสลับกลับไปใช้ STT_PROVIDER=local ซึ่งไม่มีเพดานนี้`
    );
  }

  const form = new FormData();
  form.append("file", new Blob([buf]), "audio.flac");
  form.append("model", STT_MODEL);
  form.append("language", language);
  // ฝั่งคลาวด์เรียกบริบทนำว่า "prompt" แต่เป็นตัวเดียวกับ initial_prompt ของ faster-whisper
  form.append("prompt", prompt);
  // ⚠ ต้องเป็น verbose_json เท่านั้น — รูปแบบ json ธรรมดาส่งกลับมาแค่ข้อความ ไม่มี segments
  // ซึ่งแปลว่า assessQuality() จะไม่มีข้อมูลตรวจ แล้วปล่อยผ่านทุกคลิปตามกติกา "ไม่มี segments = ไม่ตัดสิน"
  form.append("response_format", "verbose_json");
  // 0 = ให้โมเดลเลือกคำที่มั่นใจที่สุดเสมอ ไม่สุ่ม — งานนี้ต้องการผลเดิมทุกครั้งที่ถอดซ้ำ
  form.append("temperature", "0");

  let res;
  try {
    res = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(
        `${STT_PROVIDER_LABEL} ใช้เวลาเกิน ${Math.round(STT_TIMEOUT_MS / 1000)} วินาที — ลองกดประมวลผลใหม่อีกครั้ง`
      );
    }
    throw new Error(`ต่อ ${STT_PROVIDER_LABEL} ที่ ${STT_BASE_URL} ไม่ได้: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text();
    // 429 เกิดบ่อยสุดตอนครูกดตรวจทั้งห้องรวดเดียว — บอกวิธีแก้ไปเลย ครูจะได้ไม่คิดว่าระบบพัง
    if (res.status === 429) {
      throw new Error(`${STT_PROVIDER_LABEL} จำกัดจำนวนครั้งชั่วคราว (429) — รอสักครู่แล้วกดประมวลผลใหม่`);
    }
    throw new Error(`${STT_PROVIDER_LABEL} ตอบกลับ HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return { text: (data.text || "").trim(), segments: data.segments };
}

// contextText = เนื้องานจริงของนักเรียน ใช้เป็นบริบทให้ whisper เดาศัพท์เฉพาะได้ถูก
// คืน { text, quality } — ผู้เรียกต้องเช็ค quality.ok ก่อนเอา text ไปให้คะแนน
async function transcribe(audioPath, { language = "th", contextText = "" } = {}) {
  const prompt = buildInitialPrompt(contextText);
  // สองทางใช้ AUDIO_FILTER ชุดเดียวกัน ต่างแค่รูปแบบไฟล์ที่ห่อออกมา
  const workPath = await normalizeToAudio(audioPath, IS_CLOUD ? "flac" : "wav");
  try {
    const { text, segments } = IS_CLOUD
      ? await transcribeCloud(workPath, language, prompt)
      : await transcribeLocal(workPath, language, prompt);
    // เกณฑ์คุณภาพใช้ร่วมกันได้ เพราะทั้งสองทางรันโมเดล whisper และส่ง
    // avg_logprob / no_speech_prob / start / end กลับมาในรูปแบบเดียวกัน
    return { text, quality: assessQuality(segments, text) };
  } finally {
    await fs.rm(workPath, { force: true });
  }
}

// เช็คว่าตัวถอดเสียงพร้อมใช้จริงไหม — ใช้ในหน้าสถานะระบบด้านบนของหน้าเว็บ
// (ย้ายมาจาก server.js เพื่อให้ตรรกะของสองทางอยู่ที่เดียวกับตัวถอดเสียง เหมือน typhoon.checkHealth)
async function checkHealth() {
  const provider = STT_PROVIDER_LABEL;
  const model = IS_CLOUD ? STT_MODEL : process.env.ASR_MODEL || "large-v3-turbo";

  if (IS_CLOUD) {
    if (!process.env.STT_API_KEY) {
      return { ok: false, provider, model, error: "ยังไม่ได้ใส่ STT_API_KEY" };
    }
    try {
      // /models เป็นการเรียกที่ถูกที่สุดที่ยืนยันได้ว่าคีย์ใช้ได้จริง (ไม่คิดเงินตามนาทีเสียง)
      const res = await fetch(`${STT_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${process.env.STT_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, provider, model, error: "คีย์ STT_API_KEY ใช้ไม่ได้ (ถูกปฏิเสธ)" };
      }
      if (!res.ok) return { ok: false, provider, model, error: `HTTP ${res.status}` };

      const ids = ((await res.json()).data || []).map((m) => m.id);
      // บางเจ้าไม่ยอมลิสต์โมเดลเสียงใน /models — มีคีย์ที่ใช้ได้ก็ถือว่าผ่าน อย่าบล็อกครูเพราะเรื่องนี้
      return ids.length === 0 || ids.includes(model)
        ? { ok: true, provider, model }
        : { ok: false, provider, model, error: `ไม่มีโมเดล "${model}" ในบัญชีนี้ (มีอยู่: ${ids.slice(0, 5).join(", ")})` };
    } catch (err) {
      return { ok: false, provider, model, error: err.message };
    }
  }

  try {
    const res = await fetch(`${WHISPER_URL}/docs`, { signal: AbortSignal.timeout(5000) });
    return res.ok
      ? { ok: true, provider, model }
      : { ok: false, provider, model, error: `HTTP ${res.status}` };
  } catch {
    // ข้อความดิบของ fetch คือ "fetch failed" ซึ่งไม่บอกอะไรครูเลย
    // สาเหตุจริงมีอยู่สองอย่างเท่านั้น บอกไปทั้งคู่พร้อมวิธีแก้
    return {
      ok: false, provider, model,
      error: `ต่อ ${WHISPER_URL} ไม่ได้ — ยังไม่ได้สตาร์ต (docker compose --profile local-stt up -d) หรือกำลังโหลดโมเดลรอบแรกอยู่`,
    };
  }
}

// assessQuality ส่งออกไว้ให้เทสต์ได้โดยไม่ต้องยิง whisper จริง (เหมือน stripToJson ใน typhoon.js)
module.exports = { transcribe, assessQuality, checkHealth };
