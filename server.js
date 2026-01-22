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

// --- WAV parser (PCM16) ---
function findChunk(buf, fourcc) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataOff = off + 8;
    if (id === fourcc) return { id, size, dataOff };
    off = dataOff + size + (size % 2);
  }
  return null;
}

function parseWavPcm16(buf) {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  const fmt = findChunk(buf, "fmt ");
  const data = findChunk(buf, "data");
  if (!fmt || !data) return null;

  const audioFormat = buf.readUInt16LE(fmt.dataOff + 0);
  const numChannels = buf.readUInt16LE(fmt.dataOff + 2);
  const sampleRate = buf.readUInt32LE(fmt.dataOff + 4);
  const bitsPerSample = buf.readUInt16LE(fmt.dataOff + 14);

  if (audioFormat !== 1) return null;     // PCM
  if (bitsPerSample !== 16) return null;  // PCM16

  const pcm = buf.subarray(data.dataOff, data.dataOff + data.size);
  return { sampleRate, numChannels, pcm };
}

function stereoToMonoPcm16(stereoPcm) {
  const frames = Math.floor(stereoPcm.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const L = stereoPcm.readInt16LE(i * 4);
    const R = stereoPcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE((L + R) >> 1, i * 2);
  }
  return out;
}

// Linear resample (mono PCM16)
function resamplePcm16MonoLinear(pcm, inRate, outRate) {
  if (inRate === outRate) return pcm;

  const inLen = Math.floor(pcm.length / 2);
  const outLen = Math.floor((inLen * outRate) / inRate);
  const out = Buffer.alloc(outLen * 2);

  for (let i = 0; i < outLen; i++) {
    const t = i * (inRate / outRate);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = t - i0;

    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
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

    // ESP32 -> RAW PCM16 (16k mono) geliyor
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

// ===================== TTS =====================
app.post("/tts", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    const voice = (req.body?.voice || "alloy").toString();
    if (!text) return res.status(400).send("no text");

    const audioResp = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      format: "wav",
      input: text,
    });

    const wavBuf = Buffer.from(await audioResp.arrayBuffer());

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(wavBuf);
  } catch (e) {
    console.error("TTS error:", e?.message || e);
    res.status(500).send("tts_error");
  }
});

    const wavBuf = Buffer.from(await audioResp.arrayBuffer());

    // Parse edebilirsek: PCM16 mono 24000'e normalize et
    const parsed = parseWavPcm16(wavBuf);

    let outWav;

    if (!parsed) {
      // Parse edemediysek bile WAV binary gönder
      outWav = wavBuf;
    } else {
      let { sampleRate, numChannels, pcm } = parsed;

      // stereo -> mono
      if (numChannels === 2) {
        pcm = stereoToMonoPcm16(pcm);
        numChannels = 1;
      }

      // hedef: 24000 Hz (ESP sen de 24000'e kilitledin)
      const TARGET_RATE = 24000;
      if (sampleRate !== TARGET_RATE) {
        pcm = resamplePcm16MonoLinear(pcm, sampleRate, TARGET_RATE);
        sampleRate = TARGET_RATE;
      }

      outWav = pcm16ToWavBuffer(pcm, sampleRate, numChannels);
    }

    // >>> KRİTİK: Chunked olmasın diye Content-Length set et
    res.status(200);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(outWav.length));
    // bazı proxyler için güvenli:
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
