#!/usr/bin/env node
/*
 * mg-save-test.js — the CLOUD SAVE proof (addendum 23).
 *
 * Loads the real game files headlessly and proves, without a browser:
 *   S1  the compressor is lossless on adversarial bytes
 *   S2  career -> save code -> career is byte-identical (a rich career:
 *       hundreds of cards, eight seasons, materials, history, dynasty)
 *   S3  an OLD-VERSION save (v2, from tools/fixtures/saves-v2/) restores
 *       through the code path and MIGRATES — every v2 key survives
 *   S4  a save from a FUTURE version is refused, not eaten
 *   S5  damage is detected and explained, never crashed on
 *   S6  the .gsave envelope round-trips, and import accepts a bare career,
 *       a bare code and our own file
 *   S7  the backup ring keeps the last N per slot and restores one
 *   S8  size report — the number the owner asked for, in KB
 *
 * Usage: node tools/mg-save-test.js [--json]
 * Exit 0 only if every check passes.
 */
'use strict';
const path = require('path');
const fs = require('fs');

/* ---- a browser-shaped host: window + a localStorage that behaves ------- */
globalThis.window = globalThis;
const MEM = new Map();
globalThis.localStorage = {
  get length() { return MEM.size; },
  key(i) { return Array.from(MEM.keys())[i]; },
  getItem(k) { return MEM.has(String(k)) ? MEM.get(String(k)) : null; },
  setItem(k, v) {
    if (globalThis.__quota != null) {
      let used = 0;
      for (const [kk, vv] of MEM) used += kk.length + vv.length;
      const cur = MEM.has(String(k)) ? String(k).length + MEM.get(String(k)).length : 0;
      if (used - cur + String(k).length + String(v).length > globalThis.__quota) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
    }
    MEM.set(String(k), String(v));
  },
  removeItem(k) { MEM.delete(String(k)); },
  clear() { MEM.clear(); },
};

const STAT = (f) => path.join(__dirname, '..', 'gibson', 'web', 'static', f);
for (const f of ['mg-manager-data.js', 'mg-manager.js']) {
  try { require(STAT(f)); }
  catch (e) { console.error('failed to load ' + f + ': ' + (e && e.stack || e)); process.exit(2); }
}
const C = window.MG_CAREER;
if (!C) { console.error('window.MG_CAREER missing — the career layer did not load'); process.exit(2); }
if (!C.packCode) { console.error('MG_CAREER.packCode missing — cloud save not present'); process.exit(2); }

/* ---- tiny check harness ------------------------------------------------ */
const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : ''));
}
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

/* ---- a rich career: this is the save the owner would hate to lose ------ */
function richCareer(comboCount, meteredCount, seasons) {
  const p = C.freshProfile('Gibson');
  p.clubName = 'TURBO DRAGONS';
  p.crest = 6; p.colors = ['#2f8f52', '#e9bf63'];
  p.coins = 18420; p.blackLicence = true; p.division = 1; p.pseed = 2796048327;
  p.season = { n: seasons + 1, seed: 991, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
  const pids = C.ALBUM_PIDS;
  let combos = 0;
  for (let i = 0; i < pids.length && combos < comboCount; i++) {
    const tiers = 1 + (i % 4);
    for (let t = 0; t < tiers && combos < comboCount; t++) { C.addCombo(p, pids[i], t); combos++; }
  }
  const metered = pids.slice(0, meteredCount);
  metered.forEach((pid, i) => {
    p.apps[pid] = 3 + (i % 90);
    p.xp[pid] = 100 * p.apps[pid] + (i % 97);
    p.mastery[pid] = i % 4;
    p.quests[pid] = [i % 4, i % 11];
    p.gls[pid] = i % 31;
    p.form[pid] = (i % 3) - 1;
    p.bs[pid] = i % 9;
    p.vd[pid] = (i % 7) - 3;
    if (i % 3 === 0) p.disc[pid] = 0.05 * (i % 7);
    if (i % 2 === 0) p.energy[pid] = 40 + (i % 60);
    if (i < 80) { p.rc[pid] = [6.1 * (3 + i % 20), 3 + i % 20]; p.vh[pid] = [11, 13, 12, 19, 24, 22]; }
  });
  /* addendum 19's materials — the codec must not care what the schema is */
  p.shards = {}; metered.slice(0, 60).forEach((pid, i) => { p.shards[pid] = i % 17; });
  p.tp = 4210; p.cat = [3, 2, 2, 1, 1, 0];
  p.coaches = ['climb', 'fitness'];
  p.plan = [{ focus: 'climb', pid: pids[0] }, { focus: 'sharp', pid: pids[3] }, null];
  p.lineup = { formation: '3-3-2',
               slots: pids.slice(0, 9), bench: pids.slice(9, 13) };
  p.tactics = { mentality: 'attacking', talk: 'fired',
                calls: { lead: 'shut', level: 'push', trail: 'push' }, penTaker: pids[7] };
  for (let s = 1; s <= seasons; s++) {
    p.history.push({ season: s, div: Math.max(1, 6 - s), pos: 1 + (s % 6), pts: 30 + s,
                     w: 8 + (s % 5), d: 2, l: 4, gf: 30 + s, ga: 18, cup: s % 2 ? 'won' : 'semi',
                     cl: s > 3 ? 'final' : '—', coins: 900 + s * 40, avgR: 6.7 + (s % 9) / 10 });
  }
  for (let i = 0; i < 5; i++) {
    p.dynasty.sales.push({ pid: pids[i], tier: 4, club: 'alg', coins: 900 + i, season: i });
    p.dynasty.loans.push({ pid: pids[i + 5], club: 'mar', apps: 12, avg: 7.1, season: i, fee: 40 });
  }
  for (let i = 0; i < 12; i++) p.dynasty.hof.push({ pid: pids[i], season: i, avg: 7.4, apps: 16 });
  p.trophies = { div1: 3, cup: 2, cl: 1, promos: 5 };
  p.lifetime = { played: 412, won: 261, drawn: 71, lost: 80, goals: 903 };
  p.counters = { wins: 261, matches: 412, cleanSheets: 90, winStreak: 7,
                 csWinStreak: 3, goals: 903, packsOpened: 214, hotseat: 12 };
  p.unlocked = ['gibson', 'ellis', 'caruso', 'phoenix'];
  p.featsDone = ['clean-5', 'wall-3', 'season-done'];
  p.scouted = ['alg', 'mar', 'usa', 'mex'];
  p.know = { alg: 5, mar: 3, usa: 4, mex: 2 };
  p.pk = {}; metered.slice(0, 40).forEach((pid, i) => { p.pk[pid] = 1 + (i % 2); });
  p.mail = [{ id: 'x1', title: 'A BIG CLUB CIRCLES', body: 'Suárez FC want your Yamal — “name your price”.' }];
  p.rivals = { alg: 3, mar: 1 };
  p.offers = [{ kind: 'sale', pid: pids[2], tier: 3, club: 'bra', coins: 1900, expires: 4 }];
  p.trades = [{ mine: [pids[4], 2], theirs: [pids[40], 3], club: 'uru', season: 3 }];
  p.loans = [{ pid: pids[19], tier: 1, club: 'alg', from: 2 }];
  const p2 = C.freshProfile('Ellis');
  p2.clubName = 'COSMIC UNITED'; p2.coins = 1200;
  p2.season = { n: 2, seed: 77, results: [], clRes: [], cupRes: [], rsum: {}, attempt: 0 };
  pids.slice(0, 40).forEach((pid, i) => { C.addCombo(p2, pid, i % 3); p2.apps[pid] = i; });
  return { v: C.SAVE_V, createdAt: 1750000000000, updatedAt: 1788032299573,
           activeProfile: 'p1', profiles: { p1: p, p2 } };
}

/* ================= S1 — the compressor itself ========================== */
{
  const cases = [
    ['empty', ''],
    ['one byte', 'x'],
    ['all-same', 'a'.repeat(9000)],
    ['json-ish', JSON.stringify({ a: [1, 2, 3], b: { c: 'hello '.repeat(400) } })],
    ['accents', '{"club":"Peñarol · Vinícius · São Paulo — ✅","n":' + '1234567890'.repeat(50) + '}'],
    ['high bytes', Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 0x2f00 + 32)).join('')],
  ];
  let bad = null;
  for (const [name, s] of cases) {
    const raw = C.utf8Bytes(s);
    let ascii = true;
    for (let i = 0; i < raw.length; i++) if (raw[i] > 127) { ascii = false; break; }
    const dict = C.utf8Bytes('');
    const packed = C.lzCompress(raw, dict, ascii);
    const back = C.lzDecompress(packed, raw.length, dict, ascii);
    if (C.utf8Str(back) !== s) bad = name;
  }
  check('S1 the compressor is lossless (empty, repetitive, JSON, accented, high-byte)',
    !bad, bad ? 'first failure: ' + bad : '6 shapes round-tripped byte for byte');
}

/* ================= S2 — the round trip that matters ==================== */
let bigSave = null, bigCode = null;
{
  bigSave = richCareer(900, 500, 8);
  const json = JSON.stringify(bigSave);
  const t0 = Date.now();
  bigCode = C.packCode(json);
  const tPack = Date.now() - t0;
  const t1 = Date.now();
  const r = C.unpackCode(bigCode);
  const tUnpack = Date.now() - t1;
  const same = r.ok && JSON.stringify(r.save) === json;
  check('S2 a rich career survives code -> save -> code with nothing changed', same,
    (r.ok ? '' : 'unpack said: ' + r.why + ' · ')
    + '900 combos · 500 metered cards · 8 seasons · 2 managers · materials · '
    + kb(json.length) + ' of JSON -> ' + kb(bigCode.length) + ' of code'
    + ' (x' + (json.length / bigCode.length).toFixed(1) + ') · pack ' + tPack + 'ms · open ' + tUnpack + 'ms');
  /* and the code of a restored career is the same code again */
  if (r.ok) {
    const again = C.packCode(JSON.stringify(r.save));
    check('S2b re-coding a restored career gives the identical code', again === bigCode,
      again === bigCode ? 'stable, so a code can be handed on and on' : 'code drifted on the second pass');
  }
}

/* ================= S3 — an OLD save still opens ======================== */
{
  const dir = path.join(__dirname, 'fixtures', 'saves-v2');
  let lost = null, done = 0, from = null;
  for (const f of ['fresh', 'mid-s1', 'five-season']) {
    let rawTxt;
    try { rawTxt = fs.readFileSync(path.join(dir, f + '.json'), 'utf8'); } catch (e) { continue; }
    const v2 = JSON.parse(rawTxt);
    /* a code MADE BY THE OLD BUILD: v2 JSON inside a GSAVE1 envelope */
    const code = C.packCode(rawTxt);
    const r = C.unpackCode(code);
    if (!r.ok) { lost = f + ': ' + r.why; break; }
    done++; from = r.from;
    if (r.save.v !== C.SAVE_V) { lost = f + ': did not migrate (v' + r.save.v + ')'; break; }
    for (const k of Object.keys(v2.profiles)) {
      const o = v2.profiles[k], n = r.save.profiles[k];
      if (!o) continue;
      for (const key of Object.keys(o)) {
        if (key === 'tactics') {
          for (const t of Object.keys(o.tactics || {}))
            if (JSON.stringify(o.tactics[t]) !== JSON.stringify(n.tactics[t])) lost = f + '.' + k + '.tactics.' + t;
          continue;
        }
        if (key === 'offers') {
          (o.offers || []).forEach((oo, oi) => {
            for (const t of Object.keys(oo))
              if (JSON.stringify(oo[t]) !== JSON.stringify((n.offers[oi] || {})[t]))
                lost = f + '.' + k + '.offers[' + oi + '].' + t;
          });
          continue;
        }
        if (JSON.stringify(o[key]) !== JSON.stringify(n[key])) lost = f + '.' + k + '.' + key;
      }
    }
    if (lost) break;
  }
  check('S3 a code holding an OLD (v' + from + ') save restores and migrates, losing nothing',
    !lost && done === 3, lost ? 'LOST ' + lost : done + '/3 v2 fixture careers -> v' + C.SAVE_V
      + ', every v2 key value-identical after migration');
}

/* ================= S4 — a future save is refused, not eaten ============ */
{
  const futureTxt = fs.readFileSync(path.join(__dirname, 'fixtures', 'saves-v2', 'future-v9.json'), 'utf8');
  const r = C.unpackCode(C.packCode(futureTxt));
  const ok = !r.ok && /newer version/i.test(r.why) && !r.save;
  check('S4 a career from a NEWER version is refused with an explanation, never overwritten',
    ok, 'v9 code -> "' + (r.why || '') + '"');
}

/* ================= S5 — damage says so ================================= */
{
  const flip = bigCode.slice(0, 200) + (bigCode[200] === 'A' ? 'B' : 'A') + bigCode.slice(201);
  const cut = bigCode.slice(0, Math.floor(bigCode.length / 2));
  const junk = 'GSAVE1:not a real code at all:END';
  const prose = 'here is my save, hope it works';
  const rFlip = C.unpackCode(flip), rCut = C.unpackCode(cut), rJunk = C.unpackCode(junk), rPro = C.unpackCode(prose);
  const allRefused = !rFlip.ok && !rCut.ok && !rJunk.ok && !rPro.ok;
  const allPlain = [rFlip, rCut, rJunk, rPro].every(r => r.why && r.why.length > 20 && !/undefined|Error|null/.test(r.why));
  check('S5 a mangled, truncated, junk or prose paste is refused in plain English',
    allRefused && allPlain,
    'flipped: "' + rFlip.why + '" · truncated: "' + rCut.why + '" · not-a-code: "' + rPro.why + '"');
  /* and a code with line breaks in it (an email client wrapped it) still opens */
  const wrapped = bigCode.replace(/(.{72})/g, '$1\n');
  const rw = C.unpackCode(wrapped);
  check('S5b a code that got line-wrapped on the way still opens',
    rw.ok && JSON.stringify(rw.save) === JSON.stringify(bigSave),
    'wrapped at 72 columns, ' + (bigCode.length / 72 | 0) + ' lines');
  /* and one pasted with prose around it */
  const messy = 'my save is:\n\n' + bigCode + '\n\nlet me know if it works';
  const rm = C.unpackCode(messy);
  check('S5c a code pasted inside a message still opens', rm.ok, rm.ok ? 'prose either side ignored' : rm.why);
}

/* ================= S6 — the file =========================== */
{
  const env = C.exportEnvelope(bigSave);
  const name = C.exportFileName(bigSave);
  const r = C.parseImport(env);
  const ok = r.ok && JSON.stringify(r.save) === JSON.stringify(bigSave);
  const readable = env.slice(0, 400).indexOf('"club": "TURBO DRAGONS"') > 0;
  check('S6 the .gsave file round-trips and reads like a file, not a blob', ok && readable,
    name + ' · ' + kb(env.length) + ' · header names the club and season in plain sight');
  /* the file is self-healing: break the readable half, the code half opens it */
  const broken = env.replace(/"save": \{/, '"save": {{{ this half was mangled by a text editor');
  const rb = C.parseImport(broken);
  check('S6b if the readable half of the file is edited badly, the checksummed half opens it',
    rb.ok && JSON.stringify(rb.save) === JSON.stringify(bigSave), 'fell back to the embedded code');
  /* import also accepts a bare career and a bare code */
  const rBare = C.parseImport(fs.readFileSync(path.join(__dirname, 'fixtures', 'saves-v2', 'five-season.json'), 'utf8'));
  const rCode = C.parseImport(bigCode);
  const rEmpty = C.parseImport('');
  check('S6c import accepts a bare career JSON and a bare code, and refuses an empty file',
    rBare.ok && rBare.save.v === C.SAVE_V && rCode.ok && !rEmpty.ok,
    'bare v2 career migrated · bare code opened · empty file: "' + rEmpty.why + '"');
}

/* ================= S7 — the backup ring ================================ */
{
  MEM.clear();
  const small = richCareer(60, 40, 2);
  C.setSave(JSON.parse(JSON.stringify(small)));
  const ids = [];
  for (let i = 0; i < 9; i++) {
    const s = C.getSave();
    s.profiles.p1.coins = 1000 + i;
    ids.push(C.writeBackup('test ' + i));
  }
  const list = C.listBackups();
  const kept = list.length === C.BK_KEEP;
  const newestFirst = list.length > 1 && list[0].t >= list[1].t;
  const r = C.readBackup(list[list.length - 1].id);
  const coinsOfOldestKept = r.ok ? r.save.profiles.p1.coins : null;
  check('S7 the ring keeps the last ' + C.BK_KEEP + ' backups per slot, newest first, each restorable',
    kept && newestFirst && r.ok && coinsOfOldestKept === 1004,
    list.length + ' kept of 9 written · oldest surviving backup holds coins=' + coinsOfOldestKept
    + ' (expected 1004) · rows carry club/season/coins/cards for the screen');
  const used = C.storageUsed();
  check('S7b five backups of this career cost less than one raw copy of it',
    used && used.bytes < JSON.stringify(small).length * C.BK_KEEP,
    'five codes + the live save = ' + kb(used.bytes) + ' across ' + used.keys
    + ' keys · one raw copy alone is ' + kb(JSON.stringify(small).length));
  /* a corrupt live save is not fatal: the backups are still there */
  localStorage.setItem(C.SAVE_KEY, '{this is not json');
  C.loadSave();
  const afterCorrupt = C.listBackups();
  const rr = C.readBackup(afterCorrupt[0].id);
  check('S7c after a corrupt save the backups are still listed and restorable',
    afterCorrupt.length >= C.BK_KEEP && rr.ok && rr.save.profiles.p1.clubName === 'TURBO DRAGONS',
    afterCorrupt.length + ' rows (including the raw copy loadSave kept) · newest restores to '
    + (rr.ok ? rr.save.profiles.p1.clubName : '—'));
  /* a backup that will not fit is dropped, and never breaks the real save */
  MEM.clear();
  C.setSave(JSON.parse(JSON.stringify(small)));
  globalThis.__quota = 40 * 1024;
  let threw = null;
  try { for (let i = 0; i < 6; i++) { C.writeBackup('squeeze ' + i); C.saveNow(); } }
  catch (e) { threw = String(e && e.message || e); }
  globalThis.__quota = null;
  const live = localStorage.getItem(C.SAVE_KEY);
  check('S7d under a tight quota the backups give way and the career still saves',
    !threw && live && JSON.parse(live).profiles.p1.clubName === 'TURBO DRAGONS',
    threw ? 'threw: ' + threw : 'live save intact at a 40 KB ceiling · '
      + C.listBackups().filter(r2 => !r2.raw).length + ' backups survived');
  MEM.clear();
}

/* ================= S8 — the size report ================================ */
{
  const rows = [];
  const shapes = [
    ['a brand-new career', richCareer(14, 0, 0)],
    ['a first season in progress', richCareer(60, 30, 1)],
    ['a five-season club', richCareer(240, 140, 5)],
    ['a deep dynasty (900 cards, 500 played, 8 seasons)', richCareer(900, 500, 8)],
    ['everything the game can hold (6,860 combos)', (() => {
      const s = richCareer(900, 500, 12);
      C.ALBUM_PIDS.forEach(pid => { for (let t = 0; t < 7; t++) C.addCombo(s.profiles.p1, pid, t); });
      return s;
    })()],
  ];
  for (const [name, s] of shapes) {
    const json = JSON.stringify(s);
    const t0 = Date.now();
    const code = C.packCode(json);
    const ms = Date.now() - t0;
    const back = C.unpackCode(code);
    rows.push({ name, json: json.length, code: code.length, ms,
                ok: back.ok && JSON.stringify(back.save) === json });
  }
  const allOk = rows.every(r => r.ok);
  console.log('');
  console.log('  SAVE CODE SIZE — the number the owner asked for');
  for (const r of rows) {
    console.log('    ' + r.name.padEnd(52) + kb(r.json).padStart(9) + ' of career  ->  '
      + kb(r.code).padStart(9) + ' of code   (x' + (r.json / r.code).toFixed(1) + ', ' + r.ms + 'ms)');
  }
  console.log('');
  check('S8 every career shape round-trips, and the code stays pasteable', allOk,
    'a deep dynasty is ' + kb(rows[3].code) + ' of text · a young career is ' + kb(rows[1].code));
}

console.log('---');
console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', checks: results.length, failed }));
process.exit(failed ? 1 : 0);
