#!/usr/bin/env node
/*
 * mg-roster-audit.js — proves gibson/web/static/mg-roster.js.
 *
 * Loads the album layer (mg-manager-data.js) and the roster layer onto a fake
 * window, then reports: counts, file size, the merge, ten clubs with their
 * best XI, and a field-by-field re-read of random players against the raw
 * data/ea/page-*.json they came from — including all 40 stats through the
 * lazy accessor.
 *
 * Usage: node tools/mg-roster-audit.js [--spot 200] [--seed 7] [--quiet]
 * Exit 0 = every check passed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(ROOT, 'gibson', 'web', 'static');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const SPOT = +arg('--spot', 200);
let seed = +arg('--seed', 7) >>> 0;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

const fail = [];
const check = (name, ok, detail) => {
  if (!ok) fail.push(name + (detail ? ' — ' + detail : ''));
  return ok;
};
const KB = (b) => (b / 1024).toFixed(1) + ' KB';

/* ---------- load ---------------------------------------------------------- */
global.window = global;
const dataPath = path.join(STATIC, 'mg-manager-data.js');
const rosterPath = path.join(STATIC, 'mg-roster.js');
const dataSrc = fs.readFileSync(dataPath, 'utf8');
const rosterSrc = fs.readFileSync(rosterPath, 'utf8');

let t = process.hrtime.bigint();
(0, eval)(dataSrc);
const tData = Number(process.hrtime.bigint() - t) / 1e6;
t = process.hrtime.bigint();
(0, eval)(rosterSrc);
const tRoster = Number(process.hrtime.bigint() - t) / 1e6;
const R = global.MG_ROSTER;
check('window.MG_ROSTER exists', !!R);
if (!R) { console.error('FAIL: no MG_ROSTER'); process.exit(1); }

const rawBytes = Buffer.byteLength(rosterSrc);
const gzBytes = zlib.gzipSync(Buffer.from(rosterSrc), { level: 9 }).length;

console.log('=== SIZE ===');
console.log(`  mg-roster.js        ${KB(rawBytes)} raw (${(rawBytes / 1048576).toFixed(2)} MB) · ${KB(gzBytes)} gzip`);
console.log(`  mg-manager-data.js  ${KB(Buffer.byteLength(dataSrc))} raw · ${KB(zlib.gzipSync(Buffer.from(dataSrc), { level: 9 }).length)} gzip  (untouched by this crew)`);
console.log(`  parse+eval          roster ${tRoster.toFixed(1)} ms · album ${tData.toFixed(1)} ms`);
check('under 3 MB uncompressed', rawBytes < 3 * 1024 * 1024, KB(rawBytes));

/* ---------- laziness ------------------------------------------------------ */
const boot = R._state();
console.log('\n=== LAZY AT BOOT ===');
console.log('  ' + JSON.stringify(boot));
check('boot deserialises nothing',
  !boot.names && !boot.search && !boot.squads && !boot.cards && boot.players === 0 && boot.statBlocks === 0,
  JSON.stringify(boot));

/* ---------- counts -------------------------------------------------------- */
console.log('\n=== COUNTS ===');
console.log('  players ' + R.count.players + ' | clubs ' + R.count.clubs +
            ' | leagues ' + R.count.leagues + ' | nations ' + R.count.nations);
console.log('  stat keys ' + R.statKeys.length + ' | positions ' + R.positions.length +
            ' | playstyles ' + R.raw.abl.length);
console.log('  honesty: ' + R.notice);

/* ---------- the merge ----------------------------------------------------- */
const m = R.merge;
console.log('\n=== MERGE (album × EA) ===');
console.log('  album people ' + m.people + ' · matched ' + m.matched +
            ' (' + (100 * m.matched / m.people).toFixed(1) + '%) · unmatched ' + m.unmatched);
console.log('  by tier: ' + JSON.stringify(m.byTier));
console.log('  rule: ' + m.rule);
console.log('  sample merges:');
m.sample.slice(0, 8).forEach(s => console.log(
  `    ${s.card.padEnd(7)} ${s.name.padEnd(24)} ${String(s.nation)}  →  EA #${s.ea.ea} ${s.ea.name} (${s.ea.nation}, ${s.ea.club || 'no club'}, OVR ${s.ea.ovr})  [${s.tier}]`));
const weak = m.weak || [];
console.log(`  merges that were not exact name+nation: ${weak.length} (${weak.filter(x => x.xnat).length} cross-nation dual nationals) — every one of them:`);
weak.forEach(s => console.log(
  `    ${s.card.padEnd(7)} ${s.name.padEnd(25)} ${s.nation}  →  ${String(s.ea.name).padEnd(23)} (${s.ea.nation}, OVR ${s.ea.ovr})  [${s.tier}${s.xnat ? ', cross-nation' : ''}]`));
console.log('  rejected (near misses kept out on purpose):');
m.rejected.slice(0, 10).forEach(s => console.log(
  `    ${s.card.padEnd(7)} ${s.name.padEnd(24)} ${s.nation}  ✗ ${s.why}` +
  (s.saw && s.saw.length ? '  [saw: ' + s.saw.map(x => `${x.name} ${x.nation} ${x.ovr}`).join(' | ') + ']' : '')));

/* every merged card resolves both ways */
let bad = 0, sampled = 0;
const cards = R.raw.cards.split(' ');
for (const row of cards) {
  const [sid, pid] = row.split(':');
  const p = R.byCard(sid);
  if (!p || p.id !== +pid || p.card !== sid) bad++;
  sampled++;
}
check('every merged card round-trips through byCard()', bad === 0, bad + ' of ' + sampled);
console.log('  byCard/cardOf round-trip: ' + (sampled - bad) + '/' + sampled + ' ok');

/* an unmerged album card still answers, from MG_DATA, marked album-only */
const albumOnly = m.rejected.find(r => r.why.indexOf('no EA player') === 0);
if (albumOnly) {
  const a = R.byCard(albumOnly.card);
  check('unmerged album card still resolves as album-only',
    !!a && a.source === 'album' && a.id === null, albumOnly.card);
  console.log(`  album-only card ${albumOnly.card}: ${a && a.name} (${a && a.source}, album OVR ${a && a.ovr})`);
}

/* ---------- ten clubs and their best XI ---------------------------------- */
console.log('\n=== TEN CLUBS · BEST XI (4-3-3, from real squads) ===');
const wanted = ['Liverpool', 'Real Madrid', 'FC Barcelona', 'Paris SG', 'Manchester City',
                'FC Bayern München', 'Inter Miami CF', 'Ajax', 'Boca Juniors', 'Al Nassr'];
const shown = [];
for (const name of wanted) {
  const ci = R.findClub(name);
  if (ci === null) { console.log('  (no club named ' + name + ')'); continue; }
  const c = R.club(ci);
  shown.push(c);
  const xi = R.bestXI(ci, '4-3-3');
  const line = xi.map(p => `${p.slot} ${p.short}${p.outOfPosition ? '*' : ''} ${p.ovr}`).join(', ');
  console.log(`  ${c.label} — squad ${c.size} · strength ${c.strength} · EA team ${c.ea}`);
  console.log(`    ${line}`);
  check('XI is 11 for ' + name, xi.length === 11, String(xi.length));
  check('XI has one keeper for ' + name, xi.filter(p => p.pos === 'GK' && !p.outOfPosition).length >= 1);
}

/* ---------- graph sanity -------------------------------------------------- */
console.log('\n=== GRAPH ===');
let squadTotal = 0, clubless = R.count.clubless;
for (let i = 0; i < R.count.clubSlots; i++) squadTotal += R.squadIds(i).length;
check('every player sits in exactly one club bucket', squadTotal === R.count.players,
  squadTotal + ' vs ' + R.count.players);
let leagueClubTotal = 0, leaguePlayerTotal = 0;
for (let i = 0; i < R.count.leagueSlots; i++) {
  leagueClubTotal += R.clubsOfLeague(i, { ids: 1 }).length;
  leaguePlayerTotal += R.playersOfLeague(i, { ids: 1 }).length;
}
check('every club sits in exactly one league bucket', leagueClubTotal === R.count.clubSlots,
  leagueClubTotal + ' vs ' + R.count.clubSlots);
check('every player sits in exactly one league bucket', leaguePlayerTotal === R.count.players,
  leaguePlayerTotal + ' vs ' + R.count.players);
check('club 0 is the synthetic no-club slot', R.club(0).synthetic === true);
console.log('  players with no club in EA\'s public feed: ' + clubless +
            ' (unlicensed clubs — they keep their real league)');
const top = R.leagues().filter(l => l.clubs).sort((a, b) => b.strength - a.strength).slice(0, 6);
console.log('  strongest leagues: ' + top.map(l => `${l.name} ${l.strength} (${l.clubs} clubs)`).join(' · '));
const bigClubs = R.clubs().sort((a, b) => b.strength - a.strength).slice(0, 6);
console.log('  strongest clubs:   ' + bigClubs.map(c => `${c.label} ${c.strength}`).join(' · '));

/* ---------- search -------------------------------------------------------- */
console.log('\n=== SEARCH ===');
for (const q of ['salah', 'mbappe', 'ødegaard', 'de bruyne', 'yamal']) {
  const hit = R.search(q, 3);
  console.log(`  "${q}" → ` + hit.map(p => `${p.name} (${p.ovr}, ${p.clubName})`).join(' · '));
  check('search finds ' + q, hit.length > 0);
}

/* ---------- the spot check: raw EA JSON vs the packed roster ------------- */
console.log('\n=== SPOT CHECK vs data/ea/page-*.json ===');
const pages = fs.readdirSync(path.join(ROOT, 'data', 'ea')).filter(f => /^page-\d+\.json$/.test(f)).sort();
const byEa = new Map();
for (const f of pages) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ea', f), 'utf8'));
  for (const it of j.items) byEa.set(it.id, it);
}
check('audit sees the same population', byEa.size === R.count.players, byEa.size + ' vs ' + R.count.players);

const picks = [];
for (let i = 0; i < SPOT; i++) picks.push(Math.floor(rnd() * R.count.players));
picks.push(0, 1, 2, R.count.players - 1);
let fields = 0, statsChecked = 0, mismatch = [];
for (const id of picks) {
  const p = R.byId(id);
  const it = byEa.get(p.ea);
  if (!it) { mismatch.push(`id ${id}: no raw record for ea ${p.ea}`); continue; }
  const eq = (what, a, b) => { fields++; if (a !== b) mismatch.push(`${p.name} [${id}] ${what}: ${a} != ${b}`); };
  eq('ovr', p.ovr, it.overallRating);
  eq('rank', p.rank, it.rank);
  eq('first', p.first, it.firstName || '');
  eq('last', p.last, it.lastName || '');
  eq('common', p.common, it.commonName || '');
  eq('pos', p.pos, it.position.shortLabel);
  eq('club', p.clubName, (it.team && it.team.label) || '(no club listed)');
  eq('league', p.leagueName, it.leagueName);
  eq('nation', p.nationName, it.nationality.label);
  eq('height', p.height, it.height);
  eq('weight', p.weight, it.weight);
  eq('foot', p.foot, it.preferredFoot === 2 ? 'L' : 'R');
  eq('skill', p.skill, it.skillMoves);
  eq('weak', p.weak, it.weakFootAbility);
  eq('gender', p.gender, it.gender.id === 1 ? 'W' : 'M');
  eq('alt', p.alt.join(','), (it.alternatePositions || []).map(a => a.shortLabel).join(','));
  eq('playstyles', p.playstyles.map(x => x.label).join(','), (it.playerAbilities || []).map(a => a.label).join(','));
  const bd = /^(\d+)\/(\d+)\/(\d{4})/.exec(it.birthdate);
  if (bd) { eq('born.y', p.born.y, +bd[3]); eq('born.m', p.born.m, +bd[1]); eq('born.d', p.born.d, +bd[2]); }
  const st = R.stats(id);
  for (const k of R.statKeys) {
    statsChecked++; fields++;
    const want = it.stats[k].value;
    if (st[k] !== want) mismatch.push(`${p.name} [${id}] stat ${k}: ${st[k]} != ${want}`);
    if (R.stat(id, k) !== want) mismatch.push(`${p.name} [${id}] stat(id,'${k}'): ${R.stat(id, k)} != ${want}`);
  }
}
console.log(`  ${picks.length} players · ${fields} fields compared · ${statsChecked} stat values through the lazy accessor`);
check('every spot-checked field matches the raw EA JSON', mismatch.length === 0,
  mismatch.slice(0, 6).join(' ; '));
if (mismatch.length) mismatch.slice(0, 10).forEach(x => console.log('   MISMATCH ' + x));
else console.log('  all match, byte for byte');

/* full-population stat sweep (cheap enough to be honest about) */
let sweepBad = 0;
for (const [ea, it] of byEa) {
  const p = R.byEaId(ea);
  if (!p) { sweepBad++; continue; }
  if (p.ovr !== it.overallRating) sweepBad++;
}
check('all 17k OVRs match by EA id', sweepBad === 0, String(sweepBad));
console.log('  full sweep: every EA id resolves and its OVR matches (' + byEa.size + ' players)');

/* one named player, printed in full, so a human can eyeball it */
const salah = R.search('mohamed salah', 1)[0];
if (salah) {
  const s = R.stats(salah.id);
  console.log(`\n  ${salah.name} — ${salah.pos} · ${salah.clubName} (${salah.leagueName}) · ${salah.nationName}` +
    ` · OVR ${salah.ovr} · ${salah.height}cm ${salah.weight}kg · ${salah.foot} foot · ${salah.skill}★ skills / ${salah.weak}★ weak` +
    ` · age ${salah.age} · card ${salah.card || '—'}`);
  console.log(`    faces  pac ${s.pac} sho ${s.sho} pas ${s.pas} dri ${s.dri} def ${s.def} phy ${s.phy}` +
    ` · finishing ${s.finishing} · composure ${s.composure} · playstyles ${salah.playstyles.map(x => x.label).join(', ')}`);
}

/* ---------- timing -------------------------------------------------------- */
console.log('\n=== TIMING (lazy paths, first call builds the index) ===');
const time = (label, fn) => {
  const a = process.hrtime.bigint(); const v = fn();
  console.log(`  ${label.padEnd(34)} ${(Number(process.hrtime.bigint() - a) / 1e6).toFixed(2)} ms`);
  return v;
};
const fresh = () => { delete global.MG_ROSTER; (0, eval)(rosterSrc); return global.MG_ROSTER; };
let F = fresh();
time('first byId()', () => F.byId(4321));
time('first stats() (builds nothing else)', () => F.stats(4321));
time('10k stats() over random players', () => { for (let i = 0; i < 10000; i++) F.stats(Math.floor(rnd() * F.count.players)); });
F = fresh();
time('first playersOfClub() (squad index)', () => F.playersOfClub('Liverpool'));
time('next playersOfClub()', () => F.playersOfClub('Real Madrid'));
F = fresh();
time('first search() (folds 17.8k names)', () => F.search('haaland'));
time('next search()', () => F.search('vinicius'));
console.log('  state after that run: ' + JSON.stringify(F._state()));

/* ---------- verdict ------------------------------------------------------- */
console.log('\n=== VERDICT ===');
if (fail.length) { fail.forEach(f => console.log('  FAIL ' + f)); console.log(`  ${fail.length} check(s) failed`); process.exit(1); }
console.log('  all checks passed');
