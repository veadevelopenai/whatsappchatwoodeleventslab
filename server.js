// server.js
// Bot ponte: Chatwoot (webhook) ↔ ElevenLabs Agent ↔ Chatwoot (API) → WhatsApp

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- ENV --------------------------------------------------------------------
const {
  PORT = 3000,
  CW_BASE,           // es: https://chatwoot-production-b47d.up.railway.app
  CW_ACCOUNT_ID,     // es: 1
  CW_API_TOKEN,      // Settings → Access Tokens in Chatwoot
  ELEVEN_API_KEY,    // ElevenLabs API key
  ELEVEN_AGENT_ID    // es: agent_xxxxx
} = process.env;

// Piccolo helper per log brevi
const short = (s, n = 160) => (typeof s === "string" ? s.slice(0, n) : s);

// --- HANDLER PRINCIPALE -----------------------------------------------------
const chatwootHandler = async (req, res) => {
  try {
    const ev = req.body || {};
    // Chatwoot spesso incapsula i dati in ev.data
    const e = ev?.data ? ev.data : ev;

    console.log("[WEBHOOK]",
      ev?.event || e?.event,
      "| type:", e?.message_type,
      "| conv:", e?.conversation?.id
    );

    // Processa solo messaggi IN ARRIVO
    const eventName = ev?.event || e?.event;
    if (eventName !== "message_created") return res.sendStatus(200);
    if (e?.message_type !== "incoming") return res.sendStatus(200);

    const content = (e?.content || "").trim();
    const conversationId = e?.conversation?.id;

    if (!content || !conversationId) {
      console.log("[SKIP] content/convId mancanti");
      return res.sendStatus(200);
    }

    // --- 1) Chiedi risposta TESTUALE all'Agent ElevenLabs -------------------
    // ⚠️ Endpoint indicativo per Agents/Conversational AI.
    // Sostituiscilo se nel tuo account l'endpoint è diverso.
    const elResp = await fetch(
      `https://api.elevenlabs.io/v1/agents/${ELEVEN_AGENT_ID}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVEN_API_KEY
        },
        body: JSON.stringify({ input: content })
      }
    );

    let elJson = {};
    try { elJson = await elResp.json(); } catch { elJson = {}; }
    const reply =
      elJson?.reply ||
      "Posso aiutarti, puoi riformulare la domanda?";

    console.log("[ELEVENLABS] status:", elResp.status, "| reply:", short(reply));

    // --- 2) Invia la risposta su Chatwoot (verrà inoltrata su WhatsApp) -----
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

    // Rispondi sempre 200 a Chatwoot (evita retry)
    return res.sendStatus(200);
  } catch (err) {
    console.error("BOT ERROR:", err);
    return res.sendStatus(200);
  }
};

// --- ROUTES -----------------------------------------------------------------
// Endpoint ufficiale del webhook Chatwoot
app.post("/chatwoot-bot", chatwootHandler);

// Healthcheck + fallback per ping alla root
app.get("/", (_req, res) => res.status(200).send("OK"));
// Se Chatwoot (o qualcuno) fa POST "/" per sbaglio, reindirizza all'handler
app.post("/", (req, res, next) => { req.url = "/chatwoot-bot"; next(); });

// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Bot listening on :${PORT}`);
  if (!CW_BASE || !CW_ACCOUNT_ID || !CW_API_TOKEN) {
    console.warn("[WARN] Manca qualche variabile Chatwoot (CW_BASE/CW_ACCOUNT_ID/CW_API_TOKEN).");
  }
  if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID) {
    console.warn("[WARN] Manca ELEVEN_API_KEY o ELEVEN_AGENT_ID.");
  }
});
