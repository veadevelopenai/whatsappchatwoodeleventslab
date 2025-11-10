// server.js — Chatwoot ↔ ElevenLabs (Conversational Chat) ↔ WhatsApp
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Variabili ambiente da Railway
const {
  PORT = 3000,
  CW_BASE,
  CW_ACCOUNT_ID,
  CW_API_TOKEN,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,
  ELEVEN_CHAT_URL // opzionale: URL completo personalizzato dalla dashboard ElevenLabs
} = process.env;

const short = (s, n = 240) =>
  typeof s === "string" ? s.slice(0, n) : JSON.stringify(s || {}).slice(0, n);

// -------------------- FUNZIONE: richiesta a ElevenLabs --------------------
async function getElevenReply(content) {
  const endpoint =
    ELEVEN_CHAT_URL ||
    `https://api.elevenlabs.io/v1/convai/agents/${ELEVEN_AGENT_ID}/message`;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body: JSON.stringify({ content })
    });

    const text = await resp.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}

    console.log(
      "[ELEVEN message] status:",
      resp.status,
      "| body:",
      text.slice(0, 240)
    );

    // Se risponde correttamente
    if (resp.status < 400) {
      return (
        json.assistant_response ||
        json.reply ||
        json.text ||
        json.message ||
        null
      );
    }

    // Se errore o 404
    return null;
  } catch (err) {
    console.error("[ELEVEN ERROR]", err.message);
    return null;
  }
}

// -------------------- HANDLER PRINCIPALE (Chatwoot Webhook) --------------------
const chatwootHandler = async (req, res) => {
  try {
    const ev = req.body || {};
    const e = ev?.data ? ev.data : ev;

    console.log(
      "[WEBHOOK]",
      ev?.event || e?.event,
      "| type:",
      e?.message_type,
      "| conv:",
      e?.conversation?.id
    );

    const eventName = ev?.event || e?.event;
    if (eventName !== "message_created") return res.sendStatus(200);
    if (e?.message_type !== "incoming") return res.sendStatus(200);

    const content = (e?.content || "").trim();
    const conversationId = e?.conversation?.id;
    if (!content || !conversationId) {
      console.log("[SKIP] content/convId mancanti");
      return res.sendStatus(200);
    }

    // Ottieni risposta da ElevenLabs
    let reply = await getElevenReply(content);
    if (!reply)
      reply = "Ciao! 👋 Dimmi pure come posso aiutarti.";

    // Invia la risposta a Chatwoot (che inoltra su WhatsApp)
    const cwUrl = `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${conversationId}/messages`;
    const cwResp = await fetch(cwUrl, {
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

    const cwText = await cwResp.text();
    console.log("[CHATWOOT POST] status:", cwResp.status, "| body:", short(cwText));

    return res.sendStatus(200);
  } catch (err) {
    console.error("BOT ERROR:", err);
    return res.sendStatus(200);
  }
};

// -------------------- ROUTES --------------------
app.post("/chatwoot-bot", chatwootHandler);
app.get("/", (_req, res) => res.status(200).send("OK"));
app.post("/", (req, res, next) => { req.url = "/chatwoot-bot"; next(); });

app.listen(PORT, () => {
  console.log(`Bot listening on port ${PORT}`);
  if (!CW_BASE || !CW_API_TOKEN) console.warn("[WARN] Manca configurazione Chatwoot");
  if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID) console.warn("[WARN] Manca configurazione ElevenLabs");
});
