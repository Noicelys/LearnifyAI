# Web build — Vite compiles web/ into public/, which the server serves as static files
FROM node:20-alpine AS web
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY vite.config.mjs ./
COPY scripts ./scripts
COPY web ./web
RUN npm run build

# Backend + Web — Node.js + Express + PostgreSQL
FROM node:20-alpine

# ffmpeg = แปลงไฟล์เสียง/วิดีโอเป็น wav ก่อนส่งให้ whisper กัน mp4 moov-atom-ท้ายไฟล์ decode พัง
# ไม่ต้องมี python3/make/g++ แล้ว เพราะเลิกใช้ native module (better-sqlite3) ไปตอนย้ายมา PostgreSQL
RUN apk add --no-cache ffmpeg

WORKDIR /app

# copy manifest ก่อน เพื่อให้ layer cache ทำงาน (ไม่ต้อง npm ci ใหม่ทุกครั้งที่แก้โค้ด)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=web /build/public ./public

# mount ทับด้วย volume ใน compose แต่สร้างไว้เผื่อรัน image เดี่ยวๆ
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
