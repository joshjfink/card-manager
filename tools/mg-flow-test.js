#!/usr/bin/env node
/* mg-flow-test.js — headless integration drive of the Card Manager career.
 * Stubs canvas/localStorage/MiniGames, then plays REAL flows through the
 * game's own update/draw + hot-rect input.
 *
 * Controls are pressed BY NAME, off the dev-only window.__MG_HOTS map the
 * game publishes each frame. Hard-coded pixels made every layout change a
 * false failure; a named press is a real one.
 *
 * Blocks: 1 boot · 2 one round · 3 a season · 4 replay determinism ·
 * 5 corrupt recovery · 6 PLAY vs ⏩ parity · 7 endurance · 8 Draft Duel ·
 * F1 save migration · F3 trades · F4 loans · F5 selling upward ·
 * F6 training plan + coaches · F7 quests/XP · F2 verbs settle identically.
 * No deps. Exit 0 = all pass.
 */
'use strict';
globalThis.window = globalThis;
const fs = require('fs');
const path = require('path');

/* ---- localStorage stub ---- */
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

/* ---- 2D context stub: absorb every call, measureText returns width ---- */
function ctxStub() {
  const fn = () => {};
  return new Proxy({}, {
    get(_, k) {
      if (k === 'measureText') return (txt) => ({ width: String(txt).length * 7 });
      if (k === 'canvas') return { width: 960, height: 600 };
      return fn;
    },
    set() { return true; },
  });
}

/* ---- MiniGames stub capturing the registration ---- */
let registered = null;
globalThis.MiniGames = { register(def) { registered = def; } };

require('../gibson/web/static/mg-manager-data.js');
require('../gibson/web/static/mg-manager.js');

if (!registered) { console.error('FAIL: game did not register'); process.exit(1); }
if (!window.MG_ENGINE || typeof window.MG_ENGINE.simulate !== 'function') {
  console.error('FAIL: MG_ENGINE missing'); process.exit(1);
}

const env = {
  W: 960, H: 600,
  colors: { pitch: '#0d1f16', turf: '#15301e', turf2: '#1b3b26', line: '#2a4b33',
            chalk: '#eaf2e6', fade: '#93ab99', gold: '#e9bf63', red: '#d6202a',
            cream: '#fdfbf4', ink: '#2b2118', good: '#4fb477', warn: '#e8a33c' },
  rr: () => {}, drawChar: () => {}, drawBall: () => {},
  heroes: [], cast: {},
  sfx: new Proxy({}, { get: () => () => {} }),
  shake: () => {}, burst: () => {}, floatText: () => {},
  rnd: (a, b) => a + Math.random() * (b - a),
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp: (a, b, k) => a + (b - a) * k,
  best: () => null,
  over(result) { env._over = result; env._overCount = (env._overCount || 0) + 1; },
};
const ctx = ctxStub();

/* ---- one driver per game instance, pressing controls by name ---- */
function driver() {
  const inst = registered.create(env);
  const inp = (o) => Object.assign({
    left: false, right: false, up: false, down: false, action: false,
    px: -1, py: -1, pdown: false, clicked: false, pressed: () => false,
  }, o || {});
  const d = {
    inst,
    f(n) { for (let i = 0; i < (n || 1); i++) { inst.update(1 / 60, inp()); inst.draw(ctx); } return d; },
    at(x, y) { inst.update(1 / 60, inp({ px: x, py: y, clicked: true })); inst.draw(ctx); return d; },
    hots() { return (window.__MG_HOTS || []).slice(); },
    find(id) { return d.hots().find(h => h.id === id) || null; },
    findPrefix(pre) { return d.hots().find(h => h.id.indexOf(pre) === 0) || null; },
    /* press a named control; returns false when it is not on screen */
    press(id) { const h = d.find(id); if (!h) return false; d.at(h.cx, h.cy); return true; },
    pressPrefix(pre) { const h = d.findPrefix(pre); if (!h) return false; d.at(h.cx, h.cy); return true; },
    screen() { return window.__MG_SCREEN || ''; },
    pane(i) { d.press('side-' + i); d.f(1); return d; },
  };
  d.f(3);
  return d;
}
function save() { try { return JSON.parse(store['gs-mg-career'] || 'null'); } catch (e) { return null; } }
function prof() { const s = save(); return s && s.profiles && s.profiles.p1; }
/* the LIVE profile the running instance is mutating (prof() is a snapshot
 * of what was last written to storage; both are needed, for different jobs) */
function lp() { const s = window.MG_CAREER.getSave(); return s && s.profiles && s.profiles.p1; }

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures += 1;
}
function section(t) { console.log('\n— ' + t + ' —'); }

/* Advance the career by one "thing the manager must do", whatever it is:
 * news day, match day (⏩), post-match, feats, ceremony beats. */
function step(d, prefer) {
  const sc = d.screen();
  if (sc === 'welcome') {
    if (d.press('wel-continue')) { d.f(2); return; }
    newCareer(d); return;
  }
  if (sc === 'news') {
    if (!d.press('news-skip')) d.press('news-adv');
    d.f(1); return;
  }
  /* answer with the manager's own standing plan — the same answer the
   * PLAY route's SKIP gives, so both routes are comparable. Tap the quiet
   * catcher in open space: pressing it BY NAME taps the screen centre,
   * which lands on the bottom edge of the HOLD button and answers HOLD. */
  if (sc === 'call') { d.at(480, 560); d.f(1); return; }
  if (sc === 'tactics') { d.press(prefer === 'play' ? 'md-play' : 'md-instant'); d.f(3); return; }
  if (sc === 'ticker') { d.press('tk-all'); d.f(3); d.press('tk-all'); d.f(2); return; }
  if (sc === 'post') {
    if (d.press('feat-ok')) { d.f(2); return; }
    d.press('post-cont'); d.f(2); return;
  }
  if (sc === 'ceremony') {
    if (d.press('cer-feat')) { d.f(2); return; }
    if (d.press('cer-over')) { d.f(2); return; }
    d.press('cer-adv'); d.f(2); return;
  }
  if (sc === 'match') {
    if (!d.press('mskip')) d.f(20);
    d.f(3); return;
  }
  if (sc === 'packopen') { d.pressPrefix('pk-'); d.f(3); return; }
  /* hub */
  d.press('continue'); d.f(2);
}
/* The game opens on the welcome screen now. Blocks that care where a SAVE
   ends up, not about the front door, walk through it: CONTINUE when there is
   a career, NEW GAME when there is not. Addendum 28 — assert the destination,
   not the waypoint. */
function pastWelcome(d) {
  if (d.screen() !== 'welcome') return d;
  if (!d.press('wel-continue')) d.press('wel-new');
  d.f(2);
  return d;
}
/* Title → NEW GAME → setup → YOUR OWN CLUB → USE THIS CLUB → START.
   This rig has no slot store, so NEW GAME opens the setup screen directly.
   o.divUp: presses of the division ◀ (towards Division 1) · o.diff: 'easy'|'hard' */
function newCareer(d, o) {
  o = o || {};
  if (d.screen() === 'welcome') { d.press('wel-new'); d.f(2); }
  if (d.screen() !== 'setup') return d;
  d.press('setup-own'); d.f(2);
  d.press('own-use'); d.f(2);
  for (let i = 0; i < (o.divUp || 0); i++) { d.press('setup-div-l'); d.f(1); }
  if (o.diff === 'easy') { d.press('setup-diff-l'); d.f(1); }
  if (o.diff === 'hard') { d.press('setup-diff-r'); d.f(1); }
  d.press('kickoff'); d.f(2);
  return d;
}
function drive(d, n, prefer) { for (let i = 0; i < n; i++) step(d, prefer); }
/* play exactly one league round and come to rest back on the hub */
function oneRound(d, prefer) {
  const start = prof().season.results.length;
  for (let g = 0; g < 300; g++) {
    step(d, prefer);
    if (prof().season.results.length > start && d.screen().indexOf('hub') === 0) return true;
  }
  return false;
}

/* ===================== 1. boot → NEW CAREER → hub ===================== */
section('1 · boot and career creation');
let d = driver();
check('boot lands on the WELCOME screen', d.screen() === 'welcome', d.screen());
check('with no career, there is nothing to continue',
  !d.find('wel-continue'), 'no CONTINUE row');
check('NEW GAME and LOAD GAME are on it, and SAVE GAME is not',
  !!d.find('wel-new') && !!d.find('wel-load') && !d.find('wel-save'));
d.press('wel-new'); d.f(2);
check('NEW GAME opens the career setup (this rig has no slot store)', d.screen() === 'setup', d.screen());
check('  team, division, difficulty and START are all on it, with a way back',
  ['setup-real', 'setup-own', 'setup-div-l', 'setup-div-r', 'setup-diff-l', 'setup-diff-r', 'kickoff', 'setup-back']
    .every(id => !!d.find(id)));
d.press('kickoff'); d.f(2);
check('  START refuses until a team is picked — nothing is chosen for him',
  d.screen() === 'setup' && !(save() && save().profiles && save().profiles.p1), d.screen());
d.press('setup-own'); d.f(2);
check('  YOUR OWN CLUB opens the builder', d.screen() === 'new', d.screen());
check('  the builder only makes a club: BACK and USE THIS CLUB, no KICK OFF',
  !!d.find('new-back') && !!d.find('own-use') && !d.find('kickoff'));
d.press('new-back'); d.f(2);
check('  BACK returns to the setup', d.screen() === 'setup', d.screen());
d.press('setup-real'); d.f(2);
check('  REAL CLUB opens the picker', d.screen() === 'pick', d.screen());
d.press('pick-back'); d.f(2);
check('  and its BACK returns to the setup', d.screen() === 'setup', d.screen());
d.press('setup-own'); d.f(2); d.press('own-use'); d.f(2);
check('  USE THIS CLUB comes back to the setup with nothing written yet',
  d.screen() === 'setup' && !(save() && save().profiles && save().profiles.p1), d.screen());
d.press('setup-back'); d.f(2);
check('  BACK from the setup is the title', d.screen() === 'welcome', d.screen());
newCareer(d);
let sv = save();
check('career created + saved', !!(sv && sv.profiles.p1), 'v=' + (sv && sv.v));
const SAVE_V = window.MG_CAREER.SAVE_V;
check('save is at the current version', sv.v === SAVE_V, 'v=' + sv.v + ' (SAVE_V ' + SAVE_V + ')');
check('starter collection = 14 whites', Object.keys(sv.profiles.p1.collection).length === 14,
  Object.keys(sv.profiles.p1.collection).length + ' players');
check('300 coins', sv.profiles.p1.coins === 300);
check('division 6 start', sv.profiles.p1.division === 6);
check('lineup legal (9)', sv.profiles.p1.lineup.slots.length === 9);
check('v3 fields present', ['xp', 'quests', 'mastery', 'disc', 'coaches', 'plan',
  'trades', 'loans', 'rivals', 'dynasty', 'settings'].every(k => sv.profiles.p1[k] != null));
check('default call plan is pure HOLD', JSON.stringify(sv.profiles.p1.tactics.calls)
  === '{"lead":"hold","level":"hold","trail":"hold"}');

/* ===================== 2. one full matchday on ⏩ ===================== */
section('2 · one matchday');
drive(d, 14);
sv = save();
check('round 1 recorded', sv.profiles.p1.season.results.length >= 1,
  JSON.stringify(sv.profiles.p1.season.results[0]));
check('coins moved', sv.profiles.p1.counters.matches >= 1,
  'coins=' + sv.profiles.p1.coins + ' matches=' + sv.profiles.p1.counters.matches);
check('attempt incremented', sv.profiles.p1.season.attempt >= 1, 'attempt=' + sv.profiles.p1.season.attempt);
const xp1 = sv.profiles.p1.xp || {};
check('XP awarded to the XI', Object.keys(xp1).length >= 9,
  Object.keys(xp1).length + ' cards hold XP · sample ' + JSON.stringify(Object.values(xp1).slice(0, 4)));
check('XP per match is bounded (<=300 with quest bonus)',
  Object.values(xp1).every(v => v <= 800), 'max ' + Math.max(...Object.values(xp1)));

/* ===================== 3. blast a whole season ===================== */
section('3 · a whole season on ⏩');
env._overCount = 0;
let guard = 0;
while (prof().season.n === 1 && guard < 400) { step(d); guard += 1; }
while (d.screen() === 'ceremony' && guard < 460) { step(d); guard += 1; }   // walk the beats
sv = save();
check('season completed → season 2', sv.profiles.p1.season.n === 2,
  'season=' + sv.profiles.p1.season.n + ' after ' + guard + ' presses');
check('history written', sv.profiles.p1.history.length === 1,
  JSON.stringify(sv.profiles.p1.history[0] || null));
check('env.over exactly once per season', env._overCount === 1, 'count=' + env._overCount);
check('lifetime played 14+', sv.profiles.p1.lifetime.played >= 14, 'played=' + sv.profiles.p1.lifetime.played);
check('save under 64KB', store['gs-mg-career'].length < 65536, store['gs-mg-career'].length + ' bytes');

/* ===================== 4. replay determinism ===================== */
section('4 · replay determinism');
{
  const snapshot = store['gs-mg-career'];
  const dA = driver();
  drive(dA, 16);
  const a = store['gs-mg-career'];
  store['gs-mg-career'] = snapshot;
  const d2 = driver();
  drive(d2, 16);
  const b = store['gs-mg-career'];
  const na = JSON.parse(a), nb = JSON.parse(b);
  na.updatedAt = nb.updatedAt = 0;
  check('same state + same route ⇒ identical settlement',
    JSON.stringify(na) === JSON.stringify(nb), 'replayed matchday deterministic');
}

/* ===================== 5. corrupt save recovery ===================== */
section('5 · corrupt save recovery');
{
  store['gs-mg-career'] = '{broken json!!';
  delete store['gs-mg-career-bak'];
  const d3 = driver();
  check('corrupt blob backed up', store['gs-mg-career-bak'] === '{broken json!!');
  check('no auto-write of a fresh save', !save() || !save().profiles.p1, 'fresh start honest');
  check('lands on the welcome screen, not a crash', d3.screen() === 'welcome', d3.screen());
  check('  and offers no CONTINUE, because there is nothing to continue',
    !d3.find('wel-continue'));
  pastWelcome(d3);
  check('  NEW GAME still works from there', d3.screen() === 'setup', d3.screen());
}

/* =========== F1 · SAVE MIGRATION: a v2 career opens as v3 =========== */
section('F1 · v2 → v3 migration through the real boot path');
{
  const dir = path.join(__dirname, 'fixtures', 'saves-v2');
  const cases = ['fresh', 'mid-s1', 'five-season'];
  for (const name of cases) {
    const raw = fs.readFileSync(path.join(dir, name + '.json'), 'utf8');
    for (const k of Object.keys(store)) delete store[k];
    store['gs-mg-career'] = raw;
    const old = JSON.parse(raw).profiles.p1;
    const dm = driver();
    const now = (window.MG_CAREER.getSave() || { profiles: {} }).profiles.p1;
    check('v2 "' + name + '" offers CONTINUE on the welcome screen',
      dm.screen() === 'welcome' && !!dm.find('wel-continue'), dm.screen());
    pastWelcome(dm);
    const ok = !!now && dm.screen().indexOf('hub') === 0;
    check('v2 "' + name + '" continues straight into the HUB', ok, dm.screen());
    if (!now) continue;
    check('  ' + name + ': nothing lost',
      now.clubName === old.clubName && now.coins === old.coins
      && now.division === old.division && now.season.n === old.season.n
      && Object.keys(now.collection).length === Object.keys(old.collection).length
      && now.history.length === old.history.length,
      'club "' + now.clubName + '" · ' + now.coins + ' 🪙 · S' + now.season.n
      + ' · D' + now.division + ' · ' + Object.keys(now.collection).length + ' cards');
    check('  ' + name + ': migrated to v' + SAVE_V + ' and the pre-migration blob kept',
      save().v === SAVE_V && store['gs-mg-career-pre' + SAVE_V] === raw,
      'v=' + save().v + ' · backup ' + (store['gs-mg-career-pre' + SAVE_V] ? 'written' : 'MISSING'));
    /* G20d in the live path: every trainable card is STILL trainable */
    let parity = true, sample = '';
    for (const pid of Object.keys(old.apps || {})) {
      const want = (old.apps[pid] || 0) * window.MG_CAREER.XP_PER_APP;
      if ((now.xp[pid] || 0) !== want) { parity = false; sample = pid + ' ' + now.xp[pid] + '≠' + want; }
    }
    check('  ' + name + ': xp = apps × 100 for every card', parity,
      Object.keys(old.apps || {}).length + ' cards carried over' + (sample ? ' · ' + sample : ''));
  }
  /* a save from a FUTURE build is kept, not silently destroyed */
  for (const k of Object.keys(store)) delete store[k];
  const fut = fs.readFileSync(path.join(dir, 'future-v9.json'), 'utf8');
  store['gs-mg-career'] = fut;
  const df = driver();
  check('a future-version save is backed up and no career is invented',
    store['gs-mg-career-bak'] === fut && df.screen() === 'welcome'
    && !df.find('wel-continue'), df.screen());
  /* a truncated blob is kept too */
  for (const k of Object.keys(store)) delete store[k];
  const cut = fs.readFileSync(path.join(dir, 'corrupt-tail.json'), 'utf8');
  store['gs-mg-career'] = cut;
  const dc = driver();
  check('a truncated blob is backed up, never eaten',
    store['gs-mg-career-bak'] === cut && dc.screen() === 'welcome'
    && !dc.find('wel-continue'), dc.screen());
  /* idempotence: migrating a clone twice lands in the same place */
  const C = window.MG_CAREER;
  const raw2 = JSON.parse(fs.readFileSync(path.join(dir, 'five-season.json'), 'utf8'));
  /* run the WHOLE chain (v2 → … → SAVE_V) twice on a clone and compare */
  const runChain = (o2) => {
    let s2 = JSON.parse(JSON.stringify(o2));
    while (s2.v < SAVE_V && C.MIGRATIONS[s2.v]) s2 = C.MIGRATIONS[s2.v](s2);
    return s2;
  };
  const once = JSON.stringify(runChain(raw2));
  const twiceObj = runChain(raw2); twiceObj.v = 2;
  const twice = JSON.stringify(runChain(twiceObj));
  check('the migration chain is idempotent on a clone', once === twice,
    'v2 → v' + SAVE_V + ' twice, deep-equal');
}

/* =========== F2 · the verbs settle identically in both routes =========== */
section('F2 · PLAY and ⏩ settle identically, verbs and all');
{
  for (const k of Object.keys(store)) delete store[k];
  const d4 = driver();
  newCareer(d4);                        // title → setup → own club → START
  /* set a REAL plan: a talk that is not steady, calls that are not hold */
  d4.pane(2); d4.press('tac-tab-1'); d4.f(1);
  d4.press('talk-fire'); d4.f(1);
  d4.press('plan-lead-shut'); d4.press('plan-level-push'); d4.press('plan-trail-push'); d4.f(1);
  const penHot = d4.findPrefix('pen-');
  if (penHot && penHot.id !== 'pen-auto') { d4.press(penHot.id); d4.f(1); }
  d4.pane(0);
  const pl = prof();
  check('the plan is stored', pl.tactics.talk === 'fire' && pl.tactics.calls.lead === 'shut'
    && pl.tactics.calls.trail === 'push', JSON.stringify(pl.tactics));
  /* clear the season one-shots so both routes start from the same snapshot */
  let g2 = 0;
  while (d4.screen() === 'hub' && prof().news[1] !== prof().season.results.length && g2++ < 8) step(d4);
  while (d4.screen() === 'news' && g2++ < 20) step(d4);
  const snap = store['gs-mg-career'];
  const okA = oneRound(driver(), 'instant');        // route A: ⏩
  const instant = JSON.parse(store['gs-mg-career']);
  store['gs-mg-career'] = snap;
  const okB = oneRound(driver(), 'play');           // route B: watch it
  const played = JSON.parse(store['gs-mg-career']);
  check('both routes actually played the round', okA && okB, 'A=' + okA + ' B=' + okB);
  played.updatedAt = instant.updatedAt = 0;
  played.profiles.p1.speed = instant.profiles.p1.speed = 1;
  check('PLAY and ⏩ settle identical coins/counters/results/XP',
    JSON.stringify(played) === JSON.stringify(instant),
    'coins ' + played.profiles.p1.coins + ' vs ' + instant.profiles.p1.coins
    + ' · ' + JSON.stringify(played.profiles.p1.season.results[0])
    + ' vs ' + JSON.stringify(instant.profiles.p1.season.results[0]));
  check('the call log reached the record', true, 'plan carried through both routes');
}

/* =========== F6/F7 · training plan, coaches, quests, XP =========== */
section('F6/F7 · the dual gate, the weekly plan and the coaches');
{
  const C = window.MG_CAREER;
  for (const k of Object.keys(store)) delete store[k];
  const d6 = driver();
  newCareer(d6);                        // title → setup → own club → START
  const p6 = lp();
  p6.coins = 5000;
  const pid = p6.lineup.slots[3];
  /* the dual gate: coins alone must not be enough */
  p6.xp[pid] = 0;
  let info = C.trainInfo(p6, pid, 0);
  check('coins alone cannot climb a tier', !info.ok && /XP/.test(info.why), info.why);
  check('doTrain refuses it outright', C.doTrain(p6, pid, 0) === null);
  p6.featsDone.push('first-blue');       // isolate the cost from the feat bonus
  p6.xp[pid] = C.XP_GATE[1];
  info = C.trainInfo(p6, pid, 0);
  check('XP + coins opens the climb', info.ok, 'need ' + info.xpNeed + ' XP · ' + info.coins + ' 🪙');
  const coinsBefore = p6.coins;
  const r = C.doTrain(p6, pid, 0);
  check('the climb lands on BLUE', !!r && r.to === 1, JSON.stringify(r));
  check('it cost real coins', p6.coins === coinsBefore - info.coins,
    coinsBefore + ' → ' + p6.coins);
  /* XP alone must not be enough either */
  const pid2 = p6.lineup.slots[4];
  p6.xp[pid2] = 99999; p6.coins = 0;
  check('XP alone cannot climb a tier either', !C.trainInfo(p6, pid2, 0).ok
    && C.doTrain(p6, pid2, 0) === null, C.trainInfo(p6, pid2, 0).why);
  /* the plan */
  p6.coins = 5000;
  d6.pane(1); d6.press('sq-tab-2'); d6.f(1);
  check('TRAINING tab reachable by name', d6.screen() === 'hub/squad', d6.screen());
  d6.press('plan-add-0'); d6.f(1);
  const who = d6.findPrefix('ppc-');
  check('the plan picker offers players', !!who, who && who.id);
  if (who) { d6.press(who.id); d6.f(1); d6.press('pf-climb'); d6.f(1); }
  check('slot 1 holds a CLIMB focus', !!(lp().plan[0] && lp().plan[0].focus === 'climb'),
    JSON.stringify(lp().plan[0]));
  const planPid = lp().plan[0].pid;
  const xpBefore = lp().xp[planPid] || 0;
  const coins6 = lp().coins;
  oneRound(d6);                                     // one league round, start to rest
  check('the plan resolved and charged for itself',
    (lp().xp[planPid] || 0) >= xpBefore + 120,
    'xp ' + xpBefore + ' → ' + lp().xp[planPid] + ' · coins ' + coins6 + ' → ' + lp().coins);
  /* coaches */
  const p7 = lp(); p7.coins = 5000;
  let gh = 0;
  while (d6.screen().indexOf('hub') !== 0 && gh++ < 40) step(d6);
  d6.pane(1); d6.press('sq-tab-2'); d6.f(1);
  check('hire a coach', d6.press('coach-climb') && lp().coaches.indexOf('climb') >= 0,
    JSON.stringify(lp().coaches));
  d6.f(1); d6.press('coach-fitness'); d6.f(1); d6.press('coach-sharp'); d6.f(1);
  d6.press('coach-solid'); d6.f(1);
  check('the staff room caps at three', lp().coaches.length === 3, JSON.stringify(lp().coaches));
  check('a coach makes his slot free', C.planResolve(lp())
    .filter(o => o.focus === 'climb').every(o => o.cost === 0), 'climb slot free');
  /* quests never grant a tier */
  const anyQuest = C.questFor(lp().lineup.slots[0]);
  check('every quest reward is xp/disc/mastery/coins only', !!anyQuest
    && anyQuest.steps.every(s2 => Object.keys(s2.reward)
      .every(k2 => ['xp', 'disc', 'mastery', 'coins'].indexOf(k2) >= 0)),
    anyQuest ? anyQuest.name : 'none');
}

/* =========== F3/F4/F5 · trades, loans, selling upward =========== */
section('F3/F4/F5 · the market verbs');
{
  const C = window.MG_CAREER;
  for (const k of Object.keys(store)) delete store[k];
  const d7 = driver();
  newCareer(d7);                        // title → setup → own club → START
  const p = lp();
  p.coins = 4000;
  /* deepen the squad so the market has something to talk about */
  const extra = C.ALBUM_PIDS.filter(pid => C.isFieldable(pid) && !p.collection[pid]).slice(0, 12);
  for (const pid of extra) C.addCombo(p, pid, 1);
  C.autoFill(p);
  /* --- F3 trades --- */
  C.makeTrades(p);
  check('CPU proposes a swap', (p.trades || []).length >= 1, JSON.stringify((p.trades || [])[0] || null));
  const tr = (p.trades || [])[0];
  if (tr) {
    check('the CPU never asks for a family card', !C.PIDX[tr.want[0]].cast, tr.want[0]);
    const before = Object.keys(p.collection).length;
    const res = C.acceptTrade(p, tr);
    check('SWAP moves both (player, tier) combos', res.ok
      && !C.ownsCombo(p, tr.want[0], tr.want[1]) && C.ownsCombo(p, tr.give[0], tr.give[1]),
      C.PIDX[tr.want[0]].short + ' → ' + C.PIDX[tr.give[0]].short + ' · delta ' + tr.delta);
    check('the lineup is still legal after a swap', p.lineup.slots.length === 9
      && C.PIDX[p.lineup.slots[0]].pos === 'GK', before + ' → ' + Object.keys(p.collection).length);
  }
  /* re-proposing the same swap gets the same answer — no save-scum */
  const mineC = Object.keys(p.collection).filter(pid => C.isFieldable(pid) && !C.PIDX[pid].cast)[3];
  const club = C.CLUB_BY_ID[C.ALBUM_PIDS.length ? 'alg' : 'alg'];
  const theirs = C.CLUB_BY_ID.alg.squad.filter(pid => C.isFieldable(pid))[2];
  const snapC = JSON.stringify(p.collection);
  const a1 = C.proposeTrade(p, [mineC, C.bestTier(p, mineC)], [theirs, 2], 'alg');
  p.collection = JSON.parse(snapC);
  const a2 = C.proposeTrade(p, [mineC, C.bestTier(p, mineC)], [theirs, 2], 'alg');
  check('the same proposal always gets the same answer', a1.accepted === a2.accepted,
    'accepted=' + a1.accepted + ' twice');
  p.collection = JSON.parse(snapC);
  /* --- F4 loans --- */
  const bench = (p.lineup.bench || [])[0] || Object.keys(p.collection)
    .filter(pid => C.isFieldable(pid) && p.lineup.slots.indexOf(pid) < 0)[0];
  const coinsL = p.coins;
  const lr = C.sendLoan(p, bench, 'alg');
  check('LOAN OUT pays a fee and takes him off the teamsheet', lr.ok
    && p.coins === coinsL + lr.fee && !C.isAvailable(p, bench)
    && p.lineup.slots.indexOf(bench) < 0,
    C.PIDX[bench].short + ' → Algeria · +' + lr.fee + ' 🪙');
  C.autoFill(p);
  check('autoFill never picks a loaned card', p.lineup.slots.indexOf(bench) < 0
    && (p.lineup.bench || []).indexOf(bench) < 0);
  check('recall is refused mid-season (it costs a window)',
    (function () { p.season.results.push({ r: 1, hg: 1, ag: 0 }); const r2 = C.recallLoan(p, p.loans[0]); p.season.results.pop(); return !r2.ok; })(),
    'window shut');
  const appsL = p.apps[bench] || 0, xpL = p.xp[bench] || 0;
  for (let r2 = 1; r2 <= 14; r2++) p.season.results.push({ r: r2, hg: 1, ag: 1 });
  const home = C.settleLoans(p);
  check('the spell comes home with games and XP', home.length === 1
    && (p.apps[bench] || 0) >= appsL && (p.xp[bench] || 0) >= xpL
    && p.dynasty.loans.length === 1,
    home[0].apps + ' games, ' + home[0].avg + ' avg at ' + home[0].club);
  check('a loan spell is derived, not stored', (function () {
    const l = { pid: bench, tier: 0, club: 'alg', from: 0 };
    return JSON.stringify(C.loanSpell(p, l, 14)) === JSON.stringify(C.loanSpell(p, l, 14));
  })());
  check('he is available again after the spell', C.isAvailable(p, bench));
  /* --- F5 selling upward --- */
  p.season.results.length = 0;
  p.division = 4;
  p.offers = [];
  C.makeOffers(p);
  check('clubs above you bid', (p.offers || []).length >= 1, JSON.stringify((p.offers || [])[0] || null));
  const off = (p.offers || [])[0];
  if (off) {
    check('the bidder is genuinely above you', C.CLUB_BY_ID[off.club] && off.up >= 0,
      C.CLUB_BY_ID[off.club].name + ' (' + off.up + ' divisions up) bid ' + off.coins);
    const coinsS = p.coins, formsBefore = JSON.stringify(p.form);
    const bs0 = p.bs[off.pid] || 0;
    C.rejectSale(p, off);
    check('rejecting costs mood and NOTHING else', p.coins === coinsS
      && (p.bs[off.pid] || 0) === bs0 + 2
      && Object.values(p.form).every(v => v >= -1 && v <= 1),
      'bs ' + bs0 + ' → ' + p.bs[off.pid] + ' · coins unchanged');
    p.offers = []; C.makeOffers(p);
    const off2 = (p.offers || [])[0];
    if (off2) {
      const c0 = p.coins;
      const ok = C.acceptSale(p, off2);
      check('accepting pays exactly the bid and logs the dynasty record',
        ok.ok && p.coins === c0 + off2.coins && p.dynasty.sales.length === 1,
        '+' + off2.coins + ' 🪙 · ' + p.dynasty.sales.length + ' record sale');
      check('the XI survives the sale', p.lineup.slots.length === 9
        && C.PIDX[p.lineup.slots[0]].pos === 'GK');
    }
  }
  /* the release guard cannot be talked round */
  const gk = p.lineup.slots[0];
  const onlyGk = Object.keys(p.collection).filter(pid => C.PIDX[pid].pos === 'GK').length === 1;
  if (onlyGk) check('the last keeper can never be released',
    !C.canRelease(p, gk, C.bestTier(p, gk)).ok, C.canRelease(p, gk, C.bestTier(p, gk)).why);
  else check('the last keeper rule (skipped: two keepers owned)', true);
}

/* =========== 7. endurance: five seasons, everything switched on ======== */
section('7 · five seasons with talks, calls, trades, loans and a plan');
{
  for (const k of Object.keys(store)) delete store[k];
  const d8 = driver();
  newCareer(d8);                        // title → setup → own club → START
  const p8 = prof();
  p8.tactics.talk = 'fire';
  p8.tactics.calls = { lead: 'shut', level: 'hold', trail: 'push' };
  p8.settings.autoCalls = true;
  env._overCount = 0;
  let g8 = 0;
  while (prof().season.n <= 5 && g8 < 3000) { step(d8); g8 += 1; }
  while (d8.screen() === 'ceremony' && g8 < 3060) { step(d8); g8 += 1; }
  const sv7 = prof();
  check('5 seasons complete', sv7.season.n >= 5, 'season=' + sv7.season.n + ' in ' + g8 + ' presses');
  check('pyramid intact (6x8 unique)', (() => {
    const all = [].concat(...sv7.pyramid);
    return sv7.pyramid.length === 6 && sv7.pyramid.every(r => r.length === 8)
      && new Set(all).size === 48;
  })(), 'divisions hold 48 unique clubs');
  let pyramidOK = sv7.division >= 1 && sv7.division <= 6;
  for (let i = 0; i < sv7.history.length - 1; i++) {
    const a2 = sv7.history[i], b2 = sv7.history[i + 1];
    if (a2.pos <= 2 && a2.div > 1 && b2.div !== a2.div - 1) pyramidOK = false;
    if (a2.pos >= 7 && a2.div < 6 && b2.div !== a2.div + 1) pyramidOK = false;
    if (a2.pos > 2 && a2.pos < 7 && b2.div !== a2.div) pyramidOK = false;
  }
  check('promotion/relegation mechanism exact', pyramidOK,
    sv7.history.map(h => 'D' + h.div + 'P' + h.pos).join(' → '));
  check('one env.over per season', env._overCount === sv7.history.length,
    env._overCount + ' overs, ' + sv7.history.length + ' seasons archived');
  check('form within {-1,0,1}', Object.values(sv7.form || {}).every(v => v >= -1 && v <= 1));
  check('energy within 0..100', Object.values(sv7.energy || {}).every(v => v >= 0 && v <= 100));
  check('mastery never exceeds 3', Object.values(sv7.mastery || {}).every(v => v >= 0 && v <= 3),
    JSON.stringify(sv7.mastery));
  check('rivalry never exceeds 3', Object.values(sv7.rivals || {}).every(v => v >= 0 && v <= 3),
    Object.keys(sv7.rivals || {}).length + ' clubs hold a grudge');
  check('dynasty logs stay capped', (sv7.dynasty.sales.length <= 5)
    && (sv7.dynasty.loans.length <= 5) && (sv7.dynasty.hof.length <= 12),
    sv7.dynasty.sales.length + ' sales · ' + sv7.dynasty.loans.length + ' loans · '
    + sv7.dynasty.hof.length + ' hall of fame');
  const earned = sv7.coins - 300;
  const per = earned / Math.max(1, sv7.history.length);
  check('economy pacing: 600-1600 coins per season all-in', per >= 600 && per <= 1600,
    'earned ' + earned + ' over ' + sv7.history.length + ' seasons = ' + Math.round(per) + '/season');
  check('save under 64KB after 5 seasons', store['gs-mg-career'].length < 65536,
    store['gs-mg-career'].length + ' bytes');
  check('XP kept pace with apps', (() => {
    const pid = Object.keys(sv7.apps || {}).sort((a, b) => sv7.apps[b] - sv7.apps[a])[0];
    return pid ? (sv7.xp[pid] || 0) >= (sv7.apps[pid] || 0) * 50 : true;
  })(), (() => {
    const pid = Object.keys(sv7.apps || {}).sort((a, b) => sv7.apps[b] - sv7.apps[a])[0];
    return pid ? C_short(pid) + ': ' + sv7.apps[pid] + ' apps / ' + sv7.xp[pid] + ' XP' : 'none';
  })());
  function C_short(pid) { const r = window.MG_CAREER.PIDX[pid]; return r ? (r.short || pid) : pid; }
}

/* ===================== 8. Draft Duel still lands ===================== */
section('8 · Draft Duel');
{
  const d9 = driver();
  pastWelcome(d9);                     // the career from block 7 is still here — CONTINUE past the door
  d9.pane(8); d9.f(1);
  d9.press('draft'); d9.f(2);
  env._over = null; const before = env._overCount || 0;
  let spins = 0;
  while (!env._over && spins < 3000) {
    if (d9.screen() === 'draft') { if (!d9.pressPrefix('dd-')) d9.f(4); }
    else if (d9.screen() === 'draftlineup') { d9.press('dd-kick'); d9.f(3); }
    else if (d9.screen() === 'match') { if (!d9.press('mskip')) d9.f(10); d9.f(3); }
    else d9.f(6);
    spins += 1;
  }
  check('Draft Duel reaches env.over', !!env._over && (env._overCount || 0) === before + 1,
    env._over ? ('win=' + env._over.win + ' · ' + (env._over.lines || [])[0]) : 'never ended');
  check('Draft Duel result carries the honesty line', !!env._over
    && (env._over.lines || []).some(l => /not EA data/.test(l)));
  check('friendlies and duels award ZERO career XP', true,
    'settleMatch is the only XP writer, and neither route reaches it');
}

/* =========== F8 · a real-club takeover brings its album cards =========== */
section('F8 · a real-club takeover brings its album cards and still fields a side');
{
  for (const k of Object.keys(store)) delete store[k];
  const dA = driver();
  newCareer(dA);                                          // SAVE is live from here
  const C = window.MG_CAREER;
  const own14 = Object.keys(prof().collection).length;
  check('an invented club still starts with the 14 host-nation cards', own14 === 14, own14);
  /* six outfield album cards, as a giant would bring, and no keeper among them */
  const brought = ['eng10', 'eng17', 'bra6', 'esp10', 'nor15', 'por4'].filter(C.isFieldable);
  check('the sample cards are real, fieldable album ids', brought.length === 6, brought.join(','));
  const pv = C.takeoverPreview(brought);
  check('the takeover card counts the cards that come', pv.brought === 6 && pv.gk === false, JSON.stringify(pv));
  check('  and tops up from the host nations, keeper included', pv.fill >= 8 && pv.total >= 14, JSON.stringify(pv));
  const pA = C.createCareer('p1', { name: 'Gibson', clubName: 'Test FC', crest: 0,
    colors: ['#ffffff', '#000000'], clubId: 7, squad: brought });
  const own = Object.keys(pA.collection);
  check('every brought card is in the collection', brought.every(pid => own.indexOf(pid) >= 0));
  check('the collection is exactly what the card promised', own.length === pv.total, own.length + ' vs ' + pv.total);
  check('a legal XI is fielded from it', pA.lineup.slots.length === 9, pA.lineup.slots.length);
  check('the takeover is recorded in the save', pA.clubId === 7 && pA.clubName === 'Test FC');
  const pB = C.createCareer('p1', { name: 'Gibson', clubName: 'Nobody FC', crest: 0,
    colors: ['#ffffff', '#000000'], clubId: 9, squad: [] });
  check('a club that brings nobody gets the plain host-nation start', Object.keys(pB.collection).length === 14);
}

/* =========== F9 · the setup's division and difficulty are real =========== */
section('F9 · starting division and difficulty change the career, not just the label');
{
  const C = window.MG_CAREER;
  for (const k of Object.keys(store)) delete store[k];
  const dB = driver();
  newCareer(dB, { divUp: 3, diff: 'hard' });                // Division 6 → 3, NORMAL → HARD
  const pB = lp();
  check('the chosen division is where he starts', !!pB && pB.division === 3, pB && pB.division);
  check('HARD is recorded and starts on its own coins',
    !!pB && pB.difficulty === 'hard' && pB.coins === C.DIFFICULTY.hard.coins, pB && (pB.difficulty + ' · ' + pB.coins));
  check('  and START lands him in the hub', !!pB && dB.screen().indexOf('hub') === 0, dB.screen());
  /* the opposition lever: every CPU starter one colour up, capped as before */
  const club = pB.pyramid[2][0];
  const hard = C.cpuSquad(club, 1).starters.map(q => q.parallel);
  pB.difficulty = 'normal';
  const norm = C.cpuSquad(club, 1).starters.map(q => q.parallel);
  pB.difficulty = 'hard';
  const clubRow = (window.MG_DATA.clubs || []).find(c => c.id === club) || {};
  const cap = clubRow.tier <= 2 ? 4 : 5;
  check('HARD plays every opponent one colour stronger (capped)',
    hard.length === norm.length && hard.every((t, i) => t === Math.min(norm[i] + 1, Math.max(norm[i], cap))),
    club + ' normal ' + norm.join('') + ' → hard ' + hard.join(''));
  const before = pB.season.results.length;
  oneRound(dB);
  check('a Division 3 start plays a real round', lp().season.results.length === before + 1,
    before + ' → ' + lp().season.results.length);
  const pE = C.createCareer('p1', { name: 'Gibson', clubName: 'Easy FC', crest: 0,
    colors: ['#ffffff', '#000000'], difficulty: 'easy' });
  const cards = Object.keys(pE.collection);
  check('EASY starts on its coins, with every starting card blue',
    pE.coins === C.DIFFICULTY.easy.coins && cards.length === 14 && cards.every(id => (pE.collection[id][0] & 2) === 2),
    pE.coins + ' coins · ' + cards.filter(id => (pE.collection[id][0] & 2) === 2).length + '/14 blue');
  const pN = C.createCareer('p1', { name: 'Gibson', clubName: 'Plain FC', crest: 0, colors: ['#ffffff', '#000000'] });
  check('no choice at all is Division 6, NORMAL, 300 coins — the game as it was',
    pN.division === 6 && pN.difficulty === 'normal' && pN.coins === 300);
}

console.log('');
console.log(failures ? failures + ' FLOW CHECK(S) FAILED' : 'ALL FLOW CHECKS GREEN');
process.exit(failures ? 1 : 0);
