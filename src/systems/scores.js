// Topscorerlisten (offentlig udgave).
//
// Hver enhed gemmer altid sine egne point (save.js). Er SCORES_URL sat i config.js, sendes
// spillerens bedste point pr. bane til den fælles liste (server/worker-public.js), og listen
// hentes derfra. Der er intet login: spilleren kendes på et tilfældigt id på enheden og
// vises med det navn, man selv har skrevet.
//
// Serverens API:
//   GET  /top?me=<pid>  -> { players: [{ name, fisher, score, reached, me }], me: { rank, score, reached } | null, count }
//   POST /sync          { pid, name, fisher, best: { <bane>: point } }  -> { ok, score, rank }
//        Serveren beholder det højeste tal pr. bane, så det er ufarligt at sende det samme igen.

import { SCORES_URL } from '../config.js';
import { LEVELS } from '../data/levels.js';
import * as Save from './save.js';

export const TOP_N = 8;

export function isShared() { return !!SCORES_URL; }

/** Gemmer resultatet for en klaret bane. */
export function recordLevel(levelIndex, score) {
  const p = Save.player();
  const id = LEVELS[levelIndex].id;
  p.unlocked = Math.min(LEVELS.length, Math.max(p.unlocked, levelIndex + 2));
  if (levelIndex === LEVELS.length - 1) p.done = true;
  const isBest = score > (p.best[id] || 0);
  if (isBest) p.best[id] = score;
  Save.persist();
  if (isBest) sync();
  return { isBest, total: total() };
}

export function total() {
  return Object.values(Save.player().best).reduce((a, b) => a + b, 0);
}

export function reached(best = Save.player().best) {
  return LEVELS.reduce((max, l, i) => (best[l.id] != null ? i + 1 : max), 0);
}

function meRow() {
  const s = Save.load();
  return { me: true, name: s.name || 'DIG', fisher: s.fisher, score: total(), reached: reached() };
}

/** Listen fra denne enhed alene: kun en selv. */
export function localBoard() {
  return { rows: [meRow()], me: { rank: 1, ...meRow() }, count: 1, shared: false };
}

/** Den fælles liste. Sender først egne point, så listen altid er opdateret. Returnerer null uden server. */
export async function fetchBoard() {
  if (!SCORES_URL) return null;
  try {
    await sync();
    const pid = encodeURIComponent(Save.load().pid);
    const res = await fetch(`${SCORES_URL}/top?me=${pid}&n=${TOP_N}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    // Serveren markerer ens egen række med me: true. Andres id'er sendes aldrig ud.
    const rows = (data.players || []).map((r) => ({ name: String(r.name || '?'), fisher: r.fisher, score: r.score | 0, reached: r.reached | 0, me: !!r.me }));
    return { rows, me: data.me ? { ...data.me, name: Save.load().name, fisher: Save.load().fisher } : null, count: data.count || rows.length, shared: true };
  } catch (e) {
    return null;
  }
}

let inflight = null;

/** Sender navn, fisker og bedste point. Gør intet, før spilleren har et navn. */
export function sync() {
  if (!SCORES_URL) return Promise.resolve(null);
  const s = Save.load();
  if (!s.name) return Promise.resolve(null);
  const body = JSON.stringify({ pid: s.pid, name: s.name, fisher: s.fisher, best: s.progress.best });
  const run = () => fetch(`${SCORES_URL}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  inflight = (inflight || Promise.resolve()).then(run, run);
  return inflight;
}
