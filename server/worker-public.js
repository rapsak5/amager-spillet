// Fælles topscorerliste og hemmeligheden (rabatkoder) for den offentlige udgave af Amager-spillet.
// Cloudflare Worker med D1-databasen amager-spil-scores bundet som DB.
// Variabler: ALLOWED_ORIGIN (fx https://rapsak5.github.io) og ADMIN_TOKEN (secret).
// Valgfrit, til mail med koden og nyhedsbrevet: BREVO_API_KEY (secret), BREVO_SENDER_EMAIL,
// BREVO_SENDER_NAME og BREVO_LIST_ID.
//
// Point kan kun komme ind gennem et løb, som serveren selv har startet og taget tid på:
//   POST /run/start   { pid, level }          -> { ok, run }
//   POST /run/finish  { pid, run, score }     -> { ok, score, rank } eller { ok: false, error }
// Serveren afviser et løb, der er klaret hurtigere, end banen kan løbes, og point over det,
// banen realistisk kan give (se LIMITS). Kun ét åbent løb pr. spiller ad gangen.
//
//   GET  /top?me=<pid>&n=8  -> { players: [{ name, fisher, score, reached, me }], me: { rank, score, reached } | null, count }
//   POST /sync              { pid, name, fisher }  -> { ok, score, rank }   (navn og fisker, aldrig point)
//   POST /claim             { pid, email, newsletter }  -> { ok, code, sent } eller { ok: false, error, sent? }
//        Kun spillere med godkendte løb på alle ti baner. Én kode pr. mail, højst 3 pr. enhed.
//
// Admin (kræver header Authorization: Bearer <ADMIN_TOKEN>). Uden ADMIN_TOKEN er admin slået fra.
//   GET  /admin/players                 -> alle spillere med pid, også skjulte
//   POST /admin/hide   { pid, hidden }  -> skjul (hidden: true) eller vis igen (hidden: false)
//   GET  /admin/codes[?code=AMA-...]    -> alle rabatkoder, eller én
//   POST /admin/used   { code, used }   -> markér en kode som brugt (used: false fortryder)
//   GET  /admin/rejected                -> de seneste afviste løb (mistanke om snyd)

const FISHERS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
const LEVELS = ['dragoer', 'lufthavn', 'blaaplanet', 'idraetspark', 'faelled', 'dr', 'campus', 'center', 'jaguaren', 'copenhill'];
const NAME_MAX = 12;

// Regnet ud fra banerne (src/data/levels.js) med fuld score på alt, shot-bonus og fire hjerter.
// max:  højeste point en bane kan give, plus 10% luft.
// sec:  hvor mange sekunder banen tager ved fuld fart. Et løb skal mindst tage 80% af det.
// CopenHill: bossen sender små fjender, så længe kampen varer. Derfor må pointene vokse med tiden.
const LIMITS = {
  dragoer: { max: 13500, sec: 69 },
  lufthavn: { max: 19700, sec: 80 },
  blaaplanet: { max: 14700, sec: 74 },
  idraetspark: { max: 16300, sec: 86 },
  faelled: { max: 22400, sec: 82 },
  dr: { max: 22500, sec: 85 },
  campus: { max: 23900, sec: 85 },
  center: { max: 25500, sec: 94 },
  jaguaren: { max: 23400, sec: 101 },
  copenhill: { max: 39200, sec: 109, perSec: 320 },
};
const MIN_SHARE = 0.8;            // et løb skal tage mindst 80% af banens tid
const RUN_TTL = 2 * 3600 * 1000;  // et løb skal afsluttes inden for to timer

function minMs(level) { return Math.max(20000, Math.round(LIMITS[level].sec * MIN_SHARE * 1000) - 4000); }
function maxScore(level, elapsedMs) {
  const L = LIMITS[level];
  if (!L.perSec) return L.max;
  const extraSec = Math.max(0, elapsedMs - L.sec * 1000) / 1000;
  return L.max + Math.ceil(extraSec * L.perSec);
}

// Grænser mod bots og spam: [antal, sekunder]
const RATE = {
  newPlayerIp: [60, 3600],
  syncPid: [120, 600],
  runPid: [40, 600],
  runIp: [600, 600],
  finishPid: [60, 600],
  claimIp: [10, 86400],
  claimPid: [10, 3600],
  topIp: [600, 60],
};

// Samme navneregler som src/systems/names.js
const ALLOWED = /[^A-Za-z0-9ÆØÅæøåÉé .\-_!']/g;
const SUB = ['fuck', 'fisse', 'kusse', 'luder', 'neger', 'nigger', 'nigga', 'perker', 'hitler', 'nazi', 'cunt', 'whore', 'retard', 'spasser', 'kneppe', 'porno', 'bøsserøv'];
const WORD = ['pik', 'sex', 'lort', 'røv', 'bøsse', 'dick', 'cock', 'ass', 'shit'];

function cleanName(raw) {
  let s = String(raw || '').normalize('NFC');
  s = s.replace(/[^\u0000-\u007fÆØÅæøåÉé]/g, (ch) => ch.normalize('NFD').replace(/\p{M}/gu, ''));
  return s.replace(ALLOWED, '').replace(/\s{2,}/g, ' ').trim().slice(0, NAME_MAX).trim();
}

function isBlocked(name) {
  const leet = (s) => s.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
  const low = leet(name.toLowerCase());
  const flat = low.replace(/[^a-zæøåé]/g, '');
  const words = low.split(/[^a-zæøåé]+/).filter(Boolean);
  return SUB.some((w) => flat.includes(w)) || WORD.some((w) => flat === w || words.includes(w));
}

// ---------- HTTP ----------

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function cors(env, request) {
  const list = allowedOrigins(env);
  const origin = request?.headers.get('Origin') || '';
  const allow = !list.length ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function makeJson(env, request) {
  return (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env, request) },
  });
}

/** Spillets egne kald kommer fra spillets side. Andre sider må ikke sende på vegne af spillerne. */
function originOk(request, env) {
  const list = allowedOrigins(env);
  if (!list.length) return true;
  return list.includes(request.headers.get('Origin') || '');
}

async function readBody(request) {
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > 4096) return null;
  const text = await request.text();
  if (text.length > 4096) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

const validPid = (pid) => typeof pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(pid);
const validRun = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(id);

function randomId(bytes = 18) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ipKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'ukendt';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`amager:${ip}`));
  return [...new Uint8Array(d)].slice(0, 10).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- Databasen ----------

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, name TEXT NOT NULL, fisher TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, reached INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS players_rank ON players (hidden, score DESC, updated ASC)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS scores (pid TEXT NOT NULL, level TEXT NOT NULL, score INTEGER NOT NULL, PRIMARY KEY (pid, level))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, pid TEXT NOT NULL, level TEXT NOT NULL, started INTEGER NOT NULL, state INTEGER NOT NULL DEFAULT 0, score INTEGER, finished INTEGER, note TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS runs_pid ON runs (pid, state)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS runs_state ON runs (state, finished)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, w))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pid TEXT NOT NULL, name TEXT, newsletter INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at INTEGER, mailed INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS codes_pid ON codes (pid)'),
  ]);
  schemaReady = true;
}

// Run states
const OPEN = 0;
const DONE = 1;
const REPLACED = 2;
const REJECTED = 3;

/** Tæller et kald. Returnerer true, hvis grænsen er nået. */
async function limited(env, name, id) {
  const [max, sec] = RATE[name];
  const w = Math.floor(Date.now() / 1000 / sec);
  const row = await env.DB.prepare(
    'INSERT INTO hits (k, w, n) VALUES (?, ?, 1) ON CONFLICT(k, w) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(`${name}:${id}`, w).first();
  return (row?.n || 0) > max;
}

function cleanup(env, ctx) {
  if (Math.random() > 0.02) return;
  const now = Date.now();
  ctx?.waitUntil?.(env.DB.batch([
    env.DB.prepare('DELETE FROM hits WHERE w < ?').bind(Math.floor(now / 1000 / 86400) - 3),
    env.DB.prepare('DELETE FROM runs WHERE state IN (?, ?) AND started < ?').bind(OPEN, REPLACED, now - 3 * 86400 * 1000),
    env.DB.prepare('DELETE FROM runs WHERE state = ? AND finished < ?').bind(DONE, now - 30 * 86400 * 1000),
  ]).catch(() => null));
}

async function rankOf(env, pid) {
  const me = await env.DB.prepare('SELECT score, reached, updated, hidden FROM players WHERE pid = ?').bind(pid).first();
  if (!me) return null;
  const ahead = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE hidden = 0 AND score > 0 AND (score > ? OR (score = ? AND updated < ?))'
  ).bind(me.score, me.score, me.updated).first();
  return { rank: (ahead?.c || 0) + 1, score: me.score, reached: me.reached, hidden: !!me.hidden };
}

/** Lægger spillerens godkendte point sammen og gemmer summen på spilleren. */
async function recompute(env, pid) {
  const rows = (await env.DB.prepare('SELECT level, score FROM scores WHERE pid = ?').bind(pid).all()).results || [];
  const byLevel = Object.fromEntries(rows.map((r) => [r.level, r.score]));
  const total = LEVELS.reduce((s, l) => s + (byLevel[l] || 0), 0);
  const reached = LEVELS.reduce((m, l, i) => (byLevel[l] != null ? i + 1 : m), 0);
  // updated flyttes kun, når pointene stiger, så den der kom først står øverst ved lige point
  await env.DB.prepare(
    'UPDATE players SET score = ?, reached = ?, updated = CASE WHEN ? > score THEN ? ELSE updated END WHERE pid = ?'
  ).bind(total, reached, total, Date.now(), pid).run();
  return total;
}

// ---------- Navn og fisker ----------

async function sync(env, request, body, json) {
  const pid = body?.pid;
  if (!validPid(pid)) return json({ ok: false, error: 'bad pid' }, 400);
  if (await limited(env, 'syncPid', pid)) return json({ ok: false, error: 'slow down' }, 429);
  const name = cleanName(body?.name);
  if (name.length < 2 || isBlocked(name)) return json({ ok: false, error: 'bad name' }, 400);
  const fisher = FISHERS.includes(body?.fisher) ? body.fisher : 'f7';
  const now = Date.now();

  const old = await env.DB.prepare('SELECT pid FROM players WHERE pid = ?').bind(pid).first();
  if (!old) {
    if (await limited(env, 'newPlayerIp', await ipKey(request))) return json({ ok: false, error: 'slow down' }, 429);
    await env.DB.prepare(
      'INSERT INTO players (pid, name, fisher, score, reached, hidden, created, updated) VALUES (?, ?, ?, 0, 0, 0, ?, ?) ON CONFLICT(pid) DO NOTHING'
    ).bind(pid, name, fisher, now, now).run();
  } else {
    await env.DB.prepare('UPDATE players SET name = ?, fisher = ? WHERE pid = ?').bind(name, fisher, pid).run();
  }
  const total = await recompute(env, pid);
  const r = await rankOf(env, pid);
  return json({ ok: true, score: total, rank: total > 0 ? r?.rank || null : null });
}

// ---------- Løb: start og mål ----------

async function runStart(env, request, body, json) {
  const pid = body?.pid;
  const level = body?.level;
  if (!validPid(pid) || !LEVELS.includes(level)) return json({ ok: false, error: 'bad run' }, 400);
  if (await limited(env, 'runPid', pid) || await limited(env, 'runIp', await ipKey(request))) {
    return json({ ok: false, error: 'slow down' }, 429);
  }
  const id = randomId();
  const now = Date.now();
  await env.DB.batch([
    // kun ét åbent løb pr. spiller, så man ikke kan køre ti baner på én gang
    env.DB.prepare('UPDATE runs SET state = ? WHERE pid = ? AND state = ?').bind(REPLACED, pid, OPEN),
    env.DB.prepare('INSERT INTO runs (id, pid, level, started, state) VALUES (?, ?, ?, ?, ?)').bind(id, pid, level, now, OPEN),
  ]);
  return json({ ok: true, run: id });
}

async function runFinish(env, request, body, json) {
  const pid = body?.pid;
  const id = body?.run;
  if (!validPid(pid) || !validRun(id)) return json({ ok: false, error: 'bad run' }, 400);
  if (await limited(env, 'finishPid', pid)) return json({ ok: false, error: 'slow down' }, 429);
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  if (!run || run.pid !== pid) return json({ ok: false, error: 'bad run' }, 400);
  if (run.state === DONE) return json({ ok: true, score: null, dup: true });
  if (run.state !== OPEN) return json({ ok: false, error: 'stale' });

  const now = Date.now();
  const elapsed = now - run.started;
  const score = Number(body?.score);
  const reject = async (note) => {
    await env.DB.prepare('UPDATE runs SET state = ?, score = ?, finished = ?, note = ? WHERE id = ?')
      .bind(REJECTED, Number.isFinite(score) ? Math.round(score) : null, now, note, id).run();
    return json({ ok: false, error: 'rejected' });
  };
  if (elapsed > RUN_TTL) return reject('for gammelt');
  if (elapsed < minMs(run.level)) return reject(`for hurtigt: ${Math.round(elapsed / 1000)} sek.`);
  if (!Number.isInteger(score) || score < 0) return reject('ugyldige point');
  if (score > maxScore(run.level, elapsed)) return reject(`for mange point: ${score}`);

  await env.DB.batch([
    env.DB.prepare('UPDATE runs SET state = ?, score = ?, finished = ? WHERE id = ?').bind(DONE, score, now, id),
    env.DB.prepare(
      'INSERT INTO scores (pid, level, score) VALUES (?, ?, ?) ON CONFLICT(pid, level) DO UPDATE SET score = MAX(score, excluded.score)'
    ).bind(pid, run.level, score),
  ]);
  const total = await recompute(env, pid);
  const r = await rankOf(env, pid);
  return json({ ok: true, score: total, rank: r && total > 0 ? r.rank : null });
}

// ---------- Listen ----------

async function top(env, url, json) {
  const me = url.searchParams.get('me');
  const n = Math.max(1, Math.min(50, parseInt(url.searchParams.get('n') || '8', 10) || 8));
  const list = (await env.DB.prepare(
    'SELECT pid, name, fisher, score, reached FROM players WHERE hidden = 0 AND score > 0 ORDER BY score DESC, updated ASC LIMIT ?'
  ).bind(n).all()).results || [];
  const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM players WHERE hidden = 0 AND score > 0').first())?.c || 0;
  const players = list.map((p) => ({ name: p.name, fisher: p.fisher, score: p.score, reached: p.reached, me: p.pid === me }));
  let mine = null;
  if (validPid(me)) {
    const r = await rankOf(env, me);
    if (r && !r.hidden && r.score > 0) mine = { rank: r.rank, score: r.score, reached: r.reached };
  }
  return json({ players, me: mine, count });
}

// ---------- Hemmeligheden: rabatkoder ----------

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // uden 0, O, 1 og I
const MAX_PER_DEVICE = 3;
const RESEND_MS = 24 * 3600 * 1000;   // samme mail får højst koden tilsendt én gang i døgnet

function newCode() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const s = [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
  return `AMA-${s.slice(0, 4)}-${s.slice(4)}`;
}

const hasBrevo = (env) => !!(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL);

async function brevo(env, path, body) {
  try {
    const r = await fetch(`https://api.brevo.com/v3${path}`, {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function mailCode(env, email, code) {
  if (!hasBrevo(env)) return false;
  const html = `<p>Tak fordi du klarede hele Amager.</p>
<p>Din rabatkode: <strong style="font-size:20px">${code}</strong></p>
<p>Koden giver 10% rabat på en workshop fra ai-workshop, højst 2.000 kr. Skriv koden, når du booker på <a href="https://ai-workshop.dk">ai-workshop.dk</a>.</p>`;
  const ok = await brevo(env, '/smtp/email', {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'ai-workshop' },
    to: [{ email }],
    subject: 'Din rabatkode fra Julefrokost på Amager',
    htmlContent: html,
  });
  if (ok) await env.DB.prepare('UPDATE codes SET mailed = ? WHERE email = ?').bind(Date.now(), email).run();
  return ok;
}

async function addToNewsletter(env, email) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) return false;
  const id = parseInt(env.BREVO_LIST_ID, 10);
  if (!id) return false;
  return brevo(env, '/contacts', { email, listIds: [id], updateEnabled: true });
}

async function claim(env, request, body, ctx, json) {
  const pid = body?.pid;
  if (!validPid(pid)) return json({ ok: false, error: 'name' }, 400);
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL.test(email)) return json({ ok: false, error: 'email' }, 400);
  if (await limited(env, 'claimPid', pid) || await limited(env, 'claimIp', await ipKey(request))) {
    return json({ ok: false, error: 'slow' }, 429);
  }
  const newsletter = body?.newsletter ? 1 : 0;

  const player = await env.DB.prepare('SELECT name, hidden FROM players WHERE pid = ?').bind(pid).first();
  if (!player) return json({ ok: false, error: 'name' });
  if (player.hidden) return json({ ok: false, error: 'notdone' });
  // kun godkendte løb tæller: scores skrives udelukkende af /run/finish
  const done = await env.DB.prepare('SELECT COUNT(*) AS c FROM scores WHERE pid = ?').bind(pid).first();
  if ((done?.c || 0) < LEVELS.length) return json({ ok: false, error: 'notdone' });

  const existing = await env.DB.prepare('SELECT code, pid, newsletter, mailed FROM codes WHERE email = ?').bind(email).first();
  if (existing) {
    if (newsletter && !existing.newsletter && existing.pid === pid) {
      await env.DB.prepare('UPDATE codes SET newsletter = 1 WHERE email = ?').bind(email).run();
      ctx?.waitUntil?.(addToNewsletter(env, email));
    }
    if (existing.pid === pid) return json({ ok: true, code: existing.code, sent: false });
    const recent = existing.mailed && Date.now() - existing.mailed < RESEND_MS;
    const sent = hasBrevo(env) && !recent ? await mailCode(env, email, existing.code) : false;
    return json({ ok: false, error: 'taken', sent: sent || !!recent });
  }

  const mine = await env.DB.prepare('SELECT COUNT(*) AS c FROM codes WHERE pid = ?').bind(pid).first();
  if ((mine?.c || 0) >= MAX_PER_DEVICE) return json({ ok: false, error: 'limit' });

  let code = null;
  for (let i = 0; i < 5 && !code; i++) {
    const c = newCode();
    try {
      await env.DB.prepare('INSERT INTO codes (code, email, pid, name, newsletter, created) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(c, email, pid, player.name, newsletter, Date.now()).run();
      code = c;
    } catch (e) {
      // samme kode findes i forvejen (meget usandsynligt), eller mailen blev taget samtidig
      const again = await env.DB.prepare('SELECT code, pid FROM codes WHERE email = ?').bind(email).first();
      if (again) return again.pid === pid ? json({ ok: true, code: again.code, sent: false }) : json({ ok: false, error: 'taken', sent: false });
    }
  }
  if (!code) return json({ ok: false, error: 'server' }, 500);

  const sent = hasBrevo(env) ? await mailCode(env, email, code) : false;
  if (newsletter) ctx?.waitUntil?.(addToNewsletter(env, email));
  return json({ ok: true, code, sent });
}

// ---------- Admin ----------

function isAdmin(request, env) {
  const token = env.ADMIN_TOKEN || '';
  if (token.length < 16) return false;
  const h = request.headers.get('Authorization') || '';
  const want = `Bearer ${token}`;
  if (h.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function admin(env, request, url, path, json) {
  if (request.method === 'GET' && path === '/admin/players') {
    const all = (await env.DB.prepare('SELECT pid, name, fisher, score, reached, hidden, created, updated FROM players ORDER BY score DESC').all()).results || [];
    return json({ players: all });
  }
  if (request.method === 'POST' && path === '/admin/hide') {
    const body = (await readBody(request)) || {};
    if (!validPid(body.pid)) return json({ ok: false, error: 'bad pid' }, 400);
    await env.DB.prepare('UPDATE players SET hidden = ? WHERE pid = ?').bind(body.hidden === false ? 0 : 1, body.pid).run();
    return json({ ok: true });
  }
  if (request.method === 'GET' && path === '/admin/codes') {
    const one = url.searchParams.get('code');
    const rows = one
      ? (await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(one.trim().toUpperCase()).all()).results || []
      : (await env.DB.prepare('SELECT * FROM codes ORDER BY created DESC').all()).results || [];
    return json({ codes: rows });
  }
  if (request.method === 'POST' && path === '/admin/used') {
    const body = (await readBody(request)) || {};
    const code = String(body.code || '').trim().toUpperCase();
    const used = body.used === false ? 0 : 1;
    await env.DB.prepare('UPDATE codes SET used = ?, used_at = ? WHERE code = ?').bind(used, used ? Date.now() : null, code).run();
    const found = await env.DB.prepare('SELECT code, used FROM codes WHERE code = ?').bind(code).first();
    return json({ ok: !!found, code: found || null });
  }
  if (request.method === 'GET' && path === '/admin/rejected') {
    const rows = (await env.DB.prepare(
      'SELECT r.pid, p.name, r.level, r.score, r.started, r.finished, r.note FROM runs r LEFT JOIN players p ON p.pid = r.pid WHERE r.state = ? ORDER BY r.finished DESC LIMIT 200'
    ).bind(REJECTED).all()).results || [];
    return json({ rejected: rows });
  }
  return json({ ok: false, error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const json = makeJson(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, request) });
    try {
      await ensureSchema(env);
      cleanup(env, ctx);
      if (path.startsWith('/admin/')) {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        return await admin(env, request, url, path, json);
      }
      if (request.method === 'GET' && path === '/top') {
        if (await limited(env, 'topIp', await ipKey(request))) return json({ ok: false, error: 'slow down' }, 429);
        return await top(env, url, json);
      }
      if (request.method === 'POST') {
        if (!originOk(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
        const body = await readBody(request);
        if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' }, 400);
        if (path === '/sync') return await sync(env, request, body, json);
        if (path === '/run/start') return await runStart(env, request, body, json);
        if (path === '/run/finish') return await runFinish(env, request, body, json);
        if (path === '/claim') return await claim(env, request, body, ctx, json);
      }
      if (path === '/') return json({ ok: true, name: 'amager-spil-scores' });
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'server error' }, 500);
    }
  },
};
