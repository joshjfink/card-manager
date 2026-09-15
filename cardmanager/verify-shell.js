#!/usr/bin/env node
/* verify-shell.js — the two claims the tap suite cannot make for itself.
 *
 *  1. POINTER TRUTH. On a rotated portrait phone, a real touch at the screen
 *     position where a control is actually DRAWN must activate that control.
 *     tools/mg-tap-suite.js cannot prove this: its gamePoint() uses the naive
 *     bounding-rect ratio, which under rotate(90deg) reports the game's Y as
 *     its X — the same error the shell used to make, so the two cancel and a
 *     broken map still passes. Here the target point comes from the shell's
 *     own forward map, and the naive point is fired too, to show it misses.
 *
 *  2. SAVE ADOPTION. A legacy 'gs-mg-career' career and a legacy slot must
 *     both arrive in the cm- namespace, byte for byte, with the originals
 *     still in place.
 *
 *   node cardmanager/verify-shell.js [--page <file>] [--show]
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const pageArg = args.includes('--page') ? args[args.indexOf('--page') + 1]
  : path.join(__dirname, 'dist', 'cardmanager-stub.html');
const SHOW = args.includes('--show');
const URL_ = pathToFileURL(path.resolve(pageArg)).href;
const IPHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !SHOW,
    args: ['--mute-audio', '--hide-scrollbars', '--allow-file-access-from-files'],
  });
  try {
    /* ── 1. pointer truth ─────────────────────────────────────────── */
    console.log('\n1. POINTER TRUTH — rotated portrait phone, true map');
    let page = await browser.newPage();
    await page.setViewport(IPHONE);
    const errs = [];
    page.on('pageerror', e => errs.push(String(e && e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CM_SHELL && window.CM_SHELL.debug().state === 'play',
      { timeout: 15000 });
    await sleep(400);

    const d = await page.evaluate(() => window.CM_SHELL.debug());
    check('canvas is rotated on a portrait phone', d.rotated, JSON.stringify(d));
    check('scale clears the 0.60 phone floor (R5)', d.s >= 0.60, 's = ' + d.s);
    check('the true pointer map is active (not the legacy one)', !d.legacyMap);

    /* THREE points for the same control:
     *   truePt  — where the shell says the control is DRAWN (forward map)
     *   aimPt   — what mg-tap-suite will actually tap, i.e. the naive map
     *             applied to the AIM-SPACE probe the shell publishes
     *   naivePt — the naive map applied to the RAW game rect: the bug
     * The shell is correct only if aimPt lands on truePt and naivePt misses. */
    const target = await page.evaluate(() => {
      const h = window.__MG_HOTS.find(x => x.id === 'stub-detail');
      const g = h.game || h;
      const r = document.querySelector('#mgScrim canvas').getBoundingClientRect();
      const nf = (x, y) => ({ x: r.left + (x / 960) * r.width, y: r.top + (y / 600) * r.height });
      return { h, aim: h.aim || 'game', truePt: window.CM_SHELL.clientOf(g.cx, g.cy),
               aimPt: nf(h.cx, h.cy), naivePt: nf(g.cx, g.cy) };
    });
    const dist = Math.hypot(target.aimPt.x - target.truePt.x, target.aimPt.y - target.truePt.y);
    check('the probe is published in aim space on a rotated phone',
      target.aim === 'rot90', 'aim = ' + target.aim);
    check('the harness aim lands ON the drawn pixel (<= 1.5 px)', dist <= 1.5,
      `aim (${target.aimPt.x.toFixed(1)},${target.aimPt.y.toFixed(1)}) vs drawn `
      + `(${target.truePt.x.toFixed(1)},${target.truePt.y.toFixed(1)})  d=${dist.toFixed(2)}px`);

    await page.touchscreen.tap(target.truePt.x, target.truePt.y);
    await sleep(300);
    let screen = await page.evaluate(() => window.__MG_SCREEN);
    check('a touch at the control\'s DRAWN position activates it',
      screen === 'stub/detail',
      `true (${target.truePt.x.toFixed(0)},${target.truePt.y.toFixed(0)}) -> ${screen}`);

    /* back home, then fire the naive point and show it misses */
    await page.evaluate(() => {
      const h = window.__MG_HOTS.find(x => x.id === 'stub-back');
      const g = h.game || h;
      window.__cmBack = window.CM_SHELL.clientOf(g.cx, g.cy);
    });
    const back = await page.evaluate(() => window.__cmBack);
    await page.touchscreen.tap(back.x, back.y);
    await sleep(300);
    screen = await page.evaluate(() => window.__MG_SCREEN);
    check('BACK returns home through the true map', screen === 'stub/home', screen);

    await page.touchscreen.tap(target.naivePt.x, target.naivePt.y);
    await sleep(300);
    screen = await page.evaluate(() => window.__MG_SCREEN);
    check('the UNCORRECTED naive point does NOT hit it',
      screen === 'stub/home',
      `naive (${target.naivePt.x.toFixed(0)},${target.naivePt.y.toFixed(0)}) -> ${screen}`
      + '  <- this is the bug the shell fixes');

    check('no page or console errors during the pointer run', errs.length === 0,
      errs.slice(0, 3).join(' | '));
    await page.close();

    /* ── 2. save adoption ─────────────────────────────────────────── */
    console.log('\n2. SAVE ADOPTION — gs-mg-career* -> cm-save-slot-N');
    page = await browser.newPage();
    await page.setViewport(IPHONE);
    const CAREER = JSON.stringify({ v: 4, activeProfile: 'p1', profiles: {
      p1: { name: 'Josh', clubName: 'GIBSON PARTY FC', coins: 1234, division: 6 } } });
    const SLOT3 = JSON.stringify({ v: 4, activeProfile: 'p1', profiles: {
      p1: { name: 'Ellis', clubName: 'ELLIS UNITED', coins: 77, division: 4 } } });
    await page.evaluateOnNewDocument((a, b) => {
      localStorage.setItem('gs-mg-career', a);
      localStorage.setItem('gs-mg-career-slot-3', b);
      localStorage.setItem('gs-mg-career-bak', a);
      localStorage.setItem('gs-mg-mute', '1');
    }, CAREER, SLOT3);
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.CM_SAVE, { timeout: 15000 });
    await sleep(500);

    const store = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out[k] = Storage.prototype.getItem.call(localStorage, k);
      }
      return { store: out, log: window.CM_SAVE.log, bridged: window.CM_SAVE.bridged,
               key: window.CM_SAVE.key(), list: window.CM_SAVE.list().filter(s => s.used) };
    });
    check('gs-mg-career adopted into cm-save-slot-1',
      store.store['cm-save-slot-1'] === CAREER);
    check('gs-mg-career-slot-3 adopted into cm-save-slot-3',
      store.store['cm-save-slot-3'] === SLOT3);
    check('the game\'s own backup came across too',
      store.store['cm-save-slot-1-bak'] === CAREER);
    check('the ORIGINALS are still there (adopted, never abandoned)',
      store.store['gs-mg-career'] === CAREER
      && store.store['gs-mg-career-slot-3'] === SLOT3);
    check('the mute flag was adopted', store.store['cm-mute'] === '1');
    check('a migration log was written',
      !!(store.log && store.log.ran && store.log.adopted.length >= 3),
      store.log ? store.log.adopted.length + ' keys' : 'none');
    check('the slot list reads the adopted careers back',
      store.list.length >= 2
      && store.list.some(s => s.info && s.info.club === 'GIBSON PARTY FC')
      && store.list.some(s => s.info && s.info.club === 'ELLIS UNITED'),
      store.list.map(s => s.n + ':' + (s.info && s.info.club)).join(', '));
    check('the bridge is live, so an unextracted game writes the cm- namespace',
      store.bridged === true, 'active key ' + store.key);

    /* a second load must not migrate twice or clobber */
    await page.evaluate(() => localStorage.setItem('cm-save-slot-1', 'EDITED'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.CM_SAVE, { timeout: 15000 });
    await sleep(300);
    const again = await page.evaluate(() =>
      Storage.prototype.getItem.call(localStorage, 'cm-save-slot-1'));
    check('a second boot does not re-migrate over a live save', again === 'EDITED', again);
    await page.close();
  } finally {
    await browser.close();
  }

  const bad = results.filter(r => !r.ok);
  console.log('\n' + JSON.stringify({
    result: bad.length ? 'FAIL' : 'PASS',
    checks: results.length, failed: bad.length,
  }));
  process.exit(bad.length ? 1 : 0);
})().catch(err => { console.error('verify-shell fatal:', err && err.stack || err); process.exit(1); });
