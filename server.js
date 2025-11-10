// server.js — Chatwoot ↔ ElevenLabs Agent via WebSocket (fallback: simulate-conversation)
import express from "express";
import fetch from "node-fetch";
import WebSocket from "ws";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,

  // Chatwoot
  CW_BASE,
  CW_ACCOUNT_ID,
  CW_API_TOKEN,

  // ElevenLabs
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,

  // URL WebSocket dalla doc ElevenLabs Agents Platform:
  // Imposta *esattamente* quello indicato nella pagina WebSocket della tua org/agent.
  // Es.: wss://api.elevenlabs.io/v1/convai/agents/<AGENT_ID>/ws   (ESEMPIO — metti il tuo reale)
  ELEVEN_WS_URL
} = process.env;

const short = (s, n = 240) => (typeof s === "string" ? s.slice(0, n) : JSON.stringify(s || {}).slice(0, n));

/** ========= 1) Conversazione via WebSocket (text mode) =========== */
function askElevenViaWS(userText, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    if (!ELEVEN_WS_URL) {
      resolve({ ok: false, reason: "NO_WS_URL" });
      return;
    }

    let ws;
    let done = false;
    let buffer = "";

    const finish = (ok, reply, reason) => {
      if (done) return;
      done = true;
      try { ws && ws.readyState === WebSocket.OPEN && ws.close(); } catch {}
      resolve({ ok, reply, reason });
    };

    // Alcune implementazioni richiedono headers con xi-api-key,
    // altre l'autenticazione nel primo messaggio. Gestiamo entrambe.
    const headers = { "xi-api-key": ELEVEN_API_KEY };

    try {
      ws = new WebSocket(ELEVEN_WS_URL, { headers });
    } catch (e) {
      return finish(false, null, "WS_CONNECT_ERROR");
    }

    const t = setTimeout(() => finish(false, null, "TIMEOUT"), timeoutMs);

    ws.on("open", () => {
      // Invia eventuale messaggio di "session/start" o "session_update" se richiesto dalla tua doc.
      // Molte integrazioni accettano subito "user_message" o "client_message" con agent_id.
      const hello = {
        type: "session_start",
        agent_id: ELEVEN_AGENT_ID,
        modalities: ["text"],
        // abilita eventi che vuoi ricevere (coerenti con quanto attivato in UI)
        subscribe_events: ["agent_chat_response_part", "agent_chat_response_completed"]
      };
      try { ws.send(JSON.stringify(hello)); } catch {}

      // Invia il messaggio dell'utente
      const msg = {
        type: "user_message",
        agent_id: ELEVEN_AGENT_ID,
        content: userText
      };
      try { ws.send(JSON.stringify(msg)); } catch {}
    });

    ws.on("message", (data) => {
      let m = null;
      try { m = JSON.parse(String(data)); } catch {}

      // Normalizza: accumula parti testuali parziali
      // Alcuni payload usano campi: event / type / data / text / message / content
      const type = m?.type || m?.event || "";
      const textPart =
        m?.text ?? m?.message ?? m?.content ?? m?.data?.text ?? m?.data?.message ?? null;

      // Arrivano chunk?
      if (type.includes("agent_chat_response_part") || type.includes("response_part") || type.includes("delta")) {
        if (typeof textPart === "string") buffer += textPart;
        return;
      }

      // Fine risposta agente
      if (type.includes("agent_chat_response_completed") || type.includes("response_completed")) {
        clearTimeout(t);
        if (buffer.trim()) return finish(true, buffer.trim());
        // se non hai ricevuto parti, prova a leggere un campo di testo finale
        const finalText = textPart && typeof textPart === "string" ? textPart.trim() : "";
        return finish(!!finalText, finalText || null);
      }

      // Alcune implementazioni inviano direttamente un singolo messaggio "assistant"
      if ((m?.role === "assistant" || m?.sender === "agent") && typeof textPart === "string") {
        clearTimeout(t);
        return finish(true, textPart.trim());
      }
    });

    ws.on("error", () => {
      clearTimeout(t);
      finish(false, null, "WS_ERROR");
    });

    ws.on("close", () => {
      clearTimeout(t);
      if (!done) finish(false, null, "WS_CLOSE");
    });
  });
}

/** ========= 2) Fallback: simulate-conversation (Agents Platform) =========== */
async function askElevenViaSimulate(userText) {
  const url = `https://api.elevenlabs.io/v1/convai/agents/${ELEVEN_AGENT_ID}/simulate-conversation`;
  const payload = {
    simulation_specification: {
      simulated_user_config: {
        first_user_message: userText
      },
      max_turns: 2
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVEN_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  console.log("[ELEVEN simulate]", r.status, "| body:", short(txt));

  if (r.status >= 400 || !Array.isArray(j?.simulated_conversation)) return null;

  const agentTurn = j.simulated_conversation.find(t => t.role === "agent" && typeof t.message === "string");
  return agentTurn?.message || null;
}

/** ========= 3) Orchestratore ========= */
async function getElevenReply(userText) {
  // 1) prova WS
  const wsAns = await askElevenViaWS(userText);
  console.log("[ELEVEN WS]", wsAns.ok ? "OK" : "FAIL", "| reason:", wsAns.reason || "ok", "| reply:", short(wsAns.reply));
  if (wsAns.ok && wsAns.reply) return wsAns.reply;

  // 2) fallback simulate
  const simAns = await askElevenViaSimulate(userText);
  if (simAns) return simAns;

  return null;
}

/** ========= 4) Webhook Chatwoot ========= */
app.post("/chatwoot-bot", async (req, res) => {
  try {
    const ev = req.body || {};
    const e = ev?.data ? ev.data : ev;

    console.log("[WEBHOOK]", ev?.event || e?.event, "| type:", e?.message_type, "| conv:", e?.conversation?.id);

    if ((ev?.event || e?.event) !== "message_created") return res.sendStatus(200);
    if (e?.message_type !== "incoming") return res.sendStatus(200);

    const content = (e?.content || "").trim();
    const conversationId = e?.conversation?.id;
    if (!content || !conversationId) return res.sendStatus(200);

    let reply = await getElevenReply(content);
    if (!reply) reply = "Ciao! Dimmi pure come posso aiutarti 🙂";

    // invia risposta in Chatwoot (inoltro su WhatsApp)
    const cwUrl = `${CW_BASE}/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${conversationId}/messages`;
    const cw = await fetch(cwUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api_access_token": CW_API_TOKEN
      },
      body: JSON.stringify({ message_type: "outgoing", content: reply })
    });
    const cwTxt = await cw.text();
    console.log("[CHATWOOT POST]", cw.status, "| body:", short(cwTxt));

    return res.sendStatus(200);
  } catch (err) {
    console.error("BOT ERROR", err);
    return res.sendStatus(200);
  }
});

/** ========= 5) Routes utili ========= */
app.get("/", (_req, res) => res.status(200).send("OK"));
app.post("/", (req, res, next) => { req.url = "/chatwoot-bot"; next(); });

app.listen(PORT, () => {
  console.log(`Bot listening on :${PORT}`);
  if (!ELEVEN_WS_URL) console.warn("[WARN] ELEVEN_WS_URL non impostato: la WS non partirà (userò solo simulate).");
});

