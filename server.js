// Serveur QR Resto — commande à table via QR code, règlement au comptoir
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// ---------- Persistance (fichiers JSON) ----------
const DATA_DIR = path.join(__dirname, 'data');
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
function save(name, data) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

const menu = load('menu.json', null);
if (!menu) throw new Error('data/menu.json est introuvable');

let tables = load('tables.json', null);
if (!tables) {
  tables = Array.from({ length: 12 }, (_, i) => newTable(i + 1));
  save('tables.json', tables);
}
// Avec TABLE_SECRET, le lien de chaque table est dérivé du secret : il reste identique
// même si l'hébergeur efface les fichiers (QR codes imprimés toujours valides).
function newTable(number) {
  const token = process.env.TABLE_SECRET
    ? crypto.createHmac('sha256', process.env.TABLE_SECRET).update('table-' + number).digest('base64url').slice(0, 12)
    : crypto.randomBytes(9).toString('base64url');
  return { id: 'table-' + number, number, token };
}

let orders = load('orders.json', []);
const saveOrders = () => save('orders.json', orders);

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

app.use(express.json({ limit: '100kb' }));
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

app.post('/api/table/:token/orders', async (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
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
  orders.push(order);
  saveOrders();

  broadcast(order, true);
  res.json({ order: publicOrder(order) });
});

app.post('/api/table/:token/call', (req, res) => {
  const table = tableByToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'Table inconnue' });
  const reason = req.body.reason === 'bill' ? 'bill' : 'waiter';
  io.to('staff').emit('call', { id: crypto.randomUUID(), table: table.number, reason, at: new Date().toISOString() });
  res.json({ ok: true });
});

function broadcast(order, isNew) {
  io.to('staff').emit(isNew ? 'order:new' : 'order:update', order);
  io.to('table:' + order.tableToken).emit('order:update', publicOrder(order));
}

// ---------- API restaurant ----------
const adminTokens = new Set();
const isAdmin = (t) => t && adminTokens.has(t);
const requireAdmin = (req, res, next) => (isAdmin(req.get('x-admin-token')) ? next() : res.status(401).json({ error: 'Non autorisé' }));

app.post('/api/admin/login', (req, res) => {
  const pin = String(req.body.pin || '');
  const ok = pin.length === ADMIN_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN));
  if (!ok) return res.status(401).json({ error: 'Code incorrect' });
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

app.get('/api/admin/session', requireAdmin, (_req, res) => res.json({ restaurant: menu.restaurant }));

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  const since = Date.now() - 24 * 3600e3;
  res.json(orders.filter((o) => new Date(o.createdAt) > since && o.status !== 'cancelled'));
});

const FLOW = ['new', 'preparing', 'ready', 'served'];
app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  const { status, paid } = req.body;
  if (status && (FLOW.includes(status) || status === 'cancelled')) order.status = status;
  if (paid === true && !order.paid) { order.paid = true; order.paymentRef = 'counter'; }
  order.updatedAt = new Date().toISOString();
  saveOrders();
  broadcast(order, false);
  res.json(order);
});

app.get('/api/admin/tables', requireAdmin, async (_req, res) => {
  const out = await Promise.all(tables.map(async (t) => {
    const url = `${BASE_URL}/t/${t.token}`;
    const qr = await QRCode.toDataURL(url, { width: 600, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14110f', light: '#ffffff' } });
    return { id: t.id, number: t.number, url, qr };
  }));
  res.json(out);
});

app.post('/api/admin/tables', requireAdmin, (_req, res) => {
  const t = newTable(Math.max(0, ...tables.map((x) => x.number)) + 1);
  tables.push(t);
  save('tables.json', tables);
  res.json({ ok: true });
});

// Régénère le QR d'une table (invalide l'ancien)
app.post('/api/admin/tables/:id/regenerate', requireAdmin, (req, res) => {
  const t = tables.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Table introuvable' });
  t.token = crypto.randomBytes(9).toString('base64url');
  save('tables.json', tables);
  res.json({ ok: true });
});

app.delete('/api/admin/tables/:id', requireAdmin, (req, res) => {
  tables = tables.filter((x) => x.id !== req.params.id);
  save('tables.json', tables);
  res.json({ ok: true });
});

app.get('/api/admin/menu', requireAdmin, (_req, res) => res.json(menu));

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const item = findItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Plat introuvable' });
  if (typeof req.body.available === 'boolean') item.available = req.body.available;
  save('menu.json', menu);
  io.emit('menu:availability', { id: item.id, available: item.available });
  res.json(item);
});

// ---------- Temps réel ----------
io.on('connection', (socket) => {
  const { role, token } = socket.handshake.auth || {};
  if (role === 'staff' && isAdmin(token)) socket.join('staff');
  else if (role === 'table' && tableByToken(token)) socket.join('table:' + token);
  else socket.disconnect(true);
});

server.listen(PORT, () => {
  console.log(`\n🍽  QR Resto démarré sur ${BASE_URL}`);
  console.log(`   Interface restaurant : ${BASE_URL}/admin  (code PIN : ${process.env.ADMIN_PIN ? '••••' : ADMIN_PIN})`);
  console.log(`   Exemple table 1      : ${BASE_URL}/t/${tables[0]?.token}`);
  console.log('   Paiement             : au comptoir / auprès du serveur\n');
});
