# LearnifyAI — AI Work Verification & Oral Defense Platform

แพลตฟอร์มตรวจงานนักเรียนยุค AI ที่เปลี่ยนแนวทางจากการ "จับผิด AI" (AI Detection ซึ่งไม่แม่นและหลอกง่าย)
มาเป็นการ "พิสูจน์ความเข้าใจจริง" — ให้นักเรียนอัดคลิปเสียงอธิบายงานของตัวเอง แล้วให้ระบบถอดเสียง
และวิเคราะห์ว่าคำอธิบายตรงกับเนื้องานจริงแค่ไหน ก่อนสรุปเป็น Trust Score พร้อมเหตุผลให้ครูตัดสินใจ

> ครู override คะแนนได้เสมอ — AI ไม่ฟันธงขาด

รายละเอียดแนวคิด ข้อจำกัด และแผนพัฒนาแบบเป็นเฟส อยู่ใน [aiworkverificationoverview.md](aiworkverificationoverview.md)

---

## ภาพรวมการทำงาน

```
ครู  ──> วางลิงก์ Google Drive ของงานนักเรียน / อัปโหลดไฟล์เอง / import รายชื่อจาก CSV
          │
          ▼
Backend ──> ดึงเนื้องานจริง (PDF / Word / Google Docs) มาเป็นข้อความ
          │
นักเรียน ──> อัดคลิปเสียงอธิบายงาน (async ทำตอนไหนก็ได้)
          │
Whisper ──> ถอดเสียงเป็นข้อความ (local ผ่าน faster-whisper หรือ cloud ผ่าน Groq)
          │
Typhoon ──> เทียบ transcript กับเนื้องานจริง: content-match, specificity, เหตุผลเชิงลึก
          │
Dashboard ──> Trust Score (เขียว / เหลือง / แดง) พร้อมเหตุผลกำกับ + ครูแก้คะแนนได้
```

---

## เทคโนโลยีที่ใช้

| ส่วน | เทคโนโลยี |
|---|---|
| Backend | Node.js 20+, Express 4 |
| Frontend | Vanilla JS + Vite 6 (ไม่มี framework), CSS custom properties |
| ฐานข้อมูล | PostgreSQL (`pg`) |
| ถอดเสียง | faster-whisper (local, CPU ได้) หรือ Groq Whisper API (cloud) |
| วิเคราะห์ | Typhoon API (`opentyphoon.ai`) หรือ Ollama (local GPU) |
| อ่านไฟล์งาน | `pdf-parse`, `mammoth` (Word), Google Drive public fetch |
| Deploy | Docker Compose + Caddy (HTTPS อัตโนมัติ) |

ทั้งตัวถอดเสียงและตัววิเคราะห์สลับ **local ↔ cloud** ได้อิสระจากกันผ่านตัวแปรใน `.env`

---

## เริ่มใช้งาน

### 1. ตั้งค่า environment

```bash
cp .env.example .env
```

แล้วเติมค่าใน `.env` — อย่างน้อยต้องมี:

| ตัวแปร | ใช้ทำอะไร | หาได้จาก |
|---|---|---|
| `SESSION_SECRET` | ความลับของ session cookie ครู | `openssl rand -hex 32` |
| `TEACHER_PASSWORD` | รหัสผ่านเข้าหน้าครู | ตั้งเอง |
| `POSTGRES_PASSWORD` | รหัสผ่านฐานข้อมูล | ตั้งเอง |
| `TYPHOON_API_KEY` | วิเคราะห์ transcript (โหมด `AI_PROVIDER=cloud`) | https://opentyphoon.ai (ฟรี) |
| `STT_API_KEY` | ถอดเสียง (โหมด `STT_PROVIDER=cloud`) | https://console.groq.com/keys (ฟรี) |

ค่าที่เหลือมี default ให้แล้ว ดูคำอธิบายรายตัวใน [.env.example](.env.example)

### 2. รันด้วย Docker (แนะนำ)

```bash
# โหมดคลาวด์ — เบาที่สุด ไม่ต้องมีการ์ดจอ
docker compose up -d --build
```

```bash
# โหมดในเครื่องล้วน — ข้อมูลไม่ออกนอกเซิร์ฟเวอร์ แต่โหลดโมเดลรวม ~4GB
docker compose --profile local-stt --profile local-ai up -d --build
docker compose logs -f ollama-pull whisper   # ดูความคืบหน้าการโหลดโมเดล
```

```bash
# production หลัง HTTPS — ตั้ง DOMAIN ใน .env ให้ชี้ DNS มาที่เครื่องนี้ก่อน
docker compose --profile proxy up -d --build
```

> ⚠️ ค่า `STT_PROVIDER` / `AI_PROVIDER` ใน `.env` ต้องตรงกับ profile ที่สตาร์ต
> ไม่งั้นจะได้ container ที่ไม่มีใครเรียก (เปลืองเปล่า) หรือแอปเรียกไปยัง service ที่ไม่ได้สตาร์ต

เปิดที่ http://localhost:3000

### 3. รันแบบ local dev (ไม่ใช้ Docker)

ต้องมี Node.js 20+ และ PostgreSQL ที่รันอยู่แล้ว

```bash
npm install
npm run build     # vite compile web/ -> public/
npm run dev       # เซิร์ฟเวอร์ที่ port 3000 (node --watch)
```

ถ้าจะแก้หน้าเว็บพร้อม hot reload ให้เปิดอีกเทอร์มินัลคู่กัน:

```bash
npm run dev:web   # vite dev server ที่ port 5173 (proxy /api ไป 3000)
```

ตาราง PostgreSQL ถูกสร้าง/อัปเดตอัตโนมัติตอนบูตเซิร์ฟเวอร์ — `db/schema.sql` เก็บไว้เป็นเอกสารอ้างอิงเท่านั้น ไม่ได้รันเอง

---

## คำสั่ง npm

| คำสั่ง | ทำอะไร |
|---|---|
| `npm start` | รันเซิร์ฟเวอร์ production |
| `npm run dev` | รันเซิร์ฟเวอร์แบบ auto-restart เมื่อไฟล์เปลี่ยน |
| `npm run dev:web` | vite dev server สำหรับแก้หน้าเว็บ |
| `npm run build` | ล้าง `public/` แล้ว compile `web/` ลงไปใหม่ |

---

## โครงสร้างโปรเจค

```
src/            Backend (Express)
  server.js       route ทั้งหมด + static serving
  db.js, pg.js    schema และ query PostgreSQL
  whisper.js      ถอดเสียง (สลับ local/cloud)
  typhoon.js      เรียกโมเดลวิเคราะห์
  rubric.js       เกณฑ์ให้คะแนน
  coach.js        feedback เชิงโค้ช
  drive.js        ดึงไฟล์จาก Google Drive
  classroom*.js   จัดการห้องเรียน + import รายชื่อ
web/            Frontend (source ที่ vite ใช้ build)
  src/views/      หน้าจอหลัก
  src/features/   flow ย่อย เช่น upload wizard, CSV import
  src/lib/        router, store, api client, helper
  src/styles/     design tokens + component CSS
  public/         static asset ที่ copy ตรงไปตอน build
public/         ผลลัพธ์จาก build (git ไม่เก็บ — สร้างใหม่ได้เสมอ)
db/schema.sql   schema PostgreSQL ไว้อ้างอิง
scripts/        สคริปต์ช่วย เช่น migrate จาก SQLite เดิม
whisper-patch/  patch ที่ mount ทับ container faster-whisper
uploads/        ไฟล์เสียง/งานนักเรียน (git ไม่เก็บ)
```

---

## ความปลอดภัย

- **`.env` ต้องไม่ขึ้น git เด็ดขาด** — มีคีย์ API จริง รหัสฐานข้อมูล และรหัสผ่านครู
  `.gitignore` กันไว้แล้ว แต่ `git add -f .env` จะทะลุการกันนี้ ห้ามทำ
- `uploads/` เก็บคลิปเสียงและงานของนักเรียนจริง เป็นข้อมูลส่วนบุคคล — git ไม่เก็บโดยตั้งใจ
- ตั้ง `COOKIE_SECURE=true` เมื่อ deploy หลัง HTTPS แล้ว
- เปลี่ยน `TEACHER_PASSWORD` และสุ่ม `SESSION_SECRET` ใหม่ก่อนใช้จริงทุกครั้ง

---

## ข้อจำกัดที่ควรรู้

- Typhoon API เป็น research showcase ไม่ใช่บริการระดับ SLA — ควรมีแผนสำรองเวลา API ล่มหรือติด rate limit
- ไฟล์ Google Drive ต้องตั้ง sharing เป็น "Anyone with the link" ไม่งั้นระบบดึงไม่ได้
- ภาษาไทยถอดเสียงยาก (ไม่เว้นวรรค + วรรณยุกต์) — โมเดล `small` มักเพี้ยนจนอ่านไม่รู้เรื่อง แนะนำ `large-v3-turbo` หรืออย่างน้อย `medium`
- อย่าใช้ความเงียบหรืออาการอ้ำอึ้งในคลิปเป็นตัวชี้วัดหลักเรื่องการโกง — เด็กตื่นเต้นหรือพูดไม่คล่องมีจริง

---

## License

Apache License 2.0 — ดู [LICENSE](LICENSE)
