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
      $('#loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Code incorrect';
      $('.login-box').classList.remove('shake'); void $('.login-box').offsetWidth; $('.login-box').classList.add('shake');
      $('#pin').value = '';
      return;
    }
    token = (await r.json()).token;
    ls.set('adminToken', token);
    start();
  });
  function logout() {
    if (token) fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-token': token } }).catch(() => {});
    token = null; ls.set('adminToken', null);
    socket?.disconnect();
    $('#app').hidden = true; $('#login').hidden = false;
  }

  let me = null;
  async function start() {
    const s = await api('/api/admin/session');
    me = s.me;
    fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: s.restaurant.currency });
    $('#brandName').textContent = s.restaurant.name;
    // Un serveur ne voit que l'onglet Commandes
    const manager = me.role === 'manager';
    document.querySelectorAll('[data-manager]').forEach((el) => { el.hidden = !manager; });
    $('#me').innerHTML = `${esc(me.name)} <small>${manager ? 'Gérant' : 'Serveur'}</small>`;
    showTab('orders');
    draft = null; setDirty(false);
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
    socket.on('menu:availability', ({ id, available }) => {
      const it = draft?.categories.flatMap((c) => c.items).find((i) => i.id === id);
      if (it) { it.available = available; if (!$('#view-menu').hidden && !openItem) renderEditor(); }
    });
    socket.on('menu:update', (menu) => {
      $('#brandName').textContent = menu.restaurant.name;
      if (!draft) return;
      if (!dirty) loadMenu(true);
      else toast('La carte vient d\'être modifiée sur un autre appareil. Enregistrer remplacera ces changements.');
    });
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
    const b = e.target.closest('.order [data-act]');
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
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    if (name === 'tables') loadTables();
    if (name === 'menu') loadMenu();
    if (name === 'team') loadTeam();
  }
  $('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) showTab(t.dataset.tab);
  });
  $('#logoutBtn').addEventListener('click', () => {
    if (dirty) { toast('Enregistrez ou annulez vos modifications de la carte avant de vous déconnecter'); return showTab('menu'); }
    logout();
  });

  // ---------- Équipe ----------
  let team = [];
  let editing = null, confirmDel = null;
  async function loadTeam() {
    team = await api('/api/admin/staff');
    renderTeam();
  }
  const roleName = (r) => (r === 'manager' ? 'Gérant' : 'Serveur');
  function renderTeam() {
    $('#teamList').innerHTML = `
      <div class="member master"><div class="m-ava">★</div><div class="m-info"><b>Gérant principal</b><small>Code défini sur Render (ADMIN_PIN) · toujours valable, sert de secours</small></div><span class="role manager">Gérant</span></div>
      ${team.map((m) => editing === m.id ? `
        <form class="member editing" data-id="${m.id}">
          <div class="team-grid">
            <label class="ed-field"><span>Prénom</span><input name="name" maxlength="40" value="${esc(m.name)}" required /></label>
            <label class="ed-field"><span>Rôle</span><select name="role"><option value="waiter" ${m.role === 'waiter' ? 'selected' : ''}>Serveur</option><option value="manager" ${m.role === 'manager' ? 'selected' : ''}>Gérant</option></select></label>
            <label class="ed-field"><span>Nouveau code (vide = inchangé)</span><input name="pin" inputmode="numeric" maxlength="8" placeholder="••••" /></label>
          </div>
          <div class="row"><button type="button" class="btn sm ghost" data-team="cancel">Annuler</button><button class="btn sm primary">Enregistrer</button></div>
        </form>` : `
        <div class="member" data-id="${m.id}">
          <div class="m-ava">${esc(m.name.slice(0, 1).toUpperCase())}</div>
          <div class="m-info"><b>${esc(m.name)}</b><small>${m.role === 'manager' ? 'Accès complet' : 'Commandes uniquement'}</small></div>
          <span class="role ${m.role}">${roleName(m.role)}</span>
          ${confirmDel === m.id
            ? `<span class="ed-confirm inline">Supprimer ${esc(m.name)} ? <button class="btn sm danger-fill" data-team="del-yes">Oui</button><button class="btn sm ghost" data-team="cancel">Non</button></span>`
            : `<button class="btn sm ghost" data-team="edit">Modifier</button><button class="btn sm ghost danger" data-team="del">Supprimer</button>`}
        </div>`).join('')}
      ${team.length ? '' : '<p class="empty">Aucun compte pour l\'instant. Ajoutez vos serveurs ci-dessus : chacun aura son propre code.</p>'}`;
  }
  $('#tGen').addEventListener('click', () => { $('#tPin').value = String(Math.floor(1000 + Math.random() * 9000)); });
  $('#tPin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $('#teamForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#tName').value, pin = $('#tPin').value;
    const r = await api('/api/admin/staff', { method: 'POST', body: { name, role: $('#tRole').value, pin } });
    if (r.error) return toast(r.error);
    toast(`${r.name} est ajouté·e. Son code : ${pin}`);
    $('#teamForm').reset();
    loadTeam();
  });
  $('#teamList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const act = b.dataset.team;
    if (act === 'edit') { editing = id; confirmDel = null; }
    if (act === 'del') { confirmDel = id; editing = null; }
    if (act === 'cancel') { editing = null; confirmDel = null; }
    if (act === 'del-yes') {
      const r = await api('/api/admin/staff/' + id, { method: 'DELETE' });
      if (r.error) return toast(r.error);
      confirmDel = null; toast('Compte supprimé : la personne est déconnectée');
      return loadTeam();
    }
    renderTeam();
  });
  $('#teamList').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, id = f.dataset.id;
    const el = (n) => f.elements.namedItem(n);
    const body = { name: el('name').value, role: el('role').value, pin: el('pin').value.trim() };
    const r = await api('/api/admin/staff/' + id, { method: 'PATCH', body });
    if (r.error) return toast(r.error);
    editing = null; toast('Compte mis à jour');
    loadTeam();
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

  // ---------- Éditeur de carte ----------
  // On modifie une copie (« brouillon ») ; rien n'est envoyé aux clients avant « Enregistrer ».
  // Seul l'interrupteur Disponible / Épuisé s'applique tout de suite.
  const TAGS = ['Signature', 'Nouveau', 'Végé', 'Vegan', 'Sans gluten', 'Épicé', 'Sans alcool', 'À partager'];
  let draft = null;
  let savedIds = new Set();
  let dirty = false;
  let openItem = null;      // plat dont le formulaire est ouvert
  let confirmKey = null;    // suppression en attente de confirmation
  let uploading = null;     // plat dont la photo est en cours d'envoi

  const euros = (c) => (c / 100).toFixed(2).replace('.', ',');
  const parseEuros = (v) => {
    const n = Number(String(v).replace(/\s|€/g, '').replace(',', '.'));
    return v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  const thumb = (it) => it.image ? `<img src="/img/${esc(it.image)}" alt="" />` : esc(it.emoji || '🍽');

  function setDirty(v) {
    dirty = v;
    $('#saveBar').hidden = !v;
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  async function loadMenu(force) {
    if (dirty && !force) return renderEditor();
    const menu = await api('/api/admin/menu');
    draft = structuredClone(menu);
    savedIds = new Set(menu.categories.flatMap((c) => c.items.map((i) => i.id)));
    openItem = null; confirmKey = null;
    setDirty(false);
    renderEditor();
  }

  function renderEditor() {
    if (!draft) return;
    const r = draft.restaurant;
    $('#menuList').innerHTML = `
      <div class="ed-card ed-resto">
        <label class="ed-field"><span>Nom du restaurant</span><input id="edName" data-r="name" maxlength="60" value="${esc(r.name)}" /></label>
        <label class="ed-field"><span>Slogan (affiché sous le nom)</span><input id="edTagline" data-r="tagline" maxlength="120" value="${esc(r.tagline)}" /></label>
        <label class="ed-field wide"><span>Mention sur les prix (bas de la carte, vide = aucune)</span><input id="edPriceNote" data-r="priceNote" maxlength="120" value="${esc(r.priceNote ?? '')}" /></label>
      </div>
      <details class="ed-card ed-legal" ${(legalOpen ?? legalMissing()) ? 'open' : ''}>
        <summary><b>Mentions légales</b> <span class="${legalMissing() ? 'warn' : 'ok'}">${legalMissing() ? 'À compléter' : 'Complètes'}</span></summary>
        <p class="ed-help">Affichées aux clients via le lien « Allergènes et mentions légales » en bas de la carte. Obligatoires pour un site professionnel.</p>
        <div class="ed-grid legal">
          ${[['company', "Nom de l'établissement / société", 'SARL Le Comptoir'], ['siret', 'SIRET', '123 456 789 00012'],
             ['address', 'Adresse', '12 rue de la Paix, 75002 Paris'], ['phone', 'Téléphone', '01 23 45 67 89'],
             ['email', 'E-mail de contact', 'contact@monresto.fr'], ['publisher', 'Responsable de la publication', 'Prénom Nom, gérant'],
             ['host', 'Hébergeur', '']].map(([k, label, ph]) =>
            `<label class="ed-field${k === 'address' || k === 'host' ? ' wide' : ''}"><span>${label}</span><input data-legal="${k}" maxlength="200" placeholder="${esc(ph)}" value="${esc(r.legal?.[k] || '')}" /></label>`).join('')}
        </div>
      </details>
      ${draft.categories.map((c, ci) => catHtml(c, ci)).join('')}
      <button class="btn ghost ed-add-cat" data-act="cat-add">+ Ajouter une catégorie</button>`;
  }

  let legalOpen = null; // garde la section ouverte/fermée entre deux affichages
  $('#menuList').addEventListener('toggle', (e) => { if (e.target.classList?.contains('ed-legal')) legalOpen = e.target.open; }, true);
  const legalMissing = () => ['company', 'address', 'siret', 'publisher'].some((k) => !String(draft.restaurant.legal?.[k] || '').trim());
  const ALLERGEN_IDS = new Set(window.ALLERGENS.map((a) => a.id));

  function catHtml(c, ci) {
    const last = ci === draft.categories.length - 1;
    const asking = confirmKey === 'cat:' + ci;
    return `<section class="ed-cat" data-ci="${ci}">
      <div class="ed-cat-head">
        <input class="ed-icon" data-c="icon" maxlength="8" value="${esc(c.icon)}" aria-label="Emoji de la catégorie" />
        <input class="ed-cat-name" data-c="name" maxlength="40" value="${esc(c.name)}" aria-label="Nom de la catégorie" />
        <div class="ed-tools">
          <button class="ed-icon-btn" data-act="cat-up" ${ci ? '' : 'disabled'} title="Monter la catégorie" aria-label="Monter">↑</button>
          <button class="ed-icon-btn" data-act="cat-down" ${last ? 'disabled' : ''} title="Descendre la catégorie" aria-label="Descendre">↓</button>
          <button class="btn sm ghost danger" data-act="cat-del">Supprimer</button>
        </div>
      </div>
      ${asking ? `<div class="ed-confirm">Supprimer « ${esc(c.name)} »${c.items.length ? ` et ses ${c.items.length} plat${c.items.length > 1 ? 's' : ''}` : ''} ?
        <button class="btn sm danger-fill" data-act="cat-del-yes">Oui, supprimer</button><button class="btn sm ghost" data-act="cancel-confirm">Non</button></div>` : ''}
      <div class="ed-items">${c.items.map((it, ii) => itemHtml(it, ci, ii, c.items.length)).join('') || '<div class="empty">Aucun plat dans cette catégorie.</div>'}</div>
      <button class="btn sm ghost ed-add-item" data-act="item-add">+ Ajouter un plat</button>
    </section>`;
  }

  function itemHtml(it, ci, ii, count) {
    const on = it.available !== false;
    const saved = savedIds.has(it.id);
    const open = openItem === it;
    return `<div class="ed-item${open ? ' open' : ''}${on ? '' : ' off'}" data-ci="${ci}" data-ii="${ii}">
      <div class="ed-row">
        <span class="ed-thumb">${thumb(it)}</span>
        <div class="ed-sum"><b data-sum="name">${esc(it.name) || '<i>Sans nom</i>'}</b><small><span data-sum="price">${Number.isFinite(it.price) ? fmt.format(it.price / 100) : 'Prix à corriger'}</span>${(it.allergens || []).length ? '' : ' · <span class="al-missing" data-sum="al">allergènes à renseigner</span>'}</small></div>
        ${saved ? `<span class="st">${on ? 'Disponible' : 'Épuisé'}</span><button class="switch${on ? ' on' : ''}" data-act="avail" role="switch" aria-checked="${on}" aria-label="${esc(it.name)} disponible"></button>`
                : '<span class="st new">Nouveau</span>'}
        <button class="ed-icon-btn" data-act="item-up" ${ii ? '' : 'disabled'} aria-label="Monter">↑</button>
        <button class="ed-icon-btn" data-act="item-down" ${ii === count - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
        <button class="btn sm ${open ? 'next' : 'ghost'}" data-act="item-toggle">${open ? 'Fermer' : 'Modifier'}</button>
      </div>
      ${open ? formHtml(it, ci) : ''}
    </div>`;
  }

  function formHtml(it, ci) {
    const custom = (it.tags || []).filter((t) => !TAGS.includes(t));
    const asking = confirmKey === 'item:' + it.id + ':' + ci;
    return `<div class="ed-form">
      <div class="ed-photo">
        <div class="ed-photo-box">${uploading === it ? '<span class="spinner"></span>' : thumb(it)}</div>
        <div class="ed-photo-btns">
          <label class="btn sm ghost">${it.image ? 'Changer la photo' : 'Ajouter une photo'}<input type="file" accept="image/*" data-act="photo" hidden /></label>
          ${it.image ? '<button class="btn sm ghost danger" data-act="photo-del">Retirer la photo</button>' : ''}
          <small>Sans photo, l'emoji est affiché.</small>
        </div>
      </div>
      <div class="ed-grid">
        <label class="ed-field wide"><span>Nom du plat</span><input data-f="name" maxlength="80" value="${esc(it.name)}" /></label>
        <label class="ed-field"><span>Prix (€)</span><input data-f="price" inputmode="decimal" value="${Number.isFinite(it.price) ? euros(it.price) : ''}" class="${Number.isFinite(it.price) ? '' : 'bad'}" /></label>
        <label class="ed-field"><span>Emoji</span><input data-f="emoji" maxlength="8" value="${esc(it.emoji)}" /></label>
        <label class="ed-field wide"><span>Description</span><textarea data-f="description" rows="2" maxlength="300">${esc(it.description)}</textarea></label>
        <label class="ed-field"><span>Catégorie</span><select data-f="category">${draft.categories.map((c, i) => `<option value="${i}" ${i === ci ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="ed-field"><span>Étiquettes</span>
        <div class="ed-tags">${TAGS.map((t) => `<button class="ed-tag${(it.tags || []).includes(t) ? ' on' : ''}" data-act="tag" data-tag="${esc(t)}" aria-pressed="${(it.tags || []).includes(t)}">${esc(t)}</button>`).join('')}</div>
        <input data-f="customTags" placeholder="Autres étiquettes, séparées par des virgules" value="${esc(custom.join(', '))}" />
      </div>
      <div class="ed-field"><span>Allergènes (obligatoire) · cochez tout ce que contient le plat</span>
        <div class="ed-tags ed-allergens">
          ${window.ALLERGENS.map((a) => { const on = (it.allergens || []).includes(a.id);
            return `<button class="ed-tag al${on ? ' on' : ''}" data-act="allergen" data-al="${a.id}" aria-pressed="${on}" title="${esc(a.full)}">${a.icon} ${esc(a.label)}</button>`; }).join('')}
          <button class="ed-tag none${(it.allergens || []).includes('aucun') ? ' on' : ''}" data-act="allergen" data-al="aucun" aria-pressed="${(it.allergens || []).includes('aucun')}">✓ Aucun des 14</button>
        </div>
      </div>
      <div class="ed-form-foot">
        ${asking ? `<span class="ed-confirm inline">Supprimer ce plat ? <button class="btn sm danger-fill" data-act="item-del-yes">Oui</button><button class="btn sm ghost" data-act="cancel-confirm">Non</button></span>`
                 : '<button class="btn sm ghost danger" data-act="item-del">Supprimer ce plat</button>'}
      </div>
    </div>`;
  }

  const ref = (el) => {
    const box = el.closest('[data-ci]');
    const ci = Number(box?.dataset.ci);
    const itemBox = el.closest('.ed-item');
    const ii = itemBox ? Number(itemBox.dataset.ii) : null;
    const cat = draft.categories[ci];
    return { ci, ii, cat, item: itemBox ? cat.items[ii] : null, itemBox };
  };
  const swap = (arr, a, b) => { [arr[a], arr[b]] = [arr[b], arr[a]]; };

  // Saisie : on met à jour le brouillon sans tout redessiner (le curseur reste en place)
  $('#menuList').addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.r) { draft.restaurant[el.dataset.r] = el.value; return setDirty(true); }
    if (el.dataset.legal) {
      draft.restaurant.legal = { ...(draft.restaurant.legal || {}), [el.dataset.legal]: el.value };
      const badge = $('.ed-legal summary span');
      badge.className = legalMissing() ? 'warn' : 'ok'; badge.textContent = legalMissing() ? 'À compléter' : 'Complètes';
      return setDirty(true);
    }
    const { cat, item, itemBox } = ref(el);
    if (el.dataset.c) { cat[el.dataset.c] = el.value; return setDirty(true); }
    if (!item || !el.dataset.f || el.dataset.f === 'category') return;
    const f = el.dataset.f;
    if (f === 'price') {
      item.price = parseEuros(el.value);
      el.classList.toggle('bad', !Number.isFinite(item.price));
      itemBox.querySelector('[data-sum="price"]').textContent = Number.isFinite(item.price) ? fmt.format(item.price / 100) : 'Prix à corriger';
    } else if (f === 'customTags') {
      const chosen = (item.tags || []).filter((t) => TAGS.includes(t));
      item.tags = [...chosen, ...el.value.split(',').map((t) => t.trim()).filter(Boolean)];
    } else {
      item[f] = el.value;
      if (f === 'name') itemBox.querySelector('[data-sum="name"]').textContent = el.value || 'Sans nom';
      if (f === 'emoji' && !item.image) itemBox.querySelectorAll('.ed-thumb, .ed-photo-box').forEach((b) => { b.textContent = el.value || '🍽'; });
    }
    setDirty(true);
  });

  $('#menuList').addEventListener('change', async (e) => {
    const el = e.target;
    const { ci, ii, item } = ref(el);
    if (el.dataset.f === 'category') { // déplacer le plat
      const to = Number(el.value);
      draft.categories[ci].items.splice(ii, 1);
      draft.categories[to].items.push(item);
      setDirty(true); renderEditor();
      toast(`Plat déplacé dans « ${draft.categories[to].name} »`);
    }
    if (el.dataset.act === 'photo' && el.files[0]) {
      uploading = item; renderEditor();
      try {
        const blob = await shrinkImage(el.files[0]);
        const r = await fetch('/api/admin/images', { method: 'POST', headers: { 'Content-Type': blob.type, 'x-admin-token': token || '' }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) return logout();
        if (!r.ok) throw new Error(j.error || 'Envoi impossible');
        item.image = j.id; setDirty(true);
      } catch (err) {
        toast(err.message === 'decode' ? 'Format de photo non pris en charge. Essayez une photo JPEG ou PNG.' : `Photo non envoyée : ${err.message}`);
      } finally { uploading = null; renderEditor(); }
    }
  });

  $('#menuList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act;
    const { ci, ii, cat, item } = ref(b);
    if (act === 'avail') { // s'applique tout de suite
      const on = !b.classList.contains('on');
      item.available = on;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
      b.closest('.ed-item').classList.toggle('off', !on);
      b.previousElementSibling.textContent = on ? 'Disponible' : 'Épuisé';
      try { await api('/api/admin/menu/' + item.id, { method: 'PATCH', body: { available: on } }); toast(on ? `« ${item.name} » est de nouveau disponible` : `« ${item.name} » est marqué épuisé`); }
      catch (err) { toast(err.message); }
      return;
    }
    if (act === 'allergen') {
      const id = b.dataset.al;
      let list = (item.allergens || []).filter((x) => x !== 'aucun');
      if (id === 'aucun') list = (item.allergens || []).includes('aucun') ? [] : ['aucun'];
      else list = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      item.allergens = list;
      b.closest('.ed-allergens').querySelectorAll('[data-al]').forEach((x) => {
        const on = list.includes(x.dataset.al); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on);
      });
      const warn = b.closest('.ed-item').querySelector('[data-sum="al"]');
      if (list.length && warn) warn.previousSibling.remove(), warn.remove();
      return setDirty(true);
    }
    if (act === 'tag') {
      const t = b.dataset.tag;
      item.tags = (item.tags || []).includes(t) ? item.tags.filter((x) => x !== t) : [...(item.tags || []), t];
      b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on'));
      return setDirty(true);
    }
    const actions = {
      'cat-add': () => { draft.categories.push({ id: '', name: 'Nouvelle catégorie', icon: '🍽', items: [] }); },
      'cat-up': () => swap(draft.categories, ci, ci - 1),
      'cat-down': () => swap(draft.categories, ci, ci + 1),
      'cat-del': () => { confirmKey = 'cat:' + ci; return 'nodirty'; },
      'cat-del-yes': () => { draft.categories.splice(ci, 1); confirmKey = null; },
      'cancel-confirm': () => { confirmKey = null; return 'nodirty'; },
      'item-add': () => {
        const it = { id: '', name: 'Nouveau plat', description: '', price: 0, emoji: '🍽', tags: [], image: null, available: true, allergens: [] };
        cat.items.push(it); openItem = it;
      },
      'item-up': () => swap(cat.items, ii, ii - 1),
      'item-down': () => swap(cat.items, ii, ii + 1),
      'item-toggle': () => { openItem = openItem === item ? null : item; confirmKey = null; return 'nodirty'; },
      'item-del': () => { confirmKey = 'item:' + item.id + ':' + ci; return 'nodirty'; },
      'item-del-yes': () => { cat.items.splice(ii, 1); openItem = null; confirmKey = null; },
      'photo-del': () => { item.image = null; },
    };
    if (!actions[act]) return;
    if (actions[act]() !== 'nodirty') setDirty(true);
    renderEditor();
    if (act === 'item-add') $('#menuList .ed-item.open [data-f="name"]')?.select();
  });

  $('#saveMenu').addEventListener('click', async () => {
    for (const c of draft.categories) for (const it of c.items) {
      if (!String(it.name).trim() || !Number.isFinite(it.price)) {
        openItem = it; renderEditor();
        $('#menuList .ed-item.open')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return toast(!String(it.name).trim() ? 'Un plat n\'a pas de nom' : `Le prix de « ${it.name} » est invalide (ex. 12,50)`);
      }
    }
    const btn = $('#saveMenu');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      const menu = await api('/api/admin/menu', { method: 'PUT', body: draft });
      if (menu.error) throw new Error(menu.error);
      draft = structuredClone(menu);
      savedIds = new Set(menu.categories.flatMap((c) => c.items.map((i) => i.id)));
      openItem = null; confirmKey = null;
      setDirty(false); renderEditor();
      $('#brandName').textContent = menu.restaurant.name;
      toast('Carte enregistrée : les clients voient déjà la nouvelle version');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Enregistrer'; }
  });
  $('#cancelEdit').addEventListener('click', () => loadMenu(true));

  // Réduit la photo dans le navigateur (1000 px max, JPEG) avant l'envoi
  async function shrinkImage(file) {
    let src;
    try { src = await createImageBitmap(file); }
    catch {
      src = await new Promise((ok, ko) => {
        const img = new Image();
        img.onload = () => ok(img); img.onerror = () => ko(new Error('decode'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w = src.width, h = src.height;
    if (!w || !h) throw new Error('decode');
    const k = Math.min(1, 1000 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
    canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
    if (!blob) throw new Error('decode');
    return blob;
  }

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
