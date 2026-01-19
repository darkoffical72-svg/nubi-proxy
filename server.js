import express from "express";

const app = express();

// ESP32 JSON yollayacak: { audio_b64: "...", mime: "audio/wav" } gibi
app.use(express.json({ limit: "12mb" }));

// Health check
app.get("/", (req, res) => {
  res.status(200).send("nubi-proxy OK");
});

// Basit proxy endpoint (şimdilik test)
app.post("/ping", (req, res) => {
  res.json({ ok: true, msg: "pong", time: Date.now() });
});

// Render PORT
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Nubi proxy running on port", PORT);
});
