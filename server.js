import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  CW_BASE,
  CW_ACCOUNT_ID,
  CW_API_TOKEN,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID
} = process.env;

// Endpoint che Chatwoot chiamerà
app.post("/chatwoot-bot", async (req, res) => {
  try {
    const ev = req.body;

    // Evita loop e rumore
    if (ev?.event !== "message_created") return res.sendStatus(200);
    if (ev?.message_type !== "incoming") return res.sendStatus(200);

    const content = ev?.content?.trim();
    const conversationId = ev?.conversation?.id;
    if (!content || !conversationId) return res.sendStatus(200);

    // 1) Chiedi risposta TESTUALE all'Agent ElevenLabs
    const el = await fetch(`https://api.elevenlabs.io/v1/agents/${ELEVEN_AGENT_ID}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body: JSON.stringify({ input: content })
    });

    const data = await el.json().catch(() => ({}));
    const reply = data?.reply || "Puoi riformulare la domanda?";

    // 2) Invia la risposta in Chatwoot → inoltro automatico su WhatsApp
    await fetch(`${CW_BASE}/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api_access_token": CW_API_TOKEN
      },
      body: JSON.stringify({
        message_type: "outgoing",
        content: reply
      })
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("BOT ERROR:", err);
    res.sendStatus(200); // non bloccare Chatwoot
  }
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listening on :${PORT}`));
