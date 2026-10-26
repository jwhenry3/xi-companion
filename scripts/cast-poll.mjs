// Live-polls the addon's cast-tracker diagnostics (GET /api/party/dbg +
// /api/party) every 500ms and asserts the contract the /target cast bar
// depends on:
//
//   * a cat-7/8 action packet from the engaged target must surface as
//     t.cast (or at least a resolvable top-level cast)
//   * the bar must never render a foreign caster — a trust/party member's
//     cast showing on the enemy bar is the reported bug
//   * `own` may only flag the player's own cast; a false own suppresses
//     an enemy cast entirely
//   * actor->entity resolution coverage: w (direct wire hit), lx (the
//     wire id registered for actor%0x1000), an (resolved name)
//
// New 0x028 log entries, cast transitions, target changes, and findings
// print as they happen; every sample appends to --out for postmortem.
// Ctrl+C prints the coverage/finding summary.
//
//   node scripts/cast-poll.mjs [--url http://localhost:17890]
//       [--interval 500] [--out cast-poll.jsonl]

import { appendFileSync, writeFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BASE = (arg('url') || 'http://localhost:17890').replace(/\/$/, '');
const INTERVAL = Number(arg('interval') || 500);
const OUT = arg('out');

const ts = () => new Date().toISOString().slice(11, 23);
const hex = (n) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
const say = (tag, msg) => console.log(`${ts()} ${tag} ${msg}`);

async function get(path) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ac.signal });
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// --- state ---
const actionCounts = new Map(); // fp -> count seen (ring can repeat entries)
const durCounts = new Map();    // same dedupe for the dl windup ring
const learned = new Map();      // dbg.lk snapshot — for LEARN transitions
let lastCastKey = 'none';
let lastAc = 0;
let lastTargetKey = null;
let lastVerdict = null;
let wasDown = false;
const findings = new Map(); // kind -> count
const actors = new Map();   // actor id -> {cats:Set, res:'wire'|'lx'|'name'|'none', an}
let enemyCasts = 0, enemyHits = 0;

const bump = (k) => findings.set(k, (findings.get(k) || 0) + 1);

function noteFinding(kind, detail) {
  bump(kind);
  say(`FIND ${kind}`, detail);
}

// this server's 0x028 actor field packs the entity id as
// (id & 0xFFFFFF) << 8 | flags — bridge via actor>>8 vs id&0xFFFFFF
const a24 = (e) => e.a >>> 8;

// resolution summary for one action-log entry
function resOf(e, t) {
  if (e.w != null) return 'wire';
  if (e.lx === e.a) return 'lx-self';
  if (e.lx != null) return `lx->${hex(e.lx)}`;
  if (t && (a24(e) === (t.i & 0xffffff) || (t.mi != null && a24(e) === (t.mi & 0xffffff)))) return 'packed24';
  if (e.an) return 'name-only';
  return 'none';
}

function actorIsTarget(e, t) {
  if (!t) return false;
  const ix = t.ix;
  return (e.w != null && e.w === ix)
    || (e.lx != null && (e.lx === t.i || e.lx === t.mi))
    || e.a === t.i || e.a === t.mi
    || a24(e) === (t.i & 0xffffff)
    || (t.mi != null && a24(e) === (t.mi & 0xffffff))
    || (ix != null && e.a % 0x1000 === ix)
    || (e.an && norm(e.an) === norm(t.n));
}

function sample(dbg, party) {
  if (dbg?.ac != null) lastAc = dbg.ac;
  const t = dbg?.t || null;
  const pt = party?.t || null;
  const cast = dbg?.cast || null;
  const player = norm(dbg?.pn) || norm(party?.p?.[0]?.n);
  const partyNames = new Set(
    (party?.p || []).map((m) => norm(m.n)).filter((n) => n && n !== player),
  );

  // target transition
  const tKey = t ? `${t.ix}|${t.n}` : 'none';
  if (tKey !== lastTargetKey) {
    lastTargetKey = tKey;
    say('TARGET', t ? `'${t.n}' ix=${t.ix} i=${hex(t.i)} mi=${t.mi ? hex(t.mi) : '-'}` : 'none');
  }

  // new action-log entries (count-delta dedupe — the ring repeats legit
  // fps; json_array-coerced server-side but an empty {} still parses as
  // an object, so guard anyway)
  const log = Array.isArray(dbg?.log) ? dbg.log : [];
  const seen = new Map();
  for (const e of log) {
    const fp = JSON.stringify(e);
    seen.set(fp, (seen.get(fp) || 0) + 1);
  }
  for (const e of log) {
    const fp = JSON.stringify(e);
    if ((actionCounts.get(fp) || 0) >= seen.get(fp)) continue;
    actionCounts.set(fp, (actionCounts.get(fp) || 0) + 1);
    const isStart = e.c === 7 || e.c === 8;
    const res = resOf(e, t);
    const aRec = actors.get(e.a) || { cats: new Set(), res, an: e.an };
    aRec.cats.add(e.c);
    if (e.an) aRec.an = e.an;
    actors.set(e.a, aRec);
    say('ACTION',
      `c=${e.c} a=${hex(e.a)} a24=${hex(a24(e))} an=${e.an || '-'} res=${res}` +
      ` w=${e.w ?? '-'} lx=${e.lx != null ? hex(e.lx) : '-'}` +
      ` tg=${e.tg != null ? hex(e.tg) : '-'} s=${e.s}`);
    if (isStart) {
      if (actorIsTarget(e, t)) {
        enemyCasts++;
        say('EXPECT', `cat-${e.c} start resolves to target '${t.n}' — bar should show it`);
      } else if (res === 'none') {
        say('UNRESOLVED', `actor ${hex(e.a)} bridges to nothing (no wire, no lx, no name)`);
      }
    }
  }

  // windup observations — the dl ring records {an,n,e,a,c}: the estimate
  // the bar used vs the real start->finish time. NM moves running hot
  // show e-a > ~0.4s until the learned table corrects the estimate.
  const dlog = Array.isArray(dbg?.dl) ? dbg.dl : [];
  const dseen = new Map();
  for (const d of dlog) dseen.set(JSON.stringify(d), (dseen.get(JSON.stringify(d)) || 0) + 1);
  for (const d of dlog) {
    const fp = JSON.stringify(d);
    if ((durCounts.get(fp) || 0) >= dseen.get(fp)) continue;
    durCounts.set(fp, (durCounts.get(fp) || 0) + 1);
    const delta = (d.e - d.a).toFixed(2);
    const off = Math.abs(d.e - d.a) > 0.4;
    const tag = d.c === 4 || d.c === 3 || d.c === 11 ? 'finished' : 'interrupted';
    say('DUR', `'${d.n}' by ${d.an ?? '?'} est=${d.e}s act=${d.a}s Δ${delta} cat=${d.c} (${tag})${off ? '  <-- TIMING-OFF' : ''}`);
    if (off) bump(d.e > d.a ? 'WINDUP-EST-HIGH' : 'WINDUP-EST-LOW');
    else bump('WINDUP-ON');
  }

  // learned-duration transitions
  for (const [k, v] of Object.entries(dbg?.lk || {})) {
    if (learned.get(k) !== v) {
      learned.set(k, v);
      say('LEARN', `${k} = ${typeof v === 'number' ? v.toFixed(2) : v}s`);
    }
  }

  // cast transition
  const cKey = cast ? `${cast.a}|${cast.n}|${cast.t}` : 'none';
  if (cKey !== lastCastKey) {
    lastCastKey = cKey;
    say(cast ? '+CAST' : '-CAST',
      cast ? `'${cast.n}' an=${cast.an || '-'} own=${cast.own ? 1 : 0} a=${hex(cast.a)} d=${cast.d}s`
           : '');
  }

  // ---- assertions on what the /target bar would render ----
  // mirrors target.view.tsx: t.cast wins; the top-level cast only falls
  // through when its resolved actor name agrees with the target's. A
  // foreign cast rendering nothing is the CORRECT outcome now.
  let verdict = null;
  if (party?.on !== 0 && pt) {
    const nameMatch = cast?.an && norm(cast.an) === norm(pt.n);
    if (pt.cast) {
      verdict = `OK target '${pt.n}' casting '${pt.cast.n}'`;
      bump('BAR-OK');
      if (cast) enemyHits++;
    } else if (cast && !cast.own && nameMatch) {
      verdict = `OK-FALLBACK '${cast.n}' name-matches '${pt.n}'`;
      bump('BAR-OK-FALLBACK');
    } else if (cast?.own) {
      const bad = player && cast.an && norm(cast.an) !== player;
      verdict = bad
        ? `FALSE-OWN '${cast.n}' by '${cast.an}' hidden as "own" — bar empty`
        : `own cast '${cast.n}' (bar hides it)`;
      bump(bad ? 'FALSE-OWN' : 'OWN-CAST');
    } else if (cast) {
      const isParty = cast.an && partyNames.has(norm(cast.an));
      verdict = `clean — foreign cast '${cast.n}' by '${cast.an ?? hex(cast.a)}'` +
        ` (${isParty ? 'trust/party' : 'other entity'}) withheld from '${pt.n}'`;
      bump(isParty ? 'FOREIGN-SUPPRESSED-TRUST' : 'FOREIGN-SUPPRESSED');
    }
  }
  if (verdict && verdict !== lastVerdict) say('BAR', verdict);
  lastVerdict = verdict;
}

async function tick() {
  let dbg, party;
  try {
    [dbg, party] = await Promise.all([get('/api/party/dbg'), get('/api/party')]);
  } catch {
    if (!wasDown) say('DOWN', `${BASE} unreachable (addon not serving?)`);
    wasDown = true;
    return;
  }
  if (wasDown) say('UP', 'addon reachable again');
  wasDown = false;
  sample(dbg, party);
  if (OUT) {
    appendFileSync(OUT, JSON.stringify({ ts: Date.now(), dbg, party }) + '\n');
  }
}

function summary() {
  console.log('\n--- summary ---');
  console.log(`action packets seen by addon: ${lastAc}; distinct actors: ${actors.size}`);
  for (const [a, r] of actors) {
    console.log(`  ${hex(a)} cats=[${[...r.cats].join(',')}] res=${r.res} an=${r.an || '-'}`);
  }
  console.log(`enemy cat-7/8 starts resolving to target: ${enemyCasts}, shown on bar: ${enemyHits}`);
  console.log(`learned windups: ${learned.size}`);
  console.log('findings:');
  for (const [k, n] of findings) console.log(`  ${k}: ${n}`);
}

process.on('SIGINT', () => { summary(); process.exit(0); });

if (OUT) writeFileSync(OUT, '');
say('POLL', `${BASE} every ${INTERVAL}ms${OUT ? ` -> ${OUT}` : ''}`);

let inFlight = false;
setInterval(async () => {
  if (inFlight) return;
  inFlight = true;
  try { await tick(); } finally { inFlight = false; }
}, INTERVAL);
void tick();
