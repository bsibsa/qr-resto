(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  let token = ls.get('adminToken');
  let orders = [];
  let fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  let sound = ls.get('sound') !== 'off';
  let socket;
  const fresh = new Set();

  const NEXT = { new: ['preparing', 'Lancer en cuisine'], preparing: ['ready', 'Marquer prête'], ready: ['served', 'Servie ✓'] };

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token || '' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) { logout(); throw new Error('Session expirée'); }
    return r.json();
  }

  // ---------- Connexion ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    unlockAudio();
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('#pin').value }) });
    if (!r.ok) {
      $('#loginErr').textContent = 'Code incorrect';
      $('.login-box').classList.remove('shake'); void $('.login-box').offsetWidth; $('.login-box').classList.add('shake');
      $('#pin').value = '';
      return;
    }
    token = (await r.json()).token;
    ls.set('adminToken', token);
    start();
  });
  function logout() {
    token = null; ls.set('adminToken', null);
    socket?.disconnect();
    $('#app').hidden = true; $('#login').hidden = false;
  }

  async function start() {
    const s = await api('/api/admin/session');
    fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: s.restaurant.currency });
    $('#brandName').textContent = s.restaurant.name;
    $('#login').hidden = true; $('#app').hidden = false;
    $('#soundBtn').classList.toggle('off', !sound);
    orders = await api('/api/admin/orders');
    renderOrders();
    connect();
  }

  function connect() {
    socket = io({ auth: { role: 'staff', token } });
    socket.on('connect', () => { $('#live').classList.remove('down'); $('#live').lastChild.textContent = 'En direct'; });
    socket.on('disconnect', (reason) => {
      $('#live').classList.add('down'); $('#live').lastChild.textContent = 'Hors ligne';
      if (reason === 'io server disconnect') logout(); // jeton refusé (ex. serveur redémarré)
    });
    socket.on('order:new', (o) => {
      orders = orders.filter((x) => x.id !== o.id).concat(o);
      fresh.add(o.id);
      renderOrders();
      chime();
      flashTitle(`🔔 Table ${o.tableNumber}`);
      toast(`Nouvelle commande — Table ${o.tableNumber}`);
      setTimeout(() => fresh.delete(o.id), 3000);
    });
    socket.on('order:update', (o) => {
      const i = orders.findIndex((x) => x.id === o.id);
      if (i >= 0) orders[i] = o; else orders.push(o);
      renderOrders();
    });
    socket.on('call', (c) => {
      const el = document.createElement('div');
      el.className = 'call';
      el.innerHTML = `<span>${c.reason === 'bill' ? '🧾' : '🙋'} <b>Table ${c.table}</b><br>${c.reason === 'bill' ? 'demande l\'addition' : 'appelle un serveur'}</span><button>OK</button>`;
      el.querySelector('button').onclick = () => el.remove();
      $('#calls').prepend(el);
      chime(true);
      flashTitle(`🙋 Table ${c.table}`);
    });
    socket.on('menu:availability', () => { if (!$('#view-menu').hidden) loadMenu(); });
  }

  // ---------- Commandes ----------
  function elapsed(iso) {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${m % 60}`;
  }

  function orderCard(o) {
    const late = o.status !== 'served' && Date.now() - new Date(o.createdAt) > 20 * 60000;
    const next = NEXT[o.status];
    return `<article class="order${fresh.has(o.id) ? ' fresh' : ''}" data-id="${o.id}">
      <div class="order-head">
        <span class="tbl">Table ${o.tableNumber}</span><span class="num">#${String(o.number).padStart(3, '0')}</span>
        <span class="time${late ? ' late' : ''}" data-t="${o.createdAt}">${elapsed(o.createdAt)}</span>
      </div>
      <ul>${o.items.map((l) => `<li><span class="q">${l.qty}×</span><span>${esc(l.emoji)} ${esc(l.name)}${l.note ? `<small>→ ${esc(l.note)}</small>` : ''}</span></li>`).join('')}</ul>
      ${o.note ? `<div class="onote">📝 ${esc(o.note)}</div>` : ''}
      <div class="order-foot">
        <span class="pay ${o.paid ? 'ok' : 'due'}">${o.paid ? '✓ Encaissée' : '€ À encaisser'}</span>
        <span class="total">${fmt.format(o.total / 100)}</span>
        <span class="grow"></span>
        ${!o.paid ? `<button class="btn sm ghost" data-act="paid">Encaissée</button>` : ''}
        ${next ? `<button class="btn sm next" data-act="${next[0]}">${next[1]}</button>` : ''}
      </div>
    </article>`;
  }

  function renderOrders() {
    const sorted = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const col of document.querySelectorAll('.col')) {
      const list = sorted.filter((o) => o.status === col.dataset.status);
      col.querySelector('h2 span').textContent = list.length || '';
      col.querySelector('.list').innerHTML = list.map(orderCard).join('') || '<div class="empty">Rien pour l\'instant</div>';
    }
    const served = sorted.filter((o) => o.status === 'served').reverse();
    $('#servedList').innerHTML = served.map(orderCard).join('');
    $('#servedCount').textContent = served.length ? `(${served.length})` : '';

    const nNew = sorted.filter((o) => o.status === 'new').length;
    $('#newCount').hidden = !nNew; $('#newCount').textContent = nNew;

    const active = sorted.filter((o) => o.status !== 'served');
    const revenue = sorted.reduce((s, o) => s + o.total, 0);
    const due = sorted.filter((o) => !o.paid).reduce((s, o) => s + o.total, 0);
    $('#stats').innerHTML = [
      ['En cours', active.length],
      ['Commandes du jour', sorted.length],
      ['Chiffre du jour', fmt.format(revenue / 100)],
      ['Reste à encaisser', fmt.format(due / 100)],
    ].map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.order').dataset.id;
    const act = b.dataset.act;
    b.disabled = true;
    try { await api('/api/admin/orders/' + id, { method: 'PATCH', body: act === 'paid' ? { paid: true } : { status: act } }); }
    catch (err) { toast(err.message); b.disabled = false; }
  });

  setInterval(() => document.querySelectorAll('.time[data-t]').forEach((el) => {
    el.textContent = elapsed(el.dataset.t);
    el.classList.toggle('late', Date.now() - new Date(el.dataset.t) > 20 * 60000 && !el.closest('#servedList'));
  }), 30000);

  // ---------- Onglets ----------
  $('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + t.dataset.tab; });
    if (t.dataset.tab === 'tables') loadTables();
    if (t.dataset.tab === 'menu') loadMenu();
  });

  // ---------- Tables & QR ----------
  let tablesCache = [];
  async function loadTables() {
    tablesCache = await api('/api/admin/tables');
    $('#qrGrid').innerHTML = tablesCache.map((t, i) => `
      <div class="qr" style="animation-delay:${i * 40}ms" data-id="${t.id}">
        <img src="${t.qr}" alt="QR code table ${t.number}" />
        <h3>Table ${t.number}</h3>
        <a class="link" href="${t.url}" target="_blank" rel="noopener">${esc(t.url)}</a>
        <div class="row">
          <a class="btn sm ghost" href="${t.qr}" download="qr-table-${t.number}.png">Télécharger</a>
          <button class="btn sm ghost" data-tact="regen" title="Invalide l'ancien QR code">Nouveau QR</button>
          <button class="btn sm ghost danger" data-tact="del">Supprimer</button>
        </div>
      </div>`).join('');
  }
  $('#qrGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const card = b.closest('.qr');
    const num = card.querySelector('h3').textContent;
    if (b.dataset.tact === 'regen' && confirm(`Générer un nouveau QR pour la ${num} ? L'ancien ne fonctionnera plus.`)) {
      await api(`/api/admin/tables/${card.dataset.id}/regenerate`, { method: 'POST' });
      loadTables(); toast('Nouveau QR code généré');
    }
    if (b.dataset.tact === 'del' && confirm(`Supprimer la ${num} ?`)) {
      await api(`/api/admin/tables/${card.dataset.id}`, { method: 'DELETE' });
      loadTables();
    }
  });
  $('#addTable').addEventListener('click', async () => { await api('/api/admin/tables', { method: 'POST' }); loadTables(); toast('Table ajoutée'); });
  $('#printAll').addEventListener('click', () => {
    document.querySelector('.print-sheet')?.remove();
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    const name = esc($('#brandName').textContent);
    sheet.innerHTML = tablesCache.map((t) => `<div class="pcard"><h4>${name}</h4><img src="${t.qr}" alt="" /><p>Scannez pour voir le menu<br>et commander</p><div class="t">Table ${t.number}</div></div>`).join('');
    document.body.appendChild(sheet);
    setTimeout(() => window.print(), 100);
  });

  // ---------- Menu ----------
  async function loadMenu() {
    const menu = await api('/api/admin/menu');
    $('#menuList').innerHTML = menu.categories.map((c) => `
      <div class="mcat"><h3>${esc(c.icon)} ${esc(c.name)}</h3>
        ${c.items.map((it) => {
          const on = it.available !== false;
          return `<div class="mitem${on ? '' : ' off'}" data-id="${esc(it.id)}">
            <span class="e">${esc(it.emoji)}</span>
            <div class="n"><b>${esc(it.name)}</b><small>${fmt.format(it.price / 100)}</small></div>
            <span class="st">${on ? 'Disponible' : 'Épuisé'}</span>
            <button class="switch${on ? ' on' : ''}" aria-label="Disponibilité"></button>
          </div>`;
        }).join('')}
      </div>`).join('');
  }
  $('#menuList').addEventListener('click', async (e) => {
    const sw = e.target.closest('.switch');
    if (!sw) return;
    const row = sw.closest('.mitem');
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on); row.classList.toggle('off', !on);
    row.querySelector('.st').textContent = on ? 'Disponible' : 'Épuisé';
    await api('/api/admin/menu/' + row.dataset.id, { method: 'PATCH', body: { available: on } });
  });

  // ---------- Son & notifications ----------
  let ctx;
  function unlockAudio() { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch {} }
  document.addEventListener('click', unlockAudio, { once: true });
  function chime(short) {
    if (!sound || !ctx) return;
    const notes = short ? [880, 660] : [660, 880, 1320];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.5);
    });
  }
  $('#soundBtn').addEventListener('click', () => {
    sound = !sound; ls.set('sound', sound ? 'on' : 'off');
    $('#soundBtn').classList.toggle('off', !sound);
    if (sound) { unlockAudio(); chime(true); }
  });
  let titleTimer;
  function flashTitle(msg) {
    if (!document.hidden) return;
    const base = 'Restaurant · Commandes';
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => { document.title = (on = !on) ? msg : base; }, 1000);
    document.addEventListener('visibilitychange', () => { clearInterval(titleTimer); document.title = base; }, { once: true });
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  if (token) start().catch(() => logout());
})();
