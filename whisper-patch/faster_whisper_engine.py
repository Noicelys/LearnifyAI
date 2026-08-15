import os
import time
from io import StringIO
from threading import Thread
from typing import BinaryIO, Union

import whisper
from faster_whisper import WhisperModel

from app.asr_models.asr_model import ASRModel
from app.config import CONFIG
from app.utils import ResultWriter, WriteJSON, WriteSRT, WriteTSV, WriteTXT, WriteVTT


# ── ทำไมต้องมีไฟล์นี้ ────────────────────────────────────────────────
# endpoint /asr ของ whisper-asr-webservice เปิดให้ตั้งได้แค่
#   task / language / initial_prompt / vad_filter / word_timestamps / diarize / output
# พารามิเตอร์ตอนถอดเสียงที่เหลือถูกฝังเป็นค่า default ของ faster-whisper ทั้งหมด
# แก้ผ่าน query string ไม่ได้ จึงต้องเปลี่ยนที่ตัว engine แล้ว mount ทับไฟล์เดิมใน container
# (ดู service whisper ใน docker-compose.yml)
#
# ไฟล์นี้ก๊อปมาจากต้นฉบับแล้วแก้เฉพาะ options_dict ในเมท็อด transcribe
# ส่วนอื่นเหมือนเดิมทุกบรรทัด เวลาอัปเกรด image ต้องเทียบกับต้นฉบับใหม่ทุกครั้ง


def _env_float(name, default):
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    # ใส่ "none" ใน .env = ปิดเกณฑ์นั้นไปเลย (faster-whisper รับ None ได้)
    if raw.strip().lower() == "none":
        return None
    return float(raw)


def _env_bool(name, default):
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class FasterWhisperASR(ASRModel):

    def load_model(self):

        self.model = WhisperModel(
            model_size_or_path=CONFIG.MODEL_NAME,
            device=CONFIG.DEVICE,
            compute_type=CONFIG.MODEL_QUANTIZATION,
            download_root=CONFIG.MODEL_PATH
        )

        Thread(target=self.monitor_idleness, daemon=True).start()

    def transcribe(
            self,
            audio,
            task: Union[str, None],
            language: Union[str, None],
            initial_prompt: Union[str, None],
            vad_filter: Union[bool, None],
            word_timestamps: Union[bool, None],
            options: Union[dict, None],
            output,
    ):
        self.last_activity_time = time.time()

        with self.model_lock:
            if self.model is None:
                self.load_model()

        options_dict = {"task": task}
        if language:
            options_dict["language"] = language
        if initial_prompt:
            options_dict["initial_prompt"] = initial_prompt
        if vad_filter:
            options_dict["vad_filter"] = True

            # ── VAD: กันตัดเสียงคนพูดเบา/พูดไม่ชัดทิ้ง ──────────────
            # ค่าเริ่มต้น threshold 0.5 ตัดเสียงกระซิบ/เสียงอู้อี้ทิ้งเป็นช่วง ๆ
            # นักเรียนที่เป็นร้อนในหรือประหม่าจะพูดเบาลงเป็นพัก ๆ ลดลงมาให้ผ่านง่ายขึ้น
            # speech_pad กันหัวคำ/ท้ายคำโดนเฉือน ซึ่งทำให้ถอดผิดทั้งคำ
            options_dict["vad_parameters"] = {
                "threshold": _env_float("WHISPER_VAD_THRESHOLD", 0.35),
                "min_silence_duration_ms": int(_env_float("WHISPER_VAD_MIN_SILENCE_MS", 500)),
                "speech_pad_ms": int(_env_float("WHISPER_VAD_SPEECH_PAD_MS", 400)),
            }

        # ── ตัวหลักที่แก้อาการ "ประโยคซ้ำวนลูป / โผล่ประโยคที่ไม่มีคนพูด" ──
        # ค่าเริ่มต้นเป็น True = เอาข้อความที่ถอดได้ของท่อนก่อนไปเป็นบริบทของท่อนถัดไป
        # พอเสียงไม่ชัดแล้วถอดผิดหนึ่งครั้ง ความผิดจะถูกป้อนต่อเป็นลูกโซ่จนวนซ้ำทั้งคลิป
        # ปิดทิ้ง = แต่ละท่อนถอดอิสระจากกัน เสียความต่อเนื่องของบริบทไปบ้าง
        # แต่แลกกับการที่ความผิดพลาดไม่ลาม ซึ่งคุ้มกว่ามากกับเสียงอัดจากมือถือในห้องเรียน
        options_dict["condition_on_previous_text"] = _env_bool(
            "WHISPER_CONDITION_ON_PREVIOUS_TEXT", False
        )

        # โทษการพ่นคำเดิมซ้ำ ๆ เบา ๆ — 1.0 คือไม่ทำอะไรเลย เกิน 1.15 เริ่มทำให้
        # คำที่ซ้ำโดยธรรมชาติในภาษาไทย (คำซ้ำ, คำลักษณนาม) หายไป
        options_dict["repetition_penalty"] = _env_float("WHISPER_REPETITION_PENALTY", 1.05)

        # ตัวคุมคุณภาพของ faster-whisper เอง เมื่อท่อนไหนไม่ผ่านเกณฑ์จะถอดซ้ำด้วย
        # temperature ที่สูงขึ้นตามลำดับ ค่าพวกนี้เท่าค่าเริ่มต้น ดึงออกมาไว้ตรงนี้
        # เพื่อให้จูนได้จาก .env โดยไม่ต้องแก้โค้ด
        options_dict["compression_ratio_threshold"] = _env_float(
            "WHISPER_COMPRESSION_RATIO_THRESHOLD", 2.4
        )
        options_dict["log_prob_threshold"] = _env_float("WHISPER_LOG_PROB_THRESHOLD", -1.0)
        options_dict["no_speech_threshold"] = _env_float("WHISPER_NO_SPEECH_THRESHOLD", 0.6)

        # ตัดข้อความที่โมเดล "แต่งขึ้นมา" ในช่วงที่จริง ๆ แล้วเงียบ
        # (เสียงลมกระโชกมักถูกตีเป็นเสียงพูดแล้วโมเดลเดาคำใส่มา)
        # ข้อบังคับของ faster-whisper: ใช้ได้เฉพาะเมื่อ word_timestamps = True
        hallucination_threshold = _env_float("WHISPER_HALLUCINATION_SILENCE_S", 2.0)
        if hallucination_threshold:
            options_dict["hallucination_silence_threshold"] = hallucination_threshold
            word_timestamps = True

        if word_timestamps:
            options_dict["word_timestamps"] = True

        with self.model_lock:
            segments = []
            text = ""
            segment_generator, info = self.model.transcribe(audio, beam_size=5, **options_dict)
            for segment in segment_generator:
                segments.append(segment)
                text = text + segment.text
            result = {"language": options_dict.get("language", info.language), "segments": segments, "text": text}

        output_file = StringIO()
        self.write_result(result, output_file, output)
        output_file.seek(0)

        return output_file

    def language_detection(self, audio):

        self.last_activity_time = time.time()

        with self.model_lock:
            if self.model is None: self.load_model()

        # load audio and pad/trim it to fit 30 seconds
        audio = whisper.pad_or_trim(audio)

        # detect the spoken language
        with self.model_lock:
            segments, info = self.model.transcribe(audio, beam_size=5)
            detected_lang_code = info.language
            detected_language_confidence = info.language_probability

        return detected_lang_code, detected_language_confidence

    def write_result(self, result: dict, file: BinaryIO, output: Union[str, None]):
        if output == "srt":
            WriteSRT(ResultWriter).write_result(result, file=file)
        elif output == "vtt":
            WriteVTT(ResultWriter).write_result(result, file=file)
        elif output == "tsv":
            WriteTSV(ResultWriter).write_result(result, file=file)
        elif output == "json":
            WriteJSON(ResultWriter).write_result(result, file=file)
        else:
            WriteTXT(ResultWriter).write_result(result, file=file)
