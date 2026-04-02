import express from "express";
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/* ================================================================
   CONFIG (из Railway Variables)
================================================================ */
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const CHAT_TABLE = 'chat_messages';

const POLL_INTERVAL_MS    = 2000;
const TG_POLL_INTERVAL_MS = 1500;

/* ================================================================
   STATE
================================================================ */
let lastProcessedMsgId = 0;
let tgOffset           = 0;

const sessionMeta = {};
const tgReplyMap  = {};
let currentSessionId = null;

/* ================================================================
   EXPRESS (для Railway)
================================================================ */
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

/* ================================================================
   SUPABASE
================================================================ */
function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };
}

async function fetchUnprocessedMessages() {
  const url = `${SUPABASE_URL}/rest/v1/${CHAT_TABLE}`
    + `?id=gt.${lastProcessedMsgId}`
    + `&role=in.(user,system)`
    + `&order=id.asc`;

  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return [];
  return await res.json();
}

async function insertAgentMessage(sessionId, text) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${CHAT_TABLE}`, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      session_id: sessionId,
      role: 'agent',
      text: text,
    }),
  });

  if (!res.ok) {
    console.error('insertAgentMessage failed:', await res.text());
    return null;
  }

  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/* ================================================================
   TELEGRAM
================================================================ */
async function tgRequest(method, params = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await res.json();

  if (!data.ok) {
    console.error(`Telegram ${method} error:`, data.description);
    return null;
  }

  return data.result;
}

async function sendToAdmin(text) {
  return await tgRequest('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    parse_mode: 'Markdown',
  });
}

async function getUpdates() {
  return await tgRequest('getUpdates', {
    offset: tgOffset,
    timeout: 0,
    allowed_updates: ['message'],
  });
}

/* ================================================================
   SUPABASE → TELEGRAM
================================================================ */
async function processNewMessages() {
  try {
    const msgs = await fetchUnprocessedMessages();

    for (const msg of msgs) {
      lastProcessedMsgId = Math.max(lastProcessedMsgId, msg.id);

      if (msg.role === 'system') {
        sessionMeta[msg.session_id] = {
          user_name: msg.user_name,
          user_phone: msg.user_phone,
          tour_title: msg.tour_title,
        };

        currentSessionId = msg.session_id;

        await sendToAdmin(msg.text);

        await sendToAdmin(
          `💡 *Как ответить:*\nПросто напишите сообщение — оно уйдёт клиенту.\n\nИли:\n\`/reply ${msg.session_id} текст\``
        );

      } else if (msg.role === 'user') {
        const meta = sessionMeta[msg.session_id] || {};

        const label = meta.user_name
          ? `👤 *${meta.user_name}* (${meta.user_phone})`
          : `👤 Клиент`;

        let text = `${label}:\n${msg.text}`;
        if (msg.tour_title) text += `\n\n_Тур: ${msg.tour_title}_`;

        await sendToAdmin(text);
        currentSessionId = msg.session_id;
      }
    }

  } catch (e) {
    console.error('processNewMessages error:', e);
  }
}

/* ================================================================
   TELEGRAM → SUPABASE
================================================================ */
async function processTelegramReplies() {
  try {
    const updates = await getUpdates();
    if (!updates || !updates.length) return;

    for (const update of updates) {
      tgOffset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (msg.chat.id.toString() !== ADMIN_CHAT_ID.toString()) continue;

      const text = msg.text.trim();

      if (text.startsWith('/reply ')) {
        const parts  = text.slice(7).split(' ');
        const sessId = parts[0];
        const reply  = parts.slice(1).join(' ');

        if (sessId && reply) {
          await insertAgentMessage(sessId, reply);
          await sendToAdmin(`✅ Ответ отправлен`);
        }

        continue;
      }

      if (text === '/start' || text === '/help') {
        await sendToAdmin(
          `*AiTravel Bot* 🤖\n\n/reply <session_id> текст\nили просто пиши`
        );
        continue;
      }

      if (currentSessionId) {
        await insertAgentMessage(currentSessionId, text);
        await sendToAdmin(`✅ Отправлено`);
      } else {
        await sendToAdmin(`⚠️ Нет активного чата`);
      }
    }

  } catch (e) {
    console.error('processTelegramReplies error:', e);
  }
}

/* ================================================================
   INIT
================================================================ */
async function init() {
  console.log('🤖 Bot started');

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${CHAT_TABLE}?order=id.desc&limit=1`,
      { headers: sbHeaders() }
    );

    const data = await res.json();

    if (Array.isArray(data) && data.length) {
      lastProcessedMsgId = data[0].id;
    }

  } catch (e) {
    console.warn('Init warning:', e);
  }

  await sendToAdmin('🟢 Бот запущен');

  setInterval(processNewMessages, POLL_INTERVAL_MS);
  setInterval(processTelegramReplies, TG_POLL_INTERVAL_MS);
}

init().catch(console.error);

/* ================================================================
   SAFETY
================================================================ */
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});