import express from "express";

const app = express();

// /stt için RAW binary alacağız (pcm16 stream)
app.use("/stt", express.raw({ type: "*/*", limit: "2mb" }));
// /chat için JSON
app.use(express.json({ limit: "200kb" }));

app.get("/", (req, res) => res.status(200).send("nubi-proxy OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Basit RAM içi konuşma hafızası (free plan restart edince sıfırlanır, normal)
const memory = new Map(); // sessionId -> [{role,content},...]

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
  buf.writeUInt32LE(16, 16);            // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);            // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  return buf;
}

// ===== STT: ESP32 PCM16 (mono, 16k) -> text =====
app.post("/stt", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const session = (req.header("X-Session") || "default").toString();
    const sr = parseInt(req.header("X-Sample-Rate") || "16000", 10);
    const ch = parseInt(req.header("X-Channels") || "1", 10);

    const pcm = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (pcm.length < 2000) return res.json({ text: "" }); // çok kısa -> boş say

    const numSamples = Math.floor(pcm.length / 2 / ch);
    const hdr = wavHeaderPCM16({ sampleRate: sr, numChannels: ch, numSamples });
    const wav = Buffer.concat([hdr, pcm]);

    // multipart form
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "stt_failed", detail: t.slice(0, 400) });
    }

    const j = await r.json();
    const text = (j.text || "").toString().trim();

    // session'a user cümlesini de kaydedelim (boş değilse)
    if (text) {
      const hist = memory.get(session) || [];
      hist.push({ role: "user", content: text });
      // hafıza şişmesin diye son 12 mesaj
      while (hist.length > 12) hist.shift();
      memory.set(session, hist);
    }

    return res.json({ text });
  } catch (e) {
    return res.status(500).json({ error: "stt_exception", detail: String(e) });
  }
});

// ===== CHAT: text -> reply text (hafızalı) =====
app.post("/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const session = (req.body?.session || "default").toString();
    const userText = (req.body?.text || "").toString().trim();
    if (!userText) return res.json({ reply: "" });

    const hist = memory.get(session) || [];
    // Sistem davranışı: kısa, samimi, oyuncak.
    const system = {
      role: "system",
      content:
        "Sen Nubi'sin: samimi, neşeli, kısa konuşan, çocuklara uygun bir peluş asistan. Gereksiz uzun cevap verme. 1-2 cümle yeter.",
    };

    const input = [system, ...hist, { role: "user", content: userText }];

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "chat_failed", detail: t.slice(0, 400) });
    }

    const j = await r.json();
    // responses format: output_text bazen var; yoksa basit çıkaralım
    const reply =
      (j.output_text || "").toString().trim() ||
      (j.output?.[0]?.content?.[0]?.text || "").toString().trim();

    if (reply) {
      hist.push({ role: "assistant", content: reply });
      while (hist.length > 12) hist.shift();
      memory.set(session, hist);
    }

    return res.json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "chat_exception", detail: String(e) });
  }
});

// ===== TTS: reply text -> PCM16 audio =====
app.post("/tts", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        format: "pcm16",
        input: text,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "tts_failed", detail: t.slice(0, 400) });
    }

    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/pcm");
    res.setHeader("X-Audio-Rate", "24000");
    return res.status(200).send(audio);
  } catch (e) {
    return res.status(500).json({ error: "tts_exception", detail: String(e) });
  }
});

app.listen(PORT, () => console.log("Nubi proxy running on port", PORT));
