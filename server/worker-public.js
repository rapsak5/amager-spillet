// Fælles topscorerliste for den offentlige udgave af Amager-spillet.
// Cloudflare Worker med D1-databasen amager-spil-scores bundet som DB.
// Variabler: ALLOWED_ORIGIN (fx https://rapsak5.github.io) og ADMIN_TOKEN (secret).
//
//   GET  /top?me=<pid>&n=8  -> { players: [{ name, fisher, score, reached, me }], me: { rank, score, reached } | null, count }
//   POST /sync              { pid, name, fisher, best: { <bane>: point } }  -> { ok, score, rank }
//
// Admin (kræver header Authorization: Bearer <ADMIN_TOKEN>):
//   GET  /admin/players                 -> alle spillere med pid, også skjulte
//   POST /admin/hide   { pid, hidden }  -> skjul (hidden: true) eller vis igen (hidden: false)

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

function isAdmin(request, env) {
  const h = request.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && h === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(request, env) {
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
      }
      if (path === '/') return json(env, { ok: true, name: 'amager-spil-scores' });
      return json(env, { ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json(env, { ok: false, error: 'server error' }, 500);
    }
  },
};
