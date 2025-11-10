// server.js
// Chatwoot (webhook) ↔ ElevenLabs Conversational AI ↔ Chatwoot (API) → WhatsApp

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

const short = (s, n = 160) => (typeof s === "string" ? s.slice(0, n) : s);

// Mappa: conversationId Chatwoot -> conversationId ElevenLabs (convai)
const cwToEleven = new Map();

/** ---- helper: chiama endpoint "semplice" (se disponibile) ---- */
async function elevenSimpleRespond(text) {
  const url = `https://api.elevenlabs.io/v1/agents/${ELEVEN_AGENT_ID}/respond`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVEN_API_KEY
    },
    body: JSON.stringify({ input: text })
  });
  let j = {};
  try { j = await r.json(); } catch {}
  return { status: r.status, data: j };
}

/** ---- helper: crea/recupera una conversation convai ---- */
async function elevenEnsureConversation(cwConvId) {
  // se già esiste, la riuso
  if (cwToEleven.has(cwConvId)) return cwToEleven.get(cwConvId);

  // creo nuova conversation
  const r = await fetch("https://api.elevenlabs.io/v1/convai/conversations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVEN_API_KEY
    },
    body: JSON.stringify({ agent_id: ELEVEN_AGENT_ID })
  });
  const j = await r.json().catch(() => ({}));
  const elevenConvId = j?.conversation_id || j?.id;
  if (elevenConvId) cwToEleven.set(cwConvId, elevenConvId);
  return elevenConvId;
}

/** ---- helper: invia un messaggio e ottieni la reply testuale (convai) ---- */
async function elevenConvaiReply(cwConvId, userText) {
  const elevenConvId = await elevenEnsureConversation(cwConvId);
  if (!elevenConvId) {
    return { ok: false, reply: null, info: "no_conversation" };
  }

  // invio messaggio utente
  const send = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${elevenConvId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVEN_API_KEY
    },
    body: JSON.stringify({ role: "user", content: userText })
  });

  const jsend = await send.json().catch(() => ({}));

  // molte risposte convai includono direttamente la reply dell'assistente
  let reply = jsend?.assistant_response || jsend?.reply;

  // altrimenti cerca l'ultimo messaggio con role=assistant
  if (!reply && Array.isArray(jsend?.messages)) {
    const lastAssistant = [...jsend.messages].reverse().find(m => m.role === "assistant");
    reply = lastAssistant?.content;
  }

  return { ok: !!reply, reply, info: jsend };
}

/** ---- handler principale webhook Chatwoot ---- */
const chatwootHandler = async (req, res) => {
  try {
    const ev = req.body || {};
    const e = ev?.data ? ev.data : ev;

    console.log("[WEBHOOK]", ev?.event || e?.event, "| type:", e?.message_type, "| conv:", e?.conversation?.id);

    const eventName = ev?.event || e?.event;
    if (eventName !== "message_created") return res.sendStatus(200);
    if (e?.message_type !== "incoming") return res.sendStatus(200);

    const content = (e?.content || "").trim();
    const conversationId = e?.conversation?.id;
    if (!content || !conversationId) {
      console.log("[SKIP] content/convId mancanti");
      return res.sendStatus(200);
    }

    // ---- 1) PROVA endpoint "semplice" ----
    let finalReply = null;

    try {
      const simple = await elevenSimpleRespond(content);
      console.log("[ELEVEN(simple)] status:", simple.status, "| raw:", short(JSON.stringify(simple.data)));

      if (simple.status < 400 && (simple.data?.reply || simple.data?.text)) {
        finalReply = simple.data.reply || simple.data.text;
      } else if (simple.status === 404) {
        // ---- 2) FALLBACK convai (ufficiale per chat) ----
        const conv = await elevenConvaiReply(conversationId, content);
        console.log("[ELEVEN(convai)] ok:", conv.ok, "| raw:", short(JSON.stringify(conv.info)));
        if (conv.ok) finalReply = conv.reply;
      }
    } catch (err) {
      console.log("[ELEVEN ERROR]", err?.message);
    }

    if (!finalReply) {
      finalReply = "Ok! Sono qui 👍 Dimmi pure: come posso aiutarti?";
    }

    // ---- 3) invia la risposta in Chatwoot ----
    const cwUrl = `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${conversationId}/messages`;
    const cwResp = await fetch(cwUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api_access_token": CW_API_TOKEN
      },
      body: JSON.stringify({
        message_type: "outgoing",
        content: finalReply
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

// ---- routes ----
app.post("/chatwoot-bot", chatwootHandler);
app.get("/", (_req, res) => res.status(200).send("OK"));
app.post("/", (req, res, next) => { req.url = "/chatwoot-bot"; next(); });

app.listen(PORT, () => {
  console.log(`Bot listening on :${PORT}`);
  if (!CW_BASE || !CW_ACCOUNT_ID || !CW_API_TOKEN) console.warn("[WARN] Manca CW_* env.");
  if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID) console.warn("[WARN] Manca ELEVEN_* env.");
});
