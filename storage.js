// Stockage : PostgreSQL si DATABASE_URL est défini (production), sinon fichiers JSON dans data/ (tests en local).
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90; // historique des commandes conservé

// Exécute les écritures d'une même clé l'une après l'autre (jamais une ancienne version après une récente)
function serializer() {
  const chains = new Map();
  return (key, fn) => {
    const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    chains.set(key, run);
    return run;
  };
}

async function createStorage(dataDir) {
  return process.env.DATABASE_URL ? pgStorage(process.env.DATABASE_URL, dataDir) : fileStorage(dataDir);
}

// ---------- Fichiers JSON ----------
function fileStorage(dataDir) {
  const serial = serializer();
  const file = (name) => path.join(dataDir, name + '.json');
  const read = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  };
  const write = (name, value) => {
    fs.writeFileSync(file(name) + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file(name) + '.tmp', file(name));
  };
  const orders = new Map(read('orders', []).map((o) => [o.id, o]));

  return {
    kind: 'fichiers locaux',
    async get(key) { return read(key, null); },
    async set(key, value) { const snap = JSON.parse(JSON.stringify(value)); return serial(key, () => write(key, snap)); },
    async recentOrders(hours) {
      const since = Date.now() - hours * 3600e3;
      return [...orders.values()].filter((o) => new Date(o.createdAt) > since);
    },
    async saveOrder(order) {
      orders.set(order.id, JSON.parse(JSON.stringify(order)));
      const limit = Date.now() - KEEP_DAYS * 86400e3;
      for (const [id, o] of orders) if (new Date(o.createdAt) < limit) orders.delete(id);
      const snap = [...orders.values()];
      return serial('orders', () => write('orders', snap));
    },
  };
}

// ---------- PostgreSQL ----------
async function pgStorage(url, _dataDir) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=\/|@\//.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => console.error('[db] connexion perdue :', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
  `);
  await pool.query(`DELETE FROM orders WHERE created_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);

  const serial = serializer();
  return {
    kind: 'PostgreSQL',
    async get(key) {
      const r = await pool.query('SELECT value FROM kv WHERE key = $1', [key]);
      return r.rows[0]?.value ?? null;
    },
    async set(key, value) {
      const json = JSON.stringify(value);
      return serial('kv:' + key, () => pool.query(
        `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, json]));
    },
    async recentOrders(hours) {
      const r = await pool.query(
        `SELECT data FROM orders WHERE created_at > now() - make_interval(hours => $1) ORDER BY created_at`, [hours]);
      return r.rows.map((x) => x.data);
    },
    async saveOrder(order) {
      const json = JSON.stringify(order);
      return serial('order:' + order.id, () => pool.query(
        `INSERT INTO orders (id, created_at, data) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [order.id, order.createdAt, json]));
    },
  };
}

module.exports = { createStorage };
