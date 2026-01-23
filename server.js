import express from "express";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

// /stt RAW PCM16 alacağız (ESP32 yolluyor)
app.use("/stt", express.raw({ type: "*/*", limit: "2mb" }));

// /chat ve /tts JSON
app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY yok! Render Environment'a ekle.");
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// Basit RAM içi konuşma hafızası
const memory = new Map(); // sessionId -> [{role, content}, ...]

// ===================== WAV HELPERS =====================
function wavHeaderPCM16({ sampleRate, numChannels, numSamples }) {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function pcm16ToWavBuffer(pcmBuf, sampleRate = 24000, numChannels = 1) {
  const numSamples = Math.floor(pcmBuf.length / 2) / numChannels;
  const header = wavHeaderPCM16({ sampleRate, numChannels, numSamples });
  return Buffer.concat([header, pcmBuf]);
}

// ===================== Health =====================
app.get("/", (req, res) => res.status(200).send("nubi-proxy OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ===================== STT =====================
app.post("/stt", async (req, res) => {
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length < 1000) {
      return res.json({ text: "" });
    }

    // ESP32 -> RAW PCM16 (16k mono) geliyor, WAV'e sar
    const wavBuf = pcm16ToWavBuffer(req.body, 16000, 1);
    const file = await toFile(wavBuf, "audio.wav", { type: "audio/wav" });

    const tr = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
    });

    res.json({ text: (tr.text || "").trim() });
  } catch (e) {
    console.error("STT error:", e?.message || e);
    res.status(500).json({ text: "" });
  }
});

// ===================== CHAT =====================
app.post("/chat", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    const sessionId = (req.body?.sessionId || "nubi1").toString();
    if (!text) return res.json({ reply: "" });

    if (!memory.has(sessionId)) memory.set(sessionId, []);
    const history = memory.get(sessionId);

    history.push({ role: "user", content: text });
    if (history.length > 8) history.splice(0, history.length - 8);

    const sys = {
      role: "system",
      content:
        "Sen NUBI isimli sevimli, kısa konuşan, net cevap veren bir peluş oyuncaksın. Cevapların 1-2 cümleyi geçmesin.",
    };

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [sys, ...history],
      temperature: 0.7,
      max_tokens: 80,
    });

    const reply = (resp.choices?.[0]?.message?.content || "").trim();

    history.push({ role: "assistant", content: reply });
    if (history.length > 8) history.splice(0, history.length - 8);

    res.json({ reply });
  } catch (e) {
    console.error("CHAT error:", e?.message || e);
    res.status(500).json({ reply: "" });
  }
});

// ===================== TTS (KESİN ÇÖZÜM) =====================
// NOT: OpenAI'da parametre adı "response_format".
// Default mp3 döner -> ESP "RIFF yok" diye kalır.
// Biz response_format: "pcm" isteyip WAV header ekleyip GERÇEK WAV döndürüyoruz.
app.post("/tts", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    const voice = (req.body?.voice || "alloy").toString();
    if (!text) return res.status(400).send("no text");

    const TARGET_RATE = 24000;
    const CHANNELS = 1;

    // ✅ PCM16 iste (raw), sonra WAV'e sar
    const audioResp = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "pcm", // ✅ KRİTİK
      // speed: 1.0, // istersen aç
    });

    const pcmBuf = Buffer.from(await audioResp.arrayBuffer());

    // PCM -> WAV (RIFF)
    const outWav = pcm16ToWavBuffer(pcmBuf, TARGET_RATE, CHANNELS);

    // ✅ Chunked olmasın
    res.status(200);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(outWav.length));
    res.setHeader("Connection", "close");
    return res.end(outWav);
  } catch (e) {
    console.error("TTS error:", e?.message || e);
    res.status(500).send("tts_error");
  }
});

app.listen(PORT, () => {
  console.log("Nubi proxy running on port", PORT);
});
