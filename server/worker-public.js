// Fælles topscorerliste og hemmeligheden (rabatkoder) for den offentlige udgave af Amager-spillet.
// Cloudflare Worker med D1-databasen amager-spil-scores bundet som DB.
// Variabler: ALLOWED_ORIGIN (fx https://rapsak5.github.io) og ADMIN_TOKEN (secret).
// Valgfrit, til mail med koden og nyhedsbrevet: BREVO_API_KEY (secret), BREVO_SENDER_EMAIL,
// BREVO_SENDER_NAME og BREVO_LIST_ID.
//
//   GET  /top?me=<pid>&n=8  -> { players: [{ name, fisher, score, reached, me }], me: { rank, score, reached } | null, count }
//   POST /sync              { pid, name, fisher, best: { <bane>: point } }  -> { ok, score, rank }
//   POST /claim             { pid, email, newsletter }  -> { ok, code, sent } eller { ok: false, error, sent? }
//        Kun spillere, der har klaret alle ti baner. Én kode pr. mail, højst 3 pr. enhed.
//        Har mailen allerede en kode fra en anden enhed, vises den ikke (error: taken). Den sendes
//        til mailen igen, hvis Brevo er sat op (sent: true).
//
// Admin (kræver header Authorization: Bearer <ADMIN_TOKEN>):
//   GET  /admin/players                 -> alle spillere med pid, også skjulte
//   POST /admin/hide   { pid, hidden }  -> skjul (hidden: true) eller vis igen (hidden: false)
//   GET  /admin/codes[?code=AMA-...]    -> alle rabatkoder, eller én
//   POST /admin/used   { code, used }   -> markér en kode som brugt (used: false fortryder)

const FISHERS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
const LEVELS = ['dragoer', 'lufthavn', 'blaaplanet', 'idraetspark', 'faelled', 'dr', 'campus', 'center', 'jaguaren', 'copenhill'];
const MAX_SCORE = 1000000;
const NAME_MAX = 12;

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

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) },
  });
}

const validPid = (pid) => typeof pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(pid);

async function rankOf(env, pid) {
  const me = await env.DB.prepare('SELECT score, reached, updated, hidden FROM players WHERE pid = ?').bind(pid).first();
  if (!me) return null;
  const ahead = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE hidden = 0 AND (score > ? OR (score = ? AND updated < ?))'
  ).bind(me.score, me.score, me.updated).first();
  return { rank: (ahead?.c || 0) + 1, score: me.score, reached: me.reached, hidden: !!me.hidden };
}

async function sync(env, body) {
  const pid = body?.pid;
  if (!validPid(pid)) return json(env, { ok: false, error: 'bad pid' }, 400);
  const name = cleanName(body?.name);
  if (name.length < 2 || isBlocked(name)) return json(env, { ok: false, error: 'bad name' }, 400);
  const fisher = FISHERS.includes(body?.fisher) ? body.fisher : 'f7';
  const best = body?.best && typeof body.best === 'object' ? body.best : {};
  const now = Date.now();

  const stmts = [];
  for (const level of LEVELS) {
    const sc = Number(best[level]);
    if (!Number.isInteger(sc) || sc < 0 || sc > MAX_SCORE) continue;
    stmts.push(env.DB.prepare(
      'INSERT INTO scores (pid, level, score) VALUES (?, ?, ?) ON CONFLICT(pid, level) DO UPDATE SET score = MAX(score, excluded.score)'
    ).bind(pid, level, sc));
  }
  if (stmts.length) await env.DB.batch(stmts);

  const rows = (await env.DB.prepare('SELECT level, score FROM scores WHERE pid = ?').bind(pid).all()).results || [];
  const byLevel = Object.fromEntries(rows.map((r) => [r.level, r.score]));
  const total = LEVELS.reduce((s, l) => s + (byLevel[l] || 0), 0);
  const reached = LEVELS.reduce((m, l, i) => (byLevel[l] != null ? i + 1 : m), 0);

  const old = await env.DB.prepare('SELECT score FROM players WHERE pid = ?').bind(pid).first();
  if (!old) {
    await env.DB.prepare(
      'INSERT INTO players (pid, name, fisher, score, reached, hidden, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    ).bind(pid, name, fisher, total, reached, now, now).run();
  } else {
    // updated flyttes kun, når pointene stiger, så den der kom først står øverst ved lige point
    await env.DB.prepare(
      'UPDATE players SET name = ?, fisher = ?, score = ?, reached = ?, updated = CASE WHEN ? > score THEN ? ELSE updated END WHERE pid = ?'
    ).bind(name, fisher, total, reached, total, now, pid).run();
  }
  const r = await rankOf(env, pid);
  return json(env, { ok: true, score: total, rank: r?.rank || null });
}

async function top(env, url) {
  const me = url.searchParams.get('me');
  const n = Math.max(1, Math.min(50, parseInt(url.searchParams.get('n') || '8', 10) || 8));
  const list = (await env.DB.prepare(
    'SELECT pid, name, fisher, score, reached FROM players WHERE hidden = 0 ORDER BY score DESC, updated ASC LIMIT ?'
  ).bind(n).all()).results || [];
  const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM players WHERE hidden = 0').first())?.c || 0;
  const players = list.map((p) => ({ name: p.name, fisher: p.fisher, score: p.score, reached: p.reached, me: p.pid === me }));
  let mine = null;
  if (validPid(me)) {
    const r = await rankOf(env, me);
    if (r && !r.hidden) mine = { rank: r.rank, score: r.score, reached: r.reached };
  }
  return json(env, { players, me: mine, count });
}

// ---------- Hemmeligheden: rabatkoder ----------

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // uden 0, O, 1 og I
const MAX_PER_DEVICE = 3;
let codesReady = false;

async function ensureCodes(env) {
  if (codesReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pid TEXT NOT NULL, name TEXT, newsletter INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS codes_pid ON codes (pid)'),
  ]);
  codesReady = true;
}

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
  return brevo(env, '/smtp/email', {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'ai-workshop' },
    to: [{ email }],
    subject: 'Din rabatkode fra Julefrokost på Amager',
    htmlContent: html,
  });
}

async function addToNewsletter(env, email) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) return false;
  const id = parseInt(env.BREVO_LIST_ID, 10);
  if (!id) return false;
  return brevo(env, '/contacts', { email, listIds: [id], updateEnabled: true });
}

async function claim(env, body, ctx) {
  const pid = body?.pid;
  if (!validPid(pid)) return json(env, { ok: false, error: 'name' }, 400);
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL.test(email)) return json(env, { ok: false, error: 'email' }, 400);
  const newsletter = body?.newsletter ? 1 : 0;
  await ensureCodes(env);

  const player = await env.DB.prepare('SELECT name, reached FROM players WHERE pid = ?').bind(pid).first();
  if (!player) return json(env, { ok: false, error: 'name' });
  const done = await env.DB.prepare('SELECT COUNT(*) AS c FROM scores WHERE pid = ?').bind(pid).first();
  if ((done?.c || 0) < LEVELS.length) return json(env, { ok: false, error: 'notdone' });

  const existing = await env.DB.prepare('SELECT code, pid, newsletter FROM codes WHERE email = ?').bind(email).first();
  if (existing) {
    if (newsletter && !existing.newsletter) {
      await env.DB.prepare('UPDATE codes SET newsletter = 1 WHERE email = ?').bind(email).run();
      ctx?.waitUntil?.(addToNewsletter(env, email));
    }
    if (existing.pid === pid) return json(env, { ok: true, code: existing.code, sent: false });
    const sent = hasBrevo(env) ? await mailCode(env, email, existing.code) : false;
    return json(env, { ok: false, error: 'taken', sent });
  }

  const mine = await env.DB.prepare('SELECT COUNT(*) AS c FROM codes WHERE pid = ?').bind(pid).first();
  if ((mine?.c || 0) >= MAX_PER_DEVICE) return json(env, { ok: false, error: 'limit' });

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
      if (again) return again.pid === pid ? json(env, { ok: true, code: again.code, sent: false }) : json(env, { ok: false, error: 'taken', sent: false });
    }
  }
  if (!code) return json(env, { ok: false, error: 'server' }, 500);

  const sent = hasBrevo(env) ? await mailCode(env, email, code) : false;
  if (newsletter) ctx?.waitUntil?.(addToNewsletter(env, email));
  return json(env, { ok: true, code, sent });
}

function isAdmin(request, env) {
  const h = request.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && h === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (request.method === 'GET' && path === '/top') return await top(env, url);
      if (request.method === 'POST' && path === '/sync') {
        let body;
        try { body = await request.json(); } catch (e) { return json(env, { ok: false, error: 'bad json' }, 400); }
        return await sync(env, body);
      }
      if (request.method === 'POST' && path === '/claim') {
        let body;
        try { body = await request.json(); } catch (e) { return json(env, { ok: false, error: 'email' }, 400); }
        return await claim(env, body, ctx);
      }
      if (path.startsWith('/admin/')) {
        if (!isAdmin(request, env)) return json(env, { ok: false, error: 'unauthorized' }, 401);
        if (request.method === 'GET' && path === '/admin/players') {
          const all = (await env.DB.prepare('SELECT pid, name, fisher, score, reached, hidden, created, updated FROM players ORDER BY score DESC').all()).results || [];
          return json(env, { players: all });
        }
        if (request.method === 'POST' && path === '/admin/hide') {
          const body = await request.json().catch(() => ({}));
          if (!validPid(body?.pid)) return json(env, { ok: false, error: 'bad pid' }, 400);
          await env.DB.prepare('UPDATE players SET hidden = ? WHERE pid = ?').bind(body.hidden === false ? 0 : 1, body.pid).run();
          return json(env, { ok: true });
        }
        if (request.method === 'GET' && path === '/admin/codes') {
          await ensureCodes(env);
          const one = url.searchParams.get('code');
          const rows = one
            ? (await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(one.trim().toUpperCase()).all()).results || []
            : (await env.DB.prepare('SELECT * FROM codes ORDER BY created DESC').all()).results || [];
          return json(env, { codes: rows });
        }
        if (request.method === 'POST' && path === '/admin/used') {
          await ensureCodes(env);
          const body = await request.json().catch(() => ({}));
          const code = String(body?.code || '').trim().toUpperCase();
          const used = body?.used === false ? 0 : 1;
          await env.DB.prepare('UPDATE codes SET used = ?, used_at = ? WHERE code = ?').bind(used, used ? Date.now() : null, code).run();
          const found = await env.DB.prepare('SELECT code, used FROM codes WHERE code = ?').bind(code).first();
          return json(env, { ok: !!found, code: found || null });
        }
      }
      if (path === '/') return json(env, { ok: true, name: 'amager-spil-scores' });
      return json(env, { ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json(env, { ok: false, error: 'server error' }, 500);
    }
  },
};
