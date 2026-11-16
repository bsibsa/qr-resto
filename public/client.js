(() => {
  const token = location.pathname.split('/')[2];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let data, fmt;
  let cart = store.get('cart:' + token, []); // [{key, id, qty, note}]
  let myOrders = [];
  let pendingOrder = null;
  let freshOrderId = null;
  const items = new Map();

  const STEPS = [
    ['new', 'Reçue', 'La cuisine a bien reçu votre commande.'],
    ['preparing', 'En préparation', 'Votre commande est en cours de préparation.'],
    ['ready', 'Prête', 'C\'est prêt ! On vous l\'apporte.'],
    ['served', 'Servie', 'Bon appétit !'],
  ];

  // ---------- Initialisation ----------
  async function init() {
    const res = await fetch('/api/table/' + token);
    if (!res.ok) { location.href = '/404.html'; return; }
    data = await res.json();
    fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: data.restaurant.currency });
    data.categories.forEach((c) => c.items.forEach((i) => items.set(i.id, i)));
    cart = cart.filter((l) => items.has(l.id));

    document.title = `${data.restaurant.name} · Table ${data.table.number}`;
    $('#splashName').textContent = data.restaurant.name;
    $('#splashTable').textContent = `Table ${data.table.number}`;
    $('#restoName').textContent = data.restaurant.name;
    $('#restoTagline').textContent = data.restaurant.tagline;
    $('#tableBadge').textContent = `Table ${data.table.number}`;
    if (data.payment.mode !== 'demo') $('#demoNote').hidden = true;

    renderMenu();
    renderCart();
    setTimeout(() => $('#splash').classList.add('out'), 1500);

    await loadOrders();
    connectSocket();
    await handleReturnFromCheckout();
  }

  async function loadOrders() {
    const r = await fetch(`/api/table/${token}/orders`);
    if (!r.ok) return;
    const mine = new Set(store.get('orders:' + token, []));
    myOrders = (await r.json()).filter((o) => mine.has(o.id));
    updateOrdersBtn();
  }
  function rememberOrder(id) {
    const ids = store.get('orders:' + token, []);
    if (!ids.includes(id)) store.set('orders:' + token, [...ids, id].slice(-30));
  }

  function connectSocket() {
    const socket = io({ auth: { role: 'table', token } });
    socket.on('order:update', (o) => {
      const idx = myOrders.findIndex((x) => x.id === o.id);
      if (idx === -1) return;
      const prev = myOrders[idx].status;
      myOrders[idx] = o;
      if (prev !== o.status) {
        if (o.status === 'preparing') toast('👨‍🍳 Votre commande est en préparation');
        if (o.status === 'ready') { toast('🎉 Votre commande arrive !'); navigator.vibrate?.([80, 60, 80]); }
        if (o.status === 'served') toast('Bon appétit !');
      }
      updateOrdersBtn();
      if ($('#trackSheet').classList.contains('show')) renderTrack();
    });
    socket.on('menu:availability', ({ id, available }) => {
      const it = items.get(id);
      if (!it) return;
      it.available = available;
      document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.classList.toggle('soldout', !available);
      if (!available && cart.some((l) => l.id === id)) {
        cart = cart.filter((l) => l.id !== id);
        renderCart();
        toast(`« ${it.name} » vient d'être épuisé et a été retiré du panier`);
      }
    });
  }

  async function handleReturnFromCheckout() {
    const p = new URLSearchParams(location.search);
    history.replaceState(null, '', location.pathname);
    if (p.get('order') && p.get('session_id')) {
      const r = await fetch(`/api/orders/${p.get('order')}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: p.get('session_id') }),
      });
      const j = await r.json();
      if (j.order?.paid) { onOrderPlaced(j.order); }
      else toast('Paiement non confirmé');
    } else if (p.get('cancelled')) {
      post(`/api/orders/${p.get('cancelled')}/cancel-payment`, { token });
      toast('Paiement annulé — votre panier est conservé');
    }
  }

  // ---------- Menu ----------
  function renderMenu() {
    $('#cats').innerHTML = data.categories.map((c, i) =>
      `<button class="cat${i ? '' : ' active'}" data-target="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
    $('#menu').innerHTML = data.categories.map((c) => `
      <section class="section" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}">
        <h2><span>${esc(c.icon)}</span>${esc(c.name)}</h2>
        ${c.items.map((it) => `
          <article class="item${it.available === false ? ' soldout' : ''}" data-id="${esc(it.id)}">
            <div class="item-emoji">${esc(it.emoji)}</div>
            <div class="item-body">
              <div class="item-name">${esc(it.name)}</div>
              <div class="item-desc">${esc(it.description)}</div>
              <div class="item-foot">
                <span class="price">${fmt.format(it.price / 100)}</span>
                <div class="tags">${tagsHtml(it)}</div>
              </div>
            </div>
            <button class="add" aria-label="Ajouter ${esc(it.name)}">+</button>
          </article>`).join('')}
      </section>`).join('');

    // Apparition au défilement
    const reveal = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target); }
    }), { rootMargin: '0px 0px -30px 0px' });
    document.querySelectorAll('.item').forEach((el, i) => { el.style.transitionDelay = `${Math.min(i % 6, 5) * 60}ms`; reveal.observe(el); });

    // Catégorie active au défilement
    const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) setActiveCat(e.target.dataset.cat);
    }), { rootMargin: '-35% 0px -60% 0px' });
    document.querySelectorAll('.section').forEach((s) => spy.observe(s));

    $('#cats').addEventListener('click', (e) => {
      const b = e.target.closest('.cat');
      if (b) document.getElementById('cat-' + b.dataset.target).scrollIntoView({ behavior: 'smooth' });
    });
    $('#menu').addEventListener('click', (e) => {
      const card = e.target.closest('.item');
      if (!card) return;
      if (e.target.closest('.add')) { addToCart(card.dataset.id, 1, ''); fly(card.querySelector('.item-emoji')); }
      else openItem(card.dataset.id);
    });
  }
  function tagsHtml(it) {
    return (it.tags || []).map((t) => `<span class="tag${t === 'Signature' ? ' sig' : ''}">${esc(t)}</span>`).join('');
  }
  function setActiveCat(id) {
    document.querySelectorAll('.cat').forEach((b) => {
      const on = b.dataset.target === id;
      b.classList.toggle('active', on);
      if (on) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    });
  }

  // ---------- Fiche produit ----------
  let current = null, curQty = 1;
  function openItem(id) {
    current = items.get(id); curQty = 1;
    $('#itemHero').textContent = current.emoji;
    $('#itemName').textContent = current.name;
    $('#itemDesc').textContent = current.description;
    $('#itemTags').innerHTML = tagsHtml(current);
    $('#itemNote').value = '';
    updateItemSheet();
    openSheet('#itemSheet');
  }
  function updateItemSheet() {
    $('#itemQty').textContent = curQty;
    $('#itemAddPrice').textContent = fmt.format(current.price * curQty / 100);
  }
  $('#itemSheet').addEventListener('click', (e) => {
    const s = e.target.closest('[data-step]');
    if (s) { curQty = Math.min(20, Math.max(1, curQty + Number(s.dataset.step))); updateItemSheet(); }
  });
  $('#itemAdd').addEventListener('click', () => {
    addToCart(current.id, curQty, $('#itemNote').value.trim());
    closeSheets();
    setTimeout(() => fly($('#itemHero'), current.emoji), 120);
  });

  // ---------- Panier ----------
  function addToCart(id, qty, note) {
    const key = id + '|' + note;
    const line = cart.find((l) => l.key === key);
    if (line) line.qty = Math.min(20, line.qty + qty);
    else cart.push({ key, id, qty, note });
    renderCart(true);
  }
  function cartTotal() { return cart.reduce((s, l) => s + items.get(l.id).price * l.qty, 0); }
  function cartCount() { return cart.reduce((s, l) => s + l.qty, 0); }

  function renderCart(bump) {
    store.set('cart:' + token, cart);
    const n = cartCount();
    const bar = $('#cartBar');
    bar.hidden = n === 0;
    $('#cartCount').textContent = n;
    $('#cartTotal').textContent = fmt.format(cartTotal() / 100);
    if (bump) { bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump'); }

    // Badges de quantité sur les cartes
    document.querySelectorAll('.item').forEach((el) => {
      const q = cart.filter((l) => l.id === el.dataset.id).reduce((s, l) => s + l.qty, 0);
      let pill = el.querySelector('.qty-pill');
      if (q && !pill) { pill = document.createElement('span'); pill.className = 'qty-pill'; el.querySelector('.item-foot').prepend(pill); }
      if (pill) { if (q) pill.textContent = '×' + q; else pill.remove(); }
    });

    $('#cartLines').innerHTML = cart.map((l) => {
      const it = items.get(l.id);
      return `<div class="cline" data-key="${esc(l.key)}">
        <span class="e">${esc(it.emoji)}</span>
        <div class="n">${esc(it.name)}${l.note ? `<small>« ${esc(l.note)} »</small>` : ''}</div>
        <div class="stepper"><button data-d="-1">−</button><span>${l.qty}</span><button data-d="1">+</button></div>
        <span class="p">${fmt.format(it.price * l.qty / 100)}</span>
      </div>`;
    }).join('');
    $('#sheetTotal').textContent = fmt.format(cartTotal() / 100);
    if (!n && $('#cartSheet').classList.contains('show')) closeSheets();
  }
  $('#cartLines').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    const line = cart.find((l) => l.key === b.closest('.cline').dataset.key);
    line.qty += Number(b.dataset.d);
    if (line.qty <= 0) cart = cart.filter((l) => l !== line);
    line.qty = Math.min(line.qty, 20);
    renderCart();
  });
  $('#cartBar').addEventListener('click', () => openSheet('#cartSheet'));

  function fly(fromEl, emoji) {
    const bar = $('#cartBar');
    if (bar.hidden) return;
    const a = fromEl.getBoundingClientRect(), b = $('#cartCount').getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'flyer';
    f.textContent = emoji || fromEl.textContent.trim();
    f.style.left = a.left + a.width / 2 - 15 + 'px';
    f.style.top = a.top + a.height / 2 - 15 + 'px';
    document.body.appendChild(f);
    requestAnimationFrame(() => {
      f.style.transform = `translate(${b.left - a.left - a.width / 2 + 15}px, ${b.top - a.top - a.height / 2 + 15}px) scale(.4)`;
      f.style.opacity = '.3';
    });
    setTimeout(() => f.remove(), 750);
  }

  // ---------- Commande ----------
  $('#orderBtn').addEventListener('click', async () => {
    const btn = $('#orderBtn');
    const payment = document.querySelector('input[name="pay"]:checked').value;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await post(`/api/table/${token}/orders`, {
        items: cart.map((l) => ({ id: l.id, qty: l.qty, note: l.note })),
        note: $('#orderNote').value.trim(),
        payment,
      });
      if (r.error) throw new Error(r.error);
      rememberOrder(r.order.id);
      if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
      if (r.demo) { pendingOrder = r.order; openPay(); return; }
      onOrderPlaced(r.order);
    } catch (e) {
      toast(e.message || 'Erreur, réessayez');
    } finally {
      btn.disabled = false; btn.textContent = 'Commander';
    }
  });

  function onOrderPlaced(order) {
    cart = []; $('#orderNote').value = '';
    renderCart();
    rememberOrder(order.id);
    myOrders = myOrders.filter((o) => o.id !== order.id).concat(order);
    freshOrderId = order.id;
    updateOrdersBtn();
    closeSheets();
    setTimeout(() => { renderTrack(); openSheet('#trackSheet'); }, 250);
  }

  // ---------- Paiement (démo) ----------
  function openPay() {
    $('#payAmount').textContent = fmt.format(pendingOrder.total / 100);
    $('#payForm').reset();
    ['#ccNum', '#ccName', '#ccExp'].forEach((s) => $(s).textContent = $(s).dataset.def ||= $(s).textContent);
    openSheet('#paySheet');
  }
  $('#fNum').addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 16);
    e.target.value = v.replace(/(.{4})/g, '$1 ').trim();
    $('#ccNum').textContent = (v + '•'.repeat(16 - v.length)).replace(/(.{4})/g, '$1 ').trim();
  });
  $('#fName').addEventListener('input', (e) => { $('#ccName').textContent = e.target.value.toUpperCase() || 'NOM DU TITULAIRE'; });
  $('#fExp').addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = v.length > 2 ? v.slice(0, 2) + '/' + v.slice(2) : v;
    $('#ccExp').textContent = e.target.value || 'MM/AA';
  });
  $('#fCvc').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $('#payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#payBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Paiement en cours…';
    await new Promise((r) => setTimeout(r, 1400));
    const r = await post(`/api/orders/${pendingOrder.id}/demo-pay`, { token });
    btn.disabled = false; btn.innerHTML = `Payer <span id="payAmount">${fmt.format(pendingOrder.total / 100)}</span>`;
    if (r.error) return toast(r.error);
    pendingOrder = null;
    onOrderPlaced(r.order);
  });

  // ---------- Suivi ----------
  function updateOrdersBtn() {
    const active = myOrders.some((o) => o.status !== 'served' && o.status !== 'awaiting_payment');
    $('#ordersBtn').hidden = !myOrders.some((o) => o.status !== 'awaiting_payment');
    $('#ordersBtn .dot').style.display = active ? '' : 'none';
  }
  $('#ordersBtn').addEventListener('click', () => { renderTrack(); openSheet('#trackSheet'); });
  $('#trackClose').addEventListener('click', closeSheets);

  function renderTrack() {
    const list = myOrders.filter((o) => o.status !== 'awaiting_payment').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#trackList').innerHTML = list.map((o) => {
      const idx = STEPS.findIndex((s) => s[0] === o.status);
      const fresh = o.id === freshOrderId;
      return `<div class="track">
        ${fresh ? `<svg class="check" viewBox="0 0 84 84"><circle cx="42" cy="42" r="38"/><path d="M26 43l11 11 21-23"/></svg>` : ''}
        <div class="track-head">
          <h3>Commande n°${o.number}</h3>
          <span class="badge${o.paid ? '' : ' warn'}">${o.paid ? 'Payée' : 'À régler'}</span>
        </div>
        <div class="steps">${STEPS.map((s, i) => `<div class="step ${i < idx || o.status === 'served' ? 'done' : i === idx ? 'current' : ''}"><i></i>${s[1]}</div>`).join('')}</div>
        <p class="track-msg">${STEPS[idx]?.[2] || ''}</p>
        <div class="track-items">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(' · ')} — <b>${fmt.format(o.total / 100)}</b></div>
      </div>`;
    }).join('') || '<p class="track-msg">Aucune commande pour le moment.</p>';
    freshOrderId = null;
  }

  // ---------- Appel serveur ----------
  $('#callBtn').addEventListener('click', () => openSheet('#callSheet'));
  $('#callSheet').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-reason]');
    if (!b) return;
    await post(`/api/table/${token}/call`, { reason: b.dataset.reason });
    closeSheets();
    toast(b.dataset.reason === 'bill' ? '🧾 Un serveur arrive avec l\'addition' : '🙋 Un serveur arrive');
  });

  // ---------- Feuilles ----------
  function openSheet(sel) {
    document.querySelectorAll('.sheet.show').forEach((s) => s.classList.remove('show'));
    $(sel).classList.add('show'); $(sel).scrollTop = 0;
    $('#scrim').classList.add('show');
    document.body.classList.add('locked');
  }
  function closeSheets() {
    if ($('#paySheet').classList.contains('show') && pendingOrder) {
      post(`/api/orders/${pendingOrder.id}/cancel-payment`, { token });
      pendingOrder = null;
    }
    document.querySelectorAll('.sheet.show').forEach((s) => { s.classList.remove('show'); s.style.transform = ''; });
    $('#scrim').classList.remove('show');
    document.body.classList.remove('locked');
  }
  $('#scrim').addEventListener('click', closeSheets);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

  // Glisser vers le bas pour fermer
  document.querySelectorAll('.sheet').forEach((sheet) => {
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; } }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 === null) return;
      sheet.style.transition = '';
      if (dy > 110) closeSheets(); else sheet.style.transform = '';
      y0 = null;
    });
  });

  // ---------- Utilitaires ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({ error: 'Erreur réseau' }));
  }

  init().catch(() => toast('Impossible de charger le menu'));
})();
