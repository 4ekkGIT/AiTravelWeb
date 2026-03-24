/* ============================================================
   chat.js — Telegram-connected live chat widget
   
   HOW IT WORKS:
   1. User clicks any "chat" button (or a tour's "Связаться с агентом")
   2. User fills name + phone (step 1 form)
   3. A session_id is created and messages are stored in Supabase
   4. Backend bot polls Supabase and forwards messages to admin via Telegram
   5. Admin replies in Telegram → bot writes reply to Supabase → widget polls and shows it
   
   SETUP: See backend/bot.js for the Node.js Telegram bot server.
   ============================================================ */

const AiTravelChat = (() => {

  /* ================================================================
     CONFIG — fill these in
  ================================================================ */
  const SUPABASE_URL = 'https://jrvbynjlpjiridumydop.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_VVymyHB40jv7fOC180fFOQ_Qk1PCWUb';
  const CHAT_TABLE   = 'chat_messages';   // Supabase table (see schema below)
  const POLL_INTERVAL_MS = 3000;          // How often to poll for new agent messages

  /* ================================================================
     STATE
  ================================================================ */
  let sessionId       = null;   // Unique ID per chat session
  let selectedTour    = null;   // { title, country, price, currency } | null
  let userName        = '';
  let userPhone       = '';
  let pollTimer       = null;
  let lastMsgId       = 0;
  let unreadCount     = 0;
  let isOpen          = false;
  let started         = false;  // Whether user passed the name/phone form

  /* ================================================================
     SUPABASE HELPERS
  ================================================================ */
  function sbHeaders() {
    return {
      'Content-Type': 'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    };
  }

  async function insertMessage(payload) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${CHAT_TABLE}`, {
      method:  'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }

  async function fetchNewMessages() {
    const url = `${SUPABASE_URL}/rest/v1/${CHAT_TABLE}`
      + `?session_id=eq.${sessionId}`
      + `&id=gt.${lastMsgId}`
      + `&role=eq.agent`
      + `&order=id.asc`;
    const res = await fetch(url, { headers: sbHeaders() });
    if (!res.ok) return [];
    return await res.json();
  }

  /* ================================================================
     DOM HELPERS
  ================================================================ */
  function el(id) { return document.getElementById(id); }

  function timeStr() {
    const d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }

  function appendMsg(text, role, time) {
    const list = document.querySelector('.chat-messages-list');
    if (!list) return;
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    div.innerHTML = `${escHtml(text)}<div class="chat-msg-time">${time || timeStr()}</div>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  function appendSystem(text) {
    const list = document.querySelector('.chat-messages-list');
    if (!list) return;
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  }

  function setBadge(n) {
    const badge = document.querySelector('#chatFloatBtn .chat-badge');
    if (!badge) return;
    if (n > 0) { badge.textContent = n > 9 ? '9+' : n; badge.style.display = 'flex'; }
    else { badge.style.display = 'none'; }
  }

  /* ================================================================
     OPEN / CLOSE
  ================================================================ */
  function open(tourData) {
    if (tourData) {
      selectedTour = tourData;
      const preview = el('chatTourPreview');
      if (preview) {
        preview.style.display = 'block';
        preview.innerHTML = `<strong>✈️ ${tourData.title}</strong>${tourData.nights} ночей · от ${tourData.currency}${tourData.price}`;
      }
    } else {
      selectedTour = null;
      const preview = el('chatTourPreview');
      if (preview) preview.style.display = 'none';
    }

    isOpen = true;
    el('chatPopup').classList.add('chat-open');

    // Reset unread when user opens chat
    unreadCount = 0;
    setBadge(0);
  }

  function close() {
    isOpen = false;
    el('chatPopup').classList.remove('chat-open');
  }

  function toggle(tourData) {
    if (isOpen) close();
    else open(tourData || null);
  }

  /* ================================================================
     STEP 1 → STEP 2: Start chat after user fills form
  ================================================================ */
  async function startChat() {
    const nameInput  = el('chatName');
    const phoneInput = el('chatPhone');
    const btn        = el('chatStartBtn');

    userName  = (nameInput?.value || '').trim();
    userPhone = (phoneInput?.value || '').trim();

    if (!userName) { nameInput?.focus(); nameInput?.style && (nameInput.style.borderColor = '#e03e3e'); return; }
    if (!userPhone) { phoneInput?.focus(); phoneInput?.style && (phoneInput.style.borderColor = '#e03e3e'); return; }

    // Disable button
    if (btn) { btn.textContent = 'Соединяем...'; btn.disabled = true; }

    // Generate session ID
    sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);

    try {
      // Send initial system message to Supabase so the bot picks it up
      const intro = buildIntroMessage();
      await insertMessage({
        session_id: sessionId,
        role:       'system',
        text:       intro,
        user_name:  userName,
        user_phone: userPhone,
        tour_title: selectedTour?.title || null,
      });

      // Switch UI to chat view
      el('chatUserForm').style.display = 'none';
      el('chatMessages').style.display = 'flex';
      started = true;

      // Show welcome message
      appendSystem('Чат начат · ' + timeStr());
      if (selectedTour) {
        appendSystem(`Вы выбрали тур: ${selectedTour.title}`);
      }
      appendMsg(
        `Здравствуйте, ${userName}! Ваше сообщение отправлено агенту. Ожидайте ответа — мы обычно отвечаем в течение нескольких минут. ✈️`,
        'agent', timeStr()
      );

      // Start polling for agent replies
      startPolling();

    } catch (e) {
      console.error('Chat start error:', e);
      if (btn) { btn.textContent = 'Начать чат'; btn.disabled = false; }
      alert('Ошибка соединения. Попробуйте ещё раз.');
    }
  }

  function buildIntroMessage() {
    let msg = `🔔 *Новый чат с клиентом*\n\n`;
    msg += `👤 *Имя:* ${userName}\n`;
    msg += `📞 *Телефон:* ${userPhone}\n`;
    if (selectedTour) {
      msg += `\n✈️ *Выбранный тур:*\n`;
      msg += `  • Название: ${selectedTour.title}\n`;
      msg += `  • Страна: ${selectedTour.countryName || selectedTour.country}\n`;
      msg += `  • Ночей: ${selectedTour.nights}\n`;
      msg += `  • Цена: от ${selectedTour.currency}${selectedTour.price}\n`;
    } else {
      msg += `\n💬 *Тип обращения:* Общий вопрос\n`;
    }
    return msg;
  }

  /* ================================================================
     SEND MESSAGE
  ================================================================ */
  async function sendMessage() {
    if (!started || !sessionId) return;

    const textarea = document.querySelector('.chat-input-row textarea');
    const sendBtn  = document.querySelector('.chat-send-btn');
    const text = textarea?.value?.trim();
    if (!text) return;

    textarea.value = '';
    textarea.style.height = '';
    sendBtn.disabled = true;

    // Optimistic UI
    appendMsg(text, 'user');

    try {
      await insertMessage({
        session_id: sessionId,
        role:       'user',
        text:       text,
        user_name:  userName,
        user_phone: userPhone,
        tour_title: selectedTour?.title || null,
      });
    } catch (e) {
      console.error('Send error:', e);
      appendSystem('⚠️ Ошибка отправки. Попробуйте ещё раз.');
    } finally {
      sendBtn.disabled = false;
    }
  }

  /* ================================================================
     POLLING FOR AGENT REPLIES
  ================================================================ */
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const msgs = await fetchNewMessages();
        msgs.forEach(msg => {
          lastMsgId = Math.max(lastMsgId, msg.id);
          appendMsg(msg.text, 'agent');
          if (!isOpen) {
            unreadCount++;
            setBadge(unreadCount);
          }
        });
      } catch (e) {
        // silent fail — will retry next poll
      }
    }, POLL_INTERVAL_MS);
  }

  /* ================================================================
     BUILD UI
  ================================================================ */
  function buildWidget() {
    // Floating button
    const floatBtn = document.createElement('button');
    floatBtn.id = 'chatFloatBtn';
    floatBtn.title = 'Чат с агентом';
    floatBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2C6.477 2 2 6.145 2 11.243c0 2.675 1.172 5.086 3.063 6.812L4 22l4.233-2.118C9.39 20.283 10.672 20.5 12 20.5c5.523 0 10-4.145 10-9.257C22 6.145 17.523 2 12 2z" fill="currentColor"/>
      </svg>
      <span class="chat-badge">0</span>`;
    floatBtn.addEventListener('click', () => toggle());
    document.body.appendChild(floatBtn);

    // Popup
    const popup = document.createElement('div');
    popup.id = 'chatPopup';
    popup.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-avatar">✈️</div>
        <div class="chat-header-info">
          <div class="chat-header-name">AiTravel — Поддержка</div>
          <div class="chat-header-status">Онлайн</div>
        </div>
        <button class="chat-header-close" title="Закрыть" onclick="AiTravelChat.close()">✕</button>
      </div>

      <!-- STEP 1: User info form -->
      <div id="chatUserForm">
        <div class="chat-form-title">Добро пожаловать! 👋</div>
        <div class="chat-form-subtitle">Введите ваши данные, чтобы начать чат с агентом</div>

        <div id="chatTourPreview"></div>

        <div class="chat-field">
          <label for="chatName">Ваше имя</label>
          <input type="text" id="chatName" placeholder="Иван Иванов" autocomplete="name" />
        </div>
        <div class="chat-field">
          <label for="chatPhone">Телефон</label>
          <input type="tel" id="chatPhone" placeholder="+7 (___) ___-__-__" autocomplete="tel" />
        </div>
        <button class="chat-start-btn" id="chatStartBtn" onclick="AiTravelChat.startChat()">
          💬 Начать чат
        </button>
      </div>

      <!-- STEP 2: Messages -->
      <div id="chatMessages">
        <div class="chat-messages-list"></div>
        <div class="chat-typing">
          <span></span><span></span><span></span>
        </div>
        <div class="chat-input-row">
          <textarea placeholder="Введите сообщение..." rows="1" id="chatTextarea"></textarea>
          <button class="chat-send-btn" title="Отправить" id="chatSendBtn">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(popup);

    // Send on Enter (Shift+Enter = newline)
    popup.querySelector('#chatTextarea').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    popup.querySelector('#chatTextarea').addEventListener('input', function() {
      this.style.height = '';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
    popup.querySelector('#chatSendBtn').addEventListener('click', sendMessage);

    // Color reset on input
    popup.querySelector('#chatName').addEventListener('input', function() { this.style.borderColor = ''; });
    popup.querySelector('#chatPhone').addEventListener('input', function() { this.style.borderColor = ''; });
  }

  /* ================================================================
     HOOK UP EXISTING BUTTONS
  ================================================================ */
  function hookButtons() {
    // "Чат с агентом" buttons — no tour context
    document.querySelectorAll('[onclick*="toggleChat"]').forEach(btn => {
      btn.removeAttribute('onclick');
      btn.addEventListener('click', () => open(null));
    });

    // Tour card "Связаться с агентом" buttons — hooked dynamically
    // We use event delegation on the tours container
    const container = document.getElementById('toursContainer');
    if (container) {
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('.tour-btn');
        if (!btn) return;
        const card = btn.closest('.tour-card');
        if (!card) return;

        // Extract tour data from the card's DOM
        const tourId  = card.dataset.id;
        const title   = card.querySelector('.tour-card-name')?.textContent?.trim() || '';
        const meta    = card.querySelector('.tour-card-meta')?.textContent || '';
        const priceEl = card.querySelector('.tour-card-price')?.textContent || '';
        const countryTag = card.querySelector('.tour-tag--country')?.textContent?.trim() || '';

        // Parse nights from meta
        const nightsMatch = meta.match(/(\d+)\s*ночей/);
        const nights = nightsMatch ? nightsMatch[1] : '';

        // Parse price + currency
        const priceMatch = priceEl.match(/от\s*([$€₸])(\d+)/);
        const currency = priceMatch ? priceMatch[1] : '';
        const price    = priceMatch ? priceMatch[2] : '';

        open({
          id:          tourId,
          title,
          countryName: countryTag,
          nights,
          price,
          currency,
        });
      });
    }
  }

  /* ================================================================
     INIT
  ================================================================ */
  document.addEventListener('DOMContentLoaded', () => {
    buildWidget();
    hookButtons();
  });

  // Global toggleChat() compat
  window.toggleChat = () => toggle(null);

  return { open, close, toggle, startChat, sendMessage };

})();

window.AiTravelChat = AiTravelChat;