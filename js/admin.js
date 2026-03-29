/* ============================================================
   hot-tours-admin.js  — v5 (Supabase Auth)
   - Session validated against Supabase JWT token
   - No credentials stored in frontend code
   - Tours loaded from / saved to Supabase
   ============================================================ */

const hotToursAdmin = (() => {

  /* ---------- Supabase config ---------- */
  const SUPABASE_URL = 'https://jrvbynjlpjiridumydop.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_VVymyHB40jv7fOC180fFOQ_Qk1PCWUb';
  const TABLE        = 'tours';
  const TOKEN_KEY    = `sb-${SUPABASE_URL.split('//')[1].split('.')[0]}-auth-token`;

  /* ---------- Auth helpers ---------- */

  function getStoredSession() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function getAccessToken() {
    const session = getStoredSession();
    if (!session) return null;
    /* Check token hasn't expired (with 60s buffer) */
    if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000) + 60) {
      return null;
    }
    return session.access_token;
  }

  function isAdmin() {
    /* Check both the Supabase token AND the sessionStorage flag */
    return sessionStorage.getItem('aitravel_admin_session') === 'true'
      && getAccessToken() !== null;
  }

  function logout() {
    /* Clear Supabase session and our flag */
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('aitravel_admin_session');
    if (typeof renderNavAdmin === 'function') renderNavAdmin();
    render();
  }

  /* ---------- Request headers ---------- */

  function sbHeaders(withAuth = false) {
    const headers = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    };
    if (withAuth) {
      const token = getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /* ---------- Config ---------- */
  const COUNTRIES = {
    turkey:   'Турция',
    egypt:    'Египет',
    uae:      'ОАЭ',
    thailand: 'Таиланд',
    vietnam:  'Вьетнам',
    qatar:    'Катар',
    southkorea: 'Корея',
    japan:    'Япония',
    china:    'Китай',
    georgia:  'Грузия',
    india:    'Индия',
    indonesia: 'Индонезия',
    spain:    'Испания',
    italy:    'Италия',
    cyprus:   'Кипр',
    malaysia: 'Малайзия',
    maldives: 'Мальдивы',
    oman:     'Оман',
    uzbekistan: 'Узбекистан',
    montenegro: 'Черногория',
    other:    'Другое',
  };

  const ALL_TAGS = ['Горящий', 'Скидка', 'Новинка', 'Семейный'];
  const TAG_IDS  = ['htTagHot', 'htTagSale', 'htTagNew', 'htTagFamily'];

  /* ---------- State ---------- */
  let tours        = [];
  let editingId    = null;
  let activeFilter = 'all';


  /* ============================================================
     SUPABASE API CALLS
  ============================================================ */

  async function fetchTours() {
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?order=id.asc`, {
        headers: sbHeaders(),
      });
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Bad response: ' + JSON.stringify(data));
      return data;
    } catch (e) {
      console.error('fetchTours error:', e);
      return [];
    }
  }

  async function insertTour(tour) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method:  'POST',
      headers: { ...sbHeaders(true), 'Prefer': 'return=representation' },
      body:    JSON.stringify(tour),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }

  async function updateTour(id, tour) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${id}`, {
      method:  'PATCH',
      headers: { ...sbHeaders(true), 'Prefer': 'return=representation' },
      body:    JSON.stringify(tour),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }

  async function deleteTourFromDB(id) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${id}`, {
      method:  'DELETE',
      headers: sbHeaders(true),
    });
    if (!res.ok) throw new Error(await res.text());
  }


  /* ============================================================
     RENDER
  ============================================================ */

  function stars(rating) {
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }

  function render() {
    const filterRow = document.querySelector('.tour-filters');
    if (!filterRow) return;

    const usedCountries = [...new Set(tours.map(t => t.country))];

    let html = `<button class="filter-btn${activeFilter === 'all' ? ' active' : ''}" data-country="all">Все</button>`;
    usedCountries.forEach(c => {
      html += `<button class="filter-btn${activeFilter === c ? ' active' : ''}" data-country="${c}">${COUNTRIES[c] || c}</button>`;
    });

    if (isAdmin()) {
      html += `<button class="filter-btn admin-open-btn" id="adminOpenBtn">⚙ Добавить тур</button>`;
    }

    filterRow.innerHTML = html;

    filterRow.querySelectorAll('.filter-btn[data-country]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.country;
        filterRow.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderCards(activeFilter);
      });
    });

    const addBtn = document.getElementById('adminOpenBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    renderCards(activeFilter);
  }

  function renderCards(countryFilter) {
    const container = document.getElementById('toursContainer');
    if (!container) return;

    const filtered = countryFilter === 'all'
      ? tours
      : tours.filter(t => t.country === countryFilter);

    if (!filtered.length) {
      container.innerHTML = '<p style="padding:1rem;color:#888;">Туры не найдены.</p>';
      return;
    }

    const admin = isAdmin();

    container.innerHTML = filtered.map(t => `
      <div class="tour-card" data-id="${t.id}">
        ${t.image
          ? `<img class="tour-card-img" src="${t.image}" onerror="this.style.display='none'" alt="${t.title}" />`
          : `<div class="tour-card-img-placeholder"></div>`
        }
        ${admin ? `
        <div class="tour-card-actions">
          <button class="tour-card-btn" onclick="hotToursAdmin.openEditModal(${t.id})" title="Редактировать">✎</button>
          <button class="tour-card-btn tour-card-btn--del" onclick="hotToursAdmin.deleteTour(${t.id})" title="Удалить">✕</button>
        </div>` : ''}
        <div class="tour-card-body">
          <div class="tour-card-tags">
            <span class="tour-tag tour-tag--country">${COUNTRIES[t.country] || t.country}</span>
            ${(t.tags || []).map(tag => `<span class="tour-tag tour-tag--hot">${tag}</span>`).join('')}
          </div>
          <div class="tour-card-name">${t.title}</div>
          <div class="tour-card-meta">
            <span class="tour-stars">${stars(t.rating)}</span>
            <span>${t.rating}</span>
            <span>${t.nights} ночей</span>
          </div>
          <div class="tour-card-price">от ${t.currency}${t.price}</div>
          <button class="tour-btn">Связаться с агентом</button>
        </div>
      </div>
    `).join('');
  }

  function renderLoading() {
    const container = document.getElementById('toursContainer');
    if (container) {
      container.innerHTML = '<p style="padding:1rem;color:#aaa;">Загрузка туров...</p>';
    }
  }


  /* ============================================================
     MODAL
  ============================================================ */

  function openAddModal() {
    if (!isAdmin()) { window.location.href = 'admin.html'; return; }
    editingId = null;
    document.getElementById('htModalTitle').textContent = 'Добавить тур';
    clearForm();
    document.getElementById('htOverlay').classList.add('ht-open');
  }

  function openEditModal(id) {
    if (!isAdmin()) { window.location.href = 'admin.html'; return; }
    editingId = id;
    const t = tours.find(x => x.id === id);
    if (!t) return;

    document.getElementById('htModalTitle').textContent = 'Редактировать тур';
    document.getElementById('htTitle').value    = t.title;
    document.getElementById('htCountry').value  = t.country;
    document.getElementById('htNights').value   = t.nights;
    document.getElementById('htPrice').value    = t.price;
    document.getElementById('htCurrency').value = t.currency;
    document.getElementById('htRating').value   = t.rating;
    document.getElementById('htImage').value    = t.image;

    TAG_IDS.forEach((tagId, i) => {
      document.getElementById(tagId).checked = (t.tags || []).includes(ALL_TAGS[i]);
    });

    previewImg(t.image);
    document.getElementById('htOverlay').classList.add('ht-open');
  }

  function closeModal() {
    document.getElementById('htOverlay').classList.remove('ht-open');
  }

  function handleOverlayClick(e) {
    if (e.target === document.getElementById('htOverlay')) closeModal();
  }

  function clearForm() {
    ['htTitle', 'htNights', 'htPrice', 'htImage'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('htCountry').value  = 'turkey';
    document.getElementById('htCurrency').value = '$';
    document.getElementById('htRating').value   = '';
    TAG_IDS.forEach(id => { document.getElementById(id).checked = false; });
    previewImg('');
  }

  function previewImg(url) {
    const img = document.getElementById('htImgPreview');
    if (url && url.startsWith('http')) {
      img.src           = url;
      img.style.display = 'block';
    } else {
      img.style.display = 'none';
    }
  }


  /* ============================================================
     SAVE & DELETE
  ============================================================ */

  async function saveTour() {
    if (!isAdmin()) { window.location.href = 'admin.html'; return; }

    const saveBtn = document.querySelector('.ht-btn-save');
    if (saveBtn) { saveBtn.textContent = 'Сохранение...'; saveBtn.disabled = true; }

    const tags = TAG_IDS
      .map((tagId, i) => document.getElementById(tagId).checked ? ALL_TAGS[i] : null)
      .filter(Boolean);

    const payload = {
      title:    document.getElementById('htTitle').value    || 'Без названия',
      country:  document.getElementById('htCountry').value,
      nights:   parseInt(document.getElementById('htNights').value)    || 7,
      price:    parseInt(document.getElementById('htPrice').value)     || 0,
      currency: document.getElementById('htCurrency').value,
      rating:   parseFloat(document.getElementById('htRating').value)  || 4.5,
      tags,
      image:    document.getElementById('htImage').value,
    };

    try {
      if (editingId) {
        await updateTour(editingId, payload);
      } else {
        await insertTour(payload);
      }
      closeModal();
      await reloadTours();
    } catch (e) {
      alert('Ошибка сохранения: ' + e.message);
      console.error(e);
    } finally {
      if (saveBtn) { saveBtn.textContent = 'Сохранить'; saveBtn.disabled = false; }
    }
  }

  async function deleteTour(id) {
    if (!isAdmin()) { window.location.href = 'admin.html'; return; }
    if (!confirm('Удалить этот тур?')) return;
    try {
      await deleteTourFromDB(id);
      await reloadTours();
    } catch (e) {
      alert('Ошибка удаления: ' + e.message);
      console.error(e);
    }
  }

  async function reloadTours() {
    tours = await fetchTours();
    render();
  }


  /* ============================================================
     INIT
  ============================================================ */

  document.addEventListener('DOMContentLoaded', async () => {
    renderLoading();
    tours = await fetchTours();
    render();
  });

  /* Public API */
  return {
    openAddModal,
    openEditModal,
    closeModal,
    handleOverlayClick,
    previewImg,
    saveTour,
    deleteTour,
    logout,
  };

})();