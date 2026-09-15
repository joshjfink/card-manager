/* cm-shell.js — the Card Manager host.
 *
 * Addendum 26: Card Manager is its own game. This file is everything it used
 * to borrow from gibson/web/static/minigames.js — canvas host, main loop,
 * input, audio, particles, transitions, results — lifted, trimmed to what a
 * management game needs, and owned here. Nothing in this file talks to the
 * arcade, the shop server, or any Gibson Store file.
 *
 * WHAT WAS DROPPED from minigames.js (49 KB -> this):
 *   the game menu and its cards, the hero picker, the trophy/best shelf and
 *   its two localStorage keys, the launcher button, the arcade backdrop, the
 *   ?minigame= autoplay hook, the 3-2-1 countdown (opt-in here), and the
 *   click-anywhere-on-the-scrim close (there is nowhere to close to).
 *
 * WHAT WAS ADDED:
 *   full-viewport sizing with the portrait-phone rotation (0.40x -> 0.655x),
 *   a DPR-aware backing store, a CORRECT pointer inverse under rotation
 *   (see POINTER MAPPING below), prefers-reduced-motion, and crash armour
 *   that ends a run honestly instead of freezing the page.
 *
 * ==================================================================
 *  THE MAPPING — what the game calls today -> what it calls here
 * ==================================================================
 *  Card Manager registers with `window.MiniGames.register({... create(env) })`
 *  and inside create() it uses exactly this surface (measured by grep over
 *  mg-manager.js: 62 env.sfx.*, 6 env.burst, 5 env.shake, 3 env.over,
 *  1 env.drawBall, plus the destructure `const {W,H,colors:C,rr,drawChar}`).
 *  Every one of them is here, same name, same signature:
 *
 *    window.MiniGames.register(def)   ->  window.CM_SHELL.register(def)
 *    if (!window.MiniGames) return;   ->  if (!window.CM_SHELL) return;
 *    env.W / env.H                    ->  env.W / env.H          (960 / 600)
 *    env.colors                       ->  env.colors             (same keys)
 *    env.rr(ctx,x,y,w,h,r)            ->  env.rr(...)            verbatim
 *    env.drawChar(ctx,name,x,y,s,pose,t) -> env.drawChar(...)    verbatim
 *    env.drawBall(ctx,x,y,r,spin)     ->  env.drawBall(...)      verbatim
 *    env.cast / env.heroes            ->  env.cast / env.heroes
 *    env.sfx.move|select|count|go|point|thud|whistle|miss|fanfare
 *                                     ->  identical names, identical sounds
 *    env.music.play|stop|crowd        ->  identical
 *    env.shake(px)                    ->  identical (no-op under reduced motion)
 *    env.burst(x,y,color,n)           ->  identical
 *    env.floatText(x,y,str,color)     ->  identical
 *    env.confetti()                   ->  identical
 *    env.rnd / env.clamp / env.lerp   ->  identical
 *    env.over(result)                 ->  identical
 *    env.best(id)                     ->  RETIRED (arcade high-score shelf).
 *                                         Returns undefined; the career save
 *                                         is the only record that matters.
 *    env.hero                         ->  RETIRED (no hero picker). Reads
 *                                         'Gibson' so a stray reference is
 *                                         harmless.
 *  New, and only new:
 *    env.shell                        ->  window.CM_SHELL
 *    env.screen                       ->  {s, profile, rotated, dpr, cssW, cssH}
 *    env.dpr                          ->  device pixel ratio actually used
 *
 *  The same helpers hang directly off window.CM_SHELL, so code outside a
 *  create() closure can reach them without an env.
 *
 * ==================================================================
 *  POINTER MAPPING — the bug this shell fixes
 * ==================================================================
 *  On a portrait phone the board is rotated onto the long axis (that is what
 *  takes a 960x600 board from 0.40x to 0.655x). minigames.js maps a pointer
 *  with the naive bounding-rect ratio:
 *      gx = (clientX - rect.left) * (960 / rect.width)
 *  getBoundingClientRect() of a rotated element reports the rotated FOOTPRINT.
 *  It accounts for the extent but NOT for the axis swap, so under rotate(90deg)
 *  that formula reports the game's Y axis as X. Measured on iPhone 393x852:
 *  the board's origin sits at screen (385,124) and the naive formula calls it
 *  game (960, 0). Every tap on a rotated phone lands on the wrong control.
 *  It is invisible to tools/mg-tap-suite.js because gamePoint() makes the
 *  identical error in the opposite direction and the two cancel.
 *
 *  Here, CSS rotate(90deg) is clockwise, so a local offset (du,dv) from the
 *  element centre lands at screen offset (-dv, du). Inverting that:
 *      u = clientY - cy + Wc/2      // along the game's X, 0..Wc
 *      v = cx - clientX + Hc/2      // along the game's Y, 0..Hc
 *  with Wc = the element's CSS width (the long side) = rect.height, and
 *  Hc = the element's CSS height = rect.width.
 *
 *  ?cmharness=1 switches the input layer back to the naive formula so that
 *  legacy tap scripts written against mg-tap-suite.js still drive the page.
 *  It changes one boolean and nothing else. Ship default is the correct map.
 * ================================================================== */
(() => {
  'use strict';

  const W = 960, H = 600;
  const VERSION = '1.0.0';

  /* ── debug switches, all off by default ─────────────────────────────
   * ?cmharness=1  naive pointer map, for the legacy tap suite
   * ?cmrotate=0   never rotate (lets a phone run the true landscape map)
   * ?cmdpr=1      pin the backing store to 1x
   * ?cmmax=1600   cap the canvas CSS width in px                        */
  const Q = (() => {
    try { return new URLSearchParams(location.search); }
    catch (e) { return { get: () => null }; }
  })();
  const qnum = (k, d) => { const v = parseFloat(Q.get(k)); return isFinite(v) ? v : d; };
  const LEGACY_MAP = Q.get('cmharness') === '1';
  const ALLOW_ROTATE = Q.get('cmrotate') !== '0';
  const DPR_CAP = qnum('cmdpr', 2);
  const MAX_CSS_W = qnum('cmmax', 1600);

  let reducedMotion = false;
  try {
    reducedMotion = !!(window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  const COLORS = {
    pitch: '#0d1f16', turf: '#15301e', turf2: '#1b3b26', line: '#2a4b33',
    chalk: '#eaf2e6', fade: '#93ab99', gold: '#e9bf63', red: '#d6202a',
    cream: '#fdfbf4', ink: '#2b2118', good: '#4fb477', warn: '#e8a33c',
  };

  /* ── the cast, compact (lifted verbatim — the game draws these) ────── */
  const CAST = {
    'Gibson':  { shirt: '#d6202a', trim: '#e9bf63', skin: '#e8c39a', hair: '#5b3a1e', num: 19 },
    'Ellis':   { shirt: '#f2c200', trim: '#d6202a', skin: '#e8c39a', hair: '#c98a3a', num: 3, small: true },
    'Phoenix': { dog: true, fur: '#d4842f', furD: '#b0631c', cream: '#f7ead3' },
    'Grandpa': { shirt: '#e0a32e', trim: '#3a2f22', skin: '#e3bd93', hair: '#cfcfcf', num: 62 },
    'Messi':   { shirt: '#6cace4', trim: '#ffffff', skin: '#e3bd93', hair: '#3a2a1c', num: 10 },
    'Ronaldo': { shirt: '#c8102e', trim: '#1b6b3a', skin: '#dfae82', hair: '#2b1f18', num: 7 },
    'Haaland': { shirt: '#ba0c2f', trim: '#ffffff', skin: '#e8c8a2', hair: '#e6d28a', num: 9, big: true },
    'Yamal':   { shirt: '#c60b1e', trim: '#f5c518', skin: '#c99368', hair: '#1c1512', num: 19 },
    'Mbappé':  { shirt: '#22346b', trim: '#ffffff', skin: '#6b4227', hair: '#1c1512', num: 10 },
    'Kane':    { shirt: '#ffffff', trim: '#0b2c5f', skin: '#e8c8a2', hair: '#6b4a2c', num: 9 },
    'Suárez':  { shirt: '#55b5e5', trim: '#0b2c5f', skin: '#c99368', hair: '#2b1c12', num: 9 },
  };
  const HEROES = ['Gibson', 'Ellis', 'Phoenix', 'Grandpa', 'Messi', 'Haaland', 'Yamal', 'Mbappé'];

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* One cartoon body for the whole cast.
     pose: 'idle' | 'run' | 'kick' | 'cheer' | 'fall' | 'dive'; t drives it. */
  function drawChar(ctx, name, x, y, s, pose, t) {
    const c = CAST[name] || CAST.Gibson;
    t = t || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

    if (c.dog) {                       // Phoenix, in full
      const wag = Math.sin(t * 10) * 0.5;
      ctx.scale(pose === 'run' ? 1.05 : 1, 1);
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath(); ctx.ellipse(0, 2, 26, 6, 0, 0, 7); ctx.fill();
      ctx.fillStyle = c.fur;
      rr(ctx, -24, -26, 44, 24, 11); ctx.fill();          // body
      ctx.save();                                          // tail
      ctx.translate(-24, -22); ctx.rotate(-0.7 + wag);
      rr(ctx, -4, -14, 8, 16, 4); ctx.fillStyle = c.fur; ctx.fill();
      ctx.restore();
      const bob = pose === 'run' ? Math.abs(Math.sin(t * 9)) * 3 : 0;
      ctx.fillStyle = c.fur;
      rr(ctx, 8, -44 - bob, 26, 24, 10); ctx.fill();       // head
      ctx.fillStyle = c.furD;                              // ears
      ctx.beginPath(); ctx.moveTo(12, -44 - bob); ctx.lineTo(15, -54 - bob); ctx.lineTo(20, -44 - bob); ctx.fill();
      ctx.beginPath(); ctx.moveTo(24, -44 - bob); ctx.lineTo(27, -54 - bob); ctx.lineTo(32, -44 - bob); ctx.fill();
      ctx.fillStyle = c.cream;
      rr(ctx, 22, -34 - bob, 14, 12, 6); ctx.fill();       // snout
      ctx.fillStyle = '#2a1f16';
      ctx.beginPath(); ctx.arc(34, -30 - bob, 2.4, 0, 7); ctx.fill();   // nose
      ctx.beginPath(); ctx.arc(20, -36 - bob, 2, 0, 7); ctx.fill();     // eye
      const legStep = pose === 'run' ? Math.sin(t * 12) * 6 : 0;
      ctx.strokeStyle = c.furD; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-14, -6); ctx.lineTo(-14 - legStep, 2);
      ctx.moveTo(10, -6); ctx.lineTo(10 + legStep, 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const small = c.small ? 0.72 : c.big ? 1.12 : 1;
    ctx.scale(small, small);
    if (pose === 'fall') ctx.rotate(1.35);
    const step = pose === 'run' ? Math.sin(t * 11) * 8 : 0;
    const bounce = pose === 'run' ? Math.abs(Math.cos(t * 11)) * 3
      : pose === 'cheer' ? Math.abs(Math.sin(t * 8)) * 6 : Math.sin(t * 2) * 1.5;
    ctx.translate(0, -bounce);

    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.ellipse(0, bounce + 2, 16, 5, 0, 0, 7); ctx.fill();

    ctx.strokeStyle = '#25303c'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath();                                       // legs
    if (pose === 'kick') {
      ctx.moveTo(-4, -16); ctx.lineTo(-7, 0);
      ctx.moveTo(4, -16); ctx.lineTo(18, -10);
    } else {
      ctx.moveTo(-4, -16); ctx.lineTo(-4 - step * 0.5, 0);
      ctx.moveTo(4, -16); ctx.lineTo(4 + step * 0.5, 0);
    }
    ctx.stroke();

    ctx.fillStyle = c.shirt;                               // body
    rr(ctx, -13, -48, 26, 33, 10); ctx.fill();
    ctx.fillStyle = c.trim;
    ctx.fillRect(-13, -22, 26, 4);
    if (c.num != null) {
      ctx.fillStyle = c.trim;
      ctx.font = 'bold 13px ui-rounded, system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(c.num), 0, -28);
    }

    ctx.strokeStyle = c.skin; ctx.lineWidth = 6;           // arms
    ctx.beginPath();
    if (pose === 'cheer') {
      ctx.moveTo(-11, -42); ctx.lineTo(-20, -58);
      ctx.moveTo(11, -42); ctx.lineTo(20, -58);
    } else if (pose === 'dive') {
      ctx.moveTo(-11, -42); ctx.lineTo(-26, -46);
      ctx.moveTo(11, -42); ctx.lineTo(26, -46);
    } else {
      ctx.moveTo(-11, -42); ctx.lineTo(-14 + step * 0.4, -26);
      ctx.moveTo(11, -42); ctx.lineTo(14 - step * 0.4, -26);
    }
    ctx.stroke();

    ctx.fillStyle = c.skin;                                // head
    ctx.beginPath(); ctx.arc(0, -58, 11.5, 0, 7); ctx.fill();
    ctx.fillStyle = c.hair;
    ctx.beginPath(); ctx.arc(0, -60, 11.5, Math.PI, 0); ctx.fill();
    ctx.fillRect(-11.5, -60, 23, 3);
    ctx.fillStyle = '#2a1f16';
    ctx.beginPath(); ctx.arc(3, -57, 1.7, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(8, -57, 1.7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#2a1f16'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(5, -54, 3.2, 0.3, Math.PI - 0.4); ctx.stroke();
    ctx.restore();
  }

  function drawBall(ctx, x, y, r, spin) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(spin || 0);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7);
    ctx.fillStyle = COLORS.cream; ctx.fill();
    ctx.strokeStyle = COLORS.ink; ctx.lineWidth = Math.max(1.2, r * 0.12); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, 7);
    ctx.fillStyle = COLORS.ink; ctx.fill();
    ctx.restore();
  }

  /* ================================================================== *
   *  AUDIO — a tiny synth, built on the first human gesture             *
   * ================================================================== */
  let AC = null, gestured = false;   // no context (and no autoplay warning) before a gesture
  function ac() {
    if (!gestured) return AC;
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (AC && AC.state === 'suspended') AC.resume().catch(() => {});
    return AC;
  }

  /* Mute lives in the new namespace, adopting the arcade's flag once. */
  const MUTE_KEY = 'cm-mute';
  let muted = false;
  try {
    const own = localStorage.getItem(MUTE_KEY);
    if (own != null) muted = own === '1';
    else {
      const old = localStorage.getItem('gs-mg-mute');
      if (old != null) { muted = old === '1'; localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); }
    }
  } catch (e) {}

  function tone(freq, dur, type, vol, when) {
    const c = ac();
    if (!c || muted) return;
    const t0 = c.currentTime + (when || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.06, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const SFX = {
    move()    { tone(340, 0.05, 'square', 0.04); },
    select()  { tone(520, 0.07, 'square', 0.05); tone(780, 0.09, 'square', 0.05, 0.06); },
    count()   { tone(440, 0.1, 'square', 0.06); },
    go()      { tone(660, 0.16, 'square', 0.07); tone(880, 0.2, 'square', 0.07, 0.1); },
    point()   { tone(700, 0.06, 'triangle', 0.06); tone(1050, 0.08, 'triangle', 0.06, 0.05); },
    thud()    { tone(120, 0.12, 'sawtooth', 0.08); },
    whistle() { tone(1800, 0.09, 'sine', 0.05); tone(1800, 0.14, 'sine', 0.05, 0.12); },
    miss()    { tone(220, 0.16, 'sawtooth', 0.06); tone(160, 0.2, 'sawtooth', 0.06, 0.12); },
    fanfare() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.06, i * 0.12));
      tone(1319, 0.4, 'square', 0.06, 0.5);
    },
  };

  /* ── music: a step-sequenced chiptune layer, quiet under the sfx ────
   * Original 8-bar loops on the same AudioContext the sfx use. It never
   * creates the context itself — it waits for the first human gesture, so
   * there are no autoplay warnings before a tap. The arcade's auto() (which
   * scored a menu this game does not have) is gone: the score is entirely
   * game-driven, except the results sting the shell plays for itself. */
  const Music = (() => {
    const mf = m => 440 * Math.pow(2, (m - 69) / 12);

    const TRACKS = {
      menu: {                       // bright C major stroll — C G Am F | C G F G
        bpm: 104, loop: true,
        chords: [48, 43, 45, 41, 48, 43, 41, 43],
        bassPat: [[0, 0, 2], [4, 0, 2], [6, 12, 1], [8, 0, 2], [12, 0, 2], [14, 12, 1]],
        hatPat: [[2, 0], [6, 0], [10, 0], [14, 1]],
        leadVol: 0.02, bassVol: 0.03,
        lead: [
          [0, 0, 76, 2], [0, 2, 79, 2], [0, 4, 84, 3], [0, 8, 79, 2], [0, 10, 76, 2], [0, 12, 74, 2], [0, 14, 72, 2],
          [1, 0, 74, 2], [1, 2, 71, 2], [1, 4, 74, 3], [1, 8, 79, 4], [1, 12, 74, 2], [1, 14, 71, 2],
          [2, 0, 76, 2], [2, 2, 81, 2], [2, 4, 84, 3], [2, 8, 81, 2], [2, 10, 76, 2], [2, 12, 74, 2], [2, 14, 76, 2],
          [3, 0, 77, 4], [3, 4, 81, 2], [3, 6, 79, 2], [3, 8, 77, 2], [3, 10, 74, 2], [3, 12, 72, 4],
          [4, 0, 72, 2], [4, 2, 76, 2], [4, 4, 79, 3], [4, 8, 84, 4], [4, 12, 79, 2], [4, 14, 76, 2],
          [5, 0, 74, 2], [5, 2, 77, 2], [5, 4, 79, 3], [5, 8, 83, 2], [5, 10, 79, 2], [5, 12, 74, 4],
          [6, 0, 81, 2], [6, 2, 79, 2], [6, 4, 77, 3], [6, 8, 76, 2], [6, 10, 74, 2], [6, 12, 76, 2], [6, 14, 77, 2],
          [7, 0, 79, 4], [7, 4, 74, 2], [7, 6, 71, 2], [7, 8, 74, 4], [7, 12, 71, 2], [7, 14, 74, 2],
        ],
      },
      match: {                      // tense A minor pulse — Am Am F G | Am F E E
        bpm: 96, loop: true,
        chords: [45, 45, 41, 43, 45, 41, 40, 40],
        bassPat: [[0, 0, 1], [2, 0, 1], [4, 0, 1], [6, 0, 1], [8, 0, 1], [10, 0, 1], [12, 12, 1], [14, 0, 1]],
        hatPat: [[4, 0], [12, 0]],
        leadVol: 0.013, bassVol: 0.026,
        lead: [
          [0, 0, 69, 2], [0, 6, 72, 1], [0, 8, 69, 2],
          [1, 0, 69, 2], [1, 6, 74, 1], [1, 8, 72, 2],
          [2, 0, 72, 2], [2, 6, 77, 1], [2, 8, 76, 2],
          [3, 0, 74, 2], [3, 6, 79, 1], [3, 8, 74, 2],
          [4, 0, 76, 3], [4, 8, 72, 2], [4, 12, 69, 2],
          [5, 0, 77, 3], [5, 8, 72, 2], [5, 12, 69, 2],
          [6, 0, 68, 2], [6, 6, 71, 1], [6, 8, 76, 3],
          [7, 0, 68, 4], [7, 8, 64, 6],
        ],
      },
      results: {                    // two-bar triumphant sting, C major, plays once
        bpm: 108, loop: false,
        chords: [48, 48], bassPat: [], hatPat: [],
        leadVol: 0.024, bassVol: 0.03,
        bass: [[0, 0, 48, 4], [0, 4, 53, 4], [0, 8, 55, 4], [0, 12, 48, 4], [1, 0, 48, 12], [1, 0, 55, 12]],
        lead: [
          [0, 0, 72, 2], [0, 2, 76, 2], [0, 4, 79, 2], [0, 6, 84, 4], [0, 10, 79, 2], [0, 12, 81, 2], [0, 14, 83, 2],
          [1, 0, 84, 10], [1, 0, 79, 10], [1, 0, 76, 10],
        ],
      },
      fulltime: {                   // subdued minor close for a loss, plays once
        bpm: 100, loop: false,
        chords: [45], bassPat: [], hatPat: [],
        leadVol: 0.016, bassVol: 0.026,
        bass: [[0, 0, 45, 6], [0, 6, 41, 4], [0, 10, 45, 6]],
        lead: [[0, 0, 76, 2], [0, 2, 72, 2], [0, 4, 71, 2], [0, 6, 69, 4], [0, 10, 64, 6], [0, 10, 69, 6]],
      },
    };

    let name = null;
    let step = 0, nextT = 0, timer = 0;
    let bus = null, hatBuf = null;
    let crowdWant = false, crowdSrc = null, crowdGain = null, crowdLfo = null, crowdSwell = null;

    function compile(tr) {
      if (tr._ev) return tr._ev;
      const steps = tr.chords.length * 16;
      const ev = []; for (let i = 0; i < steps; i++) ev.push([]);
      tr.chords.forEach((root, bar) => {
        (tr.bassPat || []).forEach(p => ev[bar * 16 + p[0]].push(
          { f: mf(root + p[1]), len: p[2], type: 'triangle', vol: tr.bassVol }));
        (tr.hatPat || []).forEach(p => ev[bar * 16 + p[0]].push({ hat: true, open: p[1] }));
      });
      (tr.lead || []).forEach(n => ev[n[0] * 16 + n[1]].push(
        { f: mf(n[2]), len: n[3], type: 'square', vol: tr.leadVol }));
      (tr.bass || []).forEach(n => ev[n[0] * 16 + n[1]].push(
        { f: mf(n[2]), len: n[3], type: 'triangle', vol: tr.bassVol }));
      tr._steps = steps; tr._ev = ev;
      return ev;
    }

    const ready = () => !!AC && AC.state === 'running';
    function ensureBus(c) {
      if (!bus) { bus = c.createGain(); bus.gain.value = muted ? 0 : 1; bus.connect(c.destination); }
      return bus;
    }
    function note(c, t, f, dur, type, vol) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ensureBus(c));
      o.start(t); o.stop(t + dur + 0.03);
    }
    function hat(c, t, open) {
      if (!hatBuf) {
        hatBuf = c.createBuffer(1, (c.sampleRate * 0.12) | 0, c.sampleRate);
        const d = hatBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const s = c.createBufferSource(); s.buffer = hatBuf;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
      const g = c.createGain();
      const dur = open ? 0.09 : 0.035;
      g.gain.setValueAtTime(0.011, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(hp); hp.connect(g); g.connect(ensureBus(c));
      s.start(t); s.stop(t + dur + 0.02);
    }

    function tick() {
      updateCrowd();
      if (name && ready()) {
        const c = AC, tr = TRACKS[name];
        compile(tr);
        const spb = 15 / tr.bpm;                 // seconds per 16th
        if (nextT < c.currentTime) nextT = c.currentTime + 0.06;
        while (name && nextT < c.currentTime + 0.14) {
          if (!muted) for (const e of tr._ev[step]) {
            if (e.hat) hat(c, nextT, e.open);
            else note(c, nextT, e.f, Math.max(0.06, e.len * spb * 0.92), e.type, e.vol);
          }
          step += 1; nextT += spb;
          if (step >= tr._steps) {
            if (tr.loop) step = 0;
            else name = null;
          }
        }
      }
      if (!name && !crowdWant && !crowdSrc && timer) { clearInterval(timer); timer = 0; }
    }
    function run() { if (!timer) timer = setInterval(tick, 40); }

    function play(id) {
      if (!TRACKS[id]) return;
      if (name === id) return;
      name = id; step = 0; nextT = 0;
      if (bus && ready()) {                       // lift any hush from a stop()
        bus.gain.cancelScheduledValues(AC.currentTime);
        bus.gain.setValueAtTime(muted ? 0 : 1, AC.currentTime);
      }
      run();
    }
    function stop() {
      name = null;
      if (bus && ready()) {                       // cut in-flight tails cleanly
        const t = AC.currentTime, g = bus.gain;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, 0.04);
        g.setValueAtTime(muted ? 0 : 1, t + 0.5);
      }
    }

    function updateCrowd() {
      if (!ready()) return;
      const c = AC;
      if (crowdWant && !crowdSrc) {
        const len = (c.sampleRate * 1.5) | 0;
        const buf = c.createBuffer(1, len, c.sampleRate);
        const d = buf.getChannelData(0);
        let v = 0;
        for (let i = 0; i < len; i++) { v = v * 0.98 + (Math.random() * 2 - 1) * 0.25; d[i] = v; }
        crowdSrc = c.createBufferSource(); crowdSrc.buffer = buf; crowdSrc.loop = true;
        const lp = c.createBiquadFilter(); lp.type = 'lowpass';
        lp.frequency.value = 480; lp.Q.value = 0.4;
        crowdLfo = c.createOscillator(); const lg = c.createGain();
        crowdLfo.frequency.value = 0.17; lg.gain.value = 140;
        crowdLfo.connect(lg); lg.connect(lp.frequency);   // slow murmur movement
        crowdGain = c.createGain(); crowdGain.gain.value = 0;
        crowdGain.gain.setTargetAtTime(0.045, c.currentTime, 0.8);
        crowdSwell = c.createGain(); crowdSwell.gain.value = 1;
        crowdSrc.connect(lp); lp.connect(crowdGain);
        crowdGain.connect(crowdSwell); crowdSwell.connect(ensureBus(c));
        crowdSrc.start(); crowdLfo.start();
      }
      if (!crowdWant && crowdSrc) {
        const src = crowdSrc, g = crowdGain, lfo = crowdLfo, sw = crowdSwell;
        crowdSrc = crowdGain = crowdLfo = crowdSwell = null;
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.25);
        setTimeout(() => {
          try { src.stop(); lfo.stop(); src.disconnect(); sw.disconnect(); } catch (e) {}
        }, 1200);
      }
    }
    function crowd(on) { crowdWant = !!on; run(); updateCrowd(); }
    function swell(px) {
      if (crowdSwell && ready()) {
        const t = AC.currentTime, k = Math.min(2.6, 1 + (px || 6) * 0.1);
        crowdSwell.gain.cancelScheduledValues(t);
        crowdSwell.gain.setValueAtTime(Math.max(crowdSwell.gain.value, k), t);
        crowdSwell.gain.setTargetAtTime(1, t + 0.05, 0.5);
      }
    }
    function setMuted() {
      if (bus && AC) {
        bus.gain.cancelScheduledValues(AC.currentTime);
        bus.gain.setValueAtTime(muted ? 0 : 1, AC.currentTime);
      }
    }
    return { play, stop, crowd, swell, setMuted, get track() { return name; } };
  })();

  function setMute(on) {
    muted = !!on;
    Music.setMuted();
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    return muted;
  }

  /* ================================================================== *
   *  JUICE — shake, bursts, floating text, confetti                     *
   * ================================================================== */
  let shakeAmt = 0;
  const parts = [];
  const PART_CAP = 220;                     // production bible R16's HIGH-desk cap
  function push(p) { if (parts.length < PART_CAP) parts.push(p); }
  function burst(x, y, color, n) {
    for (let i = 0; i < (n || 14); i++) {
      const a = Math.random() * 6.283, sp = 60 + Math.random() * 190;
      push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
             color, t: 0, life: 0.6 + Math.random() * 0.5, kind: 'dot' });
    }
  }
  function confetti() {
    const cols = [COLORS.gold, COLORS.red, COLORS.good, '#4f8fd0', COLORS.cream];
    for (let i = 0; i < 90; i++) {
      push({ x: Math.random() * W, y: -20 - Math.random() * 200,
             vx: (Math.random() - 0.5) * 60, vy: 90 + Math.random() * 120,
             color: cols[i % cols.length], t: 0, life: 2.6 + Math.random(),
             kind: 'flake', spin: Math.random() * 6 });
    }
  }
  function floatText(x, y, str, color) {
    push({ x, y, vx: 0, vy: -46, color: color || COLORS.gold,
           t: 0, life: 0.9, kind: 'text', str });
  }
  function shake(px) {
    if (reducedMotion) { Music.swell(px); return; }   // SAFE-C4
    shakeAmt = Math.max(shakeAmt, px);
    Music.swell(px);
  }
  function updateParts(dt) {
    shakeAmt = Math.max(0, shakeAmt - dt * 26);
    for (const p of parts) {
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'dot') p.vy += 320 * dt;
      if (p.kind === 'flake') p.spin += dt * 4;
    }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].t > parts[i].life) parts.splice(i, 1);
  }
  function drawParts(g) {
    for (const p of parts) {
      const k = 1 - p.t / p.life;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, k * 1.6));
      if (p.kind === 'text') {
        g.font = 'bold 22px ui-rounded, system-ui'; g.textAlign = 'center';
        g.lineWidth = 4; g.strokeStyle = COLORS.pitch;
        g.strokeText(p.str, p.x, p.y);
        g.fillStyle = p.color; g.fillText(p.str, p.x, p.y);
      } else if (p.kind === 'flake') {
        g.translate(p.x, p.y); g.rotate(p.spin);
        g.fillStyle = p.color; g.fillRect(-4, -2.5, 8, 5);
      } else {
        g.fillStyle = p.color;
        g.beginPath(); g.arc(p.x, p.y, 3 * k + 1, 0, 7); g.fill();
      }
      g.restore();
    }
  }

  /* ================================================================== *
   *  THE STAGE — one canvas, the whole viewport                         *
   * ================================================================== */
  /* The host element carries id="mgScrim". That is NOT arcade residue: it is
   * the handle tools/mg-tap-suite.js looks for (`#mgScrim canvas`), and the
   * real-tap suite is the thing that proves the phone works. All styling here
   * keys off the .cm-stage class, so the id is purely the harness handle.
   * Rename it only in the same commit that teaches the suite the new name. */
  const STAGE_ID = 'mgScrim';
  let stage = null, cv = null, ctx = null, snap = null, snapCtx = null;
  const view = { s: 1, profile: 'DESK', rotated: false, dpr: 1, cssW: W, cssH: H, k: 1 };

  function injectCSS() {
    if (document.getElementById('cmShellCSS')) return;
    const st = document.createElement('style');
    st.id = 'cmShellCSS';
    st.textContent = [
      'html,body{margin:0;padding:0;height:100%;background:#0d1f16;overscroll-behavior:none;}',
      '.cm-stage{position:fixed;inset:0;z-index:900;display:flex;align-items:center;',
      '  justify-content:center;overflow:hidden;background:#0b1610;',
      '  touch-action:none;-webkit-tap-highlight-color:transparent;}',
      '.cm-stage canvas{display:block;touch-action:none;background:#0d1f16;',
      '  transform-origin:center center;image-rendering:auto;',
      '  box-shadow:0 18px 60px rgba(0,0,0,.55);}',
      '.cm-stage.cm-rot canvas{border-radius:0;border:0;}',
      '.cm-stage:not(.cm-rot) canvas{border-radius:14px;border:2px solid #233a2b;}',
      '@media (prefers-reduced-motion:reduce){.cm-stage canvas{transition:none!important;}}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* Decide the presentation and size the canvas.
   *
   * Rotated, the element's CSS width Wc runs DOWN the screen and its CSS
   * height Hc runs ACROSS, so the constraints swap:
   *     Wc <= 0.98 * innerHeight   and   Hc = Wc/1.6 <= innerWidth
   * Measured results (they match the production bible's R5 table):
   *     iPhone 393x852 -> 629x393 -> s 0.655
   *     Galaxy 360x800 -> 576x360 -> s 0.600
   *     iPad   834x1112-> 1090x681-> s 1.135
   * Rotation is applied only when it is a real win (>15% more scale), so a
   * landscape phone, a laptop and a desktop never rotate. */
  function layout() {
    if (!cv) return;
    const vw = Math.max(1, window.innerWidth || W);
    const vh = Math.max(1, window.innerHeight || H);
    const portrait = vh > vw;
    const sFlat = Math.min(vw, vh * (W / H), MAX_CSS_W) / W;
    const sRot = Math.min(vh * 0.98, vw * (W / H)) / W;
    const rotated = ALLOW_ROTATE && portrait && sRot > sFlat * 1.15;

    const cssW = Math.round((rotated ? sRot : sFlat) * W);
    const cssH = Math.round(cssW * (H / W));
    const dpr = Math.max(1, Math.min(DPR_CAP, window.devicePixelRatio || 1));
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);

    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.style.transform = rotated ? 'rotate(90deg)' : 'none';
    stage.classList.toggle('cm-rot', rotated);

    view.s = cssW / W;
    view.profile = view.s >= 0.95 ? 'DESK' : view.s >= 0.72 ? 'LAP' : 'HAND';
    view.rotated = rotated; view.dpr = dpr;
    view.cssW = cssW; view.cssH = cssH; view.k = bw / W;

    if (!snap) { snap = document.createElement('canvas'); snapCtx = snap.getContext('2d'); }
    if (snap.width !== W) { snap.width = W; snap.height = H; }
    emit('resize', view);
  }

  /* ================================================================== *
   *  INPUT — touch, pointer and keys, mapped through the live rect      *
   * ================================================================== */
  const keys = new Set(), taps = new Set();
  const mouse = { x: -1, y: -1, down: false, clicked: false };

  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right',
    ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down',
    ' ': 'action', Enter: 'enter', Escape: 'esc',
  };

  /* client point -> 960x600 game point. See POINTER MAPPING at the top. */
  function toGame(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return { x: -1, y: -1 };
    if (LEGACY_MAP || !view.rotated) {
      return { x: (clientX - r.left) * (W / r.width),
               y: (clientY - r.top) * (H / r.height) };
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const Hc = r.width, Wc = r.height;          // the 90deg swap
    const u = (clientY - cy) + Wc / 2;          // along the game's X
    const v = (cx - clientX) + Hc / 2;          // along the game's Y
    return { x: u * (W / Wc), y: v * (H / Hc) };
  }
  /* the forward map, for anything that needs to place a DOM node on a control */
  function clientOf(gx, gy) {
    const r = cv.getBoundingClientRect();
    if (LEGACY_MAP || !view.rotated) {
      return { x: r.left + (gx / W) * r.width, y: r.top + (gy / H) * r.height };
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const Hc = r.width, Wc = r.height;
    return { x: cx + Hc / 2 - (gy / H) * Hc,
             y: cy - Wc / 2 + (gx / W) * Wc };
  }

  /* ================================================================== *
   *  THE TEST PROBE — window.__MG_HOTS, in the harness's aim space      *
   * ==================================================================
   * tools/mg-tap-suite.js presses a NAMED control by reading
   * window.__MG_HOTS and mapping the rect centre with the naive ratio
   *     client = rect.left + (cx / 960) * rect.width
   * which, on a rotated phone, aims at the wrong edge of the screen (see
   * POINTER MAPPING above). That suite is shared with the arcade and is not
   * ours to edit, so the shell corrects the AIM rather than the INPUT.
   *
   * While the board is rotated, __MG_HOTS is published in the space the
   * naive formula reads: the point cx',cy' for which
   *     naiveForward(cx', cy') === clientOf(cx, cy)
   * Solving for rotate(90deg): cx' = W(1 - cy/H), cy' = H(cx/W). It is an
   * exact axis swap, so whole rects map as cleanly as points do.
   *
   * The tap that results is a REAL touch at the pixel where the control is
   * DRAWN, handled by the shipping pointer path with the true inverse map —
   * there is no test-only branch in the input code, and ?cmharness=1 is not
   * needed. Every published entry carries aim:'rot90' and the game-space
   * rect it came from, so nobody reading the probe is misled about which
   * space they are in.
   *
   * The shell publishes its OWN screens here too (the results CTA, the fatal
   * reload band): a run that has ended is not drawing hot rects, and a "tap
   * to continue" that no script can name by id is a dead end. */
  let gameHots = [];
  let shellHots = [];
  function aimRect(r) {
    const rx = r.x != null ? r.x : (r.cx || 0), ry = r.y != null ? r.y : (r.cy || 0);
    const rw = r.w || 0, rh = r.h || 0;
    const x = W * (1 - (ry + rh) / H), w = W * (rh / H);
    const y = H * (rx / W), h = H * (rw / W);
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  }
  /* game point -> the point the harness must be handed to hit it */
  function aimPoint(gx, gy) {
    if (!view.rotated || LEGACY_MAP) return { x: gx, y: gy };
    return { x: W * (1 - gy / H), y: H * (gx / W) };
  }
  /* every entry leaves here with a cx/cy: the harness taps the centre and
     nothing else, so a rect without one is an untappable control */
  function withCentre(r) {
    if (r.cx != null && r.cy != null) return r;
    return Object.assign({}, r, { cx: (r.x || 0) + (r.w || 0) / 2,
                                  cy: (r.y || 0) + (r.h || 0) / 2 });
  }
  function probeHots() {
    const src = shellHots.length ? shellHots : gameHots;
    if (!view.rotated || LEGACY_MAP) return src.map(withCentre);
    return src.map(r => {
      const a = aimRect(r);
      return {
        id: r.id, x: a.x, y: a.y, w: a.w, h: a.h, cx: a.cx, cy: a.cy,
        aim: 'rot90',
        game: { x: r.x, y: r.y, w: r.w, h: r.h,
                cx: (r.x || 0) + (r.w || 0) / 2, cy: (r.y || 0) + (r.h || 0) / 2 },
      };
    });
  }
  function installProbe() {
    try {
      const had = window.__MG_HOTS;
      if (Array.isArray(had)) gameHots = had.slice();
      Object.defineProperty(window, '__MG_HOTS', {
        configurable: true,
        get: probeHots,
        set(v) { gameHots = Array.isArray(v) ? v.slice() : []; },
      });
    } catch (e) { /* frozen window: the game's own assignment still stands */ }
  }
  /* the shell's own screens, named so a script can press them */
  function shellScreenHots(st) {
    if (st === 'results') return [{ id: 'cm-results-cta', x: 0, y: H - 72, w: W, h: 72 }];
    if (st === 'fatal') return [{ id: 'cm-fatal-reload', x: W / 2 - 200, y: H / 2 + 56, w: 400, h: 56 }];
    return [];
  }

  function onKeyDown(e) {
    gestured = true;
    const k = KEYMAP[e.key];
    if (e.key === 'm' || e.key === 'M') setMute(!muted);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    if (!keys.has(k)) taps.add(k);
    keys.add(k);
  }
  function onKeyUp(e) {
    const k = KEYMAP[e.key];
    if (k) { keys.delete(k); e.preventDefault(); e.stopPropagation(); }
  }

  function makeInput() {
    const pressed = new Set(taps);
    taps.clear();
    const clicked = mouse.clicked;
    mouse.clicked = false;
    return {
      left: keys.has('left'), right: keys.has('right'),
      up: keys.has('up'), down: keys.has('down'),
      action: keys.has('action') || keys.has('enter'),
      px: mouse.x, py: mouse.y, pdown: mouse.down, clicked,
      pressed: k => pressed.has(k),
    };
  }

  /* ================================================================== *
   *  TRANSITIONS — a short crossfade from a snapshot of the last frame  *
   * ================================================================== */
  let trans = null;                                // {t, dur, kind}
  function goState(next, kind) {
    if (next === state) return;
    if (cv && ctx && snapCtx && !reducedMotion) {
      try {
        snapCtx.clearRect(0, 0, W, H);
        snapCtx.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, W, H);
        trans = { t: 0, dur: 0.26, kind: kind || 'fade' };
      } catch (e) { trans = null; }
    }
    state = next;
    emit('state', state);
  }
  function drawTrans(dt) {
    if (!trans) return;
    trans.t += dt;
    const k = trans.t / trans.dur;
    if (k >= 1) { trans = null; return; }
    const e = k * k * (3 - 2 * k);                 // smoothstep
    ctx.save();
    ctx.globalAlpha = 1 - e;
    if (trans.kind === 'wipe') ctx.translate(-e * W * 0.22, 0);
    ctx.drawImage(snap, 0, 0, W, H);
    ctx.restore();
  }

  /* ================================================================== *
   *  THE LOOP                                                           *
   * ================================================================== */
  const GAMES = [];
  let running = false, raf = 0, last = 0, clock = 0;
  let state = 'idle';        // idle | load | count | play | results | fatal
  let current = null, inst = null;
  let loadT = 0, loadPhase = 0, loadHold = 0;
  let countT = 0;
  let resultData = null, resultsT = 0, resultsFlash = 0;
  let drawFails = 0, fatalMsg = '';
  const listeners = {};
  function emit(evt, arg) {
    (listeners[evt] || []).forEach(fn => { try { fn(arg); } catch (e) {} });
  }
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return () => off(evt, fn); }
  function off(evt, fn) {
    const a = listeners[evt]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }

  function register(def) {
    if (!def || !def.id || GAMES.some(g => g.id === def.id)) return;
    GAMES.push(def);
    return def.id;
  }

  function start(id) {
    build();
    const def = id ? GAMES.find(g => g.id === id) : GAMES[0];
    if (!def) { fatal('No game registered.'); return false; }
    current = def; inst = null;
    loadT = 0; loadPhase = 0; loadHold = 0; drawFails = 0;
    resultData = null;
    parts.length = 0; shakeAmt = 0;
    goState('load');
    running = true;
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    return true;
  }
  function stop() {
    running = false;
    Music.stop(); Music.crowd(false);
    cancelAnimationFrame(raf);
  }
  function fatal(msg) {
    fatalMsg = String(msg || 'Something went wrong.').slice(0, 140);
    state = 'fatal';
    emit('state', state);
    if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function beginPlay() {
    if (current && current.countdown) {
      goState('count');
      countT = 3.2;
      SFX.whistle();
    } else {
      goState('play');
    }
  }

  function over(result) {
    resultData = result || {};
    resultsT = 0; resultsFlash = 0;
    goState('results');
    Music.crowd(false);
    if (resultData.win) { SFX.fanfare(); confetti(); Music.play('results'); }
    else { SFX.miss(); Music.play('fulltime'); }
  }

  /* Crash armour. A bug in the game must end the run honestly and leave the
   * page alive — never freeze the loop, never close the only thing on screen.
   * Three layers: create(), update()/draw(), and the frame body itself. */
  function frame(now) {
    if (!running) return;
    try { frameBody(now); }
    catch (err) {
      console.error('[cm-shell:frame]', err);
      if (state === 'results' || state === 'fatal') fatal(msgOf(err));
      else over({ win: false, lines: ['The game hit a bug and stopped itself.', msgOf(err)] });
    }
    raf = requestAnimationFrame(frame);
  }
  const msgOf = err => String((err && err.message) || err).slice(0, 70);

  function frameBody(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now; clock += dt;
    const input = makeInput();

    /* the probe, refreshed every frame: the shell owns it whenever the game
       is not the thing on screen (see THE TEST PROBE) */
    shellHots = shellScreenHots(state);
    if (state !== 'play') { try { window.__MG_SCREEN = 'cm/' + state; } catch (e) {} }

    if (state === 'load') {
      loadT += dt;
      if (loadPhase === 0) loadPhase = 1;             // paint one warming-up frame first
      else if (loadPhase === 1) {
        loadPhase = 2;
        const t0 = performance.now();
        try { inst = current.create(env); }
        catch (err) {
          console.error('[cm-shell:create]', err);
          over({ win: false, lines: ['The game hit a bug while warming up.', msgOf(err)] });
        }
        if (!inst && state === 'load') over({ win: false, lines: ['The game failed to start.'] });
        else if (inst) loadHold = (performance.now() - t0) > 100 ? 0.55 : 0;
      } else {
        loadHold -= dt;
        if (inst && loadHold <= 0) beginPlay();
      }
    } else if (state === 'count') {
      countT -= dt;
      if (countT <= 0) { goState('play'); SFX.go(); }
      else if ((countT % 1) > 0.94) SFX.count();
    } else if (state === 'play') {
      try { inst.update(dt, input); }
      catch (err) {
        console.error('[cm-shell:update]', err);
        over({ win: false, lines: ['The game hit a bug and stopped itself.', msgOf(err)] });
      }
    } else if (state === 'results') {
      resultsT += dt;
      resultsFlash = Math.max(0, resultsFlash - dt * 2.6);
      if (resultsT > 0.6
          && (input.clicked || input.pressed('enter') || input.pressed('action'))) {
        start(current && current.id);
        return;
      }
    } else if (state === 'fatal') {
      if (input.clicked || input.pressed('enter')) { try { location.reload(); } catch (e) {} }
    }

    updateParts(dt);

    /* ── draw ── everything below runs inside one device transform, so the
       game keeps drawing in 960x600 no matter the DPR or the canvas size. */
    ctx.setTransform(view.k, 0, 0, view.k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (shakeAmt > 0.5) {
      ctx.translate((Math.random() - 0.5) * shakeAmt, (Math.random() - 0.5) * shakeAmt);
    }
    ctx.fillStyle = COLORS.pitch;
    ctx.fillRect(0, 0, W, H);
    if (state === 'load') drawLoading();
    else if (state === 'fatal') drawFatal();
    else if (inst) {
      try { inst.draw(ctx); drawFails = 0; }
      catch (err) {
        console.error('[cm-shell:draw]', err);
        if (++drawFails >= 3) {
          over({ win: false, lines: ['The game could not draw itself.', msgOf(err)] });
        }
      }
    }
    if (state === 'count') drawCountdown();
    if (state === 'results') drawResults();
    drawParts(ctx);
    ctx.restore();
    drawTrans(dt);                       // the crossfade rides on top, unshaken
  }

  function easeOutBack(k) {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
  }

  function drawLoading() {
    const def = current || {};
    ctx.fillStyle = 'rgba(13,31,22,.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = '64px system-ui';
    ctx.fillText(def.icon || '🏆', W / 2, H / 2 - 74);
    ctx.font = 'bold 34px ui-rounded, system-ui';
    ctx.lineWidth = 7; ctx.strokeStyle = COLORS.pitch;
    ctx.strokeText(def.title || 'CARD MANAGER', W / 2, H / 2 - 14);
    ctx.fillStyle = COLORS.chalk;
    ctx.fillText(def.title || 'CARD MANAGER', W / 2, H / 2 - 14);
    const dots = '.'.repeat(1 + (Math.floor(loadT * 3) % 3));
    ctx.font = 'bold 17px ui-rounded, system-ui';
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('warming up' + dots, W / 2, H / 2 + 26);
    drawBall(ctx, W / 2, H / 2 + 76, 15, loadT * 7);
  }

  function drawCountdown() {
    const n = Math.ceil(countT);
    ctx.save();
    ctx.fillStyle = 'rgba(13,31,22,.5)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    const k = 1 - (countT % 1);
    ctx.font = 'bold ' + (90 + k * 40) + 'px ui-rounded, system-ui';
    ctx.lineWidth = 10; ctx.strokeStyle = COLORS.pitch;
    const txt = n > 0 ? String(n) : 'GO!';
    ctx.globalAlpha = 0.6 + k * 0.4;
    ctx.strokeText(txt, W / 2, H / 2 + 30);
    ctx.fillStyle = n > 0 ? COLORS.chalk : COLORS.gold;
    ctx.fillText(txt, W / 2, H / 2 + 30);
    ctx.restore();
  }

  function drawFatal() {
    ctx.fillStyle = 'rgba(13,31,22,.92)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px ui-rounded, system-ui';
    ctx.fillStyle = COLORS.chalk;
    ctx.fillText('CARD MANAGER STOPPED', W / 2, H / 2 - 30);
    ctx.font = 'bold 16px ui-rounded, system-ui';
    ctx.fillStyle = COLORS.fade;
    ctx.fillText(fatalMsg, W / 2, H / 2 + 6);
    ctx.fillText('Your career is saved.', W / 2, H / 2 + 34);
    ctx.font = 'bold 20px ui-rounded, system-ui';
    ctx.fillStyle = COLORS.gold;
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(clock * 3);
    ctx.fillText('TAP TO RELOAD', W / 2, H / 2 + 84);
    ctx.globalAlpha = 1;
  }

  /* The results presenter. Phone law (addendum 2): a waiting screen must SAY
   * how to leave it, so the prompt is a tap prompt, not a key list. */
  function drawResults() {
    const r = resultData || {};
    ctx.save();
    /* heavier than the arcade's .72: this screen has to stay legible at the
     * 0.40x reading test with a whole game frame behind it (ART-B1). */
    ctx.fillStyle = 'rgba(11,20,14,.90)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    const headIn = easeOutBack(Math.min(1, resultsT / 0.28));
    ctx.save();
    ctx.translate(W / 2, 170);
    ctx.scale(headIn, headIn);
    ctx.font = 'bold 56px ui-rounded, system-ui';
    ctx.lineWidth = 9; ctx.strokeStyle = COLORS.pitch;
    const head = r.title || (r.win ? 'YOU DID IT!' : 'FULL TIME');
    ctx.strokeText(head, 0, 0);
    if (r.win) {                          // trophy gleam sweeps the headline
      const p = (resultsT * 0.55) % 1.6;
      const cl = v => Math.max(0, Math.min(1, v));
      const g = ctx.createLinearGradient(-260, 0, 260, 0);
      g.addColorStop(0, COLORS.gold);
      g.addColorStop(cl(p - 0.09), COLORS.gold);
      g.addColorStop(cl(p), '#fff6d8');
      g.addColorStop(cl(p + 0.09), COLORS.gold);
      g.addColorStop(1, COLORS.gold);
      ctx.fillStyle = g;
    } else ctx.fillStyle = COLORS.chalk;
    ctx.fillText(head, 0, 0);
    ctx.restore();

    if (typeof r.score === 'number') {    // animated count-up (kept under
      const k = Math.min(1, Math.max(0, (resultsT - 0.25) / 0.9));  // reduced
      const e = 1 - Math.pow(1 - k, 3);                             // motion)
      ctx.font = 'bold 30px ui-rounded, system-ui';
      ctx.fillStyle = COLORS.chalk;
      ctx.fillText('score  ' + Math.round(r.score * e), W / 2, 228);
      if (k >= 1 && !r._counted) { r._counted = true; SFX.point(); }
    }
    let y = 300;
    for (const line of (r.lines || []).slice(0, 4)) {
      ctx.font = 'bold 17px ui-rounded, system-ui';
      ctx.fillStyle = COLORS.fade;
      ctx.fillText(line, W / 2, y); y += 26;
    }
    if (r.ranks && r.ranks.length) {      // podium bounces in, staggered
      const podium = r.ranks.slice().sort((a, b) => b.score - a.score).slice(0, 3);
      const spots = [{ x: W / 2, h: 86 }, { x: W / 2 - 150, h: 56 }, { x: W / 2 + 150, h: 38 }];
      podium.forEach((p2, i) => {
        const ak = Math.min(1, Math.max(0, (resultsT - 0.35 - i * 0.18) / 0.34));
        if (ak <= 0) return;
        const eb = easeOutBack(ak);
        const sp = spots[i], base = 470, h = Math.max(4, sp.h * eb);
        ctx.globalAlpha = Math.min(1, ak * 2.5);
        ctx.fillStyle = COLORS.turf2;
        ctx.strokeStyle = COLORS.line;
        rr(ctx, sp.x - 55, base - h, 110, h, Math.min(6, h / 2)); ctx.fill(); ctx.stroke();
        ctx.fillStyle = i === 0 ? COLORS.gold : COLORS.fade;
        ctx.font = 'bold 15px ui-rounded, system-ui';
        ctx.fillText(p2.name + ' · ' + p2.score, sp.x, base + 20);
        drawChar(ctx, p2.name in CAST ? p2.name : 'Gibson',
                 sp.x, base - h - 4, eb, i === 0 ? 'cheer' : 'idle', clock);
        ctx.globalAlpha = 1;
      });
    }
    /* the tap prompt — a big, honest, thumb-sized band across the bottom */
    const prompt = r.cta || 'TAP TO CONTINUE';
    ctx.fillStyle = 'rgba(21,48,30,.85)';
    rr(ctx, 0, H - 72, W, 72, 0); ctx.fill();
    ctx.fillStyle = COLORS.gold;
    ctx.font = 'bold 22px ui-rounded, system-ui';
    ctx.globalAlpha = reducedMotion ? 1 : 0.68 + 0.32 * Math.sin(clock * 3);
    ctx.fillText(prompt, W / 2, H - 28);
    ctx.globalAlpha = 1;
    if (resultsFlash > 0) {
      ctx.globalAlpha = Math.min(0.35, resultsFlash * 0.35);   // SAFE-C3 cap
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /* ================================================================== *
   *  ENV — what a game's create() receives                              *
   * ================================================================== */
  const env = {
    W, H, colors: COLORS, rr, drawChar, drawBall,
    heroes: HEROES, cast: CAST,
    get hero() { return 'Gibson'; },        // no hero picker; kept harmless
    sfx: new Proxy({}, { get: (_, k) => () => { if (SFX[k]) SFX[k](); } }),
    music: {
      play: id => Music.play(id),
      stop: () => Music.stop(),
      crowd: on2 => Music.crowd(on2),
    },
    shake, burst, floatText, confetti,
    rnd: (a, b) => a + Math.random() * (b - a),
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    lerp: (a, b, k) => a + (b - a) * k,
    best() { return undefined; },           // retired with the arcade shelf
    over(result) { over(result || {}); },
    get screen() { return view; },
    get dpr() { return view.dpr; },
    get reducedMotion() { return reducedMotion; },
    get shell() { return API; },
  };

  /* ================================================================== *
   *  BUILD                                                              *
   * ================================================================== */
  let built = false;
  function build() {
    if (built) return;
    built = true;
    injectCSS();
    stage = document.getElementById(STAGE_ID);
    if (!stage) {
      stage = document.createElement('div');
      stage.id = STAGE_ID;
      document.body.appendChild(stage);
    }
    stage.className = 'cm-stage';
    stage.hidden = false;
    cv = document.createElement('canvas');
    cv.id = 'cmCanvas';
    stage.appendChild(cv);
    ctx = cv.getContext('2d');

    cv.addEventListener('pointermove', e => {
      const p = toGame(e.clientX, e.clientY); mouse.x = p.x; mouse.y = p.y;
    });
    cv.addEventListener('pointerdown', e => {
      gestured = true;
      const p = toGame(e.clientX, e.clientY);
      mouse.x = p.x; mouse.y = p.y; mouse.down = true; mouse.clicked = true;
      ac();
      if (e.preventDefault) e.preventDefault();
    });
    cv.addEventListener('pointerup', () => { mouse.down = false; });
    cv.addEventListener('pointercancel', () => { mouse.down = false; });
    /* A tap on the letterbox does nothing. There is nowhere to close to, and
     * the arcade's click-to-close scrim was 72% of a phone (QA D-6). */
    stage.addEventListener('pointerdown', e => {
      if (e.target === stage) { gestured = true; ac(); }
    });
    cv.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', () => setTimeout(layout, 60));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
    layout();
  }

  /* ================================================================== *
   *  PUBLIC SURFACE                                                     *
   * ================================================================== */
  const API = {
    version: VERSION,
    W, H, colors: COLORS, cast: CAST, heroes: HEROES,
    rr, drawChar, drawBall,
    sfx: env.sfx, music: env.music,
    shake, burst, floatText, confetti,
    rnd: env.rnd, clamp: env.clamp, lerp: env.lerp,
    over: r => over(r || {}),
    register, start, stop, build, layout, fatal,
    on, off,
    toGame, clientOf, aimPoint,
    get env() { return env; },
    get canvas() { return cv; },
    get ctx() { return ctx; },
    get stage() { return stage; },
    get games() { return GAMES.map(g => g.id); },
    get view() { return view; },
    get muted() { return muted; },
    setMute,
    get reducedMotion() { return reducedMotion; },
    debug() {
      return { state, game: current && current.id, open: running,
               s: +view.s.toFixed(3), profile: view.profile,
               rotated: view.rotated, dpr: view.dpr, legacyMap: LEGACY_MAP,
               parts: parts.length, version: VERSION,
               probe: (view.rotated && !LEGACY_MAP) ? 'rot90' : 'game' };
    },
  };
  installProbe();
  window.CM_SHELL = API;

  /* Harness compatibility. tools/mg-tap-suite.js waits for window.MiniGames
   * and polls MiniGames.debug().state. This is the SHELL's own object under
   * the name the test rig knows — not a dependency on minigames.js, which is
   * never loaded here. It also lets the unextracted mg-manager.js (whose last
   * line is `if (!window.MiniGames) return;`) register on this page today, so
   * the shell can be proven against the real game before the extract lands.
   * Never installed if a real arcade is already on the page. */
  if (!window.MiniGames) {
    window.MiniGames = {
      register, open: id => start(id), close: stop,
      get games() { return API.games; },
      debug: API.debug,
      __cmShim: true,
    };
  }
})();
