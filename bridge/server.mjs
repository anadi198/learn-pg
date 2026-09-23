// Postgres Lab bridge: lets the Postgres Lab page (on GitHub Pages or served from here)
// run SQL on YOUR local PostgreSQL over several real connections.
//
//   cd bridge && npm install && npm start
//
// Connection settings use the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD);
// without PGPASSWORD the password is read from your pgpass file
// (%APPDATA%\postgresql\pgpass.conf on Windows, ~/.pgpass elsewhere).
// It listens on 127.0.0.1 only, and every SQL request must carry a pairing token.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import pgpass from 'pgpass';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP_ROOT = normalize(join(HERE, '..'));
const PORT = Number(process.env.PGLAB_PORT || 8787);
const DATABASE = process.env.PGLAB_DATABASE || 'pglab';
const PAGES_URL = process.env.PGLAB_PAGES_URL || 'https://anadi198.github.io/learn-pg/';
const ORIGINS = new Set([
  new URL(PAGES_URL).origin,
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  'http://localhost:8765', 'http://127.0.0.1:8765',
  'null', // index.html opened straight from disk
  ...(process.env.PGLAB_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const IDLE_MS = 60 * 60 * 1000;
const MAX_ROWS = 50000;

/* ── pairing token: persisted so a paired browser stays paired across restarts ── */
const TOKEN_FILE = join(HERE, '.pglab-token');
let TOKEN = process.env.PGLAB_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = (await readFile(TOKEN_FILE, 'utf8')).trim(); } catch { /* first run */ }
  if (!TOKEN) { TOKEN = crypto.randomBytes(18).toString('base64url'); await writeFile(TOKEN_FILE, TOKEN + '\n'); }
}
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

/* ── Postgres connections ── */
const base = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
};
const password = process.env.PGPASSWORD
  ? process.env.PGPASSWORD
  : () => new Promise((resolve) => pgpass({ ...base, database: DATABASE }, (p) => resolve(p ?? '')));
const RAW = { getTypeParser: () => (v) => v }; // return every value as the text Postgres sent (like psql)

async function ensureDatabase() {
  const c = new pg.Client({ ...base, password, database: 'postgres' });
  await c.connect();
  try {
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE ${pg.escapeIdentifier(DATABASE)}`);
    return (await c.query('SHOW server_version')).rows[0].server_version;
  } finally { await c.end(); }
}

const sessions = new Map(); // id → { client, pid, name, notices, last, dead }
async function openSession(name) {
  const id = crypto.randomUUID();
  const client = new pg.Client({ ...base, password, database: DATABASE, application_name: `pglab ${name || 'session'}`.slice(0, 60) });
  const s = { id, client, name, notices: [], last: Date.now(), dead: false };
  client.on('notice', (n) => s.notices.push({ severity: n.severity, message: n.message, detail: n.detail, hint: n.hint }));
  client.on('error', () => { s.dead = true; });
  client.on('end', () => { s.dead = true; });
  await client.connect();
  s.pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  sessions.set(id, s);
  return s;
}
const errObj = (e) => ({ message: e?.message || String(e), code: e?.code, detail: e?.detail, hint: e?.hint,
  position: e?.position, where: e?.where, severity: e?.severity });
const txState = (s) => { const t = s.client.getTransactionStatus(); return { intx: t === 'T' || t === 'E', aborted: t === 'E' }; };

async function exec(s, sql, maxRows) {
  s.last = Date.now(); s.notices = [];
  const t0 = performance.now();
  try {
    const out = await s.client.query({ text: sql, rowMode: 'array', types: RAW });
    const ms = performance.now() - t0;
    const list = Array.isArray(out) ? out : [out];
    const results = list.map((r) => ({
      fields: (r.fields || []).map((f) => ({ name: f.name, type: f.dataTypeID })),
      rows: (r.rows || []).slice(0, maxRows), total: (r.rows || []).length,
      command: r.command, rowCount: r.rowCount,
    }));
    return { ok: true, results, notices: s.notices, ms, ...txState(s) };
  } catch (e) {
    const gone = s.dead;
    // an error inside a transaction block always aborts it (node-postgres may still report 'T' here)
    const { intx } = gone ? { intx: false } : txState(s);
    return { ok: false, error: errObj(e), notices: s.notices, ms: performance.now() - t0, gone, intx, aborted: intx };
  } finally { s.last = Date.now(); }
}

async function cancel(s) {
  const c = new pg.Client({ ...base, password, database: DATABASE, application_name: 'pglab cancel' });
  await c.connect();
  try { return (await c.query('SELECT pg_cancel_backend($1) AS ok', [s.pid])).rows[0].ok; } finally { await c.end(); }
}

setInterval(() => {
  for (const [id, s] of sessions) {
    if (s.dead || Date.now() - s.last > IDLE_MS) { s.client.end().catch(() => {}); sessions.delete(id); }
  }
}, 60_000).unref();

/* ── HTTP ── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-pglab-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return !origin || ORIGINS.has(origin);
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 5e6) throw new Error('request too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

let SERVER_VERSION = '?';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const originOk = cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(originOk ? 204 : 403); res.end(); return; }

  if (!url.pathname.startsWith('/api/')) { // static app files, so http://localhost:PORT works too
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const path = normalize(join(APP_ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    const rel = path.slice(APP_ROOT.length).split(/[\\/]/).filter(Boolean);
    if (!path.startsWith(APP_ROOT) || rel[0] === 'bridge' || rel.some((seg) => seg.startsWith('.'))) { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404).end('not found'); }
    return;
  }

  if (!originOk) { send(res, 403, { ok: false, error: { message: `Origin ${req.headers.origin} is not allowed. Add it with PGLAB_ORIGINS.` } }); return; }
  try {
    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, app: 'pglab-bridge', version: 1, server_version: SERVER_VERSION, database: DATABASE, host: base.host, port: base.port, user: base.user });
      return;
    }
    if (url.pathname === '/api/pair') { // only the page this bridge serves itself may fetch the token
      if (req.headers['sec-fetch-site'] !== 'same-origin') { send(res, 403, { ok: false, error: { message: 'Pair using the link printed in the bridge terminal.' } }); return; }
      send(res, 200, { ok: true, token: TOKEN });
      return;
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: { message: 'POST only' } }); return; }
    if (!tokenOk(req.headers['x-pglab-token'])) { send(res, 401, { ok: false, unpaired: true, error: { message: 'This page is not paired with the bridge. Open the pairing link printed in the bridge terminal.' } }); return; }
    const b = await body(req);
    if (url.pathname === '/api/session') {
      const s = await openSession(b.name);
      send(res, 200, { ok: true, id: s.id, pid: s.pid, server_version: SERVER_VERSION, database: DATABASE });
      return;
    }
    const s = sessions.get(b.id);
    if (!s || s.dead) { send(res, 200, { ok: false, gone: true, error: { message: 'This connection was closed (idle timeout, server restart, or bridge restart). It will reconnect on the next statement.' } }); return; }
    if (url.pathname === '/api/exec') { send(res, 200, await exec(s, String(b.sql || ''), Math.min(Number(b.maxRows) || 500, MAX_ROWS))); return; }
    if (url.pathname === '/api/cancel') { send(res, 200, { ok: true, cancelled: await cancel(s) }); return; }
    if (url.pathname === '/api/close') { sessions.delete(s.id); await s.client.end().catch(() => {}); send(res, 200, { ok: true }); return; }
    send(res, 404, { ok: false, error: { message: 'unknown endpoint' } });
  } catch (e) {
    send(res, 500, { ok: false, error: errObj(e) });
  }
});

try {
  SERVER_VERSION = await ensureDatabase();
} catch (e) {
  console.error(`\nCould not connect to PostgreSQL at ${base.host}:${base.port} as ${base.user}: ${e.message}`);
  console.error('Check that the server is running, and that your password is in the pgpass file (or set PGPASSWORD).\n');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nPostgres Lab bridge → PostgreSQL ${SERVER_VERSION} at ${base.host}:${base.port}, database "${DATABASE}"`);
  console.log(`\n  Use it here:        http://localhost:${PORT}`);
  console.log(`  Or pair the site:   ${PAGES_URL}#pair=${TOKEN}`);
  console.log('\nKeep this window open while you use "Your Postgres" in the lab. Ctrl+C stops it.\n');
});
