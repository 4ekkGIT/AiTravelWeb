/* ============================================================
   bot.js — AiTravel Telegram Chat Backend
   
   This Node.js server:
   1. Polls Supabase for new 'user' messages
   2. Forwards them to the admin via Telegram Bot
   3. Listens for admin replies in Telegram
   4. Writes admin replies back to Supabase so the widget picks them up
   
   SETUP INSTRUCTIONS:
   ──────────────────────────────────────────────────────────────
   1. Create a Telegram bot:
      → Open Telegram, message @BotFather
      → Send /newbot, follow the prompts
      → Copy the bot token it gives you → paste into BOT_TOKEN below
   
   2. Get your Telegram admin chat ID:
      → Message @userinfobot in Telegram
      → It will reply with your Chat ID → paste into ADMIN_CHAT_ID below
   
   3. Create the Supabase table:
      Run this SQL in your Supabase SQL editor:
      
      CREATE TABLE chat_messages (
        id          BIGSERIAL PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user','agent','system')),
        text        TEXT NOT NULL,
        user_name   TEXT,
        user_phone  TEXT,
        tour_title  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      
      -- Allow anonymous inserts (widget sends messages without auth)
      ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
      
      CREATE POLICY "allow_insert" ON chat_messages
        FOR INSERT TO anon WITH CHECK (true);
      
      CREATE POLICY "allow_select" ON chat_messages
        FOR SELECT TO anon USING (true);
   
   4. Install dependencies and run:
      npm install node-fetch
      node bot.js
   
   5. (Recommended) Run with PM2 to keep alive:
      npm install -g pm2
      pm2 start bot.js --name aitravel-bot
      pm2 save
   ============================================================ */

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

/* ================================================================
   CONFIG — fill these in!
================================================================ */
const BOT_TOKEN    = '8091452245:AAG0vtSkUVIM8rAEBNiGZXlLhYfmHCTDeHU';   // from @BotFather
const ADMIN_CHAT_ID = '1978427006';    // from @userinfobot

const SUPABASE_URL = 'https://jrvbynjlpjiridumydop.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpydmJ5bmpscGppcmlkdW15ZG9wIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE4NDAxMywiZXhwIjoyMDg5NzYwMDEzfQ.8tQID5sQh4qS-7jYqbck8KYGh7zq7Kfy0MHYx0rmXFY';     // ⚠️ Use SERVICE ROLE key (not publishable) for backend inserts
const CHAT_TABLE   = 'chat_messages';

const POLL_INTERVAL_MS      = 2000;   // Poll Supabase every 2 seconds
const TG_POLL_INTERVAL_MS   = 1500;   // Poll Telegram every 1.5 seconds

/* ================================================================
   STATE
================================================================ */
let lastProcessedMsgId = 0;   // Last Supabase message ID we forwarded to Telegram
let tgOffset           = 0;   // Telegram getUpdates offset
// Maps session_id → { user_name, user_phone, tour_title }
const sessionMeta = {};
// Maps Telegram message_id of the "intro" → session_id
// So when admin replies to a session intro, we know which session to respond to
const tgReplyMap = {};
// Current active session (most recent one) for non-reply Telegram messages
let currentSessionId = null;

/* ================================================================
   SUPABASE HELPERS
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
    body:    JSON.stringify({
      session_id: sessionId,
      role:       'agent',
      text:       text,
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
   TELEGRAM HELPERS
================================================================ */
async function tgRequest(method, params = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram ${method} error:`, data.description);
    return null;
  }
  return data.result;
}

async function sendToAdmin(text, replyMarkup) {
  return await tgRequest('sendMessage', {
    chat_id:    ADMIN_CHAT_ID,
    text:       text,
    parse_mode: 'Markdown',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function getUpdates() {
  return await tgRequest('getUpdates', {
    offset:  tgOffset,
    timeout: 0,
    allowed_updates: ['message'],
  });
}

/* ================================================================
   PROCESS SUPABASE → TELEGRAM
================================================================ */
async function processNewMessages() {
  try {
    const msgs = await fetchUnprocessedMessages();
    for (const msg of msgs) {
      lastProcessedMsgId = Math.max(lastProcessedMsgId, msg.id);

      if (msg.role === 'system') {
        // New chat session started — send intro card to admin
        sessionMeta[msg.session_id] = {
          user_name:  msg.user_name,
          user_phone: msg.user_phone,
          tour_title: msg.tour_title,
        };
        currentSessionId = msg.session_id;

        // Send intro message
        const sent = await sendToAdmin(msg.text);
        if (sent?.message_id) {
          tgReplyMap[sent.message_id] = msg.session_id;
        }

        // Send instructions to admin
        await sendToAdmin(
          `💡 *Как ответить:*\nПросто напишите любое сообщение — оно будет отправлено этому клиенту.\nЧтобы ответить конкретному клиенту (если несколько чатов), используйте команду:\n\`/reply ${msg.session_id} Ваш ответ\``
        );

      } else if (msg.role === 'user') {
        // Regular user message
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
   PROCESS TELEGRAM → SUPABASE (admin replies)
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

      // /reply <session_id> <message>
      if (text.startsWith('/reply ')) {
        const parts   = text.slice(7).split(' ');
        const sessId  = parts[0];
        const reply   = parts.slice(1).join(' ');
        if (sessId && reply) {
          await insertAgentMessage(sessId, reply);
          await sendToAdmin(`✅ Ответ отправлен клиенту`);
        }
        continue;
      }

      // /start or /help
      if (text === '/start' || text === '/help') {
        await sendToAdmin(
          `*AiTravel Bot* 🤖\n\nЯ перенаправляю сообщения с сайта.\n\n*Команды:*\n/reply <session_id> <текст> — ответить конкретному клиенту\n\nИли просто напишите любое сообщение — оно будет отправлено последнему активному клиенту.`
        );
        continue;
      }

      // Plain message → send to current session
      if (currentSessionId) {
        await insertAgentMessage(currentSessionId, text);
        const meta = sessionMeta[currentSessionId];
        const who  = meta?.user_name ? `${meta.user_name} (${meta.user_phone})` : 'клиенту';
        await sendToAdmin(`✅ Отправлено ${who}`);
      } else {
        await sendToAdmin(`⚠️ Нет активного чата. Дождитесь сообщения от клиента.`);
      }
    }
  } catch (e) {
    console.error('processTelegramReplies error:', e);
  }
}

/* ================================================================
   MAIN LOOP
================================================================ */
async function init() {
  console.log('🤖 AiTravel Telegram bot started');
  console.log(`📋 Forwarding to admin chat: ${ADMIN_CHAT_ID}`);

  // Load last processed ID to avoid re-processing old messages on restart
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${CHAT_TABLE}?order=id.desc&limit=1`,
      { headers: sbHeaders() }
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      lastProcessedMsgId = data[0].id;
      console.log(`📌 Starting from message ID: ${lastProcessedMsgId}`);
    }
  } catch (e) {
    console.warn('Could not load last message ID, starting from 0');
  }

  // Notify admin the bot is up
  await sendToAdmin('🟢 *AiTravel бот запущен* — ожидаю сообщений с сайта.');

  // Poll loops
  setInterval(processNewMessages, POLL_INTERVAL_MS);
  setInterval(processTelegramReplies, TG_POLL_INTERVAL_MS);
}

init().catch(console.error);