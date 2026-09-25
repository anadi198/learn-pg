/* Postgres Lab — app shell: engine (PGlite in a worker), psql-style console, lessons, grader. */
(() => {
'use strict';

const PG_CDN = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.8/dist';
const SEED = window.PGLAB_SEED;
const COURSE = window.PGLAB_COURSE;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pglab.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pglab.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMs = (ms) => ms < 1 ? ms.toFixed(3) : ms < 100 ? ms.toFixed(2) : ms.toFixed(0);
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString();
};

/* ─────────────────────────── Engine worker ─────────────────────────── */
const WORKER_SRC = `
import { PGlite } from '${PG_CDN}/index.js';
import { pg_trgm } from '${PG_CDN}/contrib/pg_trgm.js';
import { pg_stat_statements } from '${PG_CDN}/contrib/pg_stat_statements.js';
import { btree_gist } from '${PG_CDN}/contrib/btree_gist.js';
import { pageinspect } from '${PG_CDN}/contrib/pageinspect.js';
import { pg_visibility } from '${PG_CDN}/contrib/pg_visibility.js';
const EXT = { pg_trgm, pg_stat_statements, btree_gist, pageinspect, pg_visibility };
let db = null, RAW = {};
const post = (m) => self.postMessage(m);
// Snapshots live in the page's IndexedDB, not here: a worker started from a data: URL
// (needed when index.html is opened from disk) is not allowed to use IndexedDB.
async function openDb(blob) {
  if (db) { try { await db.close(); } catch (e) {} db = null; }
  db = await PGlite.create({ loadDataDir: blob || undefined, extensions: EXT });
  RAW = {};
  for (const k of Object.keys(db.parsers || {})) RAW[k] = (x) => x;
  for (const k of [16, 17, 20, 21, 23, 26, 114, 700, 701, 1082, 1083, 1114, 1184, 1186, 1700, 2950, 3802]) RAW[k] = (x) => x;
  try { Object.assign(db.parsers, RAW); } catch (e) {}
}
const errObj = (e) => ({ message: (e && e.message) || String(e), code: e && e.code, detail: e && e.detail, hint: e && e.hint,
  position: e && e.position, where: e && e.where, severity: e && e.severity });
async function runOne(sql, maxRows) {
  const notices = []; const t0 = performance.now();
  try {
    const res = await db.exec(sql, { rowMode: 'array', parsers: RAW,
      onNotice: (n) => notices.push({ severity: n.severity, message: n.message, detail: n.detail, hint: n.hint }) });
    const ms = performance.now() - t0;
    const results = res.map((r) => ({
      fields: (r.fields || []).map((f) => ({ name: f.name, type: f.dataTypeID })),
      rows: (r.rows || []).slice(0, maxRows), total: (r.rows || []).length,
      command: r.command, rowCount: r.rowCount, affected: r.affectedRows }));
    return { ok: true, results, notices, ms, intx: db.isInTransaction() };
  } catch (e) {
    return { ok: false, error: errObj(e), notices, ms: performance.now() - t0, intx: db.isInTransaction() };
  }
}
self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    if (op === 'open') {
      await openDb(data.blob);
      post({ id, ok: true });
    } else if (op === 'seed') {
      await openDb(null);
      for (let i = 0; i < data.steps.length; i++) {
        post({ type: 'progress', i, label: data.steps[i][0] });
        const t0 = performance.now();
        await db.exec(data.steps[i][1]);
        post({ type: 'progress', i, label: data.steps[i][0], done: true, ms: performance.now() - t0 });
      }
      post({ id, ok: true });
    } else if (op === 'exec') {
      post(Object.assign({ id }, await runOne(data.sql, data.maxRows == null ? 500 : data.maxRows)));
    } else if (op === 'dump') {
      if (db.isInTransaction()) throw new Error('Finish your open transaction (COMMIT or ROLLBACK) before saving a snapshot.');
      await db.exec('CHECKPOINT');
      const blob = await db.dumpDataDir('gzip');
      post({ id, ok: true, blob });
    }
  } catch (e) { post({ id, ok: false, error: errObj(e) }); }
};`;

/* Snapshot storage (page-side IndexedDB) */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('postgres-lab', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('snapshots');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('snapshots', mode); let out;
    const r = fn(tx.objectStore('snapshots'));
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => { d.close(); res(out); };
    tx.onerror = tx.onabort = () => { d.close(); rej(tx.error || new Error('IndexedDB failed')); };
  });
}
const snapGet = () => idb('readonly', (st) => st.get('current')).catch(() => null);
const snapPut = (v) => idb('readwrite', (st) => st.put(v, 'current'));
const snapDel = () => idb('readwrite', (st) => st.delete('current')).catch(() => null);

const Engine = {
  worker: null, seq: 0, pending: new Map(), chain: Promise.resolve(), onProgress: null, onFatal: null,
  start() {
    const fromDisk = location.protocol === 'file:';
    const tip = fromDisk ? ' If your browser blocks this when opening the file straight from disk, run "node serve.mjs" in the postgres-lab folder and open http://localhost:8765 instead.' : '';
    try {
      // Chrome refuses blob: workers on file:// pages ("Refused to cross-origin redirects of the
      // top-level worker script"), but allows data: workers — so use data: there.
      const url = fromDisk
        ? 'data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKER_SRC)
        : URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(url, { type: 'module' });
    } catch (e) {
      this.worker = null;
      this.onFatal && this.onFatal('The browser refused to start the Postgres engine (' + e.message + ').' + tip);
      return false;
    }
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { this.onProgress && this.onProgress(m); return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
    };
    this.worker.onerror = (e) => {
      e.preventDefault && e.preventDefault();
      const msg = 'The Postgres engine could not load (' + (e.message || 'network error') + '). It is fetched from cdn.jsdelivr.net — check your connection and reload.' + tip;
      for (const [, r] of this.pending) r({ ok: false, error: { message: msg } });
      this.pending.clear();
      this.onFatal && this.onFatal(msg);
    };
    return true;
  },
  raw(op, payload) {
    return new Promise((resolve) => {
      const id = ++this.seq; this.pending.set(id, resolve);
      this.worker.postMessage(Object.assign({ id, op }, payload || {}));
    });
  },
  call(op, payload) {
    const p = this.chain.then(() => this.raw(op, payload));
    this.chain = p.catch(() => {});
    return p;
  },
  exec(sql, maxRows) { return this.call('exec', { sql, maxRows }); },
  kill() {
    if (this.worker) this.worker.terminate();
    for (const [, r] of this.pending) r({ ok: false, killed: true, error: { message: 'Query cancelled — engine restarted.' } });
    this.pending.clear(); this.chain = Promise.resolve();
  },
};

/* ─────────────────────────── Sessions: in-browser or your own Postgres ─────────────────────────── */
// A session is one database connection. The in-browser engine has exactly one. "Your Postgres"
// goes through the local bridge (bridge/server.mjs) and gives real, separate connections:
// A, B and C for you, G for the grader and background queries, M for watching lock waits.
class Sess {
  constructor(label) { this.label = label; this.intx = false; this.aborted = false; this.busy = false; this.t0 = 0; this.draft = null; this.pid = null; }
  track(stmt, r) {
    if (r.killed || r.gone) { this.intx = this.aborted = false; return; }
    this.intx = !!r.intx;
    if (r.aborted !== undefined) this.aborted = !!r.aborted;
    else {
      if (!r.ok && r.intx) this.aborted = true;
      if (!r.intx || (r.ok && /^\s*(rollback|abort)\b/i.test(stmt))) this.aborted = false;
    }
  }
}
class BrowserSess extends Sess {
  exec(sql, maxRows) { return Engine.exec(sql, maxRows); }
  cancel() { restartEngine('stop'); }
}
const BRIDGE_PORT = 8787;
const Bridge = {
  // served by the bridge itself → same origin; otherwise (GitHub Pages, file://, other ports) talk to 127.0.0.1
  base: location.port === String(BRIDGE_PORT) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '' : `http://127.0.0.1:${BRIDGE_PORT}`,
  token: store.get('bridgeToken', ''),
  state: 'off', // off | checking | nobridge | unpaired | nodata | seeding | ready
  info: null,
  async req(path, body) {
    try {
      const init = body === undefined ? { cache: 'no-store' }
        : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-pglab-token': this.token }, body: JSON.stringify(body) };
      const r = await fetch(this.base + path, init);
      const j = await r.json();
      if (j.unpaired) this.state = 'unpaired';
      return j;
    } catch (e) {
      return { ok: false, offline: true, error: { message: `Can't reach the bridge at 127.0.0.1:${BRIDGE_PORT}. Is it still running? (cd bridge && npm start)` } };
    }
  },
};
class LocalSess extends Sess {
  constructor(label) { super(label); this.id = null; }
  async open() {
    const r = await Bridge.req('/api/session', { name: this.label });
    if (!r.ok) return r;
    this.id = r.id; this.pid = r.pid; this.intx = this.aborted = false;
    return r;
  }
  async exec(sql, maxRows = 500) {
    if (!this.id) { const o = await this.open(); if (!o.ok) return o; }
    const r = await Bridge.req('/api/exec', { id: this.id, sql, maxRows });
    if (r.gone || r.offline) { this.id = null; this.pid = null; }
    return r;
  }
  async cancel() { if (this.id) await Bridge.req('/api/cancel', { id: this.id }); }
  async close() { if (this.id) { const id = this.id; this.id = null; this.pid = null; await Bridge.req('/api/close', { id }); } this.intx = this.aborted = false; }
}
// Example outputs under lesson snippets: RecordSess captures every exec() a snippet makes (including the
// catalog queries behind \\d), ReplaySess feeds them back, so examples render through the real renderers.
class RecordSess extends Sess {
  constructor(inner) { super(''); this.inner = inner; this.log = []; }
  async exec(sql, maxRows) { const r = await this.inner.exec(sql, maxRows); this.log.push(storable(r)); return r; }
  track(stmt, r) { this.inner.track(stmt, r); }
}
class ReplaySess extends Sess {
  constructor(log) { super(''); this.log = log || []; this.i = 0; }
  exec() { return Promise.resolve(this.log[this.i++] || { ok: false, error: { message: 'No recorded output for this statement. Press Run to execute it.' } }); }
  track() {}
}
function storable(r) {
  const o = { ok: r.ok, ms: Math.round((r.ms || 0) * 100) / 100 };
  if (r.notices && r.notices.length) o.notices = r.notices;
  if (!r.ok) o.error = r.error;
  if (r.results) o.results = r.results.map((x) => ({ fields: x.fields, command: x.command, rowCount: x.rowCount, total: x.total,
    rows: x.fields.length === 1 && x.fields[0].name === 'QUERY PLAN' ? x.rows : x.rows.slice(0, 25) }));
  return o;
}
const OUTPUTS = window.PGLAB_OUTPUTS || { snippets: {}, types: {} };
const BUILD = new URLSearchParams(location.search).has('build-outputs');
const BS = new BrowserSess('');
const L = { A: new LocalSess('A'), B: new LocalSess('B'), C: new LocalSess('C'), G: new LocalSess('grader'), M: new LocalSess('monitor') };
const USER_SESSIONS = ['A', 'B', 'C'];
const isLocal = () => S.engine === 'local';
const cur = () => (isLocal() ? L[S.curSess] : BS);   // where the console runs your SQL
const bg = () => (isLocal() ? L.G : BS);              // grader + background queries
const isReady = () => (isLocal() ? Bridge.state === 'ready' : S.bReady);
const dbName = () => (isLocal() ? (Bridge.info && Bridge.info.database) || 'pglab' : 'postgres');
const sessOf = (pid) => [...USER_SESSIONS, 'G', 'M'].find((k) => L[k].pid && String(L[k].pid) === String(pid));

/* ─────────────────────────── App state ─────────────────────────── */
const S = {
  // (types is filled from outputs.js below, then from the live catalog)
  engine: store.get('engine', 'browser'), curSess: 'A', bReady: false, bBooted: false,
  seeding: false, dirty: false, savedAt: null, scale: store.get('scale', 1),
  expanded: store.get('expanded', 'off'), timing: store.get('timing', true),
  types: {}, info: { browser: { version: '18', rows: 0 }, local: { version: '18', rows: 0 } },
  history: store.get('history', []), hIdx: -1,
  done: store.get('done', {}), visited: store.get('visited', {}), lesson: null, saving: false,
};
Object.assign(S.types, OUTPUTS.types || {});
const el = {
  app: $('#app'), nav: $('#nav'), reader: $('#reader'), pane: $('#lessonPane'), tr: $('#transcript'),
  run: $('#runBtn'), explain: $('#explainBtn'), stop: $('#stopBtn'), runstate: $('#runstate'),
  dbdot: $('#dbdot'), dbtext: $('#dbtext'), dbchip: $('#dbchip'), save: $('#saveBtn'), reset: $('#resetBtn'), prompt: $('#promptLbl'),
};

const fmtRows = (n) => (n ? `${(n / 1e6).toFixed(n > 1e6 ? 2 : 1)}M rows` : 'shop');
function setStatus() {
  let cls = 'ok', txt;
  if (isLocal()) {
    const i = S.info.local;
    txt = {
      off: 'Your Postgres', checking: 'Connecting to your Postgres…', nobridge: 'Your Postgres · bridge not running',
      unpaired: 'Your Postgres · not paired', nodata: 'Your Postgres · dataset not loaded', seeding: 'Loading the shop dataset…',
      ready: `your Postgres ${i.version} · ${dbName()} · ${fmtRows(i.rows)}`,
    }[Bridge.state];
    cls = Bridge.state === 'ready' ? 'ok' : ['nobridge', 'unpaired'].includes(Bridge.state) ? 'err' : 'busy';
  } else if (S.seeding) { cls = 'busy'; txt = 'Building the shop dataset…'; }
  else if (S.saving) { cls = 'busy'; txt = 'Saving snapshot…'; }
  else if (!S.bReady) { cls = 'busy'; txt = 'Starting Postgres…'; }
  else {
    const i = S.info.browser;
    txt = `in-browser · ${fmtRows(i.rows)} · PG ${i.version}` + (S.dirty ? ' · unsaved changes' : S.savedAt ? ` · saved ${ago(S.savedAt)}` : ' · not saved');
    if (S.dirty) cls = 'busy';
  }
  el.dbdot.className = 'dot ' + cls;
  el.dbtext.textContent = txt;
  el.dbchip.title = txt;
  el.save.hidden = isLocal();
  el.save.disabled = !S.bReady || S.saving || S.seeding;
  el.save.innerHTML = S.saving ? 'Saving…' : 'Save<span class="desk-only"> snapshot</span>';
  el.save.classList.toggle('primary', S.bReady && S.dirty && !S.saving);
  el.run.disabled = el.explain.disabled = !isReady();
  $('#pgver').textContent = isLocal() ? `${dbName()}@localhost · PostgreSQL ${S.info.local.version}` : `PGlite · PostgreSQL ${S.info.browser.version}`;
  $$('.engine-sw button').forEach((b) => b.classList.toggle('on', b.dataset.e === S.engine));
  renderSessionBar();
  const key = S.engine + ':' + Bridge.state;
  if (key !== setStatus.key) { setStatus.key = key; refreshEngineCallouts(); rerenderSims(); }
}
function promptFor(sess) { return `${dbName()}${sess.aborted ? '=!#' : sess.intx ? '=*#' : '=#'}`; }
function setPrompt() {
  const p = promptFor(cur());
  el.prompt.textContent = p;
  return p;
}
function renderSessionBar() {
  const bar = $('#sessBar'); if (!bar) return;
  bar.hidden = !isLocal();
  if (!isLocal()) return;
  bar.innerHTML = USER_SESSIONS.map((k) => {
    const s = L[k]; const st = s.busy ? 'busy' : s.aborted ? 'aborted' : s.intx ? 'intx' : '';
    const tip = `Session ${k}: ${s.busy ? 'running a statement' : s.aborted ? 'transaction failed — ROLLBACK' : s.intx ? 'inside a transaction' : 'idle'}${s.pid ? ` (pid ${s.pid})` : ''}. Alt+${USER_SESSIONS.indexOf(k) + 1}`;
    return `<button class="sess ${st}${k === S.curSess ? ' on' : ''}" data-s="${k}" title="${esc(tip)}">${k}${s.aborted ? '!' : s.intx ? '*' : ''}</button>`;
  }).join('');
}
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ─────────────────────────── SQL helpers ─────────────────────────── */
function splitSql(src) {
  const out = []; const n = src.length; let i = 0, start = 0;
  const onlyTrivia = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() === '';
  // terminated = ended by a top-level ';' (not inside a string, identifier, comment or $$ body)
  const push = (a, b, terminated = false) => { const text = src.slice(a, b); if (!onlyTrivia(text)) out.push({ kind: 'sql', text: text.trim(), start: a, end: b, terminated }); };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '\\' && onlyTrivia(src.slice(start, i))) {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      out.push({ kind: 'meta', text: src.slice(i, j).trim(), start: i, end: j });
      i = j + 1; start = i; continue;
    }
    if (c === '-' && c2 === '-') { const j = src.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (c === '/' && c2 === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) { if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; } else i++; }
      continue;
    }
    if (c === "'") {
      const isE = /[eE]/.test(src[i - 1] || '') && !/\w/.test(src[i - 2] || '');
      i++;
      while (i < n) { if (isE && src[i] === '\\') { i += 2; continue; } if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } break; } i++; }
      i++; continue;
    }
    if (c === '"') { i++; while (i < n) { if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === '$' && !/\w/.test(src[i - 1] || '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) { const j = src.indexOf(m[0], i + m[0].length); i = j < 0 ? n : j + m[0].length; continue; }
    }
    if (c === ';') { push(start, i + 1, true); i++; start = i; continue; }
    i++;
  }
  push(start, n);
  return out;
}
const stripComments = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
const firstWords = (s) => stripComments(s).replace(/^\(+/, '').split(/[\s(;]+/).filter(Boolean).map((w) => w.toUpperCase());
const isReadOnly = (s) => {
  const w = firstWords(s);
  if (['SELECT', 'SHOW', 'TABLE', 'VALUES', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'START', 'SET', 'RESET', 'SAVEPOINT', 'RELEASE', 'ABORT', 'DISCARD', 'PREPARE', 'DEALLOCATE', 'LISTEN', 'NOTIFY', 'FETCH', 'DECLARE', 'CLOSE'].includes(w[0])) {
    return !(w[0] === 'EXPLAIN' && /\banalyze\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s));
  }
  if (w[0] === 'WITH') return !/\b(insert|update|delete|merge)\b/i.test(stripComments(s));
  return false;
};
function commandTag(stmt, r) {
  const w = firstWords(stmt);
  const cmd = (w[0] || r.command || '').toUpperCase();
  const n = r.rowCount != null ? r.rowCount : (r.affected || 0);
  if (w[0] === 'WITH' && r.command) return r.command === 'INSERT' ? `INSERT 0 ${n}` : `${r.command} ${n}`;
  if (cmd === 'INSERT') return `INSERT 0 ${n}`;
  if (['UPDATE', 'DELETE', 'SELECT', 'MERGE', 'COPY', 'FETCH', 'MOVE', 'TABLE', 'VALUES'].includes(cmd)) return `${cmd === 'TABLE' || cmd === 'VALUES' ? 'SELECT' : cmd} ${n}`;
  if (['CREATE', 'ALTER', 'DROP'].includes(cmd)) {
    let i = 1;
    if (w[1] === 'OR' && w[2] === 'REPLACE') i = 3;
    while (['UNIQUE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'RECURSIVE', 'TRUSTED', 'PROCEDURAL'].includes(w[i])) i++;
    const two = { MATERIALIZED: 1, FOREIGN: 1, EVENT: 1, ACCESS: 1, DEFAULT: 1, OPERATOR: 1, USER: 0 };
    if (w[i] === 'TEXT' && w[i + 1] === 'SEARCH') return `${cmd} TEXT SEARCH ${w[i + 2] || ''}`.trim();
    return `${cmd} ${w[i] || ''}${two[w[i]] ? ' ' + (w[i + 1] || '') : ''}`.trim();
  }
  const map = { TRUNCATE: 'TRUNCATE TABLE', REFRESH: 'REFRESH MATERIALIZED VIEW', LOCK: 'LOCK TABLE', START: 'START TRANSACTION', END: 'COMMIT', ABORT: 'ROLLBACK', BEGIN: 'BEGIN', DISCARD: 'DISCARD ALL' };
  return map[cmd] || cmd || 'OK';
}

/* ─────────────────────────── Editor ─────────────────────────── */
const editorWrap = $('#editorWrap');
let cm = null, fallback = null;
const Editor = {
  get() { return cm ? cm.getValue() : fallback.value; },
  set(v) { if (cm) { cm.setValue(v); cm.setCursor(cm.lineCount(), 0); } else fallback.value = v; },
  selection() { return cm ? cm.getSelection() : fallback.value.slice(fallback.selectionStart, fallback.selectionEnd); },
  cursor() { return cm ? cm.indexFromPos(cm.getCursor()) : fallback.selectionStart; },
  focus() { cm ? cm.focus() : fallback.focus(); },
  refresh() { cm && cm.refresh(); },
  setHeight(h) { editorWrap.style.setProperty('--editor-h', h + 'px'); if (cm) cm.setSize(null, h); },
};
function initEditor() {
  const initial = store.get('draft', null) ?? 'SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC;';
  const keys = {
    // psql-style: Enter sends a finished statement (ends with ; or is a \command) when the cursor is at the end
    Enter: (c) => {
      const text = c.getValue();
      const atEnd = c.indexFromPos(c.getCursor()) >= text.replace(/\s+$/, '').length;
      if (atEnd && !c.somethingSelected() && readyToRun(text)) { runEditor(); return undefined; }
      return window.CodeMirror.Pass;
    },
    'Shift-Enter': 'newlineAndIndent',
    'Ctrl-Enter': () => runEditor(), 'Cmd-Enter': () => runEditor(), 'Shift-Ctrl-Enter': () => explainAtCursor(), 'Shift-Cmd-Enter': () => explainAtCursor(),
    // ↑ on the first line / ↓ on the last line walk the history, like a shell
    Up: (c) => { if (c.getCursor().line === 0 && !c.somethingSelected()) { histMove(-1); return undefined; } return window.CodeMirror.Pass; },
    Down: (c) => { if (c.getCursor().line === c.lastLine() && !c.somethingSelected()) { histMove(1); return undefined; } return window.CodeMirror.Pass; },
    'Ctrl-Space': 'autocomplete', 'Ctrl-Up': () => histMove(-1), 'Ctrl-Down': () => histMove(1), 'Cmd-Up': () => histMove(-1), 'Cmd-Down': () => histMove(1),
    Tab: (c) => c.replaceSelection('  '),
  };
  if (window.CodeMirror) {
    cm = window.CodeMirror(editorWrap, {
      value: initial, mode: 'text/x-pgsql', lineWrapping: true, matchBrackets: true, indentUnit: 2, tabSize: 2,
      extraKeys: keys, hintOptions: { tables: {}, completeSingle: false }, spellcheck: false, autocorrect: false,
    });
    cm.setCursor(cm.lineCount(), 0);
    cm.on('change', debounce(() => store.set('draft', cm.getValue()), 400));
    cm.on('inputRead', (c, ch) => { if (ch.text[0] === '.' && c.showHint) c.showHint({ completeSingle: false }); });
  } else {
    fallback = document.createElement('textarea'); fallback.className = 'fallback'; fallback.value = initial; fallback.spellcheck = false;
    fallback.addEventListener('keydown', (e) => {
      const v = fallback.value, pos = fallback.selectionStart, sel = fallback.selectionEnd !== pos;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.shiftKey ? explainAtCursor() : runEditor(); return; }
      if (e.key === 'Enter' && !e.shiftKey && !sel && pos >= v.replace(/\s+$/, '').length && readyToRun(v)) { e.preventDefault(); runEditor(); return; }
      if (e.key === 'ArrowUp' && !sel && !v.slice(0, pos).includes('\n')) { e.preventDefault(); histMove(-1); }
      if (e.key === 'ArrowDown' && !sel && !v.slice(pos).includes('\n')) { e.preventDefault(); histMove(1); }
    });
    fallback.addEventListener('input', debounce(() => store.set('draft', fallback.value), 400));
    editorWrap.appendChild(fallback);
  }
  Editor.setHeight(store.get('editorH', 160));
}
// A buffer is ready to send when its last statement is closed by a top-level ';' or it ends in a \command.
function readyToRun(text) {
  const items = splitSql(text);
  if (!items.length) return false;
  const last = items[items.length - 1];
  return last.kind === 'meta' || last.terminated;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function histPush(text) {
  const t = text.trim(); if (!t) return;
  if (S.history[S.history.length - 1] !== t) S.history.push(t);
  if (S.history.length > 150) S.history = S.history.slice(-150);
  S.hIdx = -1; store.set('history', S.history);
}
// ↑ goes back through history; ↓ past the newest entry restores whatever you were typing.
function histMove(d) {
  if (!S.history.length) return;
  if (S.hIdx === -1) { if (d > 0) return; S.histDraft = Editor.get(); S.hIdx = S.history.length; }
  const next = S.hIdx + d;
  if (next >= S.history.length) { S.hIdx = -1; Editor.set(S.histDraft || ''); return; }
  S.hIdx = Math.max(0, next);
  Editor.set(S.history[S.hIdx]);
}
async function refreshHints() {
  if (!cm || !isReady()) return;
  const r = await bg().exec(`SELECT c.relname, array_to_string(array_agg(a.attname ORDER BY a.attnum), ',')
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind IN ('r','v','m','p') AND c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    GROUP BY c.relname`, 1000);
  if (!r.ok) return;
  const tables = {};
  for (const [t, cols] of r.results[0].rows) tables[t] = cols.split(',');
  cm.setOption('hintOptions', { tables, completeSingle: false });
}

/* ─────────────────────────── Transcript rendering ─────────────────────────── */
function scrollBottom() { el.tr.scrollTop = el.tr.scrollHeight; }
function entry(cmdText, kind = 'sql', sess = cur()) {
  const e = document.createElement('div'); e.className = 'entry';
  const c = document.createElement('div'); c.className = 'cmd' + (kind === 'meta' ? ' meta' : '');
  const p = promptFor(sess);
  const cont = p.replace('=', '-');
  const tag = sess.label && isLocal() && USER_SESSIONS.includes(sess.label) ? `<span class="stag s${sess.label}">${sess.label}</span>` : '';
  const lines = cmdText.split('\n');
  c.innerHTML = lines.map((l, i) => `${i === 0 ? tag : tag ? '<span class="stag blank"> </span>' : ''}<span class="pr">${esc(i === 0 ? p : cont)} </span>${esc(l)}`).join('\n');
  if (lines.length > 6) { c.classList.add('collapsed'); c.addEventListener('click', () => c.classList.remove('collapsed'), { once: true }); }
  e.appendChild(c);
  const o = document.createElement('div'); o.className = 'out'; e.appendChild(o);
  el.tr.appendChild(e);
  while (el.tr.children.length > 120) el.tr.firstElementChild.remove();
  scrollBottom();
  return o;
}
function line(o, html, cls = '') { const d = document.createElement('div'); if (cls) d.className = cls; d.innerHTML = html; o.appendChild(d); scrollBottom(); return d; }
const NUMERIC = new Set([20, 21, 23, 26, 700, 701, 1700, 790]);
function typeName(oid) { return S.types[oid] || String(oid); }
function renderNotices(o, notices) {
  for (const n of notices || []) {
    let t = `${n.severity || 'NOTICE'}:  ${n.message}`;
    if (n.detail) t += `\nDETAIL:  ${n.detail}`;
    if (n.hint) t += `\nHINT:  ${n.hint}`;
    line(o, esc(t), 'notice');
  }
}
function renderError(o, err, stmt) {
  let t = `<b>${esc(err.severity || 'ERROR')}:</b>  ${esc(err.message)}`;
  const pos = Number(err.position);
  if (pos && stmt) {
    const before = stmt.slice(0, pos - 1); const ln = before.split('\n').length; const lines = stmt.split('\n');
    const col = before.length - before.lastIndexOf('\n') - 1;
    const prefix = `LINE ${ln}: `;
    t += `\n${esc(prefix + lines[ln - 1])}\n${' '.repeat(prefix.length + col)}^`;
  }
  if (err.detail) t += `\nDETAIL:  ${esc(err.detail)}`;
  if (err.hint) t += `\nHINT:  ${esc(err.hint)}`;
  if (err.where) t += `\nCONTEXT:  ${esc(err.where)}`;
  line(o, t, 'err');
}
function cellHtml(v, oid) {
  if (v === null || v === undefined) return ['null', 'NULL'];
  if (NUMERIC.has(oid)) return ['num', esc(v)];
  if (oid === 16) return ['bool', esc(v)];
  return ['', esc(v)];
}
function renderRows(o, r, title) {
  if (title) line(o, esc(title), 'title');
  const expanded = S.expanded === 'on' || (S.expanded === 'auto' && r.fields.length > 7);
  const box = document.createElement('div');
  if (expanded) {
    r.rows.forEach((row, i) => {
      const rec = document.createElement('div'); rec.className = 'xrec';
      rec.innerHTML = `<div class="xh">-[ RECORD ${i + 1} ]-</div><table>${r.fields.map((f, j) => { const [c, h] = cellHtml(row[j], f.type); return `<tr><td>${esc(f.name)}</td><td class="${c}">${h}</td></tr>`; }).join('')}</table>`;
      box.appendChild(rec);
    });
  } else {
    box.className = 'grid-wrap';
    const head = r.fields.map((f) => `<th title="${esc(typeName(f.type))}">${esc(f.name)}<small>${esc(shortType(typeName(f.type)))}</small></th>`).join('');
    const body = r.rows.map((row) => '<tr>' + row.map((v, j) => { const [c, h] = cellHtml(v, r.fields[j].type); return `<td class="${c}">${h}</td>`; }).join('') + '</tr>').join('');
    box.innerHTML = `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  o.appendChild(box);
  const n = r.total;
  let foot = `(${fmtInt(n)} ${n === 1 ? 'row' : 'rows'})`;
  if (r.rows.length < n) foot += ` · showing the first ${fmtInt(r.rows.length)} — add a LIMIT to see fewer`;
  line(o, esc(foot), 'rows');
}
const shortType = (t) => t.replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp').replace('character varying', 'varchar').replace('double precision', 'float8').replace('character', 'char');

/* ─────────────────────────── Plan viewer ─────────────────────────── */
function parsePlanText(lines) {
  const root = { cc: -2, children: [], details: [] };
  const stack = [root]; const summary = []; let nodes = 0; let inSummary = false;
  const nodeRe = /^(.*?)\s*(?:\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\))?\s*(?:\((?:actual (?:time=([\d.]+)\.\.([\d.]+) )?rows=([\d.]+) loops=(\d+)|(never executed))\))?\s*$/;
  for (const raw of lines) {
    const m = /^(\s*)(->\s+)?(.*)$/.exec(raw); const ind = m[1].length; const arrow = !!m[2]; const body = m[3];
    if (inSummary || (nodes > 0 && ind === 0 && !arrow)) { inSummary = true; summary.push(raw); continue; }
    if (nodes === 0 || arrow) {
      const nm = nodeRe.exec(body) || [body, body];
      const title = nm[1] || body;
      const tm = /^(.*?)(?: (using .*| on .*))?$/.exec(title);
      const n = { cc: arrow ? ind + 4 : 0, type: tm[1], target: tm[2] || '', title, children: [], details: [],
        est: nm[4] != null ? Number(nm[4]) : null, cost: nm[3] != null ? Number(nm[3]) : null,
        tStart: nm[6] != null ? Number(nm[6]) : null, tEnd: nm[7] != null ? Number(nm[7]) : null,
        act: nm[8] != null ? Number(nm[8]) : null, loops: nm[9] != null ? Number(nm[9]) : null, never: !!nm[10] };
      while (stack.length > 1 && stack[stack.length - 1].cc >= (arrow ? ind : 0)) stack.pop();
      stack[stack.length - 1].children.push(n); stack.push(n); nodes++;
    } else {
      while (stack.length > 1 && stack[stack.length - 1].cc >= ind) stack.pop();
      stack[stack.length - 1].details.push(body);
    }
  }
  return { top: root.children[0], summary };
}
function renderPlan(o, text) {
  const lines = text.split('\n');
  const { top, summary } = parsePlanText(lines);
  const wrap = document.createElement('div'); wrap.className = 'plan';
  const analyzed = top && top.tEnd != null;
  const exec = (summary.join('\n').match(/Execution Time: ([\d.]+) ms/) || [])[1];
  const total = exec ? Number(exec) : analyzed ? top.tEnd * (top.loops || 1) : null;
  wrap.innerHTML = `<div class="plan-tabs"><button class="on" data-v="tree">Plan tree</button><button data-v="raw">Raw text</button>
    <span class="legend">${analyzed ? 'bar = time spent in the node itself' : 'EXPLAIN only: estimates, nothing was executed'}</span></div>`;
  const tree = document.createElement('div'); tree.className = 'plan-tree';
  const raw = document.createElement('pre'); raw.className = 'plan-raw'; raw.textContent = text; raw.hidden = true;
  const walk = (n, d) => {
    const incl = n.tEnd != null ? n.tEnd * (n.loops || 1) : null;
    const childT = n.children.reduce((a, c) => a + (c.tEnd != null ? c.tEnd * (c.loops || 1) : 0), 0);
    const excl = incl != null ? Math.max(0, incl - childT) : null;
    const t = n.type;
    const cls = /Seq Scan/.test(t) ? 'scan-seq' : /Index|Bitmap/.test(t) ? 'scan-idx' : /Join|Nested Loop/.test(t) ? 'join' : /Sort|Aggregate|^Hash$|WindowAgg|Group|Unique|Limit|Memoize|Materialize|Gather/.test(t) ? 'sort' : '';
    const badges = [];
    if (n.est != null && n.act != null) {
      const a = Math.max(n.act, 1), e = Math.max(n.est, 1); const ratio = Math.max(a / e, e / a);
      if (ratio >= 10 && Math.max(a, e) >= 50) badges.push(`<span class="badge" title="Planner estimated ${fmtInt(n.est)} rows, got ${fmtInt(n.act)}">estimate ×${ratio >= 100 ? Math.round(ratio) : ratio.toFixed(0)} off</span>`);
    }
    if (n.details.some((x) => /external merge|Disk: \d|temp (read|written)|Batches: ([2-9]|\d{2,})/.test(x))) badges.push('<span class="badge disk">spilled to disk</span>');
    if (n.never) badges.push('<span class="badge disk">never executed</span>');
    const div = document.createElement('div'); div.className = 'pnode'; div.style.setProperty('--d', d);
    const nums = [];
    if (n.est != null) nums.push(`est <b>${fmtInt(n.est)}</b>`);
    if (n.act != null) nums.push(`actual <b>${Number.isInteger(n.act) ? fmtInt(n.act) : n.act}</b>${n.loops > 1 ? ` × ${fmtInt(n.loops)} loops` : ''}`);
    if (incl != null) nums.push(`<b>${fmtMs(incl)}</b> ms`);
    else if (n.cost != null) nums.push(`cost ${n.cost}`);
    div.innerHTML = `<div class="l1"><span class="nt ${cls}">${esc(t)}</span><span class="on">${esc(n.target)}</span>${badges.join('')}<span class="nums">${nums.join(' · ')}</span></div>`
      + (excl != null && total ? `<div class="bar" title="${fmtMs(excl)} ms in this node (${Math.round(100 * excl / total)}%)"><i style="width:${Math.min(100, 100 * excl / total).toFixed(1)}%"></i></div>` : '')
      + (n.details.length ? `<div class="det">${esc(n.details.join('\n'))}</div>` : '');
    tree.appendChild(div);
    n.children.forEach((c) => walk(c, d + 1));
  };
  if (top) walk(top, 0); else tree.innerHTML = `<pre class="plan-raw">${esc(text)}</pre>`;
  wrap.appendChild(tree); wrap.appendChild(raw);
  if (summary.length) {
    const s = document.createElement('div'); s.className = 'plan-sum';
    s.innerHTML = esc(summary.join('\n')).replace(/(Execution Time: [\d.]+ ms)/, '<b>$1</b>');
    wrap.appendChild(s);
  }
  wrap.querySelector('.plan-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('.plan-tabs button', wrap).forEach((x) => x.classList.toggle('on', x === b));
    tree.hidden = b.dataset.v !== 'tree'; raw.hidden = b.dataset.v !== 'raw';
  });
  o.appendChild(wrap);
}
function renderResult(o, stmt, r) {
  if (r.fields.length === 1 && r.fields[0].name === 'QUERY PLAN') {
    const txt = r.rows.map((x) => x[0]).join('\n');
    if (/^\s*[[{]/.test(txt)) { const pre = document.createElement('pre'); pre.className = 'plan-raw plan'; try { pre.textContent = JSON.stringify(JSON.parse(txt), null, 2); } catch { pre.textContent = txt; } o.appendChild(pre); }
    else renderPlan(o, txt);
    return;
  }
  if (r.fields.length) renderRows(o, r);
  else line(o, esc(commandTag(stmt, r)), 'tag');
}

/* ─────────────────────────── Running SQL ─────────────────────────── */
// One ticker drives the "running…" indicator and the Stop button for whichever session you're looking at.
setInterval(() => {
  const s = cur();
  if (!s.busy) { el.runstate.hidden = true; el.stop.hidden = true; return; }
  const secs = (performance.now() - s.t0) / 1000;
  el.runstate.hidden = false;
  el.runstate.textContent = !isLocal() && S.saving ? 'waiting for the snapshot to finish…' : `${isLocal() ? s.label + ': ' : ''}running ${secs.toFixed(1)}s`;
  el.stop.hidden = !(secs > (isLocal() ? 1 : 2.5) && !S.seeding && !(S.saving && !isLocal()));
}, 150);

// While a statement on your own Postgres is stuck, ask pg_stat_activity (on the monitor session) why.
function watchWait(sess, o) {
  if (!(sess instanceof LocalSess)) return () => {};
  let stop = false, lineEl = null, timer;
  const tick = async () => {
    if (stop || !sess.pid) return;
    const r = await L.M.exec(`SELECT wait_event_type, wait_event, pg_blocking_pids(pid)::text FROM pg_stat_activity WHERE pid = ${Number(sess.pid)}`, 1);
    if (stop) return;
    const row = r.ok && r.results[0].rows[0];
    const secs = ((performance.now() - sess.t0) / 1000).toFixed(0);
    let txt = `… still running (${secs}s)`;
    if (row) {
      const [wt, we, blk] = row;
      const pids = (blk || '{}').replace(/[{}]/g, '').split(',').filter(Boolean);
      if (wt) txt += ` — waiting on ${wt}${we ? ':' + we : ''}`;
      if (pids.length) txt += `, blocked by ${pids.map((p) => (sessOf(p) && USER_SESSIONS.includes(sessOf(p)) ? `session ${sessOf(p)}` : 'another connection') + ` (pid ${p})`).join(' and ')}`;
    }
    lineEl = lineEl || line(o, '', 'notice wait');
    lineEl.textContent = txt;
    timer = setTimeout(tick, 1000);
  };
  timer = setTimeout(tick, 800);
  return () => { stop = true; clearTimeout(timer); if (lineEl) lineEl.remove(); };
}

async function runStatement(stmt, o, { quiet = false, sess = cur(), sideEffects = true } = {}) {
  if (/pg_stat(?!_statements)|pg_statio/i.test(stmt)) await sess.exec('SELECT pg_stat_force_next_flush()');
  const unwatch = quiet ? () => {} : watchWait(sess, o);
  const r = await sess.exec(stmt, 500);
  unwatch();
  if (r.killed) return r;
  sess.track(stripComments(stmt), r);
  if (!quiet) {
    renderNotices(o, r.notices);
    if (r.ok) {
      r.results.forEach((res) => renderResult(o, stmt, res));
      if (S.timing) line(o, `Time: ${fmtMs(r.ms)} ms`, 'time');
    } else renderError(o, r.error, stmt);
  }
  if (!sideEffects) return r;
  if (r.ok && !isReadOnly(stmt) && !isLocal()) { S.dirty = true; setStatus(); }
  if (r.ok && /^\s*(create|alter|drop)\b/i.test(stripComments(stmt))) refreshHints();
  setPrompt(); renderSessionBar();
  return r;
}
// Runs a lesson snippet into a container, psql -f style: each statement's output in order,
// with a one-line echo of the statement when there are several.
async function runInline(code, o, sess, { sideEffects = true } = {}) {
  const items = splitSql(code);
  const multi = items.length > 1;
  for (const it of items) {
    if (multi) line(o, esc('› ' + oneLine(it.text)), 'echo');
    if (it.kind === 'meta') { await runMeta(it.text, o, sess); continue; }
    const r = await runStatement(it.text, o, { sess, sideEffects });
    if (r.killed || r.offline) break;
  }
}
const oneLine = (t) => { const f = stripComments(t).replace(/\s+/g, ' ').trim(); return f.length > 96 ? f.slice(0, 94) + '…' : f; };
async function runSql(text, { echo = true, sess = cur() } = {}) {
  if (!isReady()) { toast(isLocal() ? 'Your Postgres is not connected yet — see the console.' : 'Postgres is still starting — one moment.'); return []; }
  if (sess.busy) { toast(isLocal() ? `Session ${sess.label} is still running a statement (waiting for a lock?). Switch to another session, or press Stop.` : 'Still running the previous statement.'); return []; }
  const items = splitSql(text);
  if (!items.length) return [];
  histPush(text);
  const outs = [];
  sess.busy = true; sess.t0 = performance.now(); renderSessionBar();
  try {
    for (const it of items) {
      const o = entry(it.text, it.kind, sess);
      if (it.kind === 'meta') { await runMeta(it.text, o, sess); continue; }
      const r = await runStatement(it.text, o, { quiet: !echo, sess });
      outs.push({ stmt: it.text, r });
      if (r.killed || r.offline) break;   // like psql: otherwise keep going after an error (an aborted transaction reports it)
    }
  } finally { sess.busy = false; renderSessionBar(); }
  return outs;
}
// Runs the editor like a terminal: the command moves into the transcript + history and the editor clears.
// (Running a selection leaves the buffer alone.)
function runEditor() {
  const sel = Editor.selection();
  goConsole();
  if (sel && sel.trim()) return runSql(sel);
  const text = Editor.get();
  if (!text.trim()) return undefined;
  const sess = cur();
  if (!isReady() || sess.busy) return runSql(text, { sess });   // only explains why it can't run; keeps your text
  sess.lastSql = text;
  S.hIdx = -1; S.histDraft = '';
  Editor.set('');
  return runSql(text, { sess });
}
// What "Check" and "Explain" act on: the editor if it has something, else the last thing you ran.
const workingSql = () => (Editor.get().trim() ? Editor.get() : cur().lastSql || '');
function explainAtCursor() {
  const text = workingSql(); const cur = Editor.get().trim() ? Editor.cursor() : text.length;
  const items = splitSql(text).filter((x) => x.kind === 'sql');
  if (!items.length) { toast('Write a query first.'); return; }
  const it = items.find((x) => cur >= x.start && cur <= x.end + 1) || items[items.length - 1];
  let stmt = it.text.replace(/;\s*$/, '');
  if (/^\s*explain\b/i.test(stripComments(stmt))) return runSql(stmt);
  const w = firstWords(stmt)[0];
  const safe = ['SELECT', 'WITH', 'TABLE', 'VALUES'].includes(w) && !/\b(insert|update|delete|merge)\b/i.test(stripComments(stmt));
  goConsole();
  return runSql(`EXPLAIN ${safe ? '(ANALYZE) ' : ''}${stmt};`);
}

/* ─────────────────────────── psql meta-commands ─────────────────────────── */
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function patternSql(col, pat) {
  if (!pat) return '';
  const re = '^(' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + ')$';
  return ` AND ${col} ~ ${lit(re)}`;
}
async function metaQuery(o, sql, title, emptyMsg, sess) {
  const r = await sess.exec(sql, 2000);
  if (!r.ok) { renderError(o, r.error); return null; }
  const res = r.results[r.results.length - 1];
  if (!res.rows.length && emptyMsg) { line(o, esc(emptyMsg)); return res; }
  renderRows(o, res, title);
  return res;
}
const HELP = [
  ['\\d [NAME]', 'describe a table, view, index or sequence (no name: list relations)'],
  ['\\d+ NAME', 'describe with sizes, storage and extended statistics'],
  ['\\dt[+] [PATTERN]', 'list tables (+ adds size and estimated rows)'],
  ['\\di[+] [PATTERN]', 'list indexes'],
  ['\\dv / \\dm / \\ds', 'list views / materialized views / sequences'],
  ['\\df [PATTERN]', 'list functions and procedures in public'],
  ['\\dn / \\dx / \\du / \\l', 'list schemas / extensions / roles / databases'],
  ['\\x [on|off|auto]', 'toggle expanded (one field per line) output'],
  ['\\timing [on|off]', 'toggle the "Time: … ms" line'],
  ['\\conninfo', 'show what you are connected to'],
  ['\\h [COMMAND]', 'link to the SQL reference page for a command'],
  ['\\s', 'show your command history'],
  ['\\q', 'quit (well — close the tab)'],
];
async function runMeta(text, o, sess = cur()) {
  const mq = (sql, title, empty) => metaQuery(o, sql, title, empty, sess);
  const m = /^\\(\S+)\s*(.*)$/.exec(text.trim()); if (!m) return;
  let cmd = m[1]; const arg = m[2].trim().replace(/;$/, '');
  const plus = cmd.endsWith('+'); if (plus) cmd = cmd.slice(0, -1);
  const argName = arg.split(/\s+/)[0] || '';
  const visible = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND pg_table_is_visible(c.oid)`;
  const relList = (kinds, typeLabel, extra = '') => `
    SELECT n.nspname AS "Schema", c.relname AS "Name",
      CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
        WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' WHEN 'I' THEN 'partitioned index' WHEN 'f' THEN 'foreign table' END AS "Type",
      pg_get_userbyid(c.relowner) AS "Owner"${extra}
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN (${kinds}) AND ${visible}${patternSql('c.relname', argName)} ORDER BY 1, 2`;
  switch (cmd) {
    case '?':
      line(o, HELP.map(([a, b]) => `  ${esc(a.padEnd(22))} ${esc(b)}`).join('\n'), 'info');
      line(o, esc('Everything else you type is sent to Postgres as SQL. Separate statements with ;'), 'dim');
      return;
    case 'dt': case 'dv': case 'dm': case 'ds': {
      const kinds = { dt: "'r','p'", dv: "'v'", dm: "'m'", ds: "'S'" }[cmd];
      const extra = plus ? `, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "Rows (est.)", pg_size_pretty(pg_table_size(c.oid)) AS "Size", pg_size_pretty(pg_indexes_size(c.oid)) AS "Index size"` : '';
      await mq(relList(kinds, '', extra), 'List of relations', `Did not find any relations${argName ? ' named "' + argName + '"' : ''}.`);
      return;
    }
    case 'di': {
      const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name", am.amname AS "Method", t.relname AS "Table",
        CASE WHEN i.indisprimary THEN 'primary key' WHEN i.indisunique THEN 'unique' ELSE '' END AS "Kind"
        ${plus ? `, pg_size_pretty(pg_relation_size(c.oid)) AS "Size", s.idx_scan AS "Scans"` : ''}
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = c.relam
        LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
        WHERE ${visible}${patternSql('c.relname', argName)} ORDER BY 1, 4, 2`;
      await mq(sql, 'List of indexes', 'Did not find any indexes.');
      return;
    }
    case 'd':
      if (!argName) { await mq(relList("'r','p','v','m','S','f'", ''), 'List of relations', 'Did not find any relations.'); return; }
      await describe(o, argName, plus, sess); return;
    case 'df': {
      const sql = `SELECT n.nspname AS "Schema", p.proname AS "Name", pg_get_function_result(p.oid) AS "Result data type",
        pg_get_function_arguments(p.oid) AS "Argument data types", CASE p.prokind WHEN 'f' THEN 'func' WHEN 'p' THEN 'proc' WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' END AS "Type"
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')${patternSql('p.proname', argName)} ORDER BY 1, 2`;
      await mq(sql, 'List of functions', 'Did not find any functions (extension functions live here too — try \\dx).');
      return;
    }
    case 'dn': await mq(`SELECT nspname AS "Name", pg_get_userbyid(nspowner) AS "Owner" FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`, 'List of schemas'); return;
    case 'dx': {
      await mq(`SELECT e.extname AS "Name", e.extversion AS "Version", n.nspname AS "Schema", obj_description(e.oid, 'pg_extension') AS "Description" FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`, 'List of installed extensions');
      line(o, esc('Also available here: CREATE EXTENSION pg_trgm; CREATE EXTENSION btree_gist;'), 'dim');
      return;
    }
    case 'du': await mq(`SELECT rolname AS "Role name", CASE WHEN rolsuper THEN 'Superuser' ELSE '' END AS "Attributes" FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`, 'List of roles'); return;
    case 'l': await mq(`SELECT datname AS "Name", pg_get_userbyid(datdba) AS "Owner", pg_encoding_to_char(encoding) AS "Encoding", pg_size_pretty(pg_database_size(datname)) AS "Size" FROM pg_database ORDER BY 1`, 'List of databases'); return;
    case 'x': {
      const v = arg.toLowerCase();
      S.expanded = v === 'on' || v === 'off' || v === 'auto' ? v : S.expanded === 'on' ? 'off' : 'on';
      store.set('expanded', S.expanded);
      line(o, `Expanded display is ${S.expanded === 'auto' ? 'used automatically' : S.expanded}.`, 'info'); return;
    }
    case 'timing': {
      const v = arg.toLowerCase(); S.timing = v === 'on' ? true : v === 'off' ? false : !S.timing; store.set('timing', S.timing);
      line(o, `Timing is ${S.timing ? 'on' : 'off'}.`, 'info'); return;
    }
    case 'conninfo': line(o, esc(isLocal() ? `You are connected to database "${dbName()}" as user "${(Bridge.info && Bridge.info.user) || 'postgres'}" on host "${(Bridge.info && Bridge.info.host) || 'localhost'}" at port "${(Bridge.info && Bridge.info.port) || 5432}" — your own PostgreSQL ${S.info.local.version}, session ${sess.label} (backend pid ${sess.pid || '?'}).` : `You are connected to database "postgres" as user "postgres" — an in-browser PGlite build of PostgreSQL ${S.info.browser.version} (single connection, no autovacuum, no parallel workers).`), 'info'); return;
    case 'h': {
      if (!arg) { line(o, 'Usage: \\h CREATE INDEX — opens the matching page of the SQL reference.', 'info'); return; }
      const slug = arg.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).slice(0, 3).join('');
      line(o, `See <a href="https://www.postgresql.org/docs/current/sql-${esc(slug)}.html" target="_blank" rel="noopener">postgresql.org/docs/current/sql-${esc(slug)}.html</a>`, 'info'); return;
    }
    case 's': line(o, esc(S.history.slice(-30).join('\n')) || '(empty)', 'dim'); return;
    case 'q': line(o, 'There is no escape from the lab. (In real psql, \\q quits — here, just close the tab.)', 'info'); return;
    case 'echo': line(o, esc(arg)); return;
    case 'i': case 'copy': case 'watch': case 'e': case 'o': case 'g': case 'gx': case 'set':
      line(o, esc(`\\${cmd} is not available in the browser lab — it needs a real terminal and filesystem. Try it in local psql (see "Run it locally").`), 'err'); return;
    default:
      line(o, esc(`invalid command \\${m[1]}\nTry \\? for help.`), 'err');
  }
}
async function describe(o, name, plus, sess) {
  const r = await sess.exec(`SELECT c.oid, c.relkind, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass(${lit(name)})`, 5);
  if (!r.ok) { renderError(o, r.error); return; }
  const hit = r.results[0].rows[0];
  if (!hit) { line(o, esc(`Did not find any relation named "${name}".`), 'err'); return; }
  const [oid, kind, nsp, rel] = hit;
  const label = { r: 'Table', p: 'Partitioned table', v: 'View', m: 'Materialized view', i: 'Index', I: 'Partitioned index', S: 'Sequence', f: 'Foreign table' }[kind] || 'Relation';
  if (kind === 'S') { await metaQuery(o, `SELECT * FROM ${nsp}.${rel}`, `Sequence "${nsp}.${rel}"`, undefined, sess); return; }
  if (kind === 'i' || kind === 'I') {
    const q = await sess.exec(`SELECT pg_get_indexdef(${oid}), pg_size_pretty(pg_relation_size(${oid})), i.indisvalid, t.relname, am.amname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam WHERE i.indexrelid = ${oid}`, 5);
    const [def, size, valid, tbl, am] = q.results[0].rows[0];
    line(o, esc(`${label} "${nsp}.${rel}"  —  ${am}, for table "${nsp}.${tbl}"${valid === 'f' ? '  (INVALID)' : ''}\n${def}\nSize: ${size}`), 'info');
    return;
  }
  const cols = await sess.exec(`SELECT a.attname AS "Column", format_type(a.atttypid, a.atttypmod) AS "Type",
      CASE WHEN a.attnotnull THEN 'not null' ELSE '' END AS "Nullable",
      CASE WHEN a.attidentity = 'a' THEN 'generated always as identity' WHEN a.attidentity = 'd' THEN 'generated by default as identity'
           WHEN a.attgenerated = 's' THEN 'generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored'
           WHEN a.attgenerated = 'v' THEN 'generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ')'
           ELSE coalesce(pg_get_expr(d.adbin, d.adrelid), '') END AS "Default"
      ${plus ? `, CASE a.attstorage WHEN 'p' THEN 'plain' WHEN 'x' THEN 'extended' WHEN 'm' THEN 'main' WHEN 'e' THEN 'external' END AS "Storage", col_description(a.attrelid, a.attnum) AS "Description"` : ''}
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, 500);
  if (!cols.ok) { renderError(o, cols.error); return; }
  renderRows(o, Object.assign({}, cols.results[0]), `${label} "${nsp}.${rel}"`);
  o.lastElementChild.remove(); // drop the "(n rows)" footer, like psql
  const sections = [];
  const q = async (sql) => { const x = await sess.exec(sql, 500); return x.ok ? x.results[x.results.length - 1].rows : []; };
  if (kind === 'v' || kind === 'm') sections.push(['View definition:', (await q(`SELECT pg_get_viewdef(${oid}, true)`)).map((x) => ' ' + x[0])]);
  if (kind === 'p') sections.push(['Partition key: ' + ((await q(`SELECT pg_get_partkeydef(${oid})`))[0] || [''])[0], []]);
  const idx = await q(`SELECT c2.relname, i.indisprimary, i.indisunique, pg_get_indexdef(i.indexrelid, 0, true), con.contype, pg_get_constraintdef(con.oid, true), i.indisvalid, pg_size_pretty(pg_relation_size(i.indexrelid))
     FROM pg_index i JOIN pg_class c2 ON c2.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p','u','x')
     WHERE i.indrelid = ${oid} ORDER BY i.indisprimary DESC, i.indisunique DESC, c2.relname`);
  if (idx.length) sections.push(['Indexes:', idx.map(([n, pk, uq, def, ct, cdef, valid, size]) => {
    const using = def.replace(/^.*? USING /, '');
    const kindTxt = pk === 't' ? 'PRIMARY KEY, ' : ct === 'u' ? 'UNIQUE CONSTRAINT, ' : ct === 'x' ? '' : uq === 't' ? 'UNIQUE, ' : '';
    return `    "${n}" ${ct === 'x' ? cdef : kindTxt + using}${valid === 'f' ? ' INVALID' : ''}${plus ? `  [${size}]` : ''}`;
  })]);
  const chk = await q(`SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = ${oid} AND contype = 'c' ORDER BY 1`);
  if (chk.length) sections.push(['Check constraints:', chk.map(([n, d]) => `    "${n}" ${d}`)]);
  const fks = await q(`SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = ${oid} AND contype = 'f' ORDER BY 1`);
  if (fks.length) sections.push(['Foreign-key constraints:', fks.map(([n, d]) => `    "${n}" ${d}`)]);
  const refs = await q(`SELECT conrelid::regclass, conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE confrelid = ${oid} AND contype = 'f' ORDER BY 1, 2`);
  if (refs.length) sections.push(['Referenced by:', refs.map(([t, n, d]) => `    TABLE "${t}" CONSTRAINT "${n}" ${d}`)]);
  const parts = await q(`SELECT c.oid::regclass, pg_get_expr(c.relpartbound, c.oid) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = ${oid} ORDER BY 1`);
  if (parts.length) sections.push([`Partitions: (${parts.length})`, parts.map(([p, b]) => `    ${p} ${b}`)]);
  const par = await q(`SELECT i.inhparent::regclass, pg_get_expr(c.relpartbound, c.oid) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhrelid = ${oid}`);
  if (par.length) sections.push([`Partition of: ${par[0][0]} ${par[0][1] || ''}`, []]);
  const st = await q(`SELECT stxname, array_to_string(stxkind, ','), pg_get_statisticsobjdef_columns(oid) FROM pg_statistic_ext WHERE stxrelid = ${oid}`);
  if (st.length) sections.push(['Statistics objects:', st.map(([n, k, c]) => `    "${n}" (${k.replace('d', 'dependencies').replace('f', 'ndistinct').replace('m', 'mcv')}) ON ${c}`)]);
  if (plus && (kind === 'r' || kind === 'p' || kind === 'm')) {
    const sz = await q(`SELECT pg_size_pretty(pg_table_size(${oid})), pg_size_pretty(pg_indexes_size(${oid})), pg_size_pretty(pg_total_relation_size(${oid})), c.reltuples::bigint, c.relpages, array_to_string(c.reloptions, ', ') FROM pg_class c WHERE oid = ${oid}`);
    if (sz[0]) sections.push([`Size: table ${sz[0][0]} · indexes ${sz[0][1]} · total ${sz[0][2]}   (planner thinks: ${fmtInt(Math.max(0, sz[0][3]))} rows in ${fmtInt(sz[0][4])} pages)${sz[0][5] ? '\nOptions: ' + sz[0][5] : ''}`, []]);
  }
  if (sections.length) line(o, esc(sections.map(([h, ls]) => [h, ...ls].join('\n')).join('\n')), '');
}

/* ─────────────────────────── Boot / seed / snapshot ─────────────────────────── */
function banner() {
  el.tr.innerHTML = '';
  const e = document.createElement('div'); e.className = 'entry';
  e.innerHTML = `<div class="out"><div class="dim">psql (PostgreSQL 18 via PGlite, running in this tab)\nType SQL and press <span class="good">Enter</span> to run it (end statements with ;, Shift+Enter for a new line). <span class="good">↑/↓</span> recall history, <span class="good">\\?</span> lists psql commands.</div></div>`;
  e.firstChild.firstChild.style.whiteSpace = 'pre-wrap';
  el.tr.appendChild(e);
}
// Progress list shared by the in-browser build and the local load.
function seedBox(title, steps, note) {
  const box = document.createElement('div'); box.className = 'boot';
  box.innerHTML = `<h4>${esc(title)}</h4><ol>${steps.map((s) => `<li class="todo">${esc(s[0])}<span></span></li>`).join('')}</ol>${note ? `<p>${esc(note)}</p>` : ''}`;
  el.tr.appendChild(box); scrollBottom();
  const lis = $$('li', box);
  return {
    mark(i, done, ms) { const li = lis[i]; if (!li) return; li.className = done ? 'done' : 'run'; if (done) li.querySelector('span').textContent = (ms / 1000).toFixed(1) + ' s'; },
    finish(text) { box.querySelector('h4').textContent = text; },
    fail(text) { const p = document.createElement('p'); p.className = 'err'; p.textContent = text; box.appendChild(p); },
  };
}

/* ── in-browser engine (PGlite) ── */
async function boot({ fresh = false, scale = null, note = null } = {}) {
  S.bBooted = true; S.bReady = false; BS.intx = BS.aborted = BS.busy = false; setStatus(); setPrompt();
  Engine.onFatal = (msg) => {
    S.bReady = false;
    if (!isLocal()) { el.dbdot.className = 'dot err'; el.dbtext.textContent = 'Engine failed to load'; }
    const o = entry('-- engine', 'meta', BS); line(o, esc(msg), 'err');
  };
  if (!Engine.start()) return;
  if (note) { const o = entry(note.cmd, 'meta', BS); line(o, esc(note.text), note.cls || 'info'); }
  if (fresh) await snapDel();
  const snap = fresh ? null : await snapGet();
  if (snap && snap.version === SEED.version && snap.blob) {
    const r = await Engine.call('open', { blob: snap.blob });
    if (!r.ok) {
      if (r.killed) return;
      const o = entry('-- restore', 'meta', BS);
      line(o, esc(`Couldn't restore the saved snapshot (${r.error.message}). Rebuilding the dataset instead.`), 'notice');
      await seed(scale || store.get('scale', 1));
      return;
    }
    S.savedAt = snap.savedAt; S.scale = snap.scale || 1; S.dirty = false;
    await afterReady();
    const o = entry('-- restored', 'meta', BS);
    line(o, esc(`Restored your saved in-browser database (snapshot from ${ago(snap.savedAt)}, ${(snap.blob.size / 1e6).toFixed(0)} MB). Your tables and indexes are as you left them.`), 'good');
  } else await seed(scale || store.get('scale', 1));
}
async function seed(scale) {
  S.seeding = true; S.scale = scale; store.set('scale', scale); setStatus();
  const steps = SEED.steps(scale).concat([['Extensions & stats reset', `CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION IF NOT EXISTS pageinspect; CREATE EXTENSION IF NOT EXISTS pg_visibility; SELECT pg_stat_statements_reset();`]]);
  const approx = scale >= 1 ? '≈2.35 million rows' : `≈${(2.35 * scale).toFixed(1)} million rows`;
  const sb = seedBox(`Building the "shop" dataset — ${approx}`, steps, 'This runs real SQL (generate_series + random()) inside Postgres. It happens once; afterwards the database is saved in this browser and reloads in a few seconds.');
  const t0 = performance.now();
  Engine.onProgress = (m) => sb.mark(m.i, m.done, m.ms);
  const r = await Engine.call('seed', { steps });
  S.seeding = false;
  if (!r.ok) { const o = entry('-- seed', 'meta', BS); renderError(o, r.error); setStatus(); return; }
  sb.finish(`Built the "shop" dataset in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  S.savedAt = null; S.dirty = false;
  await afterReady();
  if (!BUILD) saveSnapshot({ auto: true });
}
async function loadTypes(sess) {
  const t = await sess.exec(`SELECT oid, format_type(oid, NULL) FROM pg_type`, 20000);
  if (t.ok) for (const [oid, name] of t.results[0].rows) S.types[oid] = name;
}
async function loadInfo(sess, into) {
  const v = await sess.exec(`SHOW server_version`, 1);
  const rows = await sess.exec(`SELECT sum(greatest(reltuples, 0))::bigint FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`, 1);
  if (v.ok) into.version = v.results[0].rows[0][0];
  if (rows.ok) into.rows = Number(rows.results[0].rows[0][0]) || 0;
}
async function afterReady() {
  await loadTypes(BS); await loadInfo(BS, S.info.browser);
  S.bReady = true; setStatus(); setPrompt();
  if (!isLocal()) { refreshHints(); updateLiveCounts(); }
}
async function saveSnapshot({ auto = false } = {}) {
  if (S.saving) return;
  S.saving = true; setStatus();
  const t0 = performance.now();
  let r = await Engine.call('dump');
  if (r.ok) {
    const savedAt = Date.now(); const size = r.blob.size;
    try { await snapPut({ version: SEED.version, scale: S.scale, savedAt, blob: r.blob }); r = { ok: true, savedAt, size, ms: performance.now() - t0 }; }
    catch (e) { r = { ok: false, error: { message: 'browser storage refused it (' + (e && e.message || e) + ')' } }; }
  }
  S.saving = false;
  if (r.ok) {
    S.savedAt = r.savedAt; S.dirty = false; setStatus();
    if (!auto) toast(`Snapshot saved (${(r.size / 1e6).toFixed(0)} MB) — reloads will restore it.`);
    else { const o = entry('-- snapshot', 'meta', BS); line(o, esc(`Saved a snapshot to this browser (${(r.size / 1e6).toFixed(0)} MB, ${(r.ms / 1000).toFixed(1)} s). Press "Save snapshot" whenever you want to keep your own tables and indexes across reloads.`), 'dim'); }
  } else if (!r.killed) {
    setStatus();
    const o = entry('-- snapshot', 'meta', BS); line(o, esc('Could not save a snapshot: ' + r.error.message + (auto ? ' (The lab still works; it will rebuild the data on the next reload.)' : '')), 'err');
  }
}
function restartEngine(kind) {
  Engine.kill(); BS.busy = false;
  if (kind === 'stop') boot({ note: { cmd: '-- cancelled', text: S.savedAt ? `Stopped the query by restarting the engine (PGlite cannot interrupt a running statement). Restored the snapshot from ${ago(S.savedAt)} — changes after it were discarded.` : 'Stopped the query by restarting the engine. No snapshot existed, so the dataset is being rebuilt.', cls: 'notice' } });
  else if (kind === 'restore') boot({ note: { cmd: '-- reset', text: 'Discarded unsaved changes; restoring the last snapshot.' } });
  else boot({ fresh: true, scale: kind === 'lite' ? 0.25 : 1, note: { cmd: '-- rebuild', text: 'Deleting the saved snapshot and rebuilding the dataset from scratch.' } });
}

/* ── your own Postgres, through the bridge ── */
let connectCard = null;
function clearConnectCard() { if (connectCard) { connectCard.remove(); connectCard = null; } }
function showConnectCard(errorText) {
  clearConnectCard();
  const st = Bridge.state; const i = Bridge.info || {};
  let html;
  if (st === 'nobridge') html = `<h4>Connect the lab to your own Postgres</h4>
    ${errorText ? `<p class="err">${esc(errorText)}</p>` : ''}
    <p>“Your Postgres” reaches PostgreSQL on this computer through a small helper called the bridge. In the <b>learn-pg</b> folder, run:</p>
    <pre class="cmdline">cd bridge\nnpm install      # first time only\nnpm start</pre>
    <p>It uses your pgpass file (or PGPASSWORD) and creates a database named <b>pglab</b>. Keep that window open, then press Retry. On a phone, stay on In-browser.</p>
    <div class="choices"><button class="tbtn go" data-c="retry">Retry</button><button class="tbtn" data-c="browser">Use in-browser instead</button></div>`;
  else if (st === 'unpaired') html = `<h4>Pair this page with the bridge</h4>
    <p>The bridge is running, but this page doesn't have its pairing token yet. Open the <b>“Or pair the site”</b> link printed in the bridge window, or paste the token (the part after <code>#pair=</code>):</p>
    <div class="choices"><input id="pairToken" class="tinput" placeholder="pairing token" autocomplete="off" spellcheck="false"><button class="tbtn go" data-c="pair">Pair</button><button class="tbtn" data-c="browser">Use in-browser instead</button></div>`;
  else if (st === 'nodata') html = `<h4>Load the shop dataset into your Postgres</h4>
    <p>Connected to PostgreSQL ${esc(S.info.local.version)}: database <b>${esc(dbName())}</b> on ${esc(i.host || 'localhost')}:${esc(i.port || 5432)}. The lab tables aren't there yet. Loading them takes about 20 seconds (≈2.35M rows, the same data as the in-browser lab).</p>
    <div class="choices"><button class="tbtn go" data-c="load">Load the dataset</button><button class="tbtn" data-c="browser">Use in-browser instead</button></div>`;
  else return;
  connectCard = document.createElement('div'); connectCard.className = 'boot connect'; connectCard.innerHTML = html;
  el.tr.appendChild(connectCard); scrollBottom();
  connectCard.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    if (b.dataset.c === 'retry') connectLocal();
    if (b.dataset.c === 'browser') setEngine('browser');
    if (b.dataset.c === 'load') seedLocal();
    if (b.dataset.c === 'pair') {
      const v = $('#pairToken', connectCard).value.trim().replace(/^.*#pair=/, '');
      if (v) { Bridge.token = v; store.set('bridgeToken', v); connectLocal(); }
    }
  });
}
async function connectLocal({ quiet = false } = {}) {
  clearConnectCard();
  Bridge.state = 'checking'; setStatus();
  const h = await Bridge.req('/api/health');
  if (!h.ok) { Bridge.state = 'nobridge'; setStatus(); if (isLocal()) showConnectCard(); return false; }
  Bridge.info = h;
  if (Bridge.base === '') { // the page came from the bridge itself: pair automatically
    const p = await Bridge.req('/api/pair');
    if (p.ok && p.token !== Bridge.token) { Bridge.token = p.token; store.set('bridgeToken', p.token); }
  }
  if (!Bridge.token) { Bridge.state = 'unpaired'; setStatus(); if (isLocal()) showConnectCard(); return false; }
  const r = await L.G.exec(`SELECT to_regclass('public.orders') IS NOT NULL AND to_regclass('public.order_items') IS NOT NULL AND to_regclass('public.employees') IS NOT NULL`, 1);
  if (!r.ok) {
    Bridge.state = r.unpaired ? 'unpaired' : 'nobridge'; setStatus();
    if (isLocal()) showConnectCard(r.unpaired || r.offline ? '' : `The bridge is running but couldn't open a connection: ${r.error.message}`);
    return false;
  }
  await loadTypes(L.G); await loadInfo(L.G, S.info.local);
  Bridge.state = r.results[0].rows[0][0] === 't' ? 'ready' : 'nodata';
  setStatus(); setPrompt();
  if (Bridge.state === 'nodata') { if (isLocal()) showConnectCard(); return false; }
  if (!quiet && isLocal()) {
    const o = entry('\\conninfo', 'meta', cur());
    line(o, esc(`Connected to your PostgreSQL ${S.info.local.version}, database "${dbName()}". Sessions A, B and C are three separate real connections. Switch with the buttons under the editor (Alt+1/2/3).`), 'good');
  }
  if (isLocal()) { refreshHints(); updateLiveCounts(); }
  rerenderSims();
  return true;
}
async function seedLocal() {
  clearConnectCard();
  Bridge.state = 'seeding'; setStatus();
  const steps = SEED.steps(1).concat([['Extensions', `CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION IF NOT EXISTS pageinspect; CREATE EXTENSION IF NOT EXISTS pg_visibility;`]]);
  const sb = seedBox(`Loading the "shop" dataset into your Postgres (${dbName()})`, steps, 'Same generator SQL as the in-browser lab, so the data is identical. Existing lab tables in this database are dropped and rebuilt.');
  const t0 = performance.now();
  for (let i = 0; i < steps.length; i++) {
    sb.mark(i, false);
    const t1 = performance.now();
    const r = await L.G.exec(steps[i][1], 1);
    if (!r.ok) { sb.fail(`${steps[i][0]} failed: ${r.error.message}`); Bridge.state = 'nodata'; setStatus(); return; }
    sb.mark(i, true, performance.now() - t1);
  }
  sb.finish(`Loaded the "shop" dataset into ${dbName()} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await connectLocal();
}
async function resetLocalSessions() {
  for (const k of USER_SESSIONS) { if (L[k].busy) await L[k].cancel(); await L[k].close(); L[k].busy = false; }
  setPrompt(); renderSessionBar();
  const o = entry('-- reconnect', 'meta', cur()); line(o, 'Closed sessions A, B and C. Each opens a fresh connection on its next statement (open transactions were rolled back).', 'info');
}

/* ── switching engine and session ── */
function defaultDraft(k) {
  return `-- Session ${k}: a separate connection to your Postgres.\n-- Try: BEGIN; UPDATE products SET stock = stock - 1 WHERE id = 7;  in A,\n-- then run the same UPDATE here and watch it wait for A's lock.\n`;
}
function switchSession(k) {
  if (!isLocal() || k === S.curSess || !L[k]) return;
  cur().draft = Editor.get();
  S.curSess = k;
  Editor.set(L[k].draft ?? defaultDraft(k));
  setPrompt(); renderSessionBar(); Editor.focus();
}
async function setEngine(kind) {
  if (kind === S.engine) { if (kind === 'local' && Bridge.state !== 'ready') connectLocal(); return; }
  const text = Editor.get(); cur().draft = text;
  S.engine = kind; store.set('engine', kind);
  const next = cur(); if (next.draft == null) next.draft = text; Editor.set(next.draft);
  setStatus(); setPrompt(); rerenderSims();
  if (kind === 'local') {
    const o = entry('-- engine', 'meta', cur()); line(o, 'Switched to your own Postgres (through the bridge on this computer).', 'info');
    await connectLocal();
  } else {
    clearConnectCard();
    const o = entry('-- engine', 'meta', BS); line(o, 'Switched to the in-browser engine (PGlite).', 'info');
    if (!S.bBooted) boot(); else { refreshHints(); updateLiveCounts(); }
  }
}

/* ─────────────────────────── Grader ─────────────────────────── */
class CheckFail extends Error {}
function makeCtx(userSql, gs = bg()) {
  const t = {
    user: userSql, gs,
    async q(sql, maxRows = 50000) {
      const r = await gs.exec(sql, maxRows);
      if (r.killed) throw new CheckFail('The engine restarted during the check.');
      if (!r.ok) { const e = new CheckFail(r.error.message); e.pg = r.error; throw e; }
      return r.results;
    },
    async rows(sql, maxRows) { const res = await t.q(sql, maxRows); const last = [...res].reverse().find((x) => x.fields.length); return last ? last.rows : []; },
    async last(sql, maxRows) { const res = await t.q(sql, maxRows); return [...res].reverse().find((x) => x.fields.length) || null; },
    async val(sql) { const rows = await t.rows(sql, 5); return rows.length ? rows[0][0] : null; },
    async num(sql) { const v = await t.val(sql); return v == null ? null : Number(v); },
    async plan(sql, analyze = false) {
      const v = await t.val(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${sql.replace(/;\s*$/, '')}`);
      return JSON.parse(v)[0];
    },
    nodes(p) { const out = []; const walk = (n) => { out.push(n); (n.Plans || []).forEach(walk); }; walk(p.Plan || p); return out; },
    async inTx(fn) {
      await t.q('BEGIN');
      try { return await fn(); } finally { await gs.exec('ROLLBACK'); }
    },
    async attempt(sql) {
      await t.q('SAVEPOINT _lab_chk');
      const r = await gs.exec(sql, 1000);
      if (r.ok) { await t.q('RELEASE SAVEPOINT _lab_chk'); return { ok: true, results: r.results }; }
      await t.q('ROLLBACK TO SAVEPOINT _lab_chk');
      return { ok: false, error: r.error.message };
    },
    fail(msg) { throw new CheckFail(msg); },
    need(cond, msg) { if (!cond) throw new CheckFail(msg); },
    lastStmt() {
      const it = splitSql(userSql).filter((x) => x.kind === 'sql');
      return it.length ? it[it.length - 1].text.replace(/;\s*$/, '') : '';
    },
    async inTxNow() { const r = await gs.exec('SELECT 1', 1); return !!r.intx; },
    // run statement by statement like psql does (continue after errors)
    async runScript(sql) {
      const log = [];
      for (const it of splitSql(sql)) {
        if (it.kind !== 'sql') continue;
        const r = await gs.exec(it.text, 100);
        log.push({ stmt: it.text, ok: r.ok, error: r.ok ? null : r.error.message });
      }
      return log;
    },
  };
  return t;
}
function normCell(v) {
  if (v == null) return { s: 'NULL' };
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} 00:00:00([+-]\d{2}(:\d{2})?)?$/.test(s)) s = s.slice(0, 10);  // midnight in any session time zone ≈ a date
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return { n: Number(s), s: String(Math.round(Number(s))) };
  if (s === 't' || s === 'true') return { s: 't' }; if (s === 'f' || s === 'false') return { s: 'f' };
  return { s };
}
const cellEq = (a, b) => (a.n != null && b.n != null) ? Math.abs(a.n - b.n) <= Math.max(0.011, Math.abs(a.n) * 1e-9) : a.s === b.s;
const rowKey = (r) => r.map((c) => c.s).join('\u0001');
const showRow = (r) => '(' + r.map((c) => c.n != null ? String(c.n) : c.s).join(', ') + ')';
function compareResults(mine, exp, ordered) {
  if (!mine) return { ok: false, msg: 'Your SQL did not return a result set. The last statement in the editor must be a query that returns rows.' };
  const names = exp.fields.map((f) => f.name).join(', ');
  if (mine.fields.length !== exp.fields.length) return { ok: false, msg: `Your result has ${mine.fields.length} column${mine.fields.length === 1 ? '' : 's'}; expected ${exp.fields.length} (${names}). Column names don't matter, but count and order do.` };
  if (mine.total !== exp.total) return { ok: false, msg: `You returned ${fmtInt(mine.total)} row${mine.total === 1 ? '' : 's'}; expected ${fmtInt(exp.total)}.` };
  let a = mine.rows.map((r) => r.map(normCell)), b = exp.rows.map((r) => r.map(normCell));
  const cmp = (x, y) => { for (let i = 0; i < x.length; i++) { if (cellEq(x[i], y[i])) continue; return false; } return true; };
  if (ordered) {
    for (let i = 0; i < b.length; i++) if (!cmp(a[i], b[i])) {
      const sa = [...a].sort((x, y) => rowKey(x) < rowKey(y) ? -1 : 1), sb = [...b].sort((x, y) => rowKey(x) < rowKey(y) ? -1 : 1);
      if (sa.every((r, k) => cmp(r, sb[k]))) return { ok: false, msg: 'Right rows, wrong order — check your ORDER BY (and tie-breakers).' };
      return { ok: false, msg: `Row ${i + 1} differs.`, detail: `expected ${showRow(b[i])}\nyours    ${showRow(a[i])}` };
    }
  } else {
    a = [...a].sort((x, y) => rowKey(x) < rowKey(y) ? -1 : 1); b = [...b].sort((x, y) => rowKey(x) < rowKey(y) ? -1 : 1);
    for (let i = 0; i < b.length; i++) if (!cmp(a[i], b[i])) return { ok: false, msg: 'Some rows differ from the expected result (row order is ignored for this exercise).', detail: `expected ${showRow(b[i])}\nyours    ${showRow(a[i])}` };
  }
  return { ok: true, msg: exp.total === 1 ? 'Correct — your result matches.' : `Correct — all ${fmtInt(exp.total)} rows match.` };
}
async function grade(ex, userSql, { echo = true } = {}) {
  const t = makeCtx(userSql, bg());
  if (cur().intx) return { ok: false, msg: `${isLocal() ? 'Session ' + cur().label + ' has' : 'You have'} an open transaction (the prompt shows <code>${dbName()}=*#</code> or <code>=!#</code>). Run COMMIT or ROLLBACK first, then check again.` };
  const c = ex.check;
  // On a real server, your session reports its table/index counters a few seconds after going idle;
  // ask it to report now so checks that read pg_stat_* see what you just did.
  if (isLocal() && cur() !== t.gs && !cur().busy) await cur().exec('SELECT pg_stat_force_next_flush()', 1);
  try {
    if (c.type === 'result') {
      if (!userSql.trim()) return { ok: false, msg: 'The editor is empty — write your query there, then press Check.' };
      if (c.prepare) await t.q(c.prepare);
      let mine;
      if (echo) {
        const outs = await runSql(userSql);
        const lastOut = outs[outs.length - 1];
        if (!lastOut) return { ok: false, msg: 'Nothing ran — the editor only has comments or meta-commands.' };
        if (!lastOut.r.ok) return { ok: false, msg: 'Your SQL raised an error: ' + esc(lastOut.r.error.message) };
        if (lastOut.r.intx) return { ok: false, msg: 'Your script left a transaction open — add COMMIT or ROLLBACK, then check again.' };
        const res = outs.map((x) => x.r.results || []).flat().reverse().find((x) => x.fields.length);
        mine = res && { fields: res.fields, rows: res.rows, total: res.total };
        if (mine && mine.total > mine.rows.length) mine = await t.last(t.lastStmt());
      } else {
        const pre = splitSql(userSql).filter((x) => x.kind === 'sql');
        for (const it of pre.slice(0, -1)) await t.q(it.text, 10);
        mine = await t.last(t.lastStmt());
      }
      const exp = await t.last(ex.solution);
      const res = compareResults(mine, exp, !!c.ordered);
      if (res.ok && c.extra) await c.extra(t);
      return res;
    }
    if (c.type === 'state' || c.type === 'probe') {
      if (c.type === 'probe' && !userSql.trim()) return { ok: false, msg: 'The editor is empty — write your SQL there, then press Check.' };
      const msg = await c.verify(t);
      return { ok: true, msg: msg || 'Correct!' };
    }
  } catch (e) {
    if (e instanceof CheckFail) return { ok: false, msg: e.message };
    return { ok: false, msg: 'Checker error: ' + esc(e.message) };
  }
  return { ok: false, msg: 'Unknown check type.' };
}

/* ─────────────────────────── Lessons ─────────────────────────── */
const EX = {}; const LESSON_OF = {}; const ALL = [];
COURSE.modules.forEach((m, mi) => m.lessons.forEach((l, li) => {
  l.mi = mi; l.li = li; l.mod = m; ALL.push(l);
  (l.exercises || []).forEach((x, k) => { x.num = `${mi + 1}.${li + 1}${String.fromCharCode(97 + k)}`; EX[x.id] = x; LESSON_OF[x.id] = l; });
}));
function itemsOf(l) {
  const qs = (l.body.match(/data-quiz="([^"]+)"/g) || []).map((s) => s.slice(11, -1));
  return [...(l.exercises || []).map((x) => x.id), ...qs.map((q) => 'quiz:' + q)];
}
function lessonState(l) {
  const items = itemsOf(l);
  if (!items.length) return S.visited[l.id] ? 'done' : '';
  const d = items.filter((i) => S.done[i]).length;
  return d === 0 ? '' : d === items.length ? 'done' : 'part';
}
function renderNav() {
  const all = ALL.flatMap(itemsOf); const done = all.filter((i) => S.done[i]).length;
  let html = `<div class="progress"><div class="bar"><i style="width:${all.length ? (100 * done / all.length).toFixed(1) : 0}%"></i></div><p>${done} of ${all.length} exercises &amp; checks done</p></div>`;
  COURSE.modules.forEach((m, mi) => {
    html += `<div class="mod"><h3><span class="n">${String(mi + 1).padStart(2, '0')}</span>${esc(m.title)}</h3>`;
    m.lessons.forEach((l) => {
      const st = lessonState(l); const items = itemsOf(l); const d = items.filter((i) => S.done[i]).length;
      html += `<a class="lesson${S.lesson === l.id ? ' active' : ''}" href="#${l.id}"><span class="st ${st}">${st === 'done' ? '✓' : ''}</span><span>${esc(l.title)}</span><span class="cnt">${items.length ? `${d}/${items.length}` : ''}</span></a>`;
    });
    html += '</div>';
  });
  el.nav.innerHTML = html;
}
function hl(code) {
  const KW = /^(select|from|where|and|or|not|in|is|null|as|on|join|left|right|full|inner|outer|cross|lateral|group|by|order|having|limit|offset|with|recursive|union|all|distinct|insert|into|values|update|set|delete|returning|create|table|index|unique|primary|key|references|foreign|check|constraint|default|alter|add|drop|column|if|exists|begin|commit|rollback|savepoint|release|transaction|isolation|level|read|committed|repeatable|serializable|explain|analyze|verbose|buffers|costs|format|vacuum|full|case|when|then|else|end|over|partition|rows|range|between|preceding|following|current|row|unbounded|filter|within|asc|desc|nulls|first|last|using|concurrently|include|materialized|view|refresh|extension|statistics|for|share|nowait|skip|locked|do|nothing|conflict|excluded|merge|matched|cast|interval|true|false|like|ilike|similar|any|some|exclude|gist|gin|brin|btree|lock|of|to|type|enum|generated|always|identity|stored|virtual|trigger|function|returns|language|procedure|call|show|reset|truncate|cascade|restrict|tablespace|only|window|fetch|next|valid|validate|cluster|reindex|comment|grant|revoke|temp|temporary|sequence|schema|replace|declare|cursor|notify|listen|mode|access|exclusive|advisory|security|policy|row|level|enable|disable|force|timing|settings|summary|off|timestamptz|timestamp|date|time|text|integer|int|bigint|smallint|numeric|boolean|jsonb|json|uuid|char|varchar|serial|bigserial|float8|real|double|precision|tstzrange|daterange|int4range|array)$/i;
  let out = ''; let i = 0; const n = code.length;
  while (i < n) {
    const rest = code.slice(i); let m;
    if ((m = /^--[^\n]*/.exec(rest))) { out += `<span class="tok-c">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if ((m = /^\/\*[\s\S]*?\*\//.exec(rest))) { out += `<span class="tok-c">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if ((m = /^'(?:[^']|'')*'/.exec(rest))) { out += `<span class="tok-s">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if ((m = /^\$\$[\s\S]*?\$\$/.exec(rest))) { out += `<span class="tok-s">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if ((m = /^\\[a-z+?]+/i.exec(rest)) && (i === 0 || code[i - 1] === '\n')) { out += `<span class="tok-m">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if ((m = /^\d+(\.\d+)?/.exec(rest)) && !/\w/.test(code[i - 1] || '')) { out += `<span class="tok-n">${m[0]}</span>`; i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const w = m[0];
      if (KW.test(w)) out += `<span class="tok-k">${esc(w)}</span>`;
      else if (code[i + w.length] === '(') out += `<span class="tok-f">${esc(w)}</span>`;
      else out += esc(w);
      i += w.length; continue;
    }
    out += esc(code[i]); i++;
  }
  return out;
}
// Stable id for a snippet's code, used to find its recorded output.
function snippetKey(code) {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + '-' + code.length.toString(36);
}
const codeOf = (pre) => pre.textContent.replace(/^\n+|\s+$/g, '');
const LESSON_EDITORS = new Set();
let replayChain = Promise.resolve();   // replays run one at a time (\\x on/off inside a snippet is global state)
function copyText(text) {
  const ok = () => toast('Copied');
  const no = () => toast('Copy blocked — select the text instead');
  navigator.clipboard ? navigator.clipboard.writeText(text).then(ok, no) : no();
}
function enhanceCode(root) {
  LESSON_EDITORS.clear();
  $$('pre.sql', root).forEach((pre) => {
    const code = codeOf(pre);
    const norun = pre.hasAttribute('data-norun');
    const box = document.createElement('div');
    if (norun) {
      box.className = 'codeblock';
      box.innerHTML = `<pre>${hl(code)}</pre><div class="cb-bar"><span class="lbl">${esc(pre.dataset.label || 'SQL (read only)')}</span>
        <button class="btn quiet" data-a="copy">Copy</button></div>`;
      box.addEventListener('click', (e) => { if (e.target.closest('[data-a=copy]')) copyText(code); });
      pre.replaceWith(box);
      return;
    }
    const rec = pre.hasAttribute('data-noexample') ? null : OUTPUTS.snippets[snippetKey(code)] || null;
    box.className = 'codeblock live';
    box.innerHTML = `<div class="cb-code"></div>
      <div class="cb-bar"><span class="lbl">${esc(pre.dataset.label || 'SQL')} · editable</span>
        <button class="btn quiet" data-a="reset" hidden title="Put back the original example and its output">↺ Reset</button>
        <button class="btn quiet" data-a="copy">Copy</button>
        <button class="btn quiet" data-a="edit" title="Load this into the console">To console</button>
        <button class="btn primary" data-a="run" title="Run it here (Ctrl+Enter)">Run ▸</button></div>
      <div class="cb-out"><div class="cb-out-h"><span class="tag"></span></div><div class="out"></div></div>`;
    pre.replaceWith(box);
    const codeEl = $('.cb-code', box), out = $('.cb-out .out', box), tag = $('.cb-out .tag', box), resetBtn = $('[data-a=reset]', box);
    let applying = false, running = false;
    const onChange = () => {
      if (applying) return;
      const edited = ed.get() !== code;
      resetBtn.hidden = !edited;
      if (edited && !running) setTag('edited', 'Edited · press Run (Ctrl+Enter) to see your output');
    };
    let ed;
    if (window.CodeMirror) {
      const c = window.CodeMirror(codeEl, {
        value: code, mode: 'text/x-pgsql', lineWrapping: true, matchBrackets: true, indentUnit: 2, tabSize: 2,
        viewportMargin: Infinity, spellcheck: false,
        extraKeys: { 'Ctrl-Enter': () => run(), 'Cmd-Enter': () => run(), Tab: (cc) => cc.replaceSelection('  ') },
      });
      c.on('change', onChange);
      ed = { get: () => c.getValue(), set: (v) => c.setValue(v), refresh: () => c.refresh() };
    } else {
      const ta = document.createElement('textarea'); ta.className = 'cb-ta'; ta.value = code; ta.spellcheck = false;
      const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.addEventListener('input', () => { fit(); onChange(); });
      ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
      codeEl.appendChild(ta); setTimeout(fit, 0);
      ed = { get: () => ta.value, set: (v) => { ta.value = v; fit(); }, refresh: fit };
    }
    LESSON_EDITORS.add(ed);
    function setTag(kind, text) { tag.className = 'tag ' + kind; tag.textContent = text; }
    function showExample() {
      out.innerHTML = '';
      if (!rec) { setTag('dim', pre.hasAttribute('data-noexample') ? 'Press Run to see the output (after you’ve done the exercise)' : 'Press Run to see the output'); return; }
      setTag('example', 'Example output');
      const target = out;
      replayChain = replayChain.then(() => runInline(code, target, new ReplaySess(rec), { sideEffects: false })).catch(() => {});
    }
    async function run() {
      const sql = ed.get(); if (!sql.trim()) return;
      if (!isReady()) { toast(isLocal() ? 'Your Postgres is not connected yet — see the console.' : 'Postgres is still starting — one moment.'); return; }
      const sess = cur();
      if (sess.busy) { toast(isLocal() ? `Session ${sess.label} is busy. Switch session in the console, or press Stop.` : 'Still running the previous statement.'); return; }
      running = true; out.innerHTML = ''; setTag('run', 'Running…');
      sess.busy = true; sess.t0 = performance.now(); renderSessionBar();
      const t0 = performance.now();
      try { await runInline(sql, out, sess); } finally { sess.busy = false; running = false; renderSessionBar(); }
      histPush(sql);
      setTag('mine', `Your output · ${isLocal() ? 'your Postgres, session ' + sess.label : 'in-browser engine'} · ${fmtMs(performance.now() - t0)} ms`);
    }
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'run') run();
      if (a === 'copy') copyText(ed.get());
      if (a === 'edit') { Editor.set(ed.get()); goConsole(); Editor.focus(); }
      if (a === 'reset') { applying = true; ed.set(code); applying = false; resetBtn.hidden = true; showExample(); }
    });
    showExample();
  });
}
function markDone(id) {
  if (S.done[id]) return;
  S.done[id] = Date.now(); store.set('done', S.done); renderNav();
}
function renderQuiz(div) {
  const q = COURSE.quizzes[div.dataset.quiz]; if (!q) return;
  const id = 'quiz:' + q.id; const done = !!S.done[id];
  div.innerHTML = `<p class="q"><span class="tag">Check</span><span>${q.q}</span></p>` +
    q.options.map((o, i) => `<label><input type="radio" name="${esc(q.id)}" id="${esc(q.id)}-${i}" value="${i}">${'<span>' + o + '</span>'}</label>`).join('') +
    `<div class="why" hidden></div>`;
  const why = $('.why', div);
  const reveal = (i) => {
    $$('label', div).forEach((lb, k) => { lb.classList.toggle('right', k === q.answer && i === q.answer); lb.classList.toggle('wrong', k === i && i !== q.answer); });
    why.hidden = false;
    why.innerHTML = (i === q.answer ? '<b style="color:var(--good)">Right.</b> ' : '<b style="color:var(--bad)">Not quite.</b> ') + q.why;
    if (i === q.answer) markDone(id);
  };
  div.addEventListener('change', (e) => reveal(Number(e.target.value)));
  if (done) { const inp = $$('input', div)[q.answer]; inp.checked = true; reveal(q.answer); }
}
// psql-style text for scenario cells
function textTable(res) {
  const heads = res.fields.map((f) => f.name);
  const rows = res.rows.map((r) => r.map((v) => (v == null ? '' : String(v))));
  const w = heads.map((h, j) => Math.max(h.length, ...rows.map((r) => r[j].length)));
  const num = res.fields.map((f) => NUMERIC.has(f.type));
  const center = (h, j) => { const gap = w[j] - h.length; const l = Math.floor(gap / 2); return ' '.repeat(l) + h + ' '.repeat(gap - l); };
  const lines = [' ' + heads.map(center).join(' | '), '-' + w.map((x) => '-'.repeat(x)).join('-+-') + '-',
    ...rows.map((r) => ' ' + r.map((v, j) => (num[j] ? v.padStart(w[j]) : v.padEnd(w[j]))).join(' | ')),
    `(${res.total} row${res.total === 1 ? '' : 's'})`];
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}
function psqlText(stmt, r) {
  if (!r.ok) {
    let t = `ERROR:  ${r.error.message}`;
    if (r.error.detail) t += `\nDETAIL:  ${r.error.detail}`;
    if (r.error.hint) t += `\nHINT:  ${r.error.hint}`;
    return t;
  }
  const parts = splitSql(stmt).filter((x) => x.kind === 'sql');
  return r.results.map((res, i) => (res.fields.length ? textTable(res) : commandTag(parts[i] ? parts[i].text : stmt, res))).join('\n');
}
const SIM_WIDGETS = new Set();
function rerenderSims() { for (const w of SIM_WIDGETS) { if (document.body.contains(w.div)) w.refresh(); else SIM_WIDGETS.delete(w); } }
function renderSim(div) {
  const ids = div.dataset.sim.split(',');
  const sims = ids.map((i) => COURSE.sims[i]).filter(Boolean);
  let scn = sims[0], step = 0, mode = 'replay', live = null, autoTimer = null;
  div.innerHTML = `<div class="sim-top"><span class="lbl">Two sessions</span>
    <select aria-label="Scenario" id="sim-${ids[0]}">${sims.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join('')}</select>
    <span class="sim-mode" hidden><button data-m="replay" class="on">Replay</button><button data-m="live">Live on your Postgres</button></span></div>
    <div class="sim-intro"></div><div class="sim-grid"></div><div class="sim-note"></div>
    <div class="sim-ctrl"><button class="btn" data-a="back">◀ Back</button><button class="btn primary" data-a="next">Next step ▶</button><button class="btn" data-a="auto">Auto-play</button><button class="btn quiet" data-a="reset">Restart</button><span class="step"></span></div>`;
  const grid = $('.sim-grid', div), note = $('.sim-note', div), intro = $('.sim-intro', div), stepEl = $('.step', div);
  const modeBar = $('.sim-mode', div), nextBtn = $('[data-a=next]', div), backBtn = $('[data-a=back]', div), autoBtn = $('[data-a=auto]', div);
  const canLive = () => isLocal() && Bridge.state === 'ready';
  const cols = () => (scn.c ? ['A', 'B', 'C'] : ['A', 'B']);
  const liveSteps = () => scn.steps.filter((s) => s.sql);
  const simName = (c) => `Session ${c} · ${{ A: scn.a || 'psql #1', B: scn.b || 'psql #2', C: scn.c || 'psql #3' }[c]}`;
  const header = () => {
    const names = { A: scn.a || 'psql #1', B: scn.b || 'psql #2', C: scn.c || 'psql #3' };
    grid.style.gridTemplateColumns = `repeat(${cols().length}, minmax(0, 1fr))`;
    $('.lbl', div).textContent = cols().length === 3 ? 'Three sessions' : 'Two sessions';
    return cols().map((c) => `<div class="sim-col-h${c !== 'A' ? ' r' : ''}"><b>Session ${c}</b> · ${esc(names[c])}</div>`).join('');
  };
  const stopAuto = () => { clearInterval(autoTimer); autoTimer = null; autoBtn.textContent = 'Auto-play'; };

  /* replay: recorded outputs, step back and forth */
  const drawReplay = () => {
    intro.innerHTML = scn.intro;
    let html = header();
    scn.steps.slice(0, step).forEach((s, i) => {
      const cell = (s.sql ? `<span class="p">${s.s}=#</span> ${esc(s.sql)}` : '') + (s.out ? `<span class="o ${s.cls || ''}">${esc(s.out)}</span>` : '');
      const curCls = i === step - 1 ? ' cur' : '';
      html += cols().map((c, k) => (c === s.s ? `<div class="sim-cell${k ? ' r' : ''}${curCls}" data-s="${c}" data-name="${esc(simName(c))}">${cell}</div>` : `<div class="sim-cell${k ? ' r' : ''}${curCls}"></div>`)).join('');
    });
    grid.innerHTML = html;
    note.innerHTML = step === 0 ? `<span style="color:var(--ink-3)">Press “Next step” to play the timeline. Time flows downward; each row is one statement.${canLive() ? ' Switch to <b>Live</b> to run it on real connections to your Postgres.' : ''}</span>` : scn.steps[step - 1].note || '';
    if (step === scn.steps.length && scn.moral) note.innerHTML += `<p style="margin:8px 0 0"><b>Takeaway:</b> ${scn.moral}</p>`;
    stepEl.textContent = `${step} / ${scn.steps.length}`;
    nextBtn.disabled = step >= scn.steps.length; backBtn.disabled = step === 0; backBtn.hidden = false;
    if (step >= scn.steps.length) stopAuto();
  };

  /* live: every statement really runs on its own connection to your Postgres */
  const drawLiveFrame = () => {
    intro.innerHTML = scn.intro + '<br><b style="color:var(--good)">Live:</b> each session below is a real connection to your Postgres. A statement that has to wait shows who it is waiting for, and completes on its own when the lock is released.';
    grid.innerHTML = header();
    note.innerHTML = '<span style="color:var(--ink-3)">Press “Next step” to send the first statement.</span>';
    stepEl.textContent = `0 / ${liveSteps().length}`;
    nextBtn.disabled = false; backBtn.hidden = true;
  };
  async function liveReset({ redraw = true } = {}) {
    stopAuto();
    const l = live; live = null;
    if (l) {
      l.closed = true;
      for (const s of Object.values(l.sess)) { await s.cancel(); await s.close(); }
      if (scn.cleanup) await L.G.exec(scn.cleanup, 1);
    }
    if (redraw && mode === 'live') drawLiveFrame();
  }
  function liveFinishIfDone(l) {
    if (l !== live || l.idx < liveSteps().length || l.pending) return;
    stopAuto();
    if (scn.moral) note.innerHTML += `<p style="margin:8px 0 0"><b>Takeaway:</b> ${scn.moral}</p>`;
    liveReset({ redraw: false }).then(() => { note.innerHTML += '<p style="margin:6px 0 0;color:var(--ink-3)">Done — the demo sessions were closed and any demo tables cleaned up. Press Restart to run it again.</p>'; });
  }
  async function liveNext() {
    if (!live) {
      live = { sess: {}, idx: 0, pending: 0, closed: false };
      for (const c of cols()) live.sess[c] = new LocalSess('sim ' + c);
      live.ready = scn.setup ? L.G.exec(scn.setup, 1) : Promise.resolve({ ok: true });
    }
    const l = live;
    const setup = await l.ready;
    if (l !== live) return;
    if (!setup.ok) { note.textContent = 'Scenario setup failed: ' + setup.error.message; return; }
    const steps = liveSteps();
    if (l.idx >= steps.length) return;
    const s = steps[l.idx++];
    $$('.sim-cell.cur', grid).forEach((x) => x.classList.remove('cur'));
    let out = null;
    cols().forEach((c, k) => {
      const cell = document.createElement('div'); cell.className = `sim-cell${k ? ' r' : ''} cur`;
      if (c === s.s) { cell.dataset.s = c; cell.dataset.name = simName(c); cell.innerHTML = `<span class="p">${s.s}=#</span> ${esc(s.sql)}<span class="o">running…</span>`; out = cell.querySelector('.o'); }
      grid.appendChild(cell);
    });
    note.innerHTML = s.note || '';
    stepEl.textContent = `${l.idx} / ${steps.length}`;
    nextBtn.disabled = l.idx >= steps.length;
    const sess = l.sess[s.s]; const t0 = performance.now(); let finished = false;
    l.pending++;
    const watch = async () => {
      if (finished || l.closed) return;
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      let txt = `⏳ waiting (${secs}s)`;
      if (sess.pid) {
        const r = await L.M.exec(`SELECT wait_event_type, wait_event, pg_blocking_pids(pid)::text FROM pg_stat_activity WHERE pid = ${Number(sess.pid)}`, 1);
        const row = r.ok && r.results[0].rows[0];
        if (row) {
          const pids = (row[2] || '{}').replace(/[{}]/g, '').split(',').filter(Boolean);
          const who = pids.map((p) => { const k = Object.keys(l.sess).find((c) => String(l.sess[c].pid) === p); return k ? `session ${k}` : `pid ${p}`; });
          if (row[0]) txt += ` on ${row[0]}${row[1] ? ':' + row[1] : ''}`;
          if (who.length) txt += ` — blocked by ${who.join(' and ')}`;
        }
      }
      if (!finished && !l.closed) { out.className = 'o wait'; out.textContent = txt; setTimeout(watch, 1000); }
    };
    setTimeout(watch, 700);
    const r = await sess.exec(s.sql, 50);
    finished = true; l.pending--;
    if (l.closed) return;
    const waited = (performance.now() - t0) / 1000;
    out.className = 'o' + (r.ok ? '' : ' err');
    out.textContent = psqlText(s.sql, r) + (waited > 1 ? `\n(returned after ${waited.toFixed(1)}s)` : '');
    liveFinishIfDone(l);
  }

  const refresh = () => {
    modeBar.hidden = !canLive();
    if (mode === 'live' && !canLive()) { liveReset({ redraw: false }); mode = 'replay'; }
    $$('button', modeBar).forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    if (mode === 'replay') drawReplay(); else if (!live) drawLiveFrame();
  };
  SIM_WIDGETS.add({ div, refresh });
  $('select', div).addEventListener('change', async (e) => { await liveReset({ redraw: false }); scn = sims[Number(e.target.value)]; step = 0; refresh(); });
  div.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]');
    if (m && m.dataset.m !== mode) { await liveReset({ redraw: false }); mode = m.dataset.m; step = 0; refresh(); return; }
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'auto') {
      if (autoTimer) { stopAuto(); return; }
      autoBtn.textContent = 'Pause';
      const tick = () => { if (mode === 'live') { if (!live || live.idx < liveSteps().length) liveNext(); else stopAuto(); } else if (step < scn.steps.length) { step++; drawReplay(); } else stopAuto(); };
      tick(); autoTimer = setInterval(tick, mode === 'live' ? 1700 : 1400);
      return;
    }
    if (mode === 'live') {
      if (a === 'next') liveNext();
      if (a === 'reset') liveReset();
      return;
    }
    if (a === 'next') step = Math.min(scn.steps.length, step + 1);
    if (a === 'back') step = Math.max(0, step - 1);
    if (a === 'reset') { step = 0; stopAuto(); }
    drawReplay();
  });
  refresh();
}
function exerciseHtml(x) {
  const kind = x.check.type === 'result' ? 'Query · result is checked' : x.check.type === 'state' ? 'Build · database is checked' : 'Write · your SQL is tested';
  return `<div class="ex" id="ex-${x.id}"><div class="ex-head"><span class="tag">${x.num} · ${kind}</span><h4>${esc(x.title)}</h4><span class="pill ${S.done[x.id] ? 'pass' : 'todo'}">${S.done[x.id] ? 'Passed ✓' : 'Not passed yet'}</span></div>
    <div class="ex-body">${x.prompt}</div>
    <div class="ex-actions">
      <button class="btn" data-a="open">Open in editor</button>
      ${x.setup ? '<button class="btn warn" data-a="setup">Run setup</button>' : ''}
      <button class="btn primary" data-a="check">${x.check.type === 'state' ? 'Check database' : 'Check my SQL'}</button>
      <button class="btn quiet" data-a="hint">Hint</button><button class="btn quiet" data-a="sol">Solution</button>
    </div><div class="ex-feedback" hidden></div><div class="ex-reveal" hidden></div></div>`;
}
function wireExercise(box, x) {
  const fb = $('.ex-feedback', box), rv = $('.ex-reveal', box), pill = $('.pill', box);
  const show = (cls, html, detail) => { fb.hidden = false; fb.className = 'ex-feedback ' + cls; fb.innerHTML = html + (detail ? `<pre>${esc(detail)}</pre>` : ''); };
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'open') {
      Editor.set(`-- ${x.num} ${x.title}\n${x.starter ? x.starter.trim() + '\n' : ''}`);
      goConsole(); Editor.focus();
    } else if (a === 'setup') {
      goConsole(); await runSql(x.setup.trim());
      show('info', 'Setup finished — see the console. You can re-run it any time to start this exercise over.');
    } else if (a === 'check') {
      if (!isReady()) { toast(isLocal() ? 'Your Postgres is not connected yet — see the console.' : 'Postgres is still starting.'); return; }
      b.disabled = true; show('info', 'Checking…');
      const res = await grade(x, workingSql());
      b.disabled = false;
      if (res.ok) {
        show('ok', '✓ ' + res.msg + (x.after ? `<div style="margin-top:6px;color:var(--ink-2)">${x.after}</div>` : ''));
        pill.className = 'pill pass'; pill.textContent = 'Passed ✓'; markDone(x.id);
      } else show('no', res.msg, res.detail);
    } else if (a === 'hint') {
      rv.hidden = false; rv.innerHTML = `<div class="hint">${x.hint}</div>`;
    } else if (a === 'sol') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Reveal solution?'; b.classList.add('warn'); return; }
      rv.hidden = false;
      rv.innerHTML = `<div class="codeblock"><pre>${hl(x.solution.trim())}</pre><div class="cb-bar"><span class="lbl">One good answer${x.check.type === 'state' ? ' — run it, then “Check database”' : ''}</span><button class="btn" data-a2="load">Load into editor</button></div></div>${x.explain ? `<div class="hint" style="margin-top:8px">${x.explain}</div>` : ''}`;
      $('[data-a2=load]', rv).addEventListener('click', () => { Editor.set(x.solution.trim() + '\n'); goConsole(); Editor.focus(); });
    }
  });
}
function renderLesson(id) {
  const l = ALL.find((x) => x.id === id) || ALL[0];
  S.lesson = l.id; store.set('lesson', l.id);
  if (!S.visited[l.id]) { S.visited[l.id] = Date.now(); store.set('visited', S.visited); }
  const exs = l.exercises || [];
  const prev = ALL[ALL.indexOf(l) - 1], next = ALL[ALL.indexOf(l) + 1];
  el.reader.innerHTML = `
    <div class="eyebrow"><span>Module ${l.mi + 1} · ${esc(l.mod.title)}</span><span class="meta">≈ ${l.minutes || 10} min${exs.length ? ` · ${exs.length} exercise${exs.length > 1 ? 's' : ''}` : ''}</span></div>
    <h1>${esc(l.title)}</h1>
    ${l.lede ? `<p class="lede">${l.lede}</p>` : ''}
    ${l.mod.localBest ? '<div class="callout engine" data-engine-callout></div>' : ''}
    <div class="prose">${l.body}${exs.length ? `<h2 class="practice-h">Practice</h2><p>Write your answer in the console, run it, then press <b>Check</b>. Check uses what's in the editor, or your last run if the editor is empty. It compares against the live database, so it works even after you add indexes or change data.</p>` : ''}</div>
    <div class="exs">${exs.map(exerciseHtml).join('')}</div>
    <nav class="lesson-nav">${prev ? `<a href="#${prev.id}"><small>← Previous</small><span>${esc(prev.title)}</span></a>` : ''}${next ? `<a class="next" href="#${next.id}"><small>Next →</small><span>${esc(next.title)}</span></a>` : ''}</nav>`;
  enhanceCode(el.reader);
  $$('[data-quiz]', el.reader).forEach(renderQuiz);
  $$('[data-sim]', el.reader).forEach(renderSim);
  exs.forEach((x) => wireExercise($('#ex-' + x.id, el.reader), x));
  refreshEngineCallouts();
  el.pane.scrollTop = 0;
  renderNav(); updateLiveCounts();
  el.app.classList.remove('nav-open'); goLesson();
}
function refreshEngineCallouts() {
  $$('[data-engine-callout]', el.reader).forEach((c) => {
    c.innerHTML = isLocal() && Bridge.state === 'ready'
      ? `<b>Running on your Postgres</b><p>Sessions <b>A</b>, <b>B</b> and <b>C</b> under the editor are three real connections (Alt+1/2/3). Every two-session scenario on this page has a <b>Live</b> mode that runs it for real.</p>`
      : `<b>Best on your own Postgres</b><p>This module is about several connections at once. The in-browser engine has only one, so the scenarios replay recorded output. On a laptop with Postgres installed, start the bridge and switch the console to <b>Your Postgres</b> to run them live.</p><p><button class="btn" data-engine="local">Switch to Your Postgres</button></p>`;
  });
}
async function updateLiveCounts() {
  const spans = $$('[data-count]', el.reader); if (!spans.length || !isReady()) return;
  const r = await bg().exec(`SELECT relname, reltuples::bigint FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`, 200);
  if (!r.ok) return;
  const m = Object.fromEntries(r.results[0].rows);
  spans.forEach((s) => { const v = m[s.dataset.count]; if (v != null) s.textContent = fmtInt(Math.max(0, v)) + ' rows'; });
}

/* ─────────────────────────── Layout & chrome ─────────────────────────── */
const narrow = () => window.matchMedia('(max-width: 920px)').matches;
function goConsole() { if (narrow()) { el.app.dataset.tab = 'console'; $('#tabConsole').classList.add('on'); $('#tabLesson').classList.remove('on'); setTimeout(() => Editor.refresh(), 0); } }
function goLesson() { if (narrow()) { el.app.dataset.tab = 'lesson'; $('#tabLesson').classList.add('on'); $('#tabConsole').classList.remove('on'); setTimeout(() => LESSON_EDITORS.forEach((e) => e.refresh()), 0); } }
function initChrome() {
  $('#tabLesson').onclick = goLesson; $('#tabConsole').onclick = goConsole;
  if (store.get('navHidden', false)) el.app.classList.add('nav-hidden');
  $('#navToggle').onclick = () => {
    if (narrow()) { el.app.classList.toggle('nav-open'); return; }
    el.app.classList.toggle('nav-hidden'); store.set('navHidden', el.app.classList.contains('nav-hidden')); Editor.refresh();
  };
  el.run.onclick = () => runEditor(); el.explain.onclick = () => explainAtCursor();
  $('#clearBtn').onclick = () => { el.tr.innerHTML = ''; connectCard = null; };
  $('#helpBtn').onclick = () => { goConsole(); runSql('\\?'); };
  el.stop.onclick = () => (isLocal() ? cur().cancel() : restartEngine('stop'));
  $('#engineSw').addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (b) setEngine(b.dataset.e); });
  $('#sessBar').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) switchSession(b.dataset.s); });
  el.reader.addEventListener('click', (e) => { const b = e.target.closest('[data-engine]'); if (b) { setEngine(b.dataset.engine); goConsole(); } });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && isLocal() && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); switchSession(USER_SESSIONS[Number(e.key) - 1]); }
  });
  el.save.onclick = () => saveSnapshot();
  const theme = store.get('theme', null); if (theme) document.documentElement.dataset.theme = theme;
  $('#themeBtn').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark'; store.set('theme', document.documentElement.dataset.theme);
  };
  el.reset.onclick = (e) => openResetMenu(e.currentTarget);
  // splitters
  const cw = store.get('consoleW', null); if (cw) document.documentElement.style.setProperty('--console-w', cw + 'px');
  const split = $('#split');
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId); split.classList.add('drag');
    const move = (ev) => { const w = Math.max(340, Math.min(window.innerWidth - 520, window.innerWidth - ev.clientX)); document.documentElement.style.setProperty('--console-w', w + 'px'); store.set('consoleW', w); };
    const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', move); Editor.refresh(); };
    split.addEventListener('pointermove', move); split.addEventListener('pointerup', up, { once: true });
  });
  const vs = $('#vsplit');
  vs.addEventListener('pointerdown', (e) => {
    vs.setPointerCapture(e.pointerId); vs.classList.add('drag');
    const con = $('#console').getBoundingClientRect(); const foot = $('.con-foot').getBoundingClientRect().height;
    const move = (ev) => { const h = Math.max(70, Math.min(con.height * 0.7, con.bottom - foot - ev.clientY)); Editor.setHeight(h); store.set('editorH', Math.round(h)); };
    const up = () => { vs.classList.remove('drag'); vs.removeEventListener('pointermove', move); };
    vs.addEventListener('pointermove', move); vs.addEventListener('pointerup', up, { once: true });
  });
  window.addEventListener('hashchange', () => {
    if (takePairHash()) { if (isLocal()) connectLocal(); else setEngine('local'); return; }
    renderLesson(location.hash.slice(1));
  });
  // CodeMirror measures glyphs once; re-measure after web fonts arrive or the layout changes
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => Editor.refresh());
  window.addEventListener('resize', debounce(() => { Editor.refresh(); scrollBottom(); }, 150));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { Editor.refresh(); scrollBottom(); } });
  setInterval(setStatus, 30000);
}
// The bridge prints a link like https://…/learn-pg/#pair=TOKEN; opening it pairs this browser.
function takePairHash() {
  const m = /^#pair=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return false;
  Bridge.token = m[1]; store.set('bridgeToken', m[1]);
  history.replaceState(null, '', location.pathname + location.search + '#' + store.get('lesson', ALL[0].id));
  toast('Paired with the bridge on this computer.');
  return true;
}
function openLocalResetMenu(pop) {
  pop.innerHTML = `
    <button class="item" data-k="reconnect"><b>Reconnect sessions A, B and C</b><span>Closes the three connections (rolling back anything open). Each reopens on its next statement.</span></button>
    <hr><button class="item" data-k="reload"><b>Reload the shop dataset</b><span>Drops and rebuilds the lab tables in database ${esc(dbName())} on your Postgres (~20 s). Other databases are untouched.</span></button>
    <div class="confirm" hidden><p></p><button class="btn danger" data-go>Yes, do it</button> <button class="btn quiet" data-no>Cancel</button></div>`;
  let pick = null; const conf = $('.confirm', pop);
  pop.addEventListener('click', async (e) => {
    const it = e.target.closest('.item');
    if (it) { pick = it.dataset.k; conf.hidden = false; $('p', conf).textContent = pick === 'reload' ? 'Rebuild every lab table in your Postgres? Your own tables in this database that share those names are replaced.' : 'Close sessions A, B and C? Open transactions are rolled back.'; }
    if (e.target.closest('[data-no]')) pop.remove();
    if (e.target.closest('[data-go]') && pick) {
      pop.remove(); goConsole();
      await resetLocalSessions();
      if (pick === 'reload') seedLocal();
    }
  });
}
function openResetMenu(anchor) {
  const old = $('.pop'); if (old) { old.remove(); return; }
  const pop = document.createElement('div'); pop.className = 'pop';
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px'; pop.style.right = Math.max(16, window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', off); } }), 0);
  if (isLocal()) { openLocalResetMenu(pop); document.body.appendChild(pop); return; }
  pop.innerHTML = `
    <button class="item" data-k="restore"><b>Restore last snapshot</b><span>${S.savedAt ? 'Back to the state saved ' + ago(S.savedAt) + '. Unsaved changes are discarded.' : 'No snapshot saved yet.'}</span></button>
    <hr><button class="item" data-k="full"><b>Rebuild fresh data · Standard</b><span>≈2.35M rows across 7 tables, ~15 s. Deletes your snapshot, tables and indexes.</span></button>
    <button class="item" data-k="lite"><b>Rebuild fresh data · Lite</b><span>≈0.6M rows, ~4 s. For low-memory machines; plans and timings differ a little.</span></button>
    <div class="confirm" hidden><p></p><button class="btn danger" data-go>Yes, do it</button> <button class="btn quiet" data-no>Cancel</button></div>`;
  document.body.appendChild(pop);
  let pick = null; const conf = $('.confirm', pop);
  pop.addEventListener('click', (e) => {
    const it = e.target.closest('.item');
    if (it) {
      if (it.dataset.k === 'restore' && !S.savedAt) return;
      pick = it.dataset.k; conf.hidden = false;
      $('p', conf).textContent = pick === 'restore' ? 'Discard everything since the last snapshot?' : 'Delete the saved database and rebuild from scratch? (Lesson progress is kept.)';
    }
    if (e.target.closest('[data-no]')) pop.remove();
    if (e.target.closest('[data-go]') && pick) { pop.remove(); restartEngine(pick); }
  });
}

/* ─────────────────────────── Self-test (dev) ─────────────────────────── */
async function execSplit(sql) {
  for (const it of splitSql(sql)) {
    if (it.kind !== 'sql') continue;
    const r = await bg().exec(it.text, 10);
    if (!r.ok) return r;
  }
  return { ok: true };
}
window.pglabSelfTest = async ({ only = null, from = null } = {}) => {
  const report = []; let started = !from;
  for (const l of ALL) for (const x of (l.exercises || [])) {
    if (x.id === from) started = true;
    if (!started || (only && !only.includes(x.id))) continue;
    const t0 = performance.now(); let res;
    window.__stProgress = x.id;
    try {
      if (x.setup) { const s = await execSplit(x.setup); if (!s.ok) { report.push({ id: x.id, ok: false, msg: 'setup error: ' + s.error.message }); continue; } }
      if (x.check.type === 'state') {
        const pre = await grade(x, '', { echo: false });
        if (pre.ok && !x.check.allowPrepass) { report.push({ id: x.id, ok: false, msg: 'passes before the solution ran: ' + pre.msg }); continue; }
        const r = await execSplit(x.solution);
        if (!r.ok) { report.push({ id: x.id, ok: false, msg: 'solution error: ' + r.error.message }); continue; }
        res = await grade(x, '', { echo: false });
      } else {
        res = await grade(x, x.solution, { echo: false });
        for (const alt of (x.alts || [])) { const ra = await grade(x, alt, { echo: false }); if (!ra.ok) res = { ok: false, msg: 'alt failed: ' + ra.msg + ' ' + (ra.detail || '') }; }
        for (const w of (x.wrong || [])) { const rw = await grade(x, w, { echo: false }); if (rw.ok) res = { ok: false, msg: 'wrong answer passed: ' + w.slice(0, 60) }; }
      }
      if (x.teardown) await execSplit(x.teardown);
    } catch (e) { res = { ok: false, msg: 'threw ' + e.message }; }
    report.push({ id: x.id, ok: res.ok, msg: res.ok ? '' : (res.msg + (res.detail ? ' | ' + res.detail : '')), ms: Math.round(performance.now() - t0) });
  }
  window.__selftest = report;
  return report;
};
// Used by tools/build-outputs.mjs (headless Chrome, fresh profile → freshly generated dataset).
async function buildOutputs() {
  const OUT = { v: 1, built: new Date().toISOString(), engine: 'PGlite ' + S.info.browser.version, types: {}, snippets: {} };
  const oids = new Set();
  for (const l of ALL) {
    const doc = new DOMParser().parseFromString('<div>' + l.body + '</div>', 'text/html');
    for (const pre of doc.querySelectorAll('pre.sql')) {
      if (pre.hasAttribute('data-norun') || pre.hasAttribute('data-noexample')) continue;
      const code = codeOf(pre); const key = snippetKey(code);
      if (OUT.snippets[key]) continue;
      const rec = new RecordSess(BS);
      await runInline(code, document.createElement('div'), rec);
      OUT.snippets[key] = rec.log;
      rec.log.forEach((r) => (r.results || []).forEach((res) => res.fields.forEach((f) => oids.add(f.type))));
      console.log('PGLAB-BUILD ' + l.id + ' ' + key + (rec.log.some((r) => !r.ok) ? ' (has an error — check it is intended)' : ''));
    }
  }
  if (BS.intx) console.log('PGLAB-BUILD warning: a snippet left a transaction open');
  for (const o of oids) if (S.types[o]) OUT.types[o] = S.types[o];
  return OUT;
}
async function buildOutputsWhenReady() {
  await new Promise((r) => { const t = setInterval(() => { if (S.bReady) { clearInterval(t); r(); } }, 300); });
  try {
    const out = await buildOutputs();
    const res = await fetch('/__outputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
    console.log('PGLAB-BUILD done ' + res.status + ' ' + Object.keys(out.snippets).length + ' snippets');
  } catch (e) { console.log('PGLAB-BUILD failed ' + e.message); }
}
window.pglab = { Engine, S, L, BS, Bridge, runSql, grade, EX, restartEngine, setEngine, switchSession, connectLocal };

/* ─────────────────────────── Go ─────────────────────────── */
if (takePairHash()) { S.engine = 'local'; store.set('engine', 'local'); }
initChrome(); initEditor(); banner(); setStatus(); setPrompt();
const startId = location.hash.slice(1) || store.get('lesson', ALL[0].id);
renderLesson(ALL.some((l) => l.id === startId) ? startId : ALL[0].id);
if (BUILD) { S.engine = 'browser'; boot(); buildOutputsWhenReady(); }
else if (isLocal()) connectLocal().then(() => refreshEngineCallouts()); else boot();
})();
