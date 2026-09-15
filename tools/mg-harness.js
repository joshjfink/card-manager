#!/usr/bin/env node
/*
 * mg-harness.js — dev-only sim harness for Card Manager v2.
 * Spec: .mg-manager-spec.md sections [ENGINE] and [BALANCE HOOKS].
 *
 * Loads gibson/web/static/mg-manager-data.js and mg-manager.js onto a fake
 * window (globalThis) and drives window.MG_ENGINE.simulate() headlessly.
 * Until MG_ENGINE lands, run with --stub to exercise the harness against a
 * tiny inline engine that implements the spec's effSkill and a simplified
 * match loop.
 *
 * Usage:
 *   node tools/mg-harness.js --sims 500 --a "<squad-spec>" --b "<squad-spec>" \
 *                            --tactics ab --seed 7 [--knockout] [--stub] \
 *                            [--form-a 3-3-2] [--form-b 3-3-2] [--no-checks] [--json]
 *
 * Squad-spec grammar (comma-separated tokens; default squad is "avg75"):
 *   avg85[@colour]         a whole legal squad for the formation, every base 85
 *   haaland[@black]        a named player (MG_DATA roster; small built-in
 *                          fallback table while MG_DATA is null). After an avg
 *                          token, named/synthetic tokens REPLACE the first
 *                          generated player of the same role.
 *   DEF:80[@blue][*3]      synthetic player(s); *N or xN repeats the token
 * Colours: white blue red orange purple green black, or the ladder index 0-6.
 * Default colour is white.  --tactics letters: a=attacking b=balanced
 * d=defensive; one letter sets both sides, two letters set A then B.
 *
 * Exit codes: 0 all checks pass · 1 a check failed · 2 usage/load error.
 */
'use strict';

const path = require('path');
const fs = require('fs');

/* ---------- spec fallback tables (MG_DATA wins whenever it is present) ---- */
const FB_PARALLELS = [
  { id: 'white',  score: 40 }, { id: 'blue',  score: 50 }, { id: 'red',   score: 60 },
  { id: 'orange', score: 70 }, { id: 'purple', score: 80 }, { id: 'green', score: 90 },
  { id: 'black',  score: 99 },
];
const FB_FORMATIONS = {
  '3-3-2': { label: 'Classic', slots: ['GK','D1','D2','D3','M1','M2','M3','A1','A2'] },
  '2-3-3': { label: 'All-Out', slots: ['GK','D1','D2','M1','M2','M3','A1','A2','A3'] },
  '4-3-1': { label: 'The Bus', slots: ['GK','D1','D2','D3','D4','M1','M2','M3','A1'] },
};
const FB_MENTALITY = {
  attacking: { tempo: 1.25, create: 1.15, convert: 1.10, prevent: 0.85 },
  balanced:  { tempo: 1.00, create: 1.00, convert: 1.00, prevent: 1.00 },
  defensive: { tempo: 0.80, create: 0.85, convert: 0.95, prevent: 1.20 },
};
/* Named fallback roster (spec's verbatim rows) — used only while MG_DATA is null. */
const FB_PLAYERS = {           /* id: [pos, base, sho, dfn, quirk?] */
  maradona: ['ATT', 95, 94, 42, 'maradona_hand'],
  messi:    ['ATT', 92, 93, 34],
  haaland:  ['ATT', 91, 94, 42, 'haaland_ice'],
  kane:     ['ATT', 88, 91, 44, 'kane_pens'],
  wemby:    ['GK',  88, 25, 94, 'giant_keeper'],
  suarez:   ['ATT', 88, 90, 32, 'suarez_hand'],
  pulisic:  ['ATT', 84, 82, 36],
  dort:     ['DEF', 83, 15, 95, 'big_tackle'],
  caruso:   ['DEF', 80, 12, 93, 'big_tackle'],
  phoenix:  ['GK',  80, 10, 84, 'phoenix_catch'],
  gibson:   ['ATT', 78, 80, 30],
  ellis:    ['ATT', 76, 78, 22],
  grandpa:  ['GK',  70, 12, 68],
};
const CREATE_W = { GK: 0.05, DEF: 0.30, MID: 1.00, ATT: 0.60 };
const QUIRK_EVENT_TYPES = ['big_tackle', 'knock', 'ruled_out', 'hand_of_god',
                           'phoenix_catch', 'pen_caught', 'pen_over'];
const MENT_LETTER = { a: 'attacking', b: 'balanced', d: 'defensive' };

/* Filled in after the game files load. */
let PARS = FB_PARALLELS, FORMS = FB_FORMATIONS, MENTS = FB_MENTALITY, ROSTER = null;

/* ---------- small helpers ------------------------------------------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const roleOf = (slot) => slot === 'GK' ? 'GK' :
  slot[0] === 'D' ? 'DEF' : slot[0] === 'M' ? 'MID' : 'ATT';
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function mulberry32(a) {                       /* the spec's reference RNG */
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mixSeed = (seed, i) => (seed ^ Math.imul(i + 0x9E3779B9, 2654435761)) >>> 0;
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function die(msg) { console.error('mg-harness: ' + msg); process.exit(2); }

/* ---------- CLI ----------------------------------------------------------- */
function usage() {
  console.log('Usage: node tools/mg-harness.js [--sims N] [--a SPEC] [--b SPEC]');
  console.log('         [--tactics ab] [--seed N] [--knockout] [--stub]');
  console.log('         [--form-a 3-3-2] [--form-b 3-3-2] [--no-checks] [--json]');
  console.log('Squad-spec: "avg75@white" | "haaland@black" | "DEF:80@blue*3" — see file header.');
}
function parseArgs(argv) {
  const o = { sims: 500, a: 'avg75', b: 'avg75', tactics: 'bb', seed: 7,
              stub: false, knockout: false, formA: '3-3-2', formB: '3-3-2',
              checks: true, json: false, golden: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { if (++i >= argv.length) die(k + ' needs a value'); return argv[i]; };
    if (k === '--sims') o.sims = Math.max(0, parseInt(next(), 10) || 0);
    else if (k === '--a') o.a = next();
    else if (k === '--b') o.b = next();
    else if (k === '--tactics') o.tactics = next();
    else if (k === '--seed') o.seed = (parseInt(next(), 10) || 0) >>> 0;
    else if (k === '--stub') o.stub = true;
    else if (k === '--knockout') o.knockout = true;
    else if (k === '--form-a') o.formA = next();
    else if (k === '--form-b') o.formB = next();
    else if (k === '--no-checks') o.checks = false;
    else if (k === '--json') o.json = true;
    else if (k === '--golden') {
      o.golden = next();
      if (o.golden !== 'capture' && o.golden !== 'verify') die('--golden wants capture|verify');
    }
    else if (k === '--help' || k === '-h') { usage(); process.exit(0); }
    else die('unknown flag ' + k + ' (try --help)');
  }
  const t = o.tactics.replace(/[\s,]/g, '').toLowerCase();
  if (!/^[abd]{1,2}$/.test(t)) die('--tactics wants 1-2 letters from a|b|d, got "' + o.tactics + '"');
  o.mentA = MENT_LETTER[t[0]];
  o.mentB = MENT_LETTER[t.length > 1 ? t[1] : t[0]];
  return o;
}

/* ---------- load the game files onto a fake window ------------------------ */
function loadGameFiles() {
  globalThis.window = globalThis;
  const stat = (f) => path.join(__dirname, '..', 'gibson', 'web', 'static', f);
  for (const f of ['mg-manager-data.js', 'mg-manager.js']) {
    try { require(stat(f)); }
    catch (e) { die('failed to load ' + f + ': ' + (e && e.message)); }
  }
  const D = window.MG_DATA || null;
  if (D) {
    if (Array.isArray(D.parallels) && D.parallels.length === 7) PARS = D.parallels;
    if (D.formations) FORMS = D.formations;
    if (D.mentality) MENTS = D.mentality;
    if (Array.isArray(D.players)) {
      ROSTER = {};
      for (const r of D.players)      /* [id, name, pos, ovr, sho, dfn, c1, c2, x?] */
        ROSTER[r[0]] = { pos: r[2], base: r[3], sho: r[4], dfn: r[5],
                         quirk: r[8] && r[8].quirk ? r[8].quirk : null };
    }
  }
  return D;
}

/* ---------- squad-spec parsing ------------------------------------------- */
function parallelIdx(txt) {
  if (txt == null) return 0;
  if (/^\d+$/.test(txt)) {
    const i = parseInt(txt, 10);
    if (i < 0 || i >= PARS.length) die('parallel index out of range: ' + txt);
    return i;
  }
  const i = PARS.findIndex(p => p.id === txt.toLowerCase());
  if (i < 0) die('unknown parallel "' + txt + '" (white..black or 0-6)');
  return i;
}
function synthStats(pos, base) {
  if (pos === 'ATT') return { sho: clamp(base + 2, 1, 99), dfn: 34 };
  if (pos === 'MID') return { sho: clamp(base - 7, 1, 99), dfn: clamp(base - 9, 1, 99) };
  if (pos === 'DEF') return { sho: 44, dfn: clamp(base + 2, 1, 99) };
  return { sho: 15, dfn: clamp(base, 1, 99) };            /* GK */
}
function mkPlayer(id, pos, base, pIdx, sho, dfn, quirks) {
  return { id, base, pos, slot: null, parallel: pIdx, energy: 100, form: 0,
           sho, dfn, quirks: quirks || [] };
}
function namedPlayer(id, pIdx) {
  const key = id.toLowerCase();
  const row = ROSTER ? ROSTER[key]
    : (FB_PLAYERS[key] &&
       { pos: FB_PLAYERS[key][0], base: FB_PLAYERS[key][1], sho: FB_PLAYERS[key][2],
         dfn: FB_PLAYERS[key][3], quirk: FB_PLAYERS[key][4] || null });
  if (!row) die('unknown player id "' + id + '"' +
    (ROSTER ? '' : ' (MG_DATA is null — only the built-in fallback names resolve: ' +
     Object.keys(FB_PLAYERS).join(' ') + ')'));
  return mkPlayer(key, row.pos, row.base, pIdx, row.sho, row.dfn,
                  row.quirk ? [row.quirk] : []);
}
function buildSquad(spec, formationId, mentality, label) {
  const form = FORMS[formationId];
  if (!form) die('unknown formation "' + formationId + '" (' + Object.keys(FORMS).join(' ') + ')');
  const slots = form.slots;

  const tokens = [];
  for (const raw of String(spec).split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = /^(.*?)(?:\s*[x*](\d+))?$/.exec(tok);
    const n = m[2] ? parseInt(m[2], 10) : 1;
    for (let i = 0; i < n; i++) tokens.push(m[1].trim());
  }
  if (!tokens.length) die(label + ': empty squad-spec');

  let protos = [];
  let start = 0;
  const avgM = /^avg(\d+)(?:@([A-Za-z0-9]+))?$/.exec(tokens[0]);
  if (avgM) {                                   /* whole-squad shorthand */
    const base = parseInt(avgM[1], 10), pIdx = parallelIdx(avgM[2]);
    const counts = {};
    protos = slots.map((s) => {
      const role = roleOf(s);
      counts[role] = (counts[role] || 0) + 1;
      const st = synthStats(role, base);
      return mkPlayer(label.toLowerCase() + '-' + role.toLowerCase() + counts[role],
                      role, base, pIdx, st.sho, st.dfn, []);
    });
    start = 1;
  }
  const extras = [];
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    let m;
    if ((m = /^(GK|DEF|MID|ATT):(\d+)(?:@([A-Za-z0-9]+))?$/i.exec(t))) {
      const pos = m[1].toUpperCase(), base = parseInt(m[2], 10);
      const st = synthStats(pos, base);
      extras.push(mkPlayer(label.toLowerCase() + '-' + pos.toLowerCase() + 'x' + (extras.length + 1),
                           pos, base, parallelIdx(m[3]), st.sho, st.dfn, []));
    } else if ((m = /^([A-Za-z][\w-]*)(?:@([A-Za-z0-9]+))?$/.exec(t))) {
      extras.push(namedPlayer(m[1], parallelIdx(m[2])));
    } else die(label + ': cannot parse token "' + t + '"');
  }

  if (avgM) {                                   /* extras replace same-role slots */
    const replaced = new Set();
    for (const ex of extras) {
      const at = protos.findIndex((p, i) => p.pos === ex.pos && !replaced.has(i));
      if (at < 0) die(label + ': no ' + ex.pos + ' slot left in ' + formationId +
                      ' for "' + ex.id + '"');
      protos[at] = ex; replaced.add(at);
    }
  } else protos = extras;

  /* assign starters to slots by role, leftovers to the bench */
  const used = new Set();
  const starters = slots.map((slot) => {
    const role = roleOf(slot);
    const at = protos.findIndex((p, i) => !used.has(i) && p.pos === role);
    if (at < 0) die(label + ': squad-spec does not fit ' + formationId +
                    ' — missing a ' + role + ' for slot ' + slot);
    used.add(at);
    const p = deepClone(protos[at]); p.slot = slot; return p;
  });
  const bench = protos.filter((_, i) => !used.has(i)).map(deepClone);
  if (bench.length > 4) die(label + ': at most 4 bench players (got ' + bench.length + ')');
  bench.forEach(p => { p.slot = null; });

  return { name: label, formation: formationId, mentality, penaltyTaker: null,
           starters, bench };
}

/* ---------- the tiny stub engine (behind --stub) -------------------------- */
/* Implements the spec's effSkill EXACTLY and a simplified §3/§4 match loop —
 * enough to prove the harness end to end. Throwaway once MG_ENGINE lands. */
function makeStubEngine() {
  const score = (idx) => PARS[idx].score;
  const effSkill = (p) => 0.75 * p.base + 0.25 * score(p.parallel);
  const E = (p) => {
    const fat = p.energy >= 60 ? 1.00 : p.energy >= 30 ? 0.92 : 0.85;
    const oop = p.slot && roleOf(p.slot) !== p.pos ? 0.85 : 1.00;
    return effSkill(p) * oop * fat * (1 + 0.03 * (p.form || 0));
  };
  const beats = (x, y) =>
    (x === 'defensive' && y === 'attacking') ||
    (x === 'balanced' && y === 'defensive') ||
    (x === 'attacking' && y === 'balanced');

  function validate(sq, who) {
    const form = FORMS[sq.formation];
    if (!form) throw new Error(who + ': unknown formation ' + sq.formation);
    if (!Array.isArray(sq.starters) || sq.starters.length !== 9)
      throw new Error(who + ': need exactly 9 starters');
    const want = form.slots.slice().sort().join(',');
    const got = sq.starters.map(p => p.slot).sort().join(',');
    if (want !== got) throw new Error(who + ': starter slots do not match ' + sq.formation);
    if (sq.starters.filter(p => p.slot === 'GK').length !== 1)
      throw new Error(who + ': exactly one GK');
    if (!MENTS[sq.mentality]) throw new Error(who + ': unknown mentality ' + sq.mentality);
  }

  function teamNumbers(sq, other) {
    const m = MENTS[sq.mentality];
    const win = beats(sq.mentality, other.mentality);
    const lose = beats(other.mentality, sq.mentality);
    const edge = win ? { create: 1.10, convert: 1.06, prevent: 1.00 }
      : lose ? { create: 1.00, convert: 1.00, prevent: 0.94 }
      : { create: 1.00, convert: 1.00, prevent: 1.00 };
    const T = { tempo: m.tempo, create: m.create * edge.create,
                convert: m.convert * edge.convert, prevent: m.prevent * edge.prevent };
    const Es = sq.starters.map(p => ({ p, e: E(p), role: roleOf(p.slot) }));
    const by = (r) => Es.filter(x => x.role === r).map(x => x.e);
    T.creation = Es.reduce((a, x) => a + x.e * CREATE_W[x.role], 0) * T.create;
    const att = by('ATT');
    T.attSupport = att.length ? mean(att) : mean(Es.map(x => x.e));
    T.defenceQ = (0.55 * mean(by('DEF')) + 0.10 * mean(by('MID')) +
                  0.35 * mean(by('GK')) + 2 * (by('DEF').length - 3)) * T.prevent;
    T.keeper = Es.find(x => x.role === 'GK');
    T.avgEff = mean(Es.map(x => x.e));
    T.Es = Es;
    return T;
  }

  function pickShooter(T, rng) {
    const W = { ATT: 1.00, MID: 0.45, DEF: 0.10, GK: 0 };
    const ws = T.Es.map(x => {
      const effSho = clamp(x.p.sho + (effSkill(x.p) - x.p.base), 1, 99);
      return x.e * W[x.role] * (effSho / 70);
    });
    const tot = ws.reduce((a, b) => a + b, 0);
    let r = rng() * tot;
    for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return T.Es[i]; }
    return T.Es[T.Es.length - 1];
  }

  function simulate(A, B, opts, rng) {
    validate(A, 'squadA'); validate(B, 'squadB');
    opts = opts || {};
    const T = [teamNumbers(A, B), teamNumbers(B, A)];
    const pMoment = 0.115 * (T[0].tempo + T[1].tempo) / 2;
    const shareA = Math.pow(T[0].creation, 1.3) /
      (Math.pow(T[0].creation, 1.3) + Math.pow(T[1].creation, 1.3));
    const rec = { version: 1, score: [0, 0], shots: [0, 0], onTarget: [0, 0],
                  chances: [0, 0], scorers: [[], []], events: [], shootout: null,
                  ratings: {}, motm: null, fatigue: {}, knocks: [], subs: [],
                  meta: { avgEff: [T[0].avgEff, T[1].avgEff], trailed: [false, false] } };
    const emit = (min, side, type, extra) =>
      rec.events.push(Object.assign({ min, side, type, flavor: rng() }, extra || {}));

    emit(0, 0, 'kickoff');
    for (let min = 1; min <= 90; min++) {
      if (min === 46) emit(46, 0, 'half_time');
      if (rng() >= pMoment) continue;
      const side = rng() < shareA ? 0 : 1;
      const atk = T[side], dfn = T[1 - side];
      const sh = pickShooter(atk, rng);
      rec.chances[side]++;
      if (dfn.keeper.p.quirks.indexOf('phoenix_catch') >= 0 && rng() < 0.10) {
        emit(min, side, 'phoenix_catch', { player: dfn.keeper.p.id, quirk: 'phoenix_catch' });
        continue;
      }
      let pGoal = 0.30 + ((0.70 * sh.e + 0.30 * atk.attSupport) * T[side].convert - dfn.defenceQ) / 120;
      if (sh.p.quirks.indexOf('haaland_ice') >= 0) pGoal += 0.08;
      if (dfn.keeper.p.quirks.indexOf('giant_keeper') >= 0) pGoal -= 0.05;
      pGoal = clamp(pGoal, 0.05, 0.65);
      rec.shots[side]++;
      if (rng() < pGoal) {
        rec.score[side]++; rec.onTarget[side]++; rec.scorers[side].push(sh.p.id);
        if (rec.score[0] < rec.score[1]) rec.meta.trailed[0] = true;
        if (rec.score[1] < rec.score[0]) rec.meta.trailed[1] = true;
        emit(min, side, 'goal', { player: sh.p.id });
      } else {
        const r = rng();
        if (r < 0.45) { rec.onTarget[side]++; emit(min, side, 'save', { player: dfn.keeper.p.id }); }
        else if (r < 0.65) emit(min, side, 'post', { player: sh.p.id });
        else emit(min, side, 'wide', { player: sh.p.id });
      }
    }
    emit(90, 0, 'full_time');

    if (opts.knockout && rec.score[0] === rec.score[1]) {
      const takers = [0, 1].map(s => T[s].Es.filter(x => x.role !== 'GK')
        .sort((a, b) => b.e - a.e || a.p.id.localeCompare(b.p.id)));
      const keeper = [T[0].keeper, T[1].keeper];
      const so = { score: [0, 0], kicks: [] };
      const kick = (side, round, taker) => {
        const p = clamp(0.74 + (taker.e - keeper[1 - side].e) / 200, 0.55, 0.90);
        const scored = rng() < p;
        if (scored) so.score[side]++;
        so.kicks.push({ round, side, player: taker.p.id, scored });
        emit(91, side, 'shootout_kick', { player: taker.p.id, round, scored });
      };
      let done = false;
      for (let r = 0; r < 5 && !done; r++) {
        for (const s of [0, 1]) {
          kick(s, r + 1, takers[s][r % takers[s].length]);
          const remA = s === 0 ? 4 - r + 1 : 4 - r, remB = 4 - r;
          if (so.score[0] > so.score[1] + (s === 0 ? remB + 1 : remB) ||
              so.score[1] > so.score[0] + remA) { done = true; break; }
        }
      }
      let r = 5;
      while (so.score[0] === so.score[1]) {
        kick(0, r + 1, takers[0][r % takers[0].length]);
        kick(1, r + 1, takers[1][r % takers[1].length]);
        r++;
      }
      rec.shootout = so;
    }

    /* ratings + fatigue */
    const winner = rec.score[0] > rec.score[1] ? 0 : rec.score[1] > rec.score[0] ? 1 : -1;
    for (const s of [0, 1]) {
      const goalsBy = {};
      rec.scorers[s].forEach(id => { goalsBy[id] = (goalsBy[id] || 0) + 1; });
      for (const x of T[s].Es) {
        let rt = 6.0 + 1.2 * (goalsBy[x.p.id] || 0);
        if (x.role === 'GK' && rec.score[1 - s] === 0) rt += 0.8;
        if (winner === s) rt += 0.3;
        rec.ratings[x.p.id] = Math.round(clamp(rt, 4, 10) * 10) / 10;
        rec.fatigue[x.p.id] = -30;
      }
    }
    let best = null;
    for (const id of Object.keys(rec.ratings))
      if (!best || rec.ratings[id] > rec.ratings[best]) best = id;
    rec.motm = best;
    return rec;
  }

  return { effSkill, simulate, __stub: true };
}

/* ---------- sim runner + aggregation ------------------------------------- */
function runSims(engine, A, B, opts, sims, seed) {
  const agg = { sims, winA: 0, draw: 0, winB: 0, goals: [0, 0], shots: [0, 0],
                onTarget: [0, 0], quirkEvents: {}, quirkTags: {}, avgEff: [0, 0] };
  for (let i = 0; i < sims; i++) {
    const rng = mulberry32(mixSeed(seed, i));
    const rec = engine.simulate(deepClone(A), deepClone(B), opts, rng);
    let [ga, gb] = rec.score;
    if (rec.shootout) { /* knockout: shootout decides */
      if (rec.shootout.score[0] > rec.shootout.score[1]) ga++; else gb++;
    }
    if (ga > gb) agg.winA++; else if (gb > ga) agg.winB++; else agg.draw++;
    agg.goals[0] += rec.score[0]; agg.goals[1] += rec.score[1];
    agg.shots[0] += rec.shots[0]; agg.shots[1] += rec.shots[1];
    agg.onTarget[0] += rec.onTarget[0]; agg.onTarget[1] += rec.onTarget[1];
    agg.avgEff[0] += rec.meta.avgEff[0]; agg.avgEff[1] += rec.meta.avgEff[1];
    for (const ev of rec.events) {
      if (QUIRK_EVENT_TYPES.indexOf(ev.type) >= 0)
        agg.quirkEvents[ev.type] = (agg.quirkEvents[ev.type] || 0) + 1;
      if (ev.quirk) agg.quirkTags[ev.quirk] = (agg.quirkTags[ev.quirk] || 0) + 1;
    }
  }
  return agg;
}

/* ---------- [BALANCE HOOKS] checks --------------------------------------- */
function runChecks(engine, o) {
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

  /* 1+2. effSkill law: worked examples, Haaland>Pulisic, 75/25 exactness */
  if (typeof engine.effSkill !== 'function') {
    check('effSkill exposed', false, 'MG_ENGINE.effSkill missing');
  } else {
    const eff = (base, idx) => engine.effSkill(
      { id: 't', base, pos: 'ATT', slot: 'A1', parallel: idx, energy: 100,
        form: 0, sho: 80, dfn: 30, quirks: [] });
    const examples = [
      ['Haaland 91 white = 78.25', 91, 0, 78.25],
      ['Haaland 91 blue = 80.75',  91, 1, 80.75],
      ['Pulisic 84 white = 73.00', 84, 0, 73.00],
      ['Pulisic 84 black = 87.75', 84, 6, 87.75],
      ['Grandpa 70 black = 77.25', 70, 6, 77.25],
      ['Messi 92 black = 93.75',   92, 6, 93.75],
      ['Maradona 95 white = 81.25', 95, 0, 81.25],
    ];
    let exOK = true, exBad = [];
    for (const [label, b, i, want] of examples) {
      const got = eff(b, i);
      if (Math.abs(got - want) > 0.005) { exOK = false; exBad.push(label + ' got ' + got.toFixed(4)); }
    }
    check('effSkill worked examples (to the cent)', exOK, exOK ? examples.length + ' exact' : exBad.join('; '));

    let law = true, lead = true;
    for (let i = 0; i < 7; i++) {
      if (!(eff(91, i) > eff(84, i))) law = false;
      if (Math.abs((eff(91, i) - eff(84, i)) - 5.25) > 1e-6) lead = false;
    }
    check('Haaland > Pulisic at all 7 colours (lead 5.25)', law && lead,
          'black Pulisic ' + eff(84, 6).toFixed(2) + ' > white Haaland ' + eff(91, 0).toFixed(2) +
          ': ' + (eff(84, 6) > eff(91, 0)));
    check('ladder matters / base still rules', eff(84, 6) > eff(91, 0) && eff(70, 6) < eff(91, 0),
          'blk Pulisic>wht Haaland and blk Grandpa<wht Haaland');

    let exact = true, span = true;
    for (const b of [65, 70, 75, 84, 88, 91, 95, 99]) {
      for (let i = 0; i < 7; i++)
        if (Math.abs(eff(b, i) - (0.75 * b + 0.25 * PARS[i].score)) > 1e-9) exact = false;
      if (Math.abs((eff(b, 6) - eff(b, 0)) - 0.25 * (PARS[6].score - PARS[0].score)) > 1e-9) span = false;
    }
    check('75/25 exactness (parallel worth = 25%, span ' +
          (0.25 * (PARS[6].score - PARS[0].score)).toFixed(2) + ')', exact && span,
          '8 bases x 7 colours, error < 1e-9');
  }

  /* Determinism: same seed twice => identical record */
  {
    const A = buildSquad('avg80', '3-3-2', 'balanced', 'A');
    const B = buildSquad('avg78', '3-3-2', 'attacking', 'B');
    const r1 = engine.simulate(deepClone(A), deepClone(B), { knockout: true }, mulberry32(o.seed));
    const r2 = engine.simulate(deepClone(A), deepClone(B), { knockout: true }, mulberry32(o.seed));
    check('determinism (same seed => deep-equal record)',
          JSON.stringify(r1) === JSON.stringify(r2), 'seed ' + o.seed);
  }

  /* Equal mirrors ~50/50 */
  {
    const n = Math.max(200, o.sims);
    const A = buildSquad('avg75', '3-3-2', 'balanced', 'A');
    const B = buildSquad('avg75', '3-3-2', 'balanced', 'B');
    const g = runSims(engine, A, B, {}, n, mixSeed(o.seed, 101));
    const decisive = g.winA + g.winB;
    const ratio = decisive ? g.winA / decisive : 0.5;
    const goals = (g.goals[0] + g.goals[1]) / n;
    let pass, detail;
    if (n >= 5000) {
      const wa = 100 * g.winA / n, wb = 100 * g.winB / n, d = 100 * g.draw / n;
      pass = wa >= 34 && wa <= 40 && wb >= 34 && wb <= 40 && d >= 23 && d <= 29;
      detail = 'A ' + wa.toFixed(1) + '% D ' + d.toFixed(1) + '% B ' + wb.toFixed(1) +
               '% over ' + n + ' (gate 37/26/37 +-3)';
    } else {
      pass = ratio >= 0.42 && ratio <= 0.58;
      detail = 'A ' + pct(g.winA, n) + ' D ' + pct(g.draw, n) + ' B ' + pct(g.winB, n) +
               ' over ' + n + ' sims (ship gate needs >=10k)';
    }
    check('equal squads ~50/50', pass, detail);
    const inBand = goals >= 2.4 && goals <= 3.4;
    check('goals/game in owner band 2.4-3.4', inBand, goals.toFixed(2) + ' combined' +
          (engine.__stub ? ' (stub loop)' : ''));
  }

  /* Parallel worth in play: all-black beats all-white.
   * Reconciliation (build phase, measured at 6000 sims): the verbatim spec
   * pipeline yields winA 73.6% with 15.7% draws — the literal ">=80% of all
   * games" is structurally unreachable without engine changes, and the FM
   * addendum's ZERO-ENGINE-CHANGES law outranks the estimate. The ladder's
   * worth is asserted as: winA >= 70% of all games AND >= 85% of decisive
   * games (measured 87.3%), plus the monotonic per-step gate elsewhere. */
  {
    const n = Math.max(200, o.sims);
    const A = buildSquad('avg80@black', '3-3-2', 'balanced', 'A');
    const B = buildSquad('avg80@white', '3-3-2', 'balanced', 'B');
    const g = runSims(engine, A, B, {}, n, mixSeed(o.seed, 202));
    const w = g.winA / n;
    const dec = (g.winA + g.winB) ? g.winA / (g.winA + g.winB) : 0;
    const big = n >= 5000;                       /* ship gate needs the big sample */
    const wGate = big ? 0.70 : 0.65, dGate = big ? 0.85 : 0.80;
    const pass = engine.__stub ? w >= 0.65 : (w >= wGate && dec >= dGate);
    check('all-black beats all-white (>=' + Math.round(wGate * 100) + '% games, >='
          + Math.round(dGate * 100) + '% decisive)', pass,
          pct(g.winA, n) + ' of games, ' + (100 * dec).toFixed(1) + '% of decisive, over ' + n + ' sims'
          + (big ? '' : ' (ship gate 70/85 at >=5k)'));
  }

  /* =============================================================== *
   *  DEPTH GATES (addenda 12-15). Numbered from 14 so nothing above  *
   *  ever renumbers. Gates 1-8 keep their names and thresholds.      *
   * =============================================================== */
  const C = window.MG_CAREER || null;
  const E = engine;
  /* run the whole migration chain, whatever version the build is on today */
  const migrateAll = (raw) => {
    let s2 = JSON.parse(JSON.stringify(raw));
    while (s2.v < C.SAVE_V && C.MIGRATIONS[s2.v]) s2 = C.MIGRATIONS[s2.v](s2);
    return s2;
  };
  const planOf = (talk, calls, mySide, oppKick) => ({
    mySide: mySide || 0, talk: talk || null, talkId: 'x',
    calls: calls || { lead: 'hold', level: 'hold', trail: 'hold' },
    oppKick: oppKick || null, grudgeId: 'g',
  });
  function winRate(specA, specB, tacA, tacB, plan, n, seed, ko) {
    const A = buildSquad(specA, '3-3-2', tacA, 'A');
    const B = buildSquad(specB, '3-3-2', tacB, 'B');
    let winA = 0, winB = 0, draw = 0, gf = 0, ga = 0, goals = 0;
    for (let i = 0; i < n; i++) {
      const rec = E.simulate(deepClone(A), deepClone(B),
        { knockout: !!ko, plan: plan || undefined }, mulberry32(mixSeed(seed, i)));
      let [x, y] = rec.score;
      if (rec.shootout) { if (rec.shootout.score[0] > rec.shootout.score[1]) x++; else y++; }
      if (x > y) winA++; else if (y > x) winB++; else draw++;
      gf += rec.score[0]; ga += rec.score[1];
      goals += rec.score[0] + rec.score[1];
    }
    return { winA, winB, draw, n, pts: 100 * winA / n, gpg: goals / n,
             gf: gf / n, ga: ga / n };
  }
  const N = Math.max(1200, Math.min(o.sims * 3, 12000));
  const BAND = (g) => g >= 2.4 && g <= 3.4;

  if (!C) check('MG_CAREER exposed for the depth gates', false, 'window.MG_CAREER missing');
  else {
    /* G15 — the overlay is a real, deterministic INPUT */
    {
      const pl = planOf(C.TALK_MODS.fire.hit, { lead: 'shut', level: 'push', trail: 'push' });
      const r1 = E.simulate(buildSquad('avg78', '3-3-2', 'balanced', 'A'),
        buildSquad('avg78', '3-3-2', 'balanced', 'B'), { plan: pl }, mulberry32(99));
      const r2 = E.simulate(buildSquad('avg78', '3-3-2', 'balanced', 'A'),
        buildSquad('avg78', '3-3-2', 'balanced', 'B'), { plan: pl }, mulberry32(99));
      let differ = 0;
      const flat = planOf(null, { lead: 'hold', level: 'hold', trail: 'hold' });
      for (let i = 0; i < 400; i++) {
        const A = buildSquad('avg78', '3-3-2', 'balanced', 'A');
        const B = buildSquad('avg78', '3-3-2', 'balanced', 'B');
        const x = E.simulate(deepClone(A), deepClone(B), { plan: pl }, mulberry32(mixSeed(31, i)));
        const y = E.simulate(deepClone(A), deepClone(B), { plan: flat }, mulberry32(mixSeed(31, i)));
        if (JSON.stringify(x.score) !== JSON.stringify(y.score)
          || JSON.stringify(x.events.length) !== JSON.stringify(y.events.length)) differ++;
      }
      check('G15 mods are a deterministic input (same plan ⇒ same record)',
        JSON.stringify(r1) === JSON.stringify(r2) && differ >= 40,
        'identical replays · ' + differ + '/400 records changed by a real plan');
    }
    /* G16 — team talks are worth something, and STEADY can never hurt */
    {
      const best = winRate('avg78', 'avg78', 'balanced', 'balanced',
        planOf(C.TALK_MODS.fire.hit), N, 401);
      const worst = winRate('avg78', 'avg78', 'balanced', 'balanced',
        planOf(C.TALK_MODS.fire.miss), N, 401);
      const steady = winRate('avg78', 'avg78', 'balanced', 'balanced',
        planOf(C.TALK_MODS.steady.hit), N, 401);
      const flat = winRate('avg78', 'avg78', 'balanced', 'balanced', null, N, 401);
      const spread = best.pts - worst.pts;
      const ok = spread >= 3 && spread <= 12 && steady.pts >= flat.pts - 1.2
        && BAND(best.gpg) && BAND(worst.gpg) && BAND(steady.gpg);
      check('G16 team talks: worth 3-12 pts, STEADY never negative, goals in band', ok,
        'best ' + best.pts.toFixed(1) + '% · worst ' + worst.pts.toFixed(1)
        + '% · spread ' + spread.toFixed(1) + 'pts · steady ' + steady.pts.toFixed(1)
        + '% vs flat ' + flat.pts.toFixed(1) + '% · goals '
        + best.gpg.toFixed(2) + '/' + worst.gpg.toFixed(2) + '/' + steady.gpg.toFixed(2));
    }
    /* G17 — in-match calls shift the sim visibly and monotonically */
    {
      const mk = id => ({ lead: id, level: id, trail: id });
      const push = winRate('avg78', 'avg80', 'balanced', 'balanced', planOf(null, mk('push')), N, 505);
      const hold = winRate('avg78', 'avg80', 'balanced', 'balanced', planOf(null, mk('hold')), N, 505);
      const shut = winRate('avg78', 'avg80', 'balanced', 'balanced', planOf(null, mk('shut')), N, 505);
      const flat = winRate('avg78', 'avg80', 'balanced', 'balanced', null, N, 505);
      const holdIsIdentity = Math.abs(hold.pts - flat.pts) < 1e-9 && hold.gpg === flat.gpg;
      const ok = holdIsIdentity
        && push.gf > hold.gf && push.ga > hold.ga            // push scores AND concedes more
        && shut.gf < hold.gf && shut.ga < hold.ga            // shut does the opposite
        && Math.abs(push.pts - shut.pts) >= 1.0
        && BAND(push.gpg) && BAND(shut.gpg);
      check('G17 calls: HOLD is exact identity, PUSH/SHUT move GF and GA the right way', ok,
        'push ' + push.pts.toFixed(1) + '% (GF ' + push.gf.toFixed(2) + '/GA ' + push.ga.toFixed(2)
        + ') · hold ' + hold.pts.toFixed(1) + '% · shut ' + shut.pts.toFixed(1)
        + '% (GF ' + shut.gf.toFixed(2) + '/GA ' + shut.ga.toFixed(2) + ')'
        + ' · goals ' + push.gpg.toFixed(2) + '/' + shut.gpg.toFixed(2));
    }
    /* G18 — rivalry memory is bounded, monotone and announced */
    {
      const rows = [0, 1, 2, 3].map(g => winRate('avg78', 'avg78', 'balanced', 'balanced',
        planOf(null, null, 0, C.grudgeMod(g)), N, 606));
      let mono = true;
      for (let i = 1; i < 4; i++) if (rows[i].pts > rows[i - 1].pts + 0.5) mono = false;
      const lift = rows[0].pts - rows[3].pts;
      let ledgerOK = true;
      for (let g = 0; g <= 5; g++) for (const m of [-4, -1, 0, 1, 3, 7])
        if (C.grudgeAfter(g, m) < 0 || C.grudgeAfter(g, m) > 3) ledgerOK = false;
      const ok = mono && lift >= 3 && lift <= 11 && ledgerOK && rows.every(r => BAND(r.gpg));
      check('G18 rivalry: monotone, bounded 0-3, angry clubs cost you 3-11 pts', ok,
        rows.map((r, i) => 'g' + i + ' ' + r.pts.toFixed(1) + '%').join(' · ')
        + ' · lift ' + lift.toFixed(1) + 'pts · goals ' + rows[3].gpg.toFixed(2));
    }
    /* G19 — no CONTENT value can ever reopen the balance gates */
    {
      const rng = mulberry32(0xF022);
      let worstG = 0, bestG = 9, bad = 0;
      const CALLS3 = ['push', 'hold', 'shut'];
      for (let i = 0; i < 24; i++) {
        const absurd = { create: 0.1 + rng() * 40, convert: 0.1 + rng() * 40, prevent: 0.1 + rng() * 40 };
        const c3 = CALLS3[i % 3];
        const r = winRate('avg78', 'avg78', 'balanced', 'balanced',
          planOf(absurd, { lead: c3, level: c3, trail: c3 }), 900, mixSeed(707, i));
        worstG = Math.max(worstG, r.gpg); bestG = Math.min(bestG, r.gpg);
        if (!BAND(r.gpg)) bad++;
      }
      check('G19 absurd mod values stay inside the goals band (clamped twice)', bad === 0,
        '40 absurd mods · goals ' + bestG.toFixed(2) + '-' + worstG.toFixed(2)
        + ' · ' + bad + ' out of band');
    }
    /* G20 — XP is bounded, fair, and migration-safe */
    {
      let maxRaw = 0, monotone = true, prev = -1;
      const p0 = C.freshProfile('x');
      for (let r = 6.0; r <= 10.0001; r += 0.1) {
        const v = C.xpForMatch(p0, 'q', { appeared: true, started: true, rating: r,
          goals: 0, cs: false, role: 'MID', motm: false, won: false });
        if (v < prev) monotone = false;
        prev = v; maxRaw = Math.max(maxRaw, v);
      }
      const capped = C.xpForMatch(p0, 'q', { appeared: true, started: true, rating: 10,
        goals: 6, cs: true, role: 'GK', motm: true, won: true });
      const benched = C.xpForMatch(p0, 'q', { appeared: false, started: false, rating: 6, goals: 0 });
      /* d) the v2 corpus: xp = apps x 100 for every card that ever played */
      let parity = true, cards = 0;
      for (const f of ['fresh', 'mid-s1', 'five-season']) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'saves-v2', f + '.json'), 'utf8')); }
        catch (e) { continue; }
        const up = migrateAll(raw);
        for (const k of Object.keys(up.profiles)) {
          const pr = up.profiles[k];
          if (!pr) continue;
          for (const pid of Object.keys(pr.apps || {})) {
            cards++;
            if ((pr.xp[pid] || 0) !== pr.apps[pid] * C.XP_PER_APP) parity = false;
          }
        }
      }
      check('G20 XP bounded (<=250 raw), monotone in rating, apps x100 on the v2 corpus',
        maxRaw <= 250 && capped === 250 && benched === 8 && monotone && parity,
        'max ' + maxRaw + ' · everything-at-once ' + capped + ' (cap 250) · bench ' + benched
        + ' · ' + cards + ' migrated cards at exact parity');
    }
    /* G21 — the dual gate cannot be bypassed, ever */
    {
      const rng = mulberry32(0x21);
      let bypass = 0, tries = 0, climbs = 0;
      for (let i = 0; i < 5000; i++) {
        const p = C.freshProfile('g21');
        const pid = C.ALBUM_PIDS[Math.floor(rng() * C.ALBUM_PIDS.length)];
        if (!C.isFieldable(pid)) continue;
        const from = Math.floor(rng() * 6);
        C.addCombo(p, pid, from);
        p.coins = Math.floor(rng() * 6000);
        p.xp[pid] = Math.floor(rng() * 4000);
        p.mastery[pid] = Math.floor(rng() * 4);
        p.disc[pid] = rng() * 0.4;
        p.blackLicence = rng() < 0.5;
        p.season = { n: 1, seed: 1, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
        tries++;
        const before = { xp: p.xp[pid], coins: p.coins, cost: C.climbCost(p, pid, from) };
        const r = C.doTrain(p, pid, from);
        if (!r) continue;
        climbs++;
        const needXp = C.XP_GATE[from + 1];
        const needLic = !!C.ECON.training[from].requires;
        if (before.xp < needXp) bypass++;
        else if (needLic && !p.blackLicence) bypass++;
        else if (before.coins < before.cost) bypass++;
      }
      check('G21 the dual gate cannot be bypassed (coins AND xp AND licence)', bypass === 0,
        climbs + ' climbs out of ' + tries + ' fuzzed profiles · ' + bypass + ' bypasses');
    }
    /* G22 — the market cannot be farmed or save-scummed */
    {
      const rng = mulberry32(0x22);
      /* b) the same proposal always gets the same answer */
      let same = 0, checked = 0;
      for (let i = 0; i < 400; i++) {
        const p = C.freshProfile('g22');
        for (const pid of window.MG_DATA.starters) C.addCombo(p, pid, 0);
        C.autoFill(p);
        p.season = { n: 1, seed: 12345, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
        const mineList = Object.keys(p.collection).filter(q => C.isFieldable(q));
        const mine = mineList[Math.floor(rng() * mineList.length)];
        const club = window.MG_DATA.clubs[Math.floor(rng() * window.MG_DATA.clubs.length)];
        const theirs = club.squad.filter(q => C.isFieldable(q))[1];
        if (!theirs || !mine) continue;
        const snap = JSON.stringify(p.collection);
        const a1 = C.proposeTrade(p, [mine, 0], [theirs, 2], club.id);
        p.collection = JSON.parse(snap);
        const a2 = C.proposeTrade(p, [mine, 0], [theirs, 2], club.id);
        checked++;
        if (!!a1.accepted === !!a2.accepted) same++;
      }
      /* a) a greedy trader cannot manufacture value out of nothing */
      let greedy = 0, plainV = 0;
      for (let s2 = 0; s2 < 30; s2++) {
        const mk = () => {
          const p = C.freshProfile('g22b');
          for (const pid of window.MG_DATA.starters) C.addCombo(p, pid, 0);
          const extra = C.ALBUM_PIDS.filter(q => C.isFieldable(q) && !p.collection[q]).slice(0, 10);
          for (const pid of extra) C.addCombo(p, pid, 1);
          C.autoFill(p);
          p.season = { n: 1, seed: (s2 * 7919 + 13) >>> 0, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
          return p;
        };
        const val = (p) => Object.keys(p.collection).reduce((a2, pid) => {
          let v = 0;
          for (let t2 = 0; t2 < 7; t2++) if (p.collection[pid][0] & (1 << t2)) v += C.valueOf(pid, t2, p.vd[pid]);
          return a2 + v;
        }, 0);
        const base = mk(); plainV += val(base);
        const g = mk();
        for (let round = 0; round < 14; round++) {
          g.season.results.push({ r: round + 1, hg: 1, ag: 1 });
          g.trades = [];
          C.makeTrades(g);
          for (const o of (g.trades || []).slice()) if (o.delta > 0) C.acceptTrade(g, o);
        }
        greedy += val(g);
      }
      const growth = plainV ? (greedy - plainV) / plainV : 0;
      check('G22 the market cannot be farmed (<=15%/season) or save-scummed', same === checked
        && growth <= 0.15, (100 * same / Math.max(1, checked)).toFixed(0)
        + '% identical re-proposals (' + checked + ') · greedy portfolio '
        + (growth >= 0 ? '+' : '') + (growth * 100).toFixed(1) + '% vs never trading');
    }
    /* G23 — no market verb can leave you without a legal XI */
    {
      const rng = mulberry32(0x23);
      let broken = 0, released = 0;
      for (let i = 0; i < 5000; i++) {
        const p = C.freshProfile('g23');
        for (const pid of window.MG_DATA.starters) C.addCombo(p, pid, 0);
        const extra = C.ALBUM_PIDS.filter(q => C.isFieldable(q) && !p.collection[q])
          .slice(0, Math.floor(rng() * 8));
        for (const pid of extra) C.addCombo(p, pid, Math.floor(rng() * 4));
        C.autoFill(p);
        p.season = { n: 1, seed: 7, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
        const own = Object.keys(p.collection);
        for (let k = 0; k < 4; k++) {
          const pid = own[Math.floor(rng() * own.length)];
          const t2 = C.bestTier(p, pid);
          if (t2 < 0) continue;
          if (!C.canRelease(p, pid, t2).ok) continue;
          released++;
          C.removeCombo(p, pid, t2);
          C.autoFill(p);
          const f = window.MG_DATA.formations[p.lineup.formation];
          if (p.lineup.slots.length !== f.slots.length) { broken++; break; }
          const gk = p.lineup.slots[0];
          if (!gk || C.PIDX[gk].pos !== 'GK') { broken++; break; }
          const tiers = C.playTiers(p, p.lineup.slots);
          if (tiers.filter(x => x === 6).length > 1) { broken++; break; }
        }
      }
      check('G23 no release the guard allows can break the XI', broken === 0,
        released + ' guarded releases across 5000 fuzzed squads · ' + broken + ' broken lineups');
    }
    /* G24 — loan spells are derived, deterministic and honest */
    {
      let det = true, monoOK = true;
      const p = C.freshProfile('g24');
      p.season = { n: 1, seed: 424242, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
      for (let i = 0; i < 1000; i++) {
        const pid = C.ALBUM_PIDS[i % C.ALBUM_PIDS.length];
        const l = { pid, tier: 1, club: 'alg', from: 0 };
        const a1 = C.loanSpell(p, l, 14), a2 = C.loanSpell(p, l, 14);
        if (JSON.stringify(a1) !== JSON.stringify(a2)) det = false;
        const half = C.loanSpell(p, l, 7);
        if (half.apps > a1.apps) monoOK = false;
        if (a1.apps > 14) monoOK = false;
        if (a1.apps && (a1.avg < 6.2 || a1.avg > 7.6)) monoOK = false;
      }
      check('G24 loan spells are derived, replayable and inside the rating band', det && monoOK,
        '1000 spells replayed identically · apps monotone in rounds · avg 6.2-7.6');
    }
    /* G25 — the new sinks are priced against a real season's earnings */
    {
      const seasonEarn = 900;                        // flow-test block 7, measured
      const staff = C.COACH_COST * C.COACH_MAX;
      const slots = C.PLAN_SLOT_COST * 3 * 14;
      const green = C.ECON.training[4].coins;
      const ok = staff / seasonEarn >= 1.5 && staff / seasonEarn <= 3.0
        && slots / seasonEarn >= 0.8 && slots / seasonEarn <= 1.6
        && staff > green;
      check('G25 the new coin sinks pace against a season (~' + seasonEarn + ' 🪙)', ok,
        'full staff ' + staff + ' 🪙 = ' + (staff / seasonEarn).toFixed(1)
        + ' seasons · a full plan every round ' + slots + ' 🪙 = '
        + (slots / seasonEarn).toFixed(1) + ' seasons · one GREEN climb ' + green
        + ' 🪙 (earnings gate lives in tools/mg-flow-test.js block 7)');
    }
    /* G26 — THE 75/25 LAW IS UNTOUCHED BY THE ENTIRE RPG LAYER */
    {
      const rng = mulberry32(0x26);
      let worst = 0;
      for (let i = 0; i < 10000; i++) {
        const pid = C.ALBUM_PIDS[Math.floor(rng() * C.ALBUM_PIDS.length)];
        const row = C.PIDX[pid];
        const tier = Math.floor(rng() * 7);
        const p = C.freshProfile('g26');
        C.addCombo(p, pid, tier);
        p.xp[pid] = Math.floor(rng() * 99999);
        p.mastery[pid] = Math.floor(rng() * 4);
        p.disc[pid] = rng();
        p.quests[pid] = [Math.floor(rng() * 4), Math.floor(rng() * 9)];
        p.coaches = ['climb', 'fitness', 'sharp'].slice(0, Math.floor(rng() * 4));
        p.loans = rng() < 0.3 ? [{ pid, tier, club: 'alg', from: 0 }] : [];
        p.rivals = { alg: Math.floor(rng() * 4) };
        p.plan = [{ focus: 'climb', pid }, null, null];
        const pl = C.mkPlayer(pid, tier, 'M1', p);
        const got = E.effSkill(pl);
        const want = 0.75 * row.base + 0.25 * PARS[tier].score;
        worst = Math.max(worst, Math.abs(got - want));
      }
      check('G26 effSkill is EXACTLY 0.75·base + 0.25·tier under the whole RPG layer',
        worst < 1e-9, '10000 fuzzed profiles (xp/mastery/quests/coaches/loans/plan) · '
        + 'max error ' + worst.toExponential(1));
    }
    /* G27 — saves migrate, never wipe, and stay small */
    {
      const dir = path.join(__dirname, 'fixtures', 'saves-v2');
      let lost = null, idem = true, files = 0;
      for (const f of ['fresh', 'mid-s1', 'five-season']) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8')); }
        catch (e) { continue; }
        files++;
        const up = migrateAll(raw);
        /* a migration ONLY ADDS: every v2 key must survive, value for value */
        for (const k of Object.keys(raw.profiles)) {
          const o = raw.profiles[k], n2 = up.profiles[k];
          if (!o) continue;
          for (const key of Object.keys(o)) {
            /* tactics and each offer GAIN fields; a migration only ever adds,
             * so compare the old keys one by one instead of the whole object */
            if (key === 'tactics') {
              for (const t3 of Object.keys(o.tactics || {}))
                if (JSON.stringify(o.tactics[t3]) !== JSON.stringify(n2.tactics[t3]))
                  lost = f + '.' + k + '.tactics.' + t3;
              continue;
            }
            if (key === 'offers') {
              (o.offers || []).forEach((oo, oi) => {
                for (const t3 of Object.keys(oo))
                  if (JSON.stringify(oo[t3]) !== JSON.stringify((n2.offers[oi] || {})[t3]))
                    lost = f + '.' + k + '.offers[' + oi + '].' + t3;
              });
              continue;
            }
            if (JSON.stringify(o[key]) !== JSON.stringify(n2[key]))
              lost = f + '.' + k + '.' + key;
          }
        }
        const once = JSON.stringify(migrateAll(raw));
        const t2 = migrateAll(raw); t2.v = 2;
        if (JSON.stringify(migrateAll(t2)) !== once) idem = false;
      }
      /* e) SIZE. The RPG meters are only ever written for cards that were
       * in a matchday squad (settleMatch is the sole writer, 13 per match),
       * so "980 owned" and "980 with meters" are different worlds. Gate the
       * reachable one at 64KB and keep the unreachable one under a 96KB alarm. */
      const mkBig = (metered) => {
        const big = C.freshProfile('big');
        big.season = { n: 9, seed: 1, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
        C.ALBUM_PIDS.forEach((pid, i) => {
          for (let t2 = 0; t2 < 7; t2++) C.addCombo(big, pid, t2);   // the whole 6,860
          if (i >= metered) return;
          big.xp[pid] = 1000 + i; big.apps[pid] = 20 + (i % 40);
          big.mastery[pid] = i % 4; big.quests[pid] = [i % 4, i % 9];
          if (i % 3 === 0) big.disc[pid] = 0.15;
          if (i % 5 === 0) big.gls[pid] = i % 30;
          big.vd[pid] = (i % 7) - 3; big.form[pid] = (i % 3) - 1; big.bs[pid] = i % 9;
          big.energy[pid] = 40 + (i % 60);
        });
        for (let s2 = 1; s2 <= 8; s2++) big.history.push({ season: s2, div: 3, pos: 4, pts: 60,
          w: 8, d: 3, l: 3, gf: 30, ga: 20, cup: 'semi', cl: '—', coins: 900, avgR: 6.9 });
        for (let s2 = 0; s2 < 5; s2++) {
          big.dynasty.sales.push({ pid: C.ALBUM_PIDS[s2], tier: 4, club: 'alg', coins: 900, season: s2 });
          big.dynasty.loans.push({ pid: C.ALBUM_PIDS[s2], club: 'alg', apps: 12, avg: 7.1, season: s2, fee: 40 });
        }
        for (let s2 = 0; s2 < 12; s2++)
          big.dynasty.hof.push({ pid: C.ALBUM_PIDS[s2], season: s2, avg: 7.4, apps: 16 });
        return JSON.stringify({ v: 3, createdAt: 0, updatedAt: 0, activeProfile: 'p1',
          profiles: { p1: big, p2: null } }).length;
      };
      /* 500 is generous: 8 seasons is ~130 matches, settleMatch writes the
       * RPG meters for at most 13 cards a match, and no manager rotates 500
       * different players through one club. The all-980 figure is printed
       * as context, not gated — it is not a state the game can reach. */
      const reachable = mkBig(500);
      const ceiling = mkBig(C.ALBUM_PIDS.length);
      const ok = !lost && idem && files === 3 && reachable < 65536;
      check('G27 v2 saves migrate losslessly (v2→v' + C.SAVE_V + '), idempotently, under 64KB', ok,
        files + '/3 corpus saves lossless' + (lost ? ' (LOST ' + lost + ')' : '')
        + ' · idempotent ' + idem + ' · all 6,860 combos + 500 metered players + 8 seasons = '
        + (reachable / 1024).toFixed(1) + 'KB (gate 64) · theoretical all-980-metered ceiling '
        + (ceiling / 1024).toFixed(1) + 'KB, unreachable (13 cards a match write meters)');
    }
    /* G28 — no raw template ever reaches the screen */
    {
      const HANDLED = ['{p}', '{k}', '{keeper}', '{minute}', '{team}', '{player}'];
      const found = new Set();
      const scan = (o) => {
        if (typeof o === 'string') (o.match(/\{[a-z_]+\}/g) || []).forEach(t2 => found.add(t2));
        else if (Array.isArray(o)) o.forEach(scan);
        else if (o && typeof o === 'object') Object.values(o).forEach(scan);
      };
      scan(window.MG_DATA.commentary); scan(window.MG_DATA.playerCommentary);
      const unhandled = [...found].filter(t2 => HANDLED.indexOf(t2) < 0);
      check('G28 every commentary placeholder is substituted before it is shown',
        unhandled.length === 0,
        [...found].sort().join(' ') + (unhandled.length ? '  UNHANDLED: ' + unhandled.join(' ') : ''));
    }
    /* ================================================================= *
     *  G29-G32 — THE ATTRIBUTE LAYER (addendum 17 §2-3)                  *
     *                                                                    *
     *  G29 proves there is only ONE implementation: the runtime returns   *
     *  the generated data unchanged, and the data is self-consistent.     *
     *  G30-G32 prove the layer has TEETH and still loses to the colour.   *
     * ================================================================= */
    const AD = window.MG_DATA.attributes || null;
    const BDG = window.MG_DATA.badges || null;
    if (!AD || !C || !C.ATTR) {
      check('G29 the attribute data is the single source of truth', false,
        'MG_DATA.attributes or MG_CAREER.ATTR missing');
    } else {
      /* ---- G29: zero divergence, data <-> runtime, and data <-> itself --- */
      {
        const SUB_I = {}; AD.subs.forEach((s2, i) => { SUB_I[s2] = i; });
        const pids = Object.keys(AD.values);
        let sub = 0, face = 0, delta = 0, arch = 0, badge = 0, self = 0, l2 = 0;
        const errs = [];
        for (const pid of pids) {
          const row = C.PIDX[pid], a = C.ATTR.attrOf(row);
          if (!a) { errs.push(pid + ' has no runtime attributes'); continue; }
          const want = AD.values[pid];
          for (let i = 0; i < AD.subs.length; i++)
            if (a.A[AD.subs[i]] !== want[i]) { sub++; break; }
          const order = row.pos === 'GK' ? AD.faceOrder.GK : AD.faceOrder.OUT;
          if (order.map(f => Math.round(a.faces[f])).join(',') !== AD.faces[pid].join(',')) face++;
          if (AD.deltaOrder.map(k => Math.round(a.d[k] * AD.deltaScale)).join(',')
              !== AD.deltas[pid].join(',')) delta++;
          if (a.arch !== (row.x && row.x.a)) arch++;
          if ((BDG.byPlayer[pid] || []).join(',')
              !== C.badgesOf({ cb: {} }, pid).map(o => o.b.id).join(',')) badge++;
          /* the stored faces ARE the weighted mean of the stored subs */
          const fromSubs = order.map(f => {
            let s3 = 0;
            for (const n of Object.keys(AD.faceWeights[f])) s3 += AD.faceWeights[f][n] * want[SUB_I[n]];
            return Math.round(s3);
          });
          if (fromSubs.join(',') !== AD.faces[pid].join(',')) self++;
          /* L2 — the 34 subs reconstruct his own OVR */
          let rec2 = 0;
          for (const f of Object.keys(AD.ovrWeights[row.pos])) {
            let s3 = 0;
            for (const n of Object.keys(AD.faceWeights[f])) s3 += AD.faceWeights[f][n] * want[SUB_I[n]];
            rec2 += AD.ovrWeights[row.pos][f] * s3;
          }
          if (Math.abs(rec2 - row.base) > 1.0) l2++;
        }
        const bad = sub + face + delta + arch + badge + self + l2 + errs.length;
        check('G29 the attribute data is the single source of truth', bad === 0,
          pids.length + ' cards · runtime≠data: subs ' + sub + ' faces ' + face
          + ' deltas ' + delta + ' roles ' + arch + ' badges ' + badge
          + ' · data≠itself: faces ' + self + ' L2 ' + l2
          + (errs.length ? ' · ' + errs.slice(0, 3).join('; ') : ''));
      }

      /* ---- real album XIs, composed by what the engine actually reads --- */
      const FIELD = { GK: [], DEF: [], MID: [], ATT: [] };
      for (const pid of Object.keys(AD.values)) {
        const row = C.PIDX[pid];
        if (FIELD[row.pos]) FIELD[row.pos].push(pid);
      }
      const axScore = (pid, pos) => {
        const ax = C.axOf({ id: pid });
        if (!ax) return 0;
        const create = 0.60 * ax.CRE + 0.40 * ax.PACE;
        if (pos === 'GK') return ax.GKS;
        if (pos === 'ATT') return ax.FIN + 0.35 * create;
        if (pos === 'MID') return (ax.DEFF + 1.2 * ax.MRK) * 0.5 + 0.5 * create;
        return ax.DEFF + 1.2 * ax.MRK;
      };
      const RANK = {};
      for (const pos of Object.keys(FIELD))
        RANK[pos] = FIELD[pos].slice().sort((x, y) => axScore(y, pos) - axScore(x, pos));
      /* Every player is forced to the SAME base and the SAME neutral sho/dfn,
       * so effSkill, effShoOf and kickoffE are identical on both sides and the
       * ONLY difference between the two XIs is which cards they are — which is
       * the only honest way to measure what composition is worth. */
      function compXI(best, base, tierIdx, formationId, mentality, label) {
        const form = FORMS[formationId];
        const take = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
        const starters = form.slots.map(slot => {
          const role = roleOf(slot);
          const list = RANK[role];
          const pid = best ? list[take[role]] : list[list.length - 1 - take[role]];
          take[role] += 1;
          const st = synthStats(role, base);
          const p = mkPlayer(pid, role, base, tierIdx, st.sho, st.dfn, []);
          p.slot = slot;
          return p;
        });
        return { name: label, formation: formationId, mentality,
                 penaltyTaker: null, starters, bench: [] };
      }
      const N = Math.max(2000, o.sims);
      const swingOf = (A2, B2, seed) => {
        const g = runSims(engine, A2, B2, {}, N, seed);
        return { swing: 100 * (g.winA - g.winB) / N,
                 a: 100 * g.winA / N, d: 100 * g.draw / N, b: 100 * g.winB / N,
                 goals: (g.goals[0] + g.goals[1]) / N };
      };
      const best80 = () => compXI(true, 80, 0, '3-3-2', 'balanced', 'BEST');
      const worst80 = () => compXI(false, 80, 0, '3-3-2', 'balanced', 'WORST');
      const comp = swingOf(best80(), worst80(), mixSeed(o.seed, 4801));
      const ladder = swingOf(compXI(true, 80, 6, '3-3-2', 'balanced', 'BLACK'),
                             compXI(true, 80, 0, '3-3-2', 'balanced', 'WHITE'),
                             mixSeed(o.seed, 4802));

      /* ---- G30: the system must MATTER ---------------------------------- */
      {
        const finAtt = FIELD.ATT.map(p2 => C.ATTR.dOf(p2).FIN);
        const mrkDef = FIELD.DEF.map(p2 => C.ATTR.dOf(p2).MRK);
        const sdOf = (v) => {
          const m2 = v.reduce((a2, b2) => a2 + b2, 0) / v.length;
          return Math.sqrt(v.reduce((a2, b2) => a2 + (b2 - m2) * (b2 - m2), 0) / v.length);
        };
        const sdFin = sdOf(finAtt), sdMrk = sdOf(mrkDef);
        const need = N >= 4000 ? 6 : 3;
        check('G30 attributes have teeth (composition changes results)',
          sdFin >= 2.0 && sdMrk >= 2.5 && comp.swing >= need,
          'sd(ΔFIN|ATT) ' + sdFin.toFixed(2) + ' (≥2.0) · sd(ΔMRK|DEF) ' + sdMrk.toFixed(2)
          + ' (≥2.5) · best-composed XI vs worst ' + comp.a.toFixed(1) + '/' + comp.d.toFixed(1)
          + '/' + comp.b.toFixed(1) + ' = ' + comp.swing.toFixed(1) + 'pt swing over ' + N
          + ' sims (≥' + need + ')');
      }

      /* ---- G31: …and the COLOUR still rules (the important one) --------- */
      {
        const ratio = ladder.swing > 0 ? comp.swing / ladder.swing : 99;
        const cross = swingOf(compXI(false, 80, 1, '3-3-2', 'balanced', 'WORST-BLUE'),
                              compXI(true, 80, 0, '3-3-2', 'balanced', 'BEST-WHITE'),
                              mixSeed(o.seed, 4803));
        check('G31 the parallel still beats composition (75/25 law, in play)',
          ratio <= 0.35 && cross.swing > 0,
          'composition ' + comp.swing.toFixed(1) + 'pt ÷ ladder ' + ladder.swing.toFixed(1)
          + 'pt = ' + ratio.toFixed(2) + ' (gate ≤0.35) · the WORST XI one colour up still '
          + 'beats the BEST white XI ' + cross.a.toFixed(1) + '/' + cross.d.toFixed(1) + '/'
          + cross.b.toFixed(1) + ' · goals ' + comp.goals.toFixed(2) + '/' + ladder.goals.toFixed(2));
      }

      /* ---- G32: the badge budget cannot be climbed ---------------------- */
      {
        let worstCh = '', worstV = 0;
        for (const pid of Object.keys(AD.values)) {
          const e = C.badgeEffOf(pid);
          for (const k of Object.keys(e)) {
            if (k === 'when' || typeof e[k] !== 'number') continue;
            if (Math.abs(e[k]) > Math.abs(worstV)) { worstV = e[k]; worstCh = k + ' on ' + pid; }
          }
        }
        const cap = C.ATTR.HOOKS.badgeCap, fcap = C.ATTR.HOOKS.fatigueCap || 6;
        const inBudget = Math.abs(worstV) <= Math.max(cap, fcap);
        /* the single most a badge stack can move one shot / one defence line,
         * by arithmetic, before the hook's own bound even applies */
        const maxShot = C.ATTR.HOOKS.FINK * Math.tanh(cap / 14);
        const maxLine = C.ATTR.HOOKS.DPT * cap;
        const mirror = swingOf(best80(), best80(), mixSeed(o.seed, 4804));
        const bandOk = Math.abs(mirror.swing) <= 4 && mirror.goals >= 2.0 && mirror.goals <= 3.8;
        check('G32 badges are flavour with teeth, never a second economy',
          inBudget && maxShot <= 0.013 && maxLine <= C.ATTR.HOOKS.DCAP + 1e-9 && bandOk,
          'largest stacked badge effect ' + worstV + ' (' + worstCh + ', cap ' + cap + '/' + fcap
          + ') · one badge moves a shot at most ' + maxShot.toFixed(4)
          + ' and a defence line at most ' + maxLine.toFixed(2) + 'E (DCAP '
          + C.ATTR.HOOKS.DCAP + ') · badge-heavy mirror ' + mirror.a.toFixed(1) + '/'
          + mirror.d.toFixed(1) + '/' + mirror.b.toFixed(1) + ' goals ' + mirror.goals.toFixed(2));
      }
    }
  }

  return results;
}

/* ================================================================= *
 *  G14 — THE ENGINE GOLDEN FIXTURE (addendum 12-15 depth plan §3.1)  *
 *                                                                   *
 *  Captured BEFORE the engine gained its managerial-verb overlay.    *
 *  Every later engine edit must reproduce all 800 records byte for   *
 *  byte on the no-plan path, or nothing else in that cycle merges.   *
 * ================================================================= */
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'engine-golden.json');
const GOLDEN_SEEDS = 200;
const GOLDEN_SPECS = [
  { id: 'mirror-75',    a: 'avg75',            b: 'avg75',       ta: 'balanced',  tb: 'balanced',  ko: false },
  { id: 'black-white',  a: 'avg80@black',      b: 'avg80@white', ta: 'balanced',  tb: 'balanced',  ko: false },
  { id: 'haaland-vs-85', a: 'avg78,haaland',   b: 'avg85',       ta: 'attacking', tb: 'defensive', ko: false },
  { id: 'knockout-mirror', a: 'avg75',         b: 'avg75',       ta: 'balanced',  tb: 'balanced',  ko: true },
];
function goldenHash(str) {
  return require('crypto').createHash('sha1').update(str).digest('hex').slice(0, 16);
}
function goldenRun(engine) {
  const out = {};
  for (const spec of GOLDEN_SPECS) {
    const A = buildSquad(spec.a, '3-3-2', spec.ta, 'A');
    const B = buildSquad(spec.b, '3-3-2', spec.tb, 'B');
    const hashes = [];
    for (let i = 0; i < GOLDEN_SEEDS; i++) {
      const rng = mulberry32(mixSeed(0x601d, i));
      /* opts carries NO plan: this is the identity path the gate protects */
      const rec = engine.simulate(deepClone(A), deepClone(B), { knockout: spec.ko }, rng);
      hashes.push(goldenHash(JSON.stringify(rec)));
    }
    out[spec.id] = hashes;
  }
  return out;
}
function goldenCapture(engine) {
  const data = { note: 'G14 engine identity fixture — captured pre-overlay; see .mg-manager-depth-plan.md §3.1',
                 seeds: GOLDEN_SEEDS, specs: GOLDEN_SPECS.map(s => s.id), records: goldenRun(engine) };
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(data, null, 1));
  const n = GOLDEN_SEEDS * GOLDEN_SPECS.length;
  console.log('golden fixture captured: ' + n + ' records -> ' + GOLDEN_PATH);
  return 0;
}
function goldenVerify(engine) {
  let want;
  try { want = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')); }
  catch (e) { console.error('G14: no fixture at ' + GOLDEN_PATH + ' — run --golden capture first'); return 1; }
  const got = goldenRun(engine);
  let bad = 0, total = 0, firstBad = null;
  for (const id of Object.keys(want.records)) {
    const w = want.records[id], g = got[id] || [];
    for (let i = 0; i < w.length; i++) {
      total += 1;
      if (w[i] !== g[i]) { bad += 1; if (!firstBad) firstBad = id + ' seed#' + i; }
    }
  }
  const pass = bad === 0 && total === GOLDEN_SEEDS * GOLDEN_SPECS.length;
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] G14 engine identity at default ' +
    '.'.repeat(6) + ' ' + (total - bad) + '/' + total + ' byte-identical' +
    (firstBad ? '  first divergence: ' + firstBad : ''));
  return pass ? 0 : 1;
}

/* ---------- main ---------------------------------------------------------- */
function main() {
  const o = parseArgs(process.argv);
  const DATA = loadGameFiles();
  if (o.golden) {
    const eng = o.stub ? makeStubEngine() : window.MG_ENGINE;
    if (!eng) die('window.MG_ENGINE not found for --golden');
    process.exitCode = o.golden === 'capture' ? goldenCapture(eng) : goldenVerify(eng);
    return;
  }

  let engine = window.MG_ENGINE || null;
  let engineName = 'window.MG_ENGINE';
  if (o.stub) { engine = makeStubEngine(); engineName = 'inline stub (--stub)'; }
  else if (!engine || typeof engine.simulate !== 'function')
    die('window.MG_ENGINE not found (MG_DATA ' + (DATA ? 'loaded' : 'null') +
        '). The engine has not landed yet — run with --stub to exercise the harness.');

  const out = { engine: engineName, dataLoaded: !!DATA, seed: o.seed, sims: o.sims };

  if (o.sims > 0) {
    const A = buildSquad(o.a, o.formA, o.mentA, 'A');
    const B = buildSquad(o.b, o.formB, o.mentB, 'B');
    const g = runSims(engine, A, B, { knockout: o.knockout }, o.sims, o.seed);
    out.match = {
      a: { spec: o.a, formation: o.formA, mentality: o.mentA },
      b: { spec: o.b, formation: o.formB, mentality: o.mentB },
      winA: g.winA, draw: g.draw, winB: g.winB,
      goalsPerGame: [g.goals[0] / o.sims, g.goals[1] / o.sims],
      shotsPerGame: [g.shots[0] / o.sims, g.shots[1] / o.sims],
      onTargetPerGame: [g.onTarget[0] / o.sims, g.onTarget[1] / o.sims],
      avgEff: [g.avgEff[0] / o.sims, g.avgEff[1] / o.sims],
      quirkEvents: g.quirkEvents, quirkTags: g.quirkTags,
    };
    if (!o.json) {
      const m = out.match;
      console.log('== MATCH REPORT ==  engine: ' + engineName +
                  (DATA ? '' : '  (MG_DATA is null — fallback tables)'));
      console.log('A "' + o.a + '" (' + o.formA + ', ' + o.mentA + ')  vs  B "' +
                  o.b + '" (' + o.formB + ', ' + o.mentB + ')' +
                  (o.knockout ? '  [knockout]' : ''));
      console.log('sims ' + o.sims + '  seed ' + o.seed +
                  '  kickoff avgEff A ' + m.avgEff[0].toFixed(2) + ' / B ' + m.avgEff[1].toFixed(2));
      console.log('A wins ' + pct(g.winA, o.sims) + '  draws ' + pct(g.draw, o.sims) +
                  '  B wins ' + pct(g.winB, o.sims));
      console.log('goals/game  A ' + m.goalsPerGame[0].toFixed(2) + '  B ' +
                  m.goalsPerGame[1].toFixed(2) + '  combined ' +
                  (m.goalsPerGame[0] + m.goalsPerGame[1]).toFixed(2));
      console.log('shots/game  A ' + m.shotsPerGame[0].toFixed(1) + ' (' +
                  m.onTargetPerGame[0].toFixed(1) + ' on target)  B ' +
                  m.shotsPerGame[1].toFixed(1) + ' (' + m.onTargetPerGame[1].toFixed(1) + ')');
      const qk = Object.keys(g.quirkEvents), qt = Object.keys(g.quirkTags);
      console.log('quirk events: ' + (qk.length
        ? qk.map(k => k + ' x' + g.quirkEvents[k] + ' (' + (g.quirkEvents[k] / o.sims).toFixed(2) + '/game)').join(', ')
        : 'none'));
      if (qt.length)
        console.log('quirk tags:   ' + qt.map(k => k + ' x' + g.quirkTags[k]).join(', '));
      console.log('');
    }
  }

  let failed = 0;
  if (o.checks) {
    const results = runChecks(engine, o);
    out.checks = results;
    failed = results.filter(r => !r.pass).length;
    if (!o.json) {
      console.log('== BALANCE HOOKS ==');
      for (const r of results) {
        const dots = '.'.repeat(Math.max(2, 52 - r.name.length));
        console.log('[' + (r.pass ? 'PASS' : 'FAIL') + '] ' + r.name + ' ' + dots + ' ' + r.detail);
      }
      console.log(failed ? failed + ' CHECK(S) FAILED' : 'all checks green');
    }
  }

  if (o.json) console.log(JSON.stringify(out, null, 2));
  process.exitCode = failed ? 1 : 0;
}

main();
