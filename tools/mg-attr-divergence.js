#!/usr/bin/env node
/*
 * mg-attr-divergence.js — the attribute layer has ONE implementation.
 *
 * tools/build_mg_data.py generates every card's 34 sub-attributes, six faces,
 * role, badges and the eight engine deltas into mg-manager-data.js.
 * gibson/web/static/mg-manager.js READS them. This script proves the two
 * cannot disagree, because there is nothing in the runtime left to disagree
 * with — and it fails loudly the moment somebody re-adds a second copy.
 *
 * It used to be the other way round: the runtime carried a hand-tuned copy of
 * the whole generator, and the two had drifted until they disagreed about
 *   791 / 873 cards (90.6%) on at least one sub-attribute
 *   315 / 873 cards (36.1%) on a displayed face
 *    98 / 873 cards (11.2%) on which badges the card holds
 * Run with --history to print the causes that produced those numbers.
 *
 * Usage: node tools/mg-attr-divergence.js [--history] [--verbose]
 * Exit 0 = zero divergence.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATIC = path.join(__dirname, '..', 'gibson', 'web', 'static');
globalThis.window = globalThis;
require(path.join(STATIC, 'mg-manager-data.js'));
require(path.join(STATIC, 'mg-manager.js'));
const D = window.MG_DATA;
const C = window.MG_CAREER;
if (!D || !C) { console.error('mg-attr-divergence: game files did not load'); process.exit(2); }

const AD = D.attributes, BD = D.badges;
const SUBS = AD.subs, IX = {}; SUBS.forEach((s, i) => { IX[s] = i; });
const PIDX = C.PIDX, ATTR = C.ATTR;
const args = process.argv.slice(2);
const verbose = args.indexOf('--verbose') >= 0;

const fails = [];
const F = (m) => fails.push(m);
let nCards = 0;

/* ---- 1. the runtime returns the data, exactly ---------------------------- */
let subMiss = 0, faceMiss = 0, deltaMiss = 0, archMiss = 0;
const ex = { sub: [], face: [], delta: [], arch: [] };
for (const pid of Object.keys(AD.values)) {
  const row = PIDX[pid];
  if (!row) { F('data carries ' + pid + ' but PIDX does not'); continue; }
  nCards++;
  const a = ATTR.attrOf(row);
  if (!a) { F('runtime has no attributes for ' + pid); continue; }
  const want = AD.values[pid];
  for (let i = 0; i < SUBS.length; i++)
    if (a.A[SUBS[i]] !== want[i]) {
      subMiss++;
      if (ex.sub.length < 5) ex.sub.push(pid + '.' + SUBS[i] + ' data=' + want[i] + ' runtime=' + a.A[SUBS[i]]);
      break;
    }
  const order = row.pos === 'GK' ? AD.faceOrder.GK : AD.faceOrder.OUT;
  const gotF = order.map(f => Math.round(a.faces[f]));
  if (gotF.join(',') !== AD.faces[pid].join(',')) {
    faceMiss++;
    if (ex.face.length < 5) ex.face.push(pid + ' data=' + AD.faces[pid].join('/') + ' runtime=' + gotF.join('/'));
  }
  const wd = AD.deltas[pid];
  const gd = AD.deltaOrder.map(k => Math.round(a.d[k] * AD.deltaScale));
  if (wd.join(',') !== gd.join(',')) {
    deltaMiss++;
    if (ex.delta.length < 5) ex.delta.push(pid + ' data=' + wd.join('/') + ' runtime=' + gd.join('/'));
  }
  if (a.arch !== (row.x && row.x.a)) {
    archMiss++;
    if (ex.arch.length < 5) ex.arch.push(pid + ' data=' + (row.x && row.x.a) + ' runtime=' + a.arch);
  }
}
if (subMiss) F(subMiss + ' cards whose runtime sub-attributes differ from the data: ' + ex.sub.join(' | '));
if (faceMiss) F(faceMiss + ' cards whose runtime faces differ from the data: ' + ex.face.join(' | '));
if (deltaMiss) F(deltaMiss + ' cards whose runtime deltas differ from the data: ' + ex.delta.join(' | '));
if (archMiss) F(archMiss + ' cards whose runtime role differs from the data: ' + ex.arch.join(' | '));

/* ---- 2. badges: the runtime shows the generated set, unchanged ----------- */
let badgeMiss = 0; const bex = [];
for (const pid of Object.keys(AD.values)) {
  const want = (BD.byPlayer[pid] || []).join(',');
  const got = C.badgesOf({ cb: {} }, pid).map(o => o.b.id).join(',');
  if (want !== got) { badgeMiss++; if (bex.length < 6) bex.push(pid + ' data=[' + want + '] runtime=[' + got + ']'); }
}
if (badgeMiss) F(badgeMiss + ' cards whose runtime badges differ from the data: ' + bex.join(' | '));

/* ---- 3. the data is internally consistent (faces ARE the subs) ----------- */
let selfMiss = 0; const sex = [];
for (const pid of Object.keys(AD.values)) {
  const v = AD.values[pid], row = PIDX[pid];
  const order = row.pos === 'GK' ? AD.faceOrder.GK : AD.faceOrder.OUT;
  const want = order.map(f => {
    let s = 0;
    for (const n of Object.keys(AD.faceWeights[f])) s += AD.faceWeights[f][n] * v[IX[n]];
    return Math.round(s);
  });
  if (want.join(',') !== AD.faces[pid].join(',')) {
    selfMiss++;
    if (sex.length < 5) sex.push(pid + ' stored=' + AD.faces[pid].join('/') + ' fromSubs=' + want.join('/'));
  }
}
if (selfMiss) F(selfMiss + ' cards whose stored faces are not the rounded weighted mean of their own subs: ' + sex.join(' | '));

/* ---- 4. L2: the 34 subs reconstruct the card's own OVR ------------------- */
{
  const errs = [], over = [];
  for (const pid of Object.keys(AD.values)) {
    const row = PIDX[pid], v = AD.values[pid], W = AD.ovrWeights[row.pos];
    let rec = 0;
    for (const f of Object.keys(W)) {
      let s = 0;
      for (const n of Object.keys(AD.faceWeights[f])) s += AD.faceWeights[f][n] * v[IX[n]];
      rec += W[f] * s;
    }
    const e = rec - row.base;
    errs.push(e);
    if (Math.abs(e) > 1.0) over.push(pid + ' ' + row.pos + ' base ' + row.base + ' rec ' + rec.toFixed(2));
  }
  const m = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - m) * (b - m), 0) / errs.length);
  if (over.length) F('L2 breached on ' + over.length + ' cards: ' + over.slice(0, 6).join(' | '));
  if (sd > 0.5) F('L2 reconstruction sd ' + sd.toFixed(2) + ' > 0.5');
  if (verbose) console.log('  L2 reconstruction: mean ' + m.toFixed(3) + '  sd ' + sd.toFixed(3));
}

/* ---- 5. no second implementation may creep back in ---------------------- */
{
  const src = fs.readFileSync(path.join(STATIC, 'mg-manager.js'), 'utf8');
  const banned = [
    ['faceSolve', 'the face solve belongs to the generator'],
    ['subsFor', 'the sub spread belongs to the generator'],
    ['STAR_ARCH', 'the star role table belongs to the generator'],
    ['ARCH_BY_POS', 'the shirt-number role table belongs to the generator'],
    ['HEAD_ANCHOR', 'the heading anchor belongs to the generator'],
    ['refOf(', 'the neutral reference belongs to the generator'],
  ];
  for (const [needle, why] of banned)
    if (src.indexOf(needle) >= 0)
      F('mg-manager.js contains "' + needle + '" — ' + why + ', and a second copy is exactly what this script exists to prevent');
  /* the badge thresholds must not be retyped in JS either */
  const thresholdish = /A\.(finishing|composure|defAwareness|gkReflexes|acceleration)\s*>=/g;
  const hits = src.match(thresholdish);
  if (hits) F('mg-manager.js retypes ' + hits.length + ' badge thresholds — they live in MG_DATA.badges.catalogue');
}

/* ---- 6. the engine is actually wired to the data ------------------------ */
{
  if (!ATTR.HOOKS) F('MG_DATA.attributes.engine is missing — every hook is silently disabled');
  else {
    for (const k of ['dead', 'KC', 'CCAP', 'FINK', 'GKW', 'DPT', 'DMRK', 'GPT', 'DCAP', 'PENK', 'SAVEK', 'badgeCap'])
      if (typeof ATTR.HOOKS[k] !== 'number') F('hook constant ' + k + ' missing from the data file');
  }
  const live = Object.keys(AD.values).filter(pid => {
    const ax = C.axOf({ id: pid });
    return ax && (ax.FIN || ax.CRE || ax.MRK || ax.GKS || ax.PACE || ax.PEN || ax.DEFF);
  }).length;
  if (live < 0.5 * nCards)
    F('only ' + live + ' of ' + nCards + ' cards reach the engine with a non-zero delta — the layer is inert');
  if (verbose) console.log('  ' + live + '/' + nCards + ' cards carry a live engine delta');
  /* and a card the data does not carry must be EXACTLY neutral */
  const synth = C.axOf({ id: 'a-def1' });
  if (synth) F('a synthetic card resolved to a delta — the harness gates would move');
}

/* ---- history -------------------------------------------------------------*/
if (args.indexOf('--history') >= 0) {
  console.log('');
  console.log('WHAT THE TWO IMPLEMENTATIONS USED TO DISAGREE ABOUT');
  console.log('  1. 17 role tilt values. The generator had taken the design\'s §13 tuning');
  console.log('     pass (PAC face tilts eased on anchor/enforcer/regista/stopper, poacher');
  console.log('     finishing +6→+5, the whole headingAccuracy/jumping rework); the runtime');
  console.log('     copy had not. Every card of an affected role moved.');
  console.log('  2. HEAD_ANCHOR_ATT. The generator anchors a striker\'s heading on his');
  console.log('     PHYSICAL face; the runtime had no such step, so all 291 ATT cards');
  console.log('     differed on headingAccuracy and, through the re-centre, on the other');
  console.log('     four defending subs.');
  console.log('  3. The keeper KICKING map: 50+1.5·sho (generator, the §13.2 fix) against');
  console.log('     45+1.4·sho (runtime). All 51 keepers, up to 8 points apart.');
  console.log('  4. Six badge thresholds (target 80/80 vs 85/82, clutch 88 vs 85,');
  console.log('     relentless 86/82 vs 84/80, sweeper_keeper kicking 74 vs 82).');
  console.log('  5. Six badge IDS spelled differently (power_header vs powerhead, …), which');
  console.log('     is why the raw badge divergence read 22.5% and the like-for-like one');
  console.log('     read 11.2%.');
  console.log('  6. Python\'s round() is banker\'s and JS\'s Math.round() is half-up, and the');
  console.log('     generator rounded faces twice — worth a whole point on 8 cards.');
}

console.log('');
console.log('=== ATTRIBUTE DIVERGENCE: ' + nCards + ' fieldable cards ===');
if (!fails.length) {
  console.log('[PASS] zero divergence — the data file is the only implementation');
  process.exit(0);
}
fails.forEach(f => console.log('[FAIL] ' + f));
console.log('');
console.log(fails.length + ' failure(s)');
process.exit(1);
