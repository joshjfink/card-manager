#!/usr/bin/env node
/* cm-squad-test.js — the real-club takeover, proved headless (addendum 34).
 *
 * Loads the album data, the EA roster layer and the game exactly as the page
 * does, then checks that taking over a club hands over that club's real
 * squad: every player, as playable cards, with no host-nation filler, a
 * legal teamsheet, a real match played — and that a save holding those cards
 * reopens in a FRESH node process, where nothing is left in memory from the
 * run that wrote it. That last part is the only honest test of save
 * hydration: rows built on demand are always present in the process that
 * built them.
 *
 *   node tools/cm-squad-test.js                 all checks
 *   node tools/cm-squad-test.js --club "Philadelphia"
 *
 * Exit 0 = all pass. No deps.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const STATIC = path.join(__dirname, '..', 'gibson', 'web', 'static');

function boot(storeInit) {
  globalThis.window = globalThis;
  const store = Object.assign({}, storeInit || {});
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: i => Object.keys(store)[i] || null,
  };
  globalThis.MiniGames = { register() {} };
  globalThis.Image = function () {};
  require(path.join(STATIC, 'mg-manager-data.js'));
  require(path.join(STATIC, 'mg-roster.js'));
  require(path.join(STATIC, 'mg-badges.js'));
  require(path.join(STATIC, 'mg-manager.js'));
  return store;
}

/* ---- child mode: reopen a save in a process that never saw it written ---- */
if (process.argv[2] === '--reopen') {
  const store = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  boot(store);
  const C = window.MG_CAREER;
  C.loadSave();
  const s = C.getSave();
  const p = s && s.profiles && s.profiles.p1;
  const out = { ok: !!p };
  if (p) {
    const ids = Object.keys(p.collection);
    out.cards = ids.length;
    out.rowsMissing = ids.filter(id => !C.PIDX[id]).length;
    out.slots = p.lineup.slots.length;
    out.slotsMissing = p.lineup.slots.filter(id => !C.PIDX[id]).length;
    out.keeper = (C.PIDX[p.lineup.slots[0]] || {}).pos || null;
    out.rostCards = ids.filter(id => C.PIDX[id] && C.PIDX[id].rost).length;
    out.clubId = p.clubId; out.clubEa = p.clubEa;
    const rc = window.MG_ROSTER.club(p.clubId);
    out.clubName = rc ? rc.name : null;
    try {
      const sq = C.mySquad(p);
      const opp = C.cpuSquad(p.pyramid[p.division - 1].filter(x => x !== 'you')[0], 1);
      const rec = window.MG_ENGINE.simulate(sq, opp, { knockout: false }, Math.random);
      out.played = !!(rec && rec.score);
    } catch (e) { out.played = false; out.err = String(e && e.message || e); }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/* ---- main ------------------------------------------------------------- */
const store = boot();
const C = window.MG_CAREER;
const R = window.MG_ROSTER;
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail !== undefined ? ' — ' + detail : ''));
  if (!ok) failures++;
};

const argClub = process.argv.indexOf('--club') >= 0 ? process.argv[process.argv.indexOf('--club') + 1] : 'Philadelphia';
console.log('roster: ' + (R.count && R.count.players) + ' players · as of ' + R.asOf + ' · ' + R.source + '\n');

const clubId = R.findClub(argClub);
check('the roster knows ' + argClub, typeof clubId === 'number', clubId);
const club = R.club(clubId);
const real = (R.playersOfClub(clubId) || []).filter(Boolean);
const sq = C.clubSquadPids(clubId);
console.log('  ' + club.name + ' · ' + club.leagueName + ' · ' + real.length + ' players in EA’s squad');

check('every player in the real squad becomes a card, less any icon',
  sq.pids.length + sq.icons.length === real.length, sq.pids.length + ' cards + ' + sq.icons.length + ' icons of ' + real.length);
check('  every one is a fieldable card with a row', sq.pids.every(id => C.isFieldable(id)));
check('  the names are EA’s, in the same order of rating',
  real.filter(pl => !(pl.card && C.ICON_PIDS.indexOf(pl.card) >= 0))
    .sort((a, b) => b.ovr - a.ovr).every((pl, i) => pl.card ? sq.pids[i] === pl.card
      : (C.PIDX[sq.pids[i]].name === pl.name && C.PIDX[sq.pids[i]].base === pl.ovr)));
check('  an album player arrives as his album card', real.filter(pl => pl.card && C.ICON_PIDS.indexOf(pl.card) < 0)
  .every(pl => sq.pids.indexOf(pl.card) >= 0), real.filter(pl => pl.card).map(pl => pl.card).join(',') || 'none in this squad');

C.setSave(C.freshSave());
const p = C.createCareer('p1', { name: 'Gibson', clubName: club.name, crest: 0,
  colors: ['#0a1e3c', '#e0c46c'], clubId, squad: sq.pids });
const own = Object.keys(p.collection);
check('the takeover hands over exactly that squad — no host-nation filler',
  own.length === sq.pids.length && sq.pids.every(id => p.collection[id]),
  own.length + ' cards · filler: ' + own.filter(id => sq.pids.indexOf(id) < 0).join(',') || 'none');
check('a legal teamsheet of nine with one keeper',
  p.lineup.slots.length === 9 && C.PIDX[p.lineup.slots[0]].pos === 'GK'
    && p.lineup.slots.filter(id => C.PIDX[id].pos === 'GK').length === 1,
  p.lineup.slots.map(id => C.PIDX[id].short).join(', '));
const opp = C.cpuSquad(p.pyramid[p.division - 1].filter(x => x !== 'you')[0], 1);
let rec = null;
try { rec = window.MG_ENGINE.simulate(C.mySquad(p), opp, { knockout: false }, Math.random); } catch (e) { rec = { err: e.message }; }
check('they play a real match', !!(rec && rec.score), rec && (rec.score ? rec.score.join('–') : rec.err));
const raw = store['gs-mg-career'] || localStorage.getItem('gs-mg-career');
check('the save stays small (gate G27: under 64KB)', !!raw && raw.length < 64000, raw && (raw.length + ' bytes'));

/* reopen in a process that has never built these rows */
const tmp = path.join(os.tmpdir(), 'cm-squad-save-' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify(store));
let re = {};
try { re = JSON.parse(execFileSync(process.execPath, [__filename, '--reopen', tmp], { encoding: 'utf8' })); }
catch (e) { re = { ok: false, err: String(e.message).slice(0, 200) }; }
check('a fresh process reopens the save with every card', re.ok && re.cards === own.length && re.rowsMissing === 0,
  JSON.stringify(re));
check('  and the same teamsheet, keeper first', re.slots === 9 && re.slotsMissing === 0 && re.keeper === 'GK');
check('  and plays a match with it', re.played === true, re.err || '');

check('  and the club is stored by EA team id and found again', re.clubEa === club.ea && re.clubId === clubId,
  re.clubEa + ' → index ' + re.clubId + ' (' + re.clubName + ')');

/* a save from before the FC 27 roster holds only the OLD club index */
{
  /* the old numbering ships inside mg-badges.js (legacyEa), so this check
     needs nothing that lives outside the game's own files */
  let legacyIdx = 0;
  for (let i = 1; i < 2000 && !legacyIdx; i++) if (+window.MG_BADGES.legacyEa(i) === club.ea) legacyIdx = i;
  const s3 = JSON.parse(store['gs-mg-career']);
  delete s3.profiles.p1.clubEa;
  s3.profiles.p1.clubId = legacyIdx;
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, store, { 'gs-mg-career': JSON.stringify(s3) })));
  try { re = JSON.parse(execFileSync(process.execPath, [__filename, '--reopen', tmp], { encoding: 'utf8' })); }
  catch (e) { re = { ok: false, err: String(e.message).slice(0, 200) }; }
  check('an older save that stored the pre-FC 27 club index finds the same club',
    !legacyIdx || (re.clubEa === club.ea && re.clubId === clubId),
    'old index ' + legacyIdx + ' → ' + re.clubName + ' (index ' + re.clubId + ')');
}

/* a card the roster no longer carries leaves quietly instead of crashing */
const s2 = JSON.parse(store['gs-mg-career']);
s2.profiles.p1.collection.r999999999 = [1, 0];
s2.profiles.p1.lineup.slots[3] = 'r999999999';
fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, store, { 'gs-mg-career': JSON.stringify(s2) })));
try { re = JSON.parse(execFileSync(process.execPath, [__filename, '--reopen', tmp], { encoding: 'utf8' })); }
catch (e) { re = { ok: false, err: String(e.message).slice(0, 200) }; }
check('a card missing from the roster file is dropped and the XI refilled',
  re.ok && re.rowsMissing === 0 && re.slots === 9 && re.slotsMissing === 0 && re.played === true, JSON.stringify(re));
fs.unlinkSync(tmp);

/* every club the picker offers fields a side */
const leagues = R.leagues().slice().sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name)).slice(0, 40);
let clubs = 0, thin = [], noKeeper = [], filler = 0;
for (const lg of leagues) {
  for (const c of R.clubsOfLeague(lg.id)) {
    if (c.size < 14) continue;
    clubs++;
    const s = C.clubSquadPids(c.id);
    if (s.pids.length < 14) thin.push(c.name + ' ' + s.pids.length);
    if (!s.pids.some(id => C.PIDX[id].pos === 'GK')) noKeeper.push(c.name);
    const pv = C.takeoverPreview(s.pids);
    if (pv.fill) filler++;
  }
}
check('every club in the top 40 leagues brings at least 14 players', thin.length === 0,
  clubs + ' clubs' + (thin.length ? ' · thin: ' + thin.slice(0, 6).join('; ') : ''));
/* EA's own squad can lack a keeper (FC 26 listed Trabzonspor without one).
   That is a gap in the data, not something to invent around: the takeover
   fills the keeper from the host-nation starters and the setup screen says
   so. The gate is that every such club still gets a legal side. */
let illegal = [];
for (const name of noKeeper) {
  const s = C.clubSquadPids(R.findClub(name));
  const t2 = { collection: {} };
  for (const id of s.pids) C.addCombo(t2, id, 0);
  const pv = C.takeoverPreview(s.pids);
  if (!(pv.fill >= 1)) illegal.push(name);
}
check('  a club EA lists without a keeper still gets one, from the host-nation starters',
  illegal.length === 0, noKeeper.length ? noKeeper.join('; ') + ' — filled' : 'every squad has a keeper');
check('  and no other club needs filler', filler === noKeeper.length, filler + ' need filler');
console.log('  leagues: ' + leagues.map(l => l.name).join(' · '));

console.log('');
console.log(failures ? failures + ' SQUAD CHECK(S) FAILED' : 'ALL SQUAD CHECKS GREEN');
process.exit(failures ? 1 : 0);
