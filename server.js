// Serveur QR Resto — commande à table via QR code, règlement au comptoir
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { createStorage } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// ---------- Données (chargées au démarrage depuis la base) ----------
const DATA_DIR = path.join(__dirname, 'data');
let storage;
let menu;
let tables;
let staff = [];  // comptes du personnel : { id, name, role, salt, hash }
let orders = []; // commandes des dernières 48 h, gardées en mémoire pour l'affichage temps réel

async function loadData() {
  storage = await createStorage(DATA_DIR);
  menu = await storage.get('menu');
  if (!menu) { // premier démarrage : carte d'exemple
    menu = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'menu.example.json'), 'utf8'));
    await storage.set('menu', menu);
  }
  tables = await storage.get('tables');
  if (!tables) {
    tables = Array.from({ length: 12 }, (_, i) => newTable(i + 1));
    await storage.set('tables', tables);
  }
  orders = await storage.recentOrders(48);
  staff = (await storage.get('staff')) || [];
}
const saveMenu = () => storage.set('menu', menu);
const saveTables = () => storage.set('tables', tables);
function dbError(res, e) {
  console.error('[db] écriture impossible :', e.message);
  res.status(503).json({ error: "Enregistrement impossible pour le moment, réessayez dans un instant" });
}
// Avec TABLE_SECRET, le lien de chaque table est dérivé du secret : il reste identique
// même si l'hébergeur efface les fichiers (QR codes imprimés toujours valides).
function newTable(number) {
  const token = process.env.TABLE_SECRET
    ? crypto.createHmac('sha256', process.env.TABLE_SECRET).update('table-' + number).digest('base64url').slice(0, 12)
    : crypto.randomBytes(9).toString('base64url');
  return { id: 'table-' + number, number, token };
}

const tableByToken = (t) => tables.find((x) => x.token === t);
const allItems = () => menu.categories.flatMap((c) => c.items);
const findItem = (id) => allItems().find((i) => i.id === id);

function nextOrderNumber() {
  const today = new Date().toDateString();
  const todays = orders.filter((o) => new Date(o.createdAt).toDateString() === today);
  return todays.length + 1;
}

// ---------- App ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Photos des plats (envoyées déjà réduites par le navigateur)
const IMAGE_TYPES = { 'image/jpeg': 1, 'image/webp': 1, 'image/png': 1 };
const IMAGE_ID = /^[0-9a-f]{32}$/;
app.post('/api/admin/images', (req, res, next) => requireManager(req, res, next),
  express.raw({ type: Object.keys(IMAGE_TYPES), limit: '1mb' }), async (req, res) => {
    const mime = (req.get('content-type') || '').split(';')[0];
    if (!IMAGE_TYPES[mime] || !Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Image invalide' });
    const id = crypto.randomBytes(16).toString('hex');
    try { await storage.putImage(id, mime, req.body); } catch (e) { return dbError(res, e); }
    res.json({ id });
  });
app.get('/img/:id', async (req, res) => {
  if (!IMAGE_ID.test(req.params.id)) return res.sendStatus(404);
  try {
    const img = await storage.getImage(req.params.id);
    if (!img) return res.sendStatus(404);
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' }).send(img.data);
  } catch (e) { console.error('[db] lecture image :', e.message); res.sendStatus(503); }
});

app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (_req, res) => res.redirect('/admin'));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/t/:token', (req, res) => {
  if (!tableByToken(req.params.token)) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// ---------- API client ----------
const publicOrder = (o) => ({
  id: o.id, number: o.number, items: o.items, note: o.note, total: o.total,
  payment: o.payment, paid: o.paid, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
});

app.get('/api/table/:token', (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
  res.json({
    table: { number: table.number },
    restaurant: menu.restaurant,
    categories: menu.categories,
  });
});

app.get('/api/table/:token/orders', (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
  const since = Date.now() - 6 * 3600e3; // commandes des 6 dernières heures
  res.json(orders
    .filter((o) => o.tableId === table.id && o.status !== 'cancelled' && new Date(o.createdAt) > since)
    .map(publicOrder));
});

// Limite les envois répétés depuis une même table (QR code photographié, blagues…)
const recentHits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const hits = (recentHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { recentHits.set(key, hits); return true; }
  hits.push(now);
  recentHits.set(key, hits);
  return false;
}
setInterval(() => { // ménage
  const now = Date.now();
  for (const [k, hits] of recentHits) if (!hits.some((t) => now - t < 3600e3)) recentHits.delete(k);
}, 600e3).unref();

app.post('/api/table/:token/orders', async (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
  if (tooMany('order:' + table.id, 5, 10 * 60e3)) {
    return res.status(429).json({ error: 'Trop de commandes envoyées depuis cette table en peu de temps. Merci de demander au personnel.' });
  }
  const { items, note = '' } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Panier vide' });

  // Les prix sont toujours recalculés côté serveur
  const lines = [];
  for (const it of items.slice(0, 50)) {
    const ref = findItem(it.id);
    const qty = Math.min(Math.max(parseInt(it.qty, 10) || 0, 0), 20);
    if (!ref || !qty) continue;
    if (ref.available === false) return res.status(409).json({ error: `« ${ref.name} » n'est plus disponible` });
    lines.push({ id: ref.id, name: ref.name, emoji: ref.emoji, price: ref.price, qty, note: String(it.note || '').slice(0, 140) });
  }
  if (!lines.length) return res.status(400).json({ error: 'Panier vide' });

  const now = new Date().toISOString();
  const order = {
    id: crypto.randomUUID(),
    number: nextOrderNumber(),
    tableId: table.id,
    tableNumber: table.number,
    tableToken: table.token,
    items: lines,
    note: String(note).slice(0, 300),
    total: lines.reduce((s, l) => s + l.price * l.qty, 0),
    payment: 'counter',
    paid: false,
    status: 'new',
    createdAt: now,
    updatedAt: now,
  };
  const cutoff = Date.now() - 48 * 3600e3;
  orders = orders.filter((o) => new Date(o.createdAt) > cutoff);
  orders.push(order);
  try { await storage.saveOrder(order); }
  catch (e) { orders = orders.filter((o) => o !== order); return dbError(res, e); }

  broadcast(order, true);
  res.json({ order: publicOrder(order) });
});

app.post('/api/table/:token/call', (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
  if (tooMany('call:' + table.id, 3, 2 * 60e3)) {
    return res.status(429).json({ error: 'Le personnel a déjà été prévenu, il arrive.' });
  }
  const reason = req.body.reason === 'bill' ? 'bill' : 'waiter';
  io.to('staff').emit('call', { id: crypto.randomUUID(), table: table.number, reason, at: new Date().toISOString() });
  res.json({ ok: true });
});

function broadcast(order, isNew) {
  io.to('staff').emit(isNew ? 'order:new' : 'order:update', order);
  io.to('table:' + order.tableToken).emit('order:update', publicOrder(order));
}

// ---------- API restaurant ----------
// Rôles : « manager » (gérant : tout) et « waiter » (serveur : commandes uniquement).
// Le code ADMIN_PIN défini sur l'hébergeur reste toujours valable comme code du gérant principal.
const MASTER = { id: 'master', name: 'Gérant principal', role: 'manager' };
const sessions = new Map(); // jeton -> { staffId, name, role }
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32, { N: 4096 }).toString('hex');
const sameText = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function whoHasPin(pin) {
  if (sameText(pin, ADMIN_PIN)) return MASTER;
  return staff.find((m) => sameText(hashPin(pin, m.salt), m.hash)) || null;
}
const session = (req) => sessions.get(req.get('x-admin-token') || '');
const requireAdmin = (req, res, next) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'Non autorisé' });
  req.staff = s;
  next();
};
const requireManager = (req, res, next) => requireAdmin(req, res, () =>
  req.staff.role === 'manager' ? next() : res.status(403).json({ error: 'Réservé au gérant' }));
function endSessions(staffId) {
  for (const [t, s] of sessions) if (s.staffId === staffId) sessions.delete(t);
  for (const sock of io.of('/').sockets.values()) if (sock.data.staffId === staffId) sock.disconnect(true);
}

app.post('/api/admin/login', (req, res) => {
  const pin = String(req.body.pin || '');
  const who = /^\d{4,8}$/.test(pin) || pin === ADMIN_PIN ? whoHasPin(pin) : null;
  if (!who) return res.status(401).json({ error: 'Code incorrect' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { staffId: who.id, name: who.name, role: who.role });
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => { sessions.delete(req.get('x-admin-token') || ''); res.json({ ok: true }); });

app.get('/api/admin/session', requireAdmin, (req, res) => res.json({
  restaurant: menu.restaurant,
  me: { name: req.staff.name, role: req.staff.role },
}));

// ----- Équipe (gérant uniquement)
const publicStaff = (m) => ({ id: m.id, name: m.name, role: m.role });
function checkStaffInput(body, existingId) {
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const role = body.role === 'manager' ? 'manager' : 'waiter';
  const pin = body.pin == null || body.pin === '' ? null : String(body.pin);
  if (!name) return { error: 'Indiquez un prénom' };
  if (pin !== null) {
    if (!/^\d{4,8}$/.test(pin)) return { error: 'Le code doit faire de 4 à 8 chiffres' };
    const owner = whoHasPin(pin);
    if (owner && owner.id !== existingId) return { error: 'Ce code est déjà utilisé, choisissez-en un autre' };
  }
  return { name, role, pin };
}
const saveStaff = () => storage.set('staff', staff);

app.get('/api/admin/staff', requireManager, (_req, res) => res.json(staff.map(publicStaff)));

app.post('/api/admin/staff', requireManager, async (req, res) => {
  const v = checkStaffInput(req.body, null);
  if (v.error) return res.status(400).json(v);
  if (!v.pin) return res.status(400).json({ error: 'Indiquez un code' });
  if (staff.length >= 50) return res.status(400).json({ error: 'Nombre maximum de comptes atteint' });
  const salt = crypto.randomBytes(12).toString('hex');
  const member = { id: crypto.randomUUID(), name: v.name, role: v.role, salt, hash: hashPin(v.pin, salt) };
  staff.push(member);
  try { await saveStaff(); } catch (e) { staff = staff.filter((m) => m !== member); return dbError(res, e); }
  res.json(publicStaff(member));
});

app.patch('/api/admin/staff/:id', requireManager, async (req, res) => {
  const member = staff.find((m) => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Compte introuvable' });
  const v = checkStaffInput(req.body, member.id);
  if (v.error) return res.status(400).json(v);
  const roleChanged = member.role !== v.role;
  member.name = v.name; member.role = v.role;
  if (v.pin) { member.salt = crypto.randomBytes(12).toString('hex'); member.hash = hashPin(v.pin, member.salt); }
  try { await saveStaff(); } catch (e) { return dbError(res, e); }
  if (roleChanged || v.pin) endSessions(member.id); // la personne doit se reconnecter
  else for (const s of sessions.values()) if (s.staffId === member.id) s.name = member.name;
  res.json(publicStaff(member));
});

app.delete('/api/admin/staff/:id', requireManager, async (req, res) => {
  const before = staff;
  staff = staff.filter((m) => m.id !== req.params.id);
  try { await saveStaff(); } catch (e) { staff = before; return dbError(res, e); }
  endSessions(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  const since = Date.now() - 24 * 3600e3;
  res.json(orders.filter((o) => new Date(o.createdAt) > since && o.status !== 'cancelled'));
});

const FLOW = ['new', 'preparing', 'ready', 'served'];
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  const { status, paid } = req.body;
  if (status && (FLOW.includes(status) || status === 'cancelled')) order.status = status;
  if (paid === true && !order.paid) { order.paid = true; order.paymentRef = 'counter'; }
  order.updatedAt = new Date().toISOString();
  try { await storage.saveOrder(order); } catch (e) { return dbError(res, e); }
  broadcast(order, false);
  res.json(order);
});

app.get('/api/admin/tables', requireManager, async (_req, res) => {
  const out = await Promise.all(tables.map(async (t) => {
    const url = `${BASE_URL}/t/${t.token}`;
    const qr = await QRCode.toDataURL(url, { width: 600, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14110f', light: '#ffffff' } });
    return { id: t.id, number: t.number, url, qr };
  }));
  res.json(out);
});

app.post('/api/admin/tables', requireManager, async (_req, res) => {
  const t = newTable(Math.max(0, ...tables.map((x) => x.number)) + 1);
  tables.push(t);
  try { await saveTables(); } catch (e) { return dbError(res, e); }
  res.json({ ok: true });
});

// Régénère le QR d'une table (invalide l'ancien)
app.post('/api/admin/tables/:id/regenerate', requireManager, async (req, res) => {
  const t = tables.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Table introuvable' });
  t.token = crypto.randomBytes(9).toString('base64url');
  try { await saveTables(); } catch (e) { return dbError(res, e); }
  res.json({ ok: true });
});

app.delete('/api/admin/tables/:id', requireManager, async (req, res) => {
  tables = tables.filter((x) => x.id !== req.params.id);
  try { await saveTables(); } catch (e) { return dbError(res, e); }
  res.json({ ok: true });
});

app.get('/api/admin/menu', requireManager, (_req, res) => res.json(menu));

// Enregistre la carte complète envoyée par l'éditeur (tout est revérifié ici)
function slug(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function cleanMenu(input) {
  const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const current = new Map(allItems().map((i) => [i.id, i]));
  const used = new Set();
  const uniqueId = (wanted, label) => {
    let id = /^[a-z0-9-]{1,60}$/.test(wanted || '') ? wanted : (slug(label) || 'element');
    while (used.has(id)) id = `${slug(label) || 'element'}-${crypto.randomBytes(2).toString('hex')}`;
    used.add(id);
    return id;
  };
  const cats = Array.isArray(input?.categories) ? input.categories.slice(0, 30) : [];
  return {
    restaurant: {
      name: str(input?.restaurant?.name, 60) || menu.restaurant.name,
      tagline: str(input?.restaurant?.tagline, 120),
      currency: menu.restaurant.currency || 'EUR',
    },
    categories: cats.map((c) => ({
      id: uniqueId(c?.id, c?.name),
      name: str(c?.name, 40) || 'Sans nom',
      icon: str(c?.icon, 8),
      items: (Array.isArray(c?.items) ? c.items.slice(0, 150) : [])
        .filter((it) => str(it?.name, 80))
        .map((it) => {
          const id = uniqueId(it.id, it.name);
          const price = Math.round(Number(it.price));
          return {
            id,
            name: str(it.name, 80),
            description: str(it.description, 300),
            price: Number.isFinite(price) ? Math.min(Math.max(price, 0), 1000000) : 0,
            emoji: str(it.emoji, 8) || '🍽',
            tags: (Array.isArray(it.tags) ? it.tags : []).map((t) => str(t, 24)).filter(Boolean).slice(0, 6),
            image: IMAGE_ID.test(it.image || '') ? it.image : null,
            // la disponibilité se gère avec l'interrupteur « épuisé », pas depuis l'éditeur
            available: current.has(id) ? current.get(id).available !== false : true,
          };
        }),
    })),
  };
}
app.put('/api/admin/menu', requireManager, async (req, res) => {
  const next = cleanMenu(req.body);
  const before = new Set(allItems().map((i) => i.image).filter(Boolean));
  const previous = menu;
  menu = next;
  try { await saveMenu(); }
  catch (e) { menu = previous; return dbError(res, e); }
  // supprime les photos qui ne servent plus
  const kept = new Set(allItems().map((i) => i.image).filter(Boolean));
  storage.deleteImages([...before].filter((id) => !kept.has(id))).catch((e) => console.error('[db] nettoyage images :', e.message));
  io.emit('menu:update', menu);
  res.json(menu);
});

app.patch('/api/admin/menu/:id', requireManager, async (req, res) => {
  const item = findItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Plat introuvable' });
  if (typeof req.body.available === 'boolean') item.available = req.body.available;
  try { await saveMenu(); } catch (e) { return dbError(res, e); }
  io.emit('menu:availability', { id: item.id, available: item.available });
  res.json(item);
});

// ---------- Temps réel ----------
io.on('connection', (socket) => {
  const { role, token } = socket.handshake.auth || {};
  const s = role === 'staff' && sessions.get(token || '');
  if (s) { socket.data.staffId = s.staffId; socket.join('staff'); }
  else if (role === 'table' && tableByToken(token)) socket.join('table:' + token);
  else socket.disconnect(true);
});

loadData().then(() => server.listen(PORT, () => {
  console.log(`\n🍽  QR Resto démarré sur ${BASE_URL}`);
  console.log(`   Stockage             : ${storage.kind}`);
  console.log(`   Interface restaurant : ${BASE_URL}/admin  (code PIN : ${process.env.ADMIN_PIN ? '••••' : ADMIN_PIN})`);
  console.log(`   Exemple table 1      : ${BASE_URL}/t/${tables[0]?.token}`);
  console.log('   Paiement             : au comptoir / auprès du serveur\n');
})).catch((e) => {
  console.error('Démarrage impossible :', e.message);
  process.exit(1);
});
