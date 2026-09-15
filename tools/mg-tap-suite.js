#!/usr/bin/env node
/*
 * mg-tap-suite.js — the Gibson Party REAL-TAP test rig.
 *
 * Drives a page that hosts window.MiniGames with genuine input events
 * (touchscreen taps on touch devices, mouse clicks on desktop) through a
 * declarative tap script, and fails loudly on any page error or unmet
 * state expectation. This is how every arcade fix is proven.
 *
 *   node tools/mg-tap-suite.js --page <file-or-url>
 *       [--device iphone|android|ipad|desktop]     (default: desktop)
 *       [--script tools/tap-scripts/foo.json]      (default: boot probe)
 *       [--outdir <dir>]                           (default: ./mg-tap-shots)
 *       [--timeout <ms>]                           (default per-wait: 6000)
 *       [--show]                                   (headed, for debugging)
 *
 * Tap script = JSON array of steps, executed in order:
 *   {"tapGame": [gx, gy]}          real tap at 960x600 game coords, mapped
 *                                  through the live canvas rect (so it is
 *                                  correct at any device scale/letterboxing)
 *   {"wait": ms}                   plain sleep
 *   {"expectState": "play"}        poll MiniGames.debug().state until it
 *                                  matches (optional "timeout": ms) — a miss
 *                                  is recorded, a failure shot is taken, and
 *                                  the run continues so you see everything
 *   {"shot": "name"}               screenshot to <outdir>/<script>-<device>-<name>.png
 * Extensions (documented, used sparingly):
 *   {"key": "Escape"}              real keyboard press (arcade hotkeys)
 *   {"tapSelector": "#mgLaunch"}   real tap on a DOM element's centre
 *   {"expectScreen": "hub/binder/sheet/stats"}
 *                                  poll window.__MG_SCREEN — the game's own
 *                                  read-only screen probe — until it matches.
 *                                  A trailing "*" matches a prefix, so
 *                                  "hub/binder/sheet*" accepts any sheet tab.
 *                                  Recorded, shot and reported exactly like
 *                                  expectState; the run continues on a miss.
 *   {"tapId": "md-instant"}        real tap on the CENTRE of a NAMED control,
 *                                  read from window.__MG_HOTS (the game's own
 *                                  dev-only hot-rect map). Layout changes then
 *                                  stop breaking scripts; a missing control is
 *                                  a recorded failure with a shot, not a
 *                                  silent tap into empty space. Accepts a
 *                                  trailing "*" prefix match ("call-*").
 *   {"setStorage": {"k": "v"}}     seed localStorage BEFORE the page navigates
 *                                  — the only way to prove save migration on a
 *                                  real device. Values may be a file path
 *                                  prefixed "@" (e.g. "@tools/fixtures/…json").
 *   {"perf": {"p95": 20}}          assert window.__MG_PERF.p95 is under the
 *                                  given millisecond budget (draw cost).
 *
 * Exit code 0 only if every expectState passed AND zero pageerrors AND zero
 * console errors. Anything else exits 1 and prints why.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAME_W = 960, GAME_H = 600;

const DEVICES = {
  iphone: {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  android: {
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
  ipad: {
    viewport: { width: 834, height: 1112, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  desktop: {
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
};

/* ── args ──────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const a = { device: 'desktop', outdir: path.resolve('mg-tap-shots'), timeout: 6000, show: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--page') a.page = argv[++i];
    else if (k === '--device') a.device = argv[++i];
    else if (k === '--script') a.script = argv[++i];
    else if (k === '--outdir') a.outdir = path.resolve(argv[++i]);
    else if (k === '--timeout') a.timeout = parseInt(argv[++i], 10) || 6000;
    else if (k === '--show') a.show = true;
    else { console.error(`unknown arg: ${k}`); process.exit(2); }
  }
  if (!a.page) { console.error('usage: node tools/mg-tap-suite.js --page <file-or-url> [--device iphone|android|ipad|desktop] [--script <json>] [--outdir <dir>]'); process.exit(2); }
  if (!DEVICES[a.device]) { console.error(`unknown device "${a.device}" — one of: ${Object.keys(DEVICES).join(', ')}`); process.exit(2); }
  return a;
}

function toUrl(p) {
  if (/^https?:\/\//i.test(p) || /^file:\/\//i.test(p)) return p;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) { console.error(`page not found: ${abs}`); process.exit(2); }
  return pathToFileURL(abs).href;
}

function loadScript(a) {
  if (!a.script) {
    // Default probe: page booted, MiniGames present, take one shot.
    return { name: 'boot-probe', steps: [{ wait: 800 }, { shot: 'boot' }] };
  }
  const abs = path.resolve(a.script);
  let steps;
  try { steps = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (err) { console.error(`cannot read script ${abs}: ${err.message}`); process.exit(2); }
  if (!Array.isArray(steps)) { console.error(`script ${abs} must be a JSON array of steps`); process.exit(2); }
  return { name: path.basename(abs).replace(/\.json$/i, ''), steps };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── tap plumbing ──────────────────────────────────────────────────── */
async function gamePoint(page, gx, gy) {
  // Map 960x600 game coords through the LIVE canvas rect (visible scrim).
  await page.waitForFunction(() => {
    const s = document.getElementById('mgScrim');
    const c = s && s.querySelector('canvas');
    return !!(c && !s.hidden && c.getBoundingClientRect().width > 0);
  }, { timeout: 8000 });
  return page.evaluate((gx2, gy2, W, H) => {
    const c = document.querySelector('#mgScrim canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + (gx2 / W) * r.width, y: r.top + (gy2 / H) * r.height };
  }, gx, gy, GAME_W, GAME_H);
}

async function realTap(page, pt, hasTouch) {
  if (hasTouch) {
    await page.touchscreen.tap(pt.x, pt.y);      // touchstart/touchend → pointer events
  } else {
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
  }
}

async function hotRects(page) {
  try { return await page.evaluate(() => window.__MG_HOTS || []); }
  catch (err) { return []; }
}
async function perfProbe(page) {
  try { return await page.evaluate(() => window.__MG_PERF || null); }
  catch (err) { return null; }
}
async function screenProbe(page) {
  try { return await page.evaluate(() => window.__MG_SCREEN || null); }
  catch (err) { return null; }
}

async function debugState(page) {
  try {
    return await page.evaluate(() => {
      if (!window.MiniGames || typeof window.MiniGames.debug !== 'function') return null;
      return window.MiniGames.debug();
    });
  } catch (err) { return null; }
}

/* ── main ──────────────────────────────────────────────────────────── */
(async () => {
  const args = parseArgs(process.argv);
  const dev = DEVICES[args.device];
  const url = toUrl(args.page);
  const script = loadScript(args);
  fs.mkdirSync(args.outdir, { recursive: true });

  const consoleErrors = [];
  const consoleAll = [];
  const pageErrors = [];
  const stepResults = [];
  let shots = 0;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !args.show,
    args: ['--mute-audio', '--hide-scrollbars', '--allow-file-access-from-files',
           `--window-size=${dev.viewport.width},${dev.viewport.height}`],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(dev.userAgent);
    await page.setViewport(dev.viewport);
    page.on('console', m => {
      const line = `[console:${m.type()}] ${m.text()}`;
      consoleAll.push(line);
      if (m.type() === 'error') consoleErrors.push(line);
    });
    page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));

    /* seed storage BEFORE navigation — this is how migration is proven */
    const seed = (script.steps.find(x => x && x.setStorage) || {}).setStorage;
    if (seed) {
      const pairs = {};
      for (const k of Object.keys(seed)) {
        let v = seed[k];
        if (typeof v === 'string' && v[0] === '@')
          v = fs.readFileSync(path.resolve(v.slice(1)), 'utf8');
        pairs[k] = v;
      }
      await page.evaluateOnNewDocument((kv) => {
        try { for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]); } catch (e) {}
      }, pairs);
      console.log(`seeded localStorage: ${Object.keys(pairs).join(', ')}`);
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => !!window.MiniGames, { timeout: 15000 });
    console.log(`page loaded, window.MiniGames present  (device=${args.device}, script=${script.name})`);

    const shotPath = name =>
      path.join(args.outdir, `${script.name}-${args.device}-${name}.png`);

    for (let i = 0; i < script.steps.length; i++) {
      const st = script.steps[i];
      const tag = `step ${i + 1}/${script.steps.length}`;

      if (Array.isArray(st.tapGame)) {
        const [gx, gy] = st.tapGame;
        const pt = await gamePoint(page, gx, gy);
        await realTap(page, pt, dev.viewport.hasTouch);
        console.log(`${tag}  tapGame [${gx},${gy}] -> client (${pt.x.toFixed(0)},${pt.y.toFixed(0)}) ${dev.viewport.hasTouch ? 'touch' : 'mouse'}`);
        stepResults.push({ step: i + 1, kind: 'tapGame', ok: true });

      } else if (typeof st.tapSelector === 'string') {
        const el = await page.waitForSelector(st.tapSelector, { visible: true, timeout: 8000 });
        const box = await el.boundingBox();
        await realTap(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dev.viewport.hasTouch);
        console.log(`${tag}  tapSelector ${st.tapSelector}`);
        stepResults.push({ step: i + 1, kind: 'tapSelector', ok: true });

      } else if (typeof st.key === 'string') {
        await page.keyboard.press(st.key);
        console.log(`${tag}  key ${st.key}`);
        stepResults.push({ step: i + 1, kind: 'key', ok: true });

      } else if (typeof st.wait === 'number') {
        await sleep(st.wait);
        console.log(`${tag}  wait ${st.wait}ms`);
        stepResults.push({ step: i + 1, kind: 'wait', ok: true });

      } else if (typeof st.expectState === 'string') {
        const budget = typeof st.timeout === 'number' ? st.timeout : args.timeout;
        const t0 = Date.now();
        let got = null, ok = false;
        while (Date.now() - t0 < budget) {
          const d = await debugState(page);
          got = d && d.state;
          if (got === st.expectState) { ok = true; break; }
          await sleep(100);
        }
        if (ok) {
          console.log(`${tag}  expectState "${st.expectState}"  PASS  (${Date.now() - t0}ms)`);
        } else {
          console.log(`${tag}  expectState "${st.expectState}"  FAIL  (got "${got}" after ${budget}ms)`);
          try { await page.screenshot({ path: shotPath(`FAIL-step${i + 1}`) }); shots++; } catch (e) {}
        }
        stepResults.push({ step: i + 1, kind: 'expectState', want: st.expectState, got, ok });

      } else if (typeof st.tapId === 'string') {
        const want = st.tapId;
        const pre = want.endsWith('*') ? want.slice(0, -1) : null;
        const budget = typeof st.timeout === 'number' ? st.timeout : 4000;
        const t0 = Date.now();
        let hit = null;
        while (Date.now() - t0 < budget) {
          const hs = await hotRects(page);
          hit = pre ? hs.find(h => h.id.indexOf(pre) === 0) : hs.find(h => h.id === want);
          if (hit) break;
          await sleep(100);
        }
        if (hit) {
          const pt = await gamePoint(page, hit.cx, hit.cy);
          await realTap(page, pt, dev.viewport.hasTouch);
          console.log(`${tag}  tapId "${want}" -> ${hit.id} @ (${hit.cx.toFixed(0)},${hit.cy.toFixed(0)})`);
          stepResults.push({ step: i + 1, kind: 'tapId', want, got: hit.id, ok: true });
        } else {
          const hs = await hotRects(page);
          console.log(`${tag}  tapId "${want}"  FAIL  (not on screen; visible: ${hs.slice(0, 10).map(h => h.id).join(', ')})`);
          try { await page.screenshot({ path: shotPath(`FAIL-step${i + 1}`) }); shots++; } catch (e) {}
          stepResults.push({ step: i + 1, kind: 'tapId', want, got: null, ok: false });
        }

      } else if (st.perf && typeof st.perf.p95 === 'number') {
        const got = await perfProbe(page);
        const ok = !!got && got.p95 <= st.perf.p95;
        console.log(`${tag}  perf p95 <= ${st.perf.p95}ms  ${ok ? 'PASS' : 'FAIL'}  ` +
          (got ? `(p50 ${got.p50}ms · p95 ${got.p95}ms · max ${got.max}ms over ${got.n} frames)` : '(no probe)'));
        stepResults.push({ step: i + 1, kind: 'perf', want: st.perf.p95, got: got && got.p95, ok });

      } else if (typeof st.expectScreen === 'string') {
        const budget = typeof st.timeout === 'number' ? st.timeout : args.timeout;
        const want = st.expectScreen;
        const pre = want.endsWith('*') ? want.slice(0, -1) : null;
        const t0 = Date.now();
        let got = null, ok = false;
        while (Date.now() - t0 < budget) {
          got = await screenProbe(page);
          if (pre ? (got || '').startsWith(pre) : got === want) { ok = true; break; }
          await sleep(100);
        }
        if (ok) {
          console.log(`${tag}  expectScreen "${want}"  PASS  (${Date.now() - t0}ms)`);
        } else {
          console.log(`${tag}  expectScreen "${want}"  FAIL  (got "${got}" after ${budget}ms)`);
          try { await page.screenshot({ path: shotPath(`FAIL-step${i + 1}`) }); shots++; } catch (e) {}
        }
        stepResults.push({ step: i + 1, kind: 'expectScreen', want, got, ok });

      } else if (st.setStorage) {
        console.log(`${tag}  setStorage (applied before navigation)`);
        stepResults.push({ step: i + 1, kind: 'setStorage', ok: true });

      } else if (typeof st.shot === 'string') {
        const p = shotPath(st.shot);
        await page.screenshot({ path: p });
        shots++;
        console.log(`${tag}  shot -> ${p}`);
        stepResults.push({ step: i + 1, kind: 'shot', ok: true, path: p });

      } else {
        console.error(`${tag}  unknown step: ${JSON.stringify(st)}`);
        stepResults.push({ step: i + 1, kind: 'unknown', ok: false });
      }
    }
  } finally {
    await browser.close();
  }

  /* ── verdict ─────────────────────────────────────────────────────── */
  const expectFails = stepResults.filter(
    r => ['expectState', 'expectScreen', 'tapId', 'perf'].indexOf(r.kind) >= 0 && !r.ok);
  const badSteps = stepResults.filter(r => r.kind === 'unknown');
  const pass = expectFails.length === 0 && badSteps.length === 0
    && pageErrors.length === 0 && consoleErrors.length === 0;

  console.log('---');
  for (const e of pageErrors) console.log(`pageerror: ${e}`);
  for (const e of consoleErrors) console.log(e);
  console.log(JSON.stringify({
    result: pass ? 'PASS' : 'FAIL',
    script: script.name,
    device: args.device,
    steps: stepResults.length,
    expectFails: expectFails.length,
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    shots,
  }));
  process.exit(pass ? 0 : 1);
})().catch(err => {
  console.error(`mg-tap-suite fatal: ${err && err.stack || err}`);
  process.exit(1);
});
