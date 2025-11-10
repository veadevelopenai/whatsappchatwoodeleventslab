// server.js — Chatwoot ↔ ElevenLabs (multi-strategy) ↔ Chatwoot
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

const short = (s, n = 240) =>
  typeof s === "string" ? s.slice(0, n) : JSON.stringify(s || {}).slice(0, n);

// -------------------- ELEVEN HELPERS --------------------
async function elevenSimpleRespond(text) {
  const url = `https://api.elevenlabs.io/v1/agents/${ELEVEN_AGENT_ID}/respond`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": ELEVEN_API_KEY },
    body: JSON.stringify({ input: text })
  });
  let j = {};
  try { j = await r.json(); } catch {}
  return { status: r.status, data: j };
}

// Variante A: create conversation (convai) + message
async function convaiCreateConversation() {
  const url = "https://api.elevenlabs.io/v1/convai/conversations";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": ELEVEN_API_KEY },
    body: JSON.stringify({ agent_id: ELEVEN_AGENT_ID })
  });
  const bodyText = await r.text();
  let j = {};
  try { j = JSON.parse(bodyText); } catch {}
  const id = j?.conversation_id || j?.id;
  console.log("[CONVAI create] status:", r.status, "| body:", short(bodyText));
  return { status: r.status, id, raw: j };
}

async function convaiSendMessage(conversationId, userText) {
  const url = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": ELEVEN_API_KEY },
    body: JSON.stringify({ role: "user", content: userText })
  });
  const bodyText = await r.text();
  let j = {};
  try { j = JSON.parse(bodyText); } catch {}
  console.log("[CONVAI message] status:", r.status, "| body:", short(bodyText));
  // prova estrazione reply
  let reply = j?.assistant_response || j?.reply;
  if (!reply && Array.isArray(j?.messages)) {
    const last = [...j.messages].reverse().find(m => m.role === "assistant");
    reply = last?.content;
  }
  return { status: r.status, reply, raw: j };
}

// Variante B (fallback): endpoint “direct message senza conversation”
async function convaiAgentDirectMessage(userText) {
  const url = `https://api.elevenlabs.io/v1/convai/agents/${ELEVEN_AGENT_ID}/message`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": ELEVEN_API_KEY },
    body: JSON.stringify({ content: userText })
  });
  const bodyText = await r.text();
  let j = {};
  try { j = JSON.parse(bodyText); } catch {}
  console.log("[CONVAI direct] status:", r.status, "| body:", short(bodyText));
  const reply = j?.assistant_response || j?.reply || j?.text || j?.message;
  return { status: r.status, reply, raw: j };
}

// -------------------- CHATWOOT HANDLER --------------------
const chatwootHandler = async (req, res) => {
  try {
    const ev = req.body || {};
    const e = ev?.data ? ev.data : ev;

    console.log(
      "[WEBHOOK]",
      ev?.event || e?.event,
      "| type:", e?.message_type,
      "| conv:", e?.conversation?.id
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

    let finalReply = null;

    // 1) Tentativo “simple”
    try {
      const simple = await elevenSimpleRespond(content);
      console.log("[ELEVEN(simple)] status:", simple.status, "| raw:", short(simple.data));
      if (simple.status < 400 && (simple.data?.reply || simple.data?.text)) {
        finalReply = simple.data.reply || simple.data.text;
      }
    } catch (err) {
      console.log("[ELEVEN(simple) ERROR]", err?.message);
    }

    // 2) Se non abbiamo reply, convai: create + message
    if (!finalReply) {
      const create = await convaiCreateConversation();
      if (create.id) {
        const msg = await convaiSendMessage(create.id, content);
        if (msg.reply) finalReply = msg.reply;
      } else if (create.status === 404 || create.status === 400) {
        // 3) Fallback: direct message (senza conversation persistente)
        const direct = await convaiAgentDirectMessage(content);
        if (direct.reply) finalReply = direct.reply;
      }
    }

    // 4) Se ancora nulla, rispondi con fallback gentile
    if (!finalReply) {
      finalReply = "Sono qui! Dimmi pure come posso aiutarti 🙂";
    }

    // 5) Invia su Chatwoot (che inoltra su WhatsApp)
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

// -------------------- ROUTES --------------------
app.post("/chatwoot-bot", chatwootHandler);
app.get("/", (_req, res) => res.status(200).send("OK"));
app.post("/", (req, res, next) => { req.url = "/chatwoot-bot"; next(); });

app.listen(PORT, () => {
  console.log(`Bot listening on :${PORT}`);
  if (!CW_BASE || !CW_ACCOUNT_ID || !CW_API_TOKEN) console.warn("[WARN] Manca CW_* env.");
  if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID) console.warn("[WARN] Manca ELEVEN_* env.");
});
