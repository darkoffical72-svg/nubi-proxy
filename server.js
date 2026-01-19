import express from "express";

const app = express();

// ------------------- CONFIG -------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Render health
app.get("/", (req, res) => res.status(200).send("nubi-proxy OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Basit test
app.post("/ping", express.json({ limit: "50kb" }), (req, res) => {
  res.json({ ok: true, msg: "pong", time: Date.now() });
});

// ------------------- BODY PARSERS -------------------
// /stt: ESP32 raw pcm16 yollayacak (application/octet-stream)
app.use("/stt", express.raw({ type: "*/*", limit: "4mb" }));

// /chat ve /tts: JSON
app.use(express.json({ limit: "300kb" }));

// ------------------- SIMPLE MEMORY (RAM) -------------------
// sessionId -> [{role, content}, ...]
const memory = new Map();
function getSession(sessionId = "default") {
  if (!memory.has(sessionId)) memory.set(sessionId, []);
  return memory.get(sessionId);
}

// ------------------- HELPERS -------------------
async function openaiFetch(url, payload, extraHeaders = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing (set Render Env Var)");
  }
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  return r;
}

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
  buf.writeUInt32LE(16, 16); // PCM
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample

  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// ------------------- ROUTES -------------------

// 1) STT: RAW PCM16 -> Text
// ESP32: POST /stt  (body = pcm16 bytes, 16kHz mono)
// Query: ?sr=16000  (opsiyonel)
// Header: X-Session-Id: abc (opsiyonel)
app.post("/stt", async (req, res) => {
  try {
    const sr = Number(req.query.sr || 16000);
    const pcm = req.body; // Buffer

    if (!pcm || !Buffer.isBuffer(pcm) || pcm.length < 100) {
      return res.status(400).json({ error: "pcm_missing_or_too_small" });
    }

    // PCM16 mono -> WAV ekle
    const numSamples = Math.floor(pcm.length / 2);
    const wavHeader = wavHeaderPCM16({
      sampleRate: sr,
      numChannels: 1,
      numSamples,
    });
    const wav = Buffer.concat([wavHeader, pcm]);

    // OpenAI STT (Whisper)
    // multipart/form-data gerekiyor
    const form = new FormData();
    const blob = new Blob([wav], { type: "audio/wav" });
    form.append("file", blob, "audio.wav");
    form.append("model", "whisper-1");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(500).json({ error: "stt_failed", detail: errTxt });
    }

    const j = await r.json();
    const text = (j && j.text) ? String(j.text) : "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: "stt_exception", detail: String(e) });
  }
});

// 2) CHAT: {text, sessionId} -> {reply}
app.post("/chat", async (req, res) => {
  try {
    const text = req.body?.text ? String(req.body.text) : "";
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : "default";
    if (!text) return res.status(400).json({ error: "text_missing" });

    const history = getSession(sessionId);

    // Basit prompt + hafıza
    const messages = [
      { role: "system", content: "Sen Nubi'sin: sevecen, kısa ve net cevap ver. Türkçe konuş." },
      ...history,
      { role: "user", content: text },
    ];

    const r = await openaiFetch("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages,
      temperature: 0.6,
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(500).json({ error: "chat_failed", detail: errTxt });
    }

    const j = await r.json();
    const reply = j?.choices?.[0]?.message?.content ? String(j.choices[0].message.content) : "";

    // hafızaya ekle (kısa tut)
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    if (history.length > 12) history.splice(0, history.length - 12);

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "chat_exception", detail: String(e) });
  }
});

// 3) TTS: {text} -> {audio_b64, format:"pcm16", sample_rate:16000}
app.post("/tts", async (req, res) => {
  try {
    const text = req.body?.text ? String(req.body.text) : "";
    if (!text) return res.status(400).json({ error: "text_missing" });

    const r = await openaiFetch("https://api.openai.com/v1/audio/speech", {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "pcm16",   // <<< KRITIK: MP3 degil
      input: text,
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(500).json({ error: "tts_failed", detail: errTxt });
    }

    const ab = await r.arrayBuffer();
    const b64 = Buffer.from(ab).toString("base64");

    res.json({
      audio_b64: b64,
      format: "pcm16",
      sample_rate: 16000,
    });
  } catch (e) {
    res.status(500).json({ error: "tts_exception", detail: String(e) });
  }
});

// ------------------- START -------------------
app.listen(PORT, () => {
  console.log("Nubi proxy running on port", PORT);
});
