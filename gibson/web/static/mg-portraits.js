/* mg-portraits.js — Card Manager's portrait engine.
 *
 * 989 original stylised faces, procedurally drawn, zero assets, zero network.
 * Implements .design-portraits.md (§3 determinism, §4 composition, §5 traits,
 * §9 the LOD ladder, §10 the caches, §11 fairness).
 *
 * HONESTY (§11.5): these are ORIGINAL STYLISED AVATARS invented from a hash of
 * a player's name. No photograph is read, fetched, traced or approximated; no
 * portrait is a likeness of the real person whose name the card carries, and
 * none of them ever leaves the game canvas — never a listing photo, never a
 * CSV, never eBay.
 *
 * FAIRNESS, MADE STRUCTURAL (§11.2): paintPortrait() is handed a 32-bit seed
 * and a garment. It is never handed a name, a team, a nation, a rating, an age
 * or a price — a stereotype is unrepresentable in the signature. There is
 * exactly one of each trait table; there is no per-region variant and there
 * never will be.
 *
 * Cosmetic by construction: consumes no engine rng(), writes no save state,
 * and never reaches for the platform random source (harness gate P7 greps for
 * it; this module is clean of the token as well as the call). Deleting this
 * file leaves every simulated result byte-identical.
 *
 *   window.MG_PORTRAIT = {
 *     seedOf(name, team) -> int32          // the strings die here
 *     traitsFor(seed)    -> frozen trait record (pure, memoised)
 *     draw(ctx, x, y, size, seedOrTraits, opts)   opts.pose 'card' | 'detail'
 *     cached(size, seedOrTraits, opts) -> offscreen canvas (LRU, ~400 entries)
 *     blit(ctx, x, y, size, seedOrTraits, opts)   cached tile, one drawImage
 *   }
 *
 * Loaded before mg-manager.js; also `require`-able from node for the audit and
 * determinism harnesses (tools/mg-portrait-audit.js).
 */
;(function () {
  'use strict';

  /* ==================================================================== *
   * 1.  VERSION, SALTS, CONSTANTS                                        *
   * ==================================================================== */

  /* Bumped ONLY when faces deliberately change (§3.3 law 3). It is part of
     every cache key, so a stale tile can never survive a bump. */
  const PORTRAIT_VERSION = 1;

  const TAU = Math.PI * 2;
  const D2R = Math.PI / 180;

  /* §3.4 the salt register — APPEND ONLY. Never renumber, never reuse. */
  const SALT = {
    SKIN: 11, SKINJIT: 12, HEAD: 13, JAW: 14, EAR: 15, HAIR: 16, HAIRCOL: 17,
    ROOT: 18, BROW: 19, EYE: 20, IRIS: 21, NOSE: 22, MOUTH: 23, FACIAL: 24,
    YAW: 25, TILT: 26, BAND: 27, BANDCOL: 28, TAPE: 29, EARRING: 30,
    TATTOO: 31, FRECK: 32,
    /* 40-42 are seeded by the TEAM code at the call site (§6.1) and reach the
       painter only as a resolved garment record. */
    COLLAR: 40, SLEEVE: 41, CREST: 42
  };

  /* ==================================================================== *
   * 2.  THE SEED AND THE LANE LAW  (§3.1, §3.2)                          *
   * ==================================================================== */

  /* FNV-1a, 32-bit, over UTF-16 code units. Integer-exact in every engine. */
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /* The one entry point that ever sees a name. It returns an integer and the
     strings die here: 32 bits carry nothing recoverable about a country. */
  function seedOf(name, team) {
    return fnv1a(String(name) + '|' + String(team == null ? '' : team));
  }

  /* One independent lane per layer (splitmix32 finaliser). Adding a trait
     later takes a NEW salt and cannot disturb one existing face. */
  function lane(seed, salt) {
    let h = (seed ^ Math.imul(salt | 0, 0x9E3779B1)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x21f0aaad) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x735a2d97) >>> 0;
    h ^= h >>> 15;
    return h >>> 0;
  }
  const unit = (seed, salt) => lane(seed, salt) / 4294967296;
  const chance = (seed, salt, p) => unit(seed, salt) < p;
  function pick(seed, salt, weights) {
    let tot = 0;
    for (let i = 0; i < weights.length; i++) tot += weights[i];
    let r = unit(seed, salt) * tot;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; }
    return weights.length - 1;
  }
  /* a second, decorrelated [0,1) off the same lane's low bits — used only for
     continuous jitter that must not consume a new salt */
  const unit2 = (seed, salt) => ((lane(seed, salt) >>> 8) & 0xffff) / 65536;

  /* ==================================================================== *
   * 3.  COLOUR                                                           *
   * ==================================================================== */

  const _rgbCache = new Map();
  function rgbOf(hex) {
    let v = _rgbCache.get(hex);
    if (v) return v;
    let h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16) | 0;
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (_rgbCache.size < 600) _rgbCache.set(hex, v);
    return v;
  }
  const _h2 = (n) => {
    n = Math.round(n); n = n < 0 ? 0 : n > 255 ? 255 : n;
    return (n < 16 ? '0' : '') + n.toString(16);
  };
  const hexOf = (r, g, b) => '#' + _h2(r) + _h2(g) + _h2(b);

  function mix(a, b, k) {
    const A = rgbOf(a), B = rgbOf(b);
    return hexOf(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
  }
  const lighten = (hex, k) => mix(hex, '#ffffff', k);
  const darken = (hex, k) => mix(hex, '#000000', k);
  function rgba(hex, a) {
    const c = rgbOf(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function lum(hex) {                       // sRGB relative luminance
    const c = rgbOf(hex);
    const f = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    const l = (mx + mn) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return [h, s, l];
  }
  function hsl2hex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    l = l < 0 ? 0 : l > 1 ? 1 : l;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return hexOf((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }
  function nudge(hex, dHue, dLight) {
    const c = rgbOf(hex), hsl = rgb2hsl(c[0], c[1], c[2]);
    return hsl2hex(hsl[0] + dHue, hsl[1], hsl[2] + dLight);
  }
  function hueShift(hex, deg) { return nudge(hex, deg, 0); }

  /* ==================================================================== *
   * 4.  THE TRAIT VOCABULARY  (§5)                                       *
   *                                                                      *
   * ONE global table per trait. No per-nation, per-team or per-rating     *
   * variant exists, and adding one has to defeat §11 first.              *
   * ==================================================================== */

  /* §5.1 skin — a single continuous human ramp, near-uniform weights.
     S03 is the shop's own drawChar skin, so the ramp is built AROUND the
     house colour rather than beside it. */
  const SKIN = ['#F6DCC4', '#F0CFAF', '#E8C39A', '#E0B489', '#D3A171', '#C58F63',
    '#B67C52', '#A56A45', '#8E5636', '#77452B', '#5F3520', '#4A2818'];
  const W_SKIN = [6, 7, 8, 9, 10, 10, 10, 10, 9, 8, 7, 6];

  /* §5.2 head shape: kw, tw, cw, jw, cl */
  const HEAD = [
    [0.88, 0.95, 1.00, 0.70, 1.22],   // OVAL
    [0.95, 1.00, 1.04, 0.84, 1.10],   // ROUND
    [0.96, 0.99, 1.00, 0.92, 1.14],   // SQUARE
    [0.98, 1.00, 0.96, 0.60, 1.20],   // HEART
    [0.84, 0.90, 0.92, 0.70, 1.30],   // LONG
    [0.80, 0.92, 1.02, 0.66, 1.26]    // DIAMOND
  ];
  const HEAD_NAME = ['OVAL', 'ROUND', 'SQUARE', 'HEART', 'LONG', 'DIAMOND'];
  const W_HEAD = [26, 20, 16, 12, 14, 12];
  const JAW_MULT = [0.92, 1.00, 1.08], W_JAW = [30, 45, 25];
  const EAR_R = [0.145, 0.175, 0.205], W_EAR = [30, 50, 20];

  /* §5.3 hair — 22 styles. cls = silhouette class (the only thing that
     survives at six pixels): 0 skin-top 1 close 2 capped 3 swept 4 volume
     5 tied 6 long. hairY / lift / spread build the cap (§4.4 L11); hl is the
     hairline shape: 0 round 1 flat 2 receding-peak 3 deep fringe. */
  const HAIR_NAME = ['BALD', 'SHAVED', 'BUZZ', 'CROP', 'SIDE_PART', 'FRINGE',
    'CURTAINS', 'QUIFF', 'TOP_FADE', 'AFRO_LOW', 'AFRO_TALL', 'CURLS', 'WAVES',
    'TWISTS', 'CORNROWS', 'DREADS_SHORT', 'DREADS_LONG', 'PONYTAIL', 'BUN',
    'MULLET', 'LONG_LOOSE', 'RECEDING'];
  const W_HAIR = [4, 5, 9, 11, 7, 7, 4, 6, 5, 6, 3, 6, 5, 3, 4, 3, 2, 3, 3, 2, 3, 2];
  const SIL_CLASS = [0, 0, 1, 1, 2, 2, 3, 3, 1, 4, 4, 4, 2, 4, 1, 4, 6, 5, 5, 6, 6, 2];
  const SIL_NAME = ['skin-top', 'close', 'capped', 'swept', 'volume', 'tied', 'long'];
  /*                 hairY  lift  spread  hl  hidesEars  alpha */
  const HAIR = [
    [-0.52, 0.00, 1.00, 0, 0, 0.00],   //  0 BALD
    [-0.50, 0.00, 1.01, 0, 0, 0.30],   //  1 SHAVED
    [-0.50, 0.01, 1.02, 0, 0, 0.85],   //  2 BUZZ
    [-0.46, 0.06, 1.04, 0, 0, 1.00],   //  3 CROP
    [-0.44, 0.11, 1.06, 0, 0, 1.00],   //  4 SIDE_PART
    [-0.34, 0.10, 1.06, 3, 0, 1.00],   //  5 FRINGE
    [-0.40, 0.13, 1.07, 0, 0, 1.00],   //  6 CURTAINS
    [-0.48, 0.15, 1.05, 0, 0, 1.00],   //  7 QUIFF
    [-0.48, 0.17, 1.03, 1, 0, 1.00],   //  8 TOP_FADE
    [-0.44, 0.26, 1.17, 0, 1, 1.00],   //  9 AFRO_LOW
    [-0.42, 0.40, 1.26, 0, 1, 1.00],   // 10 AFRO_TALL
    [-0.44, 0.21, 1.13, 0, 1, 1.00],   // 11 CURLS
    [-0.48, 0.07, 1.04, 0, 0, 1.00],   // 12 WAVES
    [-0.44, 0.22, 1.14, 0, 1, 1.00],   // 13 TWISTS
    [-0.50, 0.05, 1.03, 0, 0, 1.00],   // 14 CORNROWS
    [-0.44, 0.19, 1.12, 0, 1, 1.00],   // 15 DREADS_SHORT
    [-0.44, 0.21, 1.12, 0, 1, 1.00],   // 16 DREADS_LONG
    [-0.48, 0.06, 1.04, 0, 0, 1.00],   // 17 PONYTAIL
    [-0.48, 0.06, 1.04, 0, 0, 1.00],   // 18 BUN
    [-0.46, 0.08, 1.05, 0, 0, 1.00],   // 19 MULLET
    [-0.42, 0.13, 1.09, 0, 1, 1.00],   // 20 LONG_LOOSE
    [-0.30, 0.02, 1.02, 2, 0, 1.00]    // 21 RECEDING
  ];
  const HAIR_BACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 2, 3, 4, 5, 0];
  /* 0 none · 1 volume mass · 2 ponytail · 3 bun · 4 mullet skirt · 5 side falls */

  /* §5.4 hair colour */
  const HCOL_NAME = ['jet', 'soft black', 'dark brown', 'mid brown', 'warm brown',
    'chestnut', 'auburn', 'ginger', 'dark blond', 'blond', 'platinum', 'silver'];
  const HCOL = ['#16130F', '#241C16', '#3A2718', '#4E3320', '#63431F', '#7A4A24',
    '#8E4520', '#B4602A', '#9A7440', '#C79A54', '#E4D3AE', '#C9C6C0'];
  const W_HCOL = [16, 12, 15, 13, 10, 8, 5, 3, 6, 5, 4, 3];
  const W_ROOT = [16, 12, 15, 13, 10, 8, 5, 3, 6, 5];   // the table minus platinum/silver

  /* §5.5 brows: thickness, arch */
  const BROW_NAME = ['flat', 'arched', 'angled', 'thick-straight', 'thin-tapered'];
  const W_BROW = [26, 24, 18, 18, 14];
  const BROW_T = [0.078, 0.072, 0.080, 0.094, 0.058];
  const BROW_ARCH = [-0.02, -0.10, -0.05, -0.03, -0.06];

  /* §5.6 eyes: halfWidth, upper lid, lower lid, outer-corner rise */
  const EYE_NAME = ['round', 'almond', 'narrow', 'wide', 'hooded', 'upturned'];
  const W_EYE = [24, 26, 14, 14, 12, 10];
  const EYE = [
    [0.176, 0.166, 0.154, 0.000],
    [0.196, 0.142, 0.114, 0.011],
    [0.206, 0.108, 0.086, 0.007],
    [0.186, 0.178, 0.146, 0.000],
    [0.196, 0.120, 0.108, 0.004],
    [0.194, 0.144, 0.106, 0.037]
  ];
  const IRIS_NAME = ['dark brown', 'brown', 'hazel', 'green', 'blue', 'grey'];
  const IRIS = ['#3A2418', '#5A3A20', '#7A6234', '#4E7A4A', '#4E7AA8', '#7C8A94'];
  const W_IRIS = [34, 26, 12, 10, 12, 6];

  /* §5.7-5.9 */
  const NOSE_NAME = ['soft dot', 'short line', 'wedge', 'broad', 'hooked'];
  const W_NOSE = [26, 24, 20, 18, 12];
  const MOUTH_NAME = ['neutral', 'slight smile', 'smile', 'open smile', 'set', 'grin'];
  const W_MOUTH = [18, 30, 22, 12, 12, 6];
  const FACIAL_NAME = ['none', 'stubble light', 'stubble heavy', 'moustache',
    'goatee', 'chinstrap', 'beard short', 'beard full', 'beard long'];
  const W_FACIAL = [44, 14, 8, 3, 7, 4, 11, 7, 2];
  const FAC_CLASS = [0, 1, 1, 2, 2, 2, 3, 3, 3];       // none / stubble / shaped / beard
  const FAC_NAME_CLASS = ['none', 'stubble', 'shaped', 'beard'];
  const W_YAW = [40, 30, 30];
  const BAND_COL = ['#F4F1E8', '#1B1B1F', 'ACCENT'];   // ACCENT resolves to the kit accent

  /* garment (§6.1) — seeded by TEAM at the call site, never by the person */
  const W_COLLAR = [40, 28, 20, 12];                   // crew / v-neck / polo / buttoned
  const W_SLEEVE = [70, 30];                           // plain / banded

  /* ==================================================================== *
   * 5.  traitsFor — pure, frozen, memoised                               *
   * ==================================================================== */

  const _traits = new Map();
  const TRAIT_CACHE_MAX = 4096;

  function traitsFor(seed) {
    seed = seed >>> 0;
    let t = _traits.get(seed);
    if (t) return t;

    const skin = pick(seed, SALT.SKIN, W_SKIN);
    const head = pick(seed, SALT.HEAD, W_HEAD);
    const jaw = pick(seed, SALT.JAW, W_JAW);
    const ear = pick(seed, SALT.EAR, W_EAR);
    const hair = pick(seed, SALT.HAIR, W_HAIR);
    const hcol = pick(seed, SALT.HAIRCOL, W_HCOL);
    const brow = pick(seed, SALT.BROW, W_BROW);
    const eye = pick(seed, SALT.EYE, W_EYE);
    const iris = pick(seed, SALT.IRIS, W_IRIS);
    const nose = pick(seed, SALT.NOSE, W_NOSE);
    const mouth = pick(seed, SALT.MOUTH, W_MOUTH);
    const facial = pick(seed, SALT.FACIAL, W_FACIAL);
    const yaw = pick(seed, SALT.YAW, W_YAW);
    const band = chance(seed, SALT.BAND, 0.06) ? 1 + pick(seed, SALT.BANDCOL, [1, 1, 1]) : 0;
    const tape = chance(seed, SALT.TAPE, 0.02) ? 1 : 0;
    const ering = chance(seed, SALT.EARRING, 0.05) ? 1 : 0;
    const tattoo = chance(seed, SALT.TATTOO, 0.04) ? 1 : 0;
    const freck = chance(seed, SALT.FRECK, 0.07) ? 1 : 0;

    /* §5.1 jitter: +/-2.5% lightness, +/-3deg hue, so twelve stops never band
       across a page of cards. */
    const jl = (unit(seed, SALT.SKINJIT) - 0.5) * 0.05;
    const jh = (unit2(seed, SALT.SKINJIT) - 0.5) * 6;
    const skinBase = nudge(SKIN[skin], jh, jl);
    const S = Object.freeze({
      base: skinBase,
      shade: mix(skinBase, '#3A2418', 0.28),
      light: mix(skinBase, '#FFF3E2', 0.35),
      line: darken(skinBase, 0.38),
      deep: mix(skinBase, '#3A2418', 0.46)
    });

    /* §5.4 the bleach rule — platinum grows roots, and its brows and beard
       come from the natural colour underneath. Invisible brows look broken. */
    const isBleach = hcol === 10;
    const rootIdx = isBleach ? pick(seed, SALT.ROOT, W_ROOT) : hcol;
    const hb = HCOL[hcol], rootCol = HCOL[rootIdx];
    const H = Object.freeze({
      base: hb,
      shadow: darken(hb, 0.35),
      sheen: mix(hb, '#FFFFFF', 0.30),
      brow: darken(isBleach ? rootCol : hb, 0.12),
      beardCol: darken(isBleach ? rootCol : hb, 0.06),
      root: rootCol,
      bleach: isBleach
    });

    const sh = HEAD[head];
    t = Object.freeze({
      seed: seed,
      skin: skin, head: head, jaw: jaw, ear: ear, hair: hair, hcol: hcol,
      brow: brow, eye: eye, iris: iris, nose: nose, mouth: mouth,
      facial: facial, yaw: yaw, band: band, tape: tape, ering: ering,
      tattoo: tattoo, freck: freck,
      root: rootIdx,
      /* continuous, from the lanes' spare bits — never a new salt */
      tilt: (unit(seed, SALT.TILT) - 0.5) * 0.07,
      eyeGap: (unit2(seed, SALT.EYE) - 0.5) * 0.04,
      browRise: (unit2(seed, SALT.BROW) - 0.5) * 0.05,
      /* derived */
      S: S, H: H,
      kw: sh[0], tw: sh[1], cw: sh[2], jw: sh[3] * JAW_MULT[jaw], cl: sh[4],
      earR: EAR_R[ear],
      sil: SIL_CLASS[hair], facClass: FAC_CLASS[facial],
      hidesEars: HAIR[hair][4] === 1
    });

    if (_traits.size >= TRAIT_CACHE_MAX) _traits.delete(_traits.keys().next().value);
    _traits.set(seed, t);
    return t;
  }

  const traitsOf = (x) => (typeof x === 'object' && x !== null) ? x : traitsFor(x);

  /* the 18 discrete indices, in the audit script's order (§12.1) */
  function vectorOf(seed) {
    const t = traitsOf(seed);
    return [t.skin, t.head, t.jaw, t.ear, t.hair, t.hcol, t.brow, t.eye, t.iris,
      t.nose, t.mouth, t.facial, t.yaw, t.band, t.tape, t.ering, t.tattoo, t.freck];
  }

  /* ==================================================================== *
   * 6.  THE GARMENT  (§6.1) — a fact about a football team, never about   *
   *     a human being. Resolved at the call site; the painter sees only   *
   *     two colours and two shape flags.                                  *
   * ==================================================================== */

  const DEFAULT_KIT = Object.freeze({
    c1: '#3F5AA8', c2: '#E9BF63', collar: 0, sleeve: 0, key: 'def'
  });

  function guardPrimary(hex) {
    const L = lum(hex);
    if (L > 0.62) return darken(hex, 0.30);            // ENG/GER whites
    if (L < 0.05) return mix(hex, '#FFFFFF', 0.18);    // near-blacks
    return hex;
  }
  function hueDist(a, b) {
    const A = rgbOf(a), B = rgbOf(b);
    let d = Math.abs(rgb2hsl(A[0], A[1], A[2])[0] - rgb2hsl(B[0], B[1], B[2])[0]) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* kitFor(c1, c2, key) — `key` is any stable string (a team code); it is
     hashed for the collar/sleeve lanes and then discarded. */
  function kitFor(c1, c2, key) {
    const primary = guardPrimary(c1 || '#3F5AA8');
    let accent = guardPrimary(c2 || '#E9BF63');
    if (Math.abs(lum(primary) - lum(accent)) < 0.18 && hueDist(primary, accent) < 25) {
      accent = '#E9BF63';                              // the house fallback
    }
    const s = fnv1a('kit|' + (key || ''));
    return {
      c1: primary, c2: accent,
      collar: pick(s, SALT.COLLAR, W_COLLAR),
      sleeve: pick(s, SALT.SLEEVE, W_SLEEVE),
      key: (key || 'def') + ':' + primary + accent
    };
  }
  const kitKey = (k) => k.key || (k.c1 + k.c2 + k.collar + k.sleeve);

  /* ==================================================================== *
   * 7.  GEOMETRY  (§4.1) — everything in head-radius units around C       *
   * ==================================================================== */

  const G = {
    ceiling: -1.50, crown: -1.06, brow: -0.24, eye: 0.06, ear: 0.06,
    nose: 0.32, mouth: 0.60, neck: 1.00, shoulder: 1.62, floor: 2.10,
    halfW: 2.15, tileH: 3.60, tileW: 4.30
  };

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* the head: one path, six bezier segments, symmetric (§4.4 L4) */
  function headPath(ctx, R, t) {
    const kw = t.kw * R, tw = t.tw * R, cw = t.cw * R, jw = t.jw * R, cl = t.cl * R;
    ctx.beginPath();
    ctx.moveTo(0, -1.06 * R);
    ctx.bezierCurveTo(kw, -1.02 * R, tw, -0.55 * R, cw, -0.05 * R);
    ctx.bezierCurveTo(cw, 0.42 * R, jw, 0.86 * R, 0, cl);
    ctx.bezierCurveTo(-jw, 0.86 * R, -cw, 0.42 * R, -cw, -0.05 * R);
    ctx.bezierCurveTo(-tw, -0.55 * R, -kw, -1.02 * R, 0, -1.06 * R);
    ctx.closePath();
  }

  /* the cap skeleton every hairstyle starts from: the skull arc above the
     hairline, closed by a hairline curve. hl 0 round · 1 flat · 2 receding
     peak · 3 deep fringe. */
  function capPath(ctx, R, t, rx, ry, hairY, hl) {
    const s = hairY / ry;
    const t0 = Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
    const x0 = rx * Math.cos(t0);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, Math.PI - t0, TAU + t0, false);
    if (hl === 1) {
      ctx.lineTo(-x0, hairY);
    } else if (hl === 2) {                                  // receding temples
      ctx.bezierCurveTo(x0 * 0.80, hairY - 0.36 * R, x0 * 0.34, hairY - 0.10 * R, 0, hairY + 0.06 * R);
      ctx.bezierCurveTo(-x0 * 0.34, hairY - 0.10 * R, -x0 * 0.80, hairY - 0.36 * R, -x0, hairY);
    } else if (hl === 3) {                                  // deep straight fringe
      ctx.quadraticCurveTo(0, hairY + 0.06 * R, -x0, hairY);
    } else {
      ctx.quadraticCurveTo(0, hairY + 0.15 * R, -x0, hairY);
    }
    ctx.closePath();
    return x0;
  }

  /* the beard mass — jaw sides up to the ear line, top edge passing under
     the mouth so the moustache stays a separate decision (§4.4 L10) */
  function beardPath(ctx, R, t, topY, chinExt) {
    const cw = t.cw * R, jw = t.jw * R, cl = t.cl * R + chinExt;
    ctx.beginPath();
    ctx.moveTo(-cw, topY);
    ctx.bezierCurveTo(-0.66 * R, 0.58 * R, -0.36 * R, 0.78 * R, 0, 0.78 * R);
    ctx.bezierCurveTo(0.36 * R, 0.78 * R, 0.66 * R, 0.58 * R, cw, topY);
    ctx.bezierCurveTo(cw, 0.42 * R, jw, 0.86 * R, 0, cl);
    ctx.bezierCurveTo(-jw, 0.86 * R, -cw, 0.42 * R, -cw, topY);
    ctx.closePath();
  }

  function shouldersPath(ctx, R, span) {
    ctx.beginPath();
    ctx.moveTo(-span * R, G.floor * R);
    ctx.lineTo(-1.06 * R, 1.62 * R);
    ctx.quadraticCurveTo(-0.54 * R, 1.48 * R, 0, 1.46 * R);
    ctx.quadraticCurveTo(0.54 * R, 1.48 * R, 1.06 * R, 1.62 * R);
    ctx.lineTo(span * R, G.floor * R);
    ctx.closePath();
  }

  /* ==================================================================== *
   * 8.  THE LAYER STACK  (§4.3) — back to front                          *
   * ==================================================================== */

  /* L0 — hair BACK mass */
  function layerHairBack(ctx, R, t, mono) {
    const kind = HAIR_BACK[t.hair];
    if (!kind) return;
    const H = t.H, col = mono ? MONO_DEEP : H.shadow;
    ctx.fillStyle = col;
    if (kind === 1) {                                  // volume
      const kw = t.hair === 10 ? 1.44 : t.hair === 16 ? 1.30 : 1.32;
      const ky = t.hair === 10 ? 1.46 : 1.30;
      ctx.beginPath();
      ctx.ellipse(0, -0.26 * R, kw * R, ky * R, 0, 0, TAU);
      ctx.fill();
      if (t.hair === 16) {                             // DREADS_LONG hangs
        ctx.beginPath();
        rr(ctx, -1.24 * R, -0.20 * R, 2.48 * R, 1.72 * R, 0.48 * R);
        ctx.fill();
      }
      if (t.hair === 15) {
        ctx.beginPath();
        rr(ctx, -1.18 * R, -0.20 * R, 2.36 * R, 0.86 * R, 0.40 * R);
        ctx.fill();
      }
    } else if (kind === 2) {                           // ponytail — swung out
      ctx.lineCap = 'round';                           // to the side so it reads
      ctx.lineWidth = 0.28 * R;                        // from the front
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(0.42 * R, -1.00 * R);
      ctx.bezierCurveTo(1.16 * R, -0.94 * R, 1.42 * R, -0.24 * R, 1.22 * R, 0.52 * R);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(1.20 * R, 0.56 * R, 0.17 * R, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, -1.02 * R, 0.70 * R, 0.40 * R, 0, 0, TAU); ctx.fill();
    } else if (kind === 3) {                           // bun, proud of the crown
      ctx.beginPath(); ctx.arc(0.04 * R, -1.10 * R, 0.40 * R, 0, TAU); ctx.fill();
      ctx.strokeStyle = rgba(mono ? MONO_MID : H.sheen, 0.35);
      ctx.lineWidth = 0.05 * R;
      ctx.beginPath(); ctx.arc(0.04 * R, -1.10 * R, 0.40 * R, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    } else if (kind === 4) {                           // mullet skirt, business
      ctx.beginPath();                                 // at the back
      ctx.moveTo(-1.16 * R, -0.10 * R);
      ctx.quadraticCurveTo(-1.28 * R, 0.80 * R, -0.86 * R, 1.36 * R);
      ctx.lineTo(0.86 * R, 1.36 * R);
      ctx.quadraticCurveTo(1.28 * R, 0.80 * R, 1.16 * R, -0.10 * R);
      ctx.closePath(); ctx.fill();
    } else if (kind === 5) {                           // long loose falls
      ctx.beginPath();
      ctx.moveTo(-0.98 * R, -0.60 * R);
      ctx.quadraticCurveTo(-1.32 * R, 0.50 * R, -1.04 * R, 1.56 * R);
      ctx.lineTo(1.04 * R, 1.56 * R);
      ctx.quadraticCurveTo(1.32 * R, 0.50 * R, 0.98 * R, -0.60 * R);
      ctx.closePath(); ctx.fill();
    }
  }

  /* L1 — shoulders and garment: the card's kit band becomes a body */
  function layerGarment(ctx, R, t, kit, shape, lod, mono, faceGround) {
    const span = shape === 'b' ? 1.90 : 2.92;
    shouldersPath(ctx, R, span);
    if (mono) { ctx.fillStyle = MONO_MID; ctx.fill(); return; }

    const g = ctx.createLinearGradient(0, 1.43 * R, 0, G.floor * R);
    g.addColorStop(0, lighten(kit.c1, 0.16));
    g.addColorStop(0.55, kit.c1);
    g.addColorStop(1, darken(kit.c1, 0.22));
    ctx.fillStyle = g;
    ctx.fill();

    /* contrast guard — a white kit must not dissolve into a cream card face */
    if (faceGround && Math.abs(lum(kit.c1) - lum(faceGround)) < 0.18) {
      ctx.strokeStyle = 'rgba(43,53,66,.75)';
      ctx.lineWidth = Math.max(1, 0.024 * R);
      shouldersPath(ctx, R, span); ctx.stroke();
    }

    ctx.save();
    shouldersPath(ctx, R, span); ctx.clip();

    if (kit.sleeve === 1 && lod >= 1) {                 // banded sleeves
      ctx.fillStyle = kit.c2;
      ctx.globalAlpha = 0.92;
      const sx2 = (span - 0.42) * R;
      ctx.fillRect(-sx2 - 0.17 * R, 1.50 * R, 0.17 * R, 1.0 * R);
      ctx.fillRect(sx2, 1.50 * R, 0.17 * R, 1.0 * R);
      ctx.globalAlpha = 1;
    }

    /* the collar, per §6.1 */
    ctx.strokeStyle = kit.c2;
    ctx.lineWidth = 0.10 * R;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (kit.collar === 1) {                             // v-neck
      ctx.moveTo(-0.44 * R, 1.48 * R); ctx.lineTo(0, 1.88 * R); ctx.lineTo(0.44 * R, 1.48 * R);
    } else if (kit.collar === 2) {                      // polo
      ctx.moveTo(-0.56 * R, 1.50 * R); ctx.lineTo(-0.15 * R, 1.84 * R);
      ctx.moveTo(0.56 * R, 1.50 * R); ctx.lineTo(0.15 * R, 1.84 * R);
      ctx.moveTo(-0.15 * R, 1.84 * R); ctx.lineTo(0.15 * R, 1.84 * R);
    } else if (kit.collar === 3) {                      // buttoned placket
      ctx.moveTo(-0.36 * R, 1.50 * R); ctx.lineTo(-0.11 * R, 1.98 * R);
      ctx.moveTo(0.36 * R, 1.50 * R); ctx.lineTo(0.11 * R, 1.98 * R);
    } else {                                            // crew
      ctx.moveTo(-0.48 * R, 1.50 * R);
      ctx.quadraticCurveTo(0, 1.76 * R, 0.48 * R, 1.50 * R);
    }
    ctx.stroke();
    if (kit.collar === 3 && lod >= 2) {
      ctx.fillStyle = kit.c2;
      ctx.beginPath(); ctx.arc(0, 1.86 * R, 0.055 * R, 0, TAU); ctx.fill();
    }

    /* seam + the jaw's cast shadow on the chest */
    ctx.strokeStyle = rgba(darken(kit.c1, 0.45), 0.9);
    ctx.lineWidth = Math.max(0.7, 0.018 * R);
    ctx.beginPath();
    ctx.moveTo(-1.06 * R, 1.62 * R);
    ctx.quadraticCurveTo(-0.54 * R, 1.48 * R, 0, 1.46 * R);
    ctx.quadraticCurveTo(0.54 * R, 1.48 * R, 1.06 * R, 1.62 * R);
    ctx.stroke();

    const sg = ctx.createRadialGradient(0, 1.50 * R, 0, 0, 1.50 * R, 0.95 * R);
    sg.addColorStop(0, 'rgba(0,0,0,.22)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(-span * R, 1.28 * R, span * 2 * R, R);
    ctx.restore();
  }

  /* L2 — neck */
  function layerNeck(ctx, R, t, mono) {
    ctx.fillStyle = mono ? MONO_MID : t.S.base;
    rr(ctx, -0.28 * R, 0.86 * R, 0.56 * R, 0.94 * R, 0.17 * R);
    ctx.fill();
    if (mono) return;
    ctx.save();
    rr(ctx, -0.28 * R, 0.86 * R, 0.56 * R, 0.94 * R, 0.17 * R);
    ctx.clip();
    ctx.fillStyle = rgba(t.S.shade, 0.55);
    ctx.beginPath();
    ctx.moveTo(-0.42 * R, 0.80 * R);
    ctx.quadraticCurveTo(0, 1.16 * R, 0.42 * R, 0.80 * R);
    ctx.lineTo(0.42 * R, 0.86 * R);
    ctx.quadraticCurveTo(0, 1.02 * R, -0.42 * R, 0.86 * R);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* L3 — ears (suppressed by volume hair: a physical rule, never a gate) */
  function layerEars(ctx, R, t, mono) {
    if (t.hidesEars) return;
    const ex = t.cw * R * 0.92, er = t.earR * R;
    ctx.fillStyle = mono ? MONO_MID : t.S.base;
    ctx.beginPath(); ctx.ellipse(-ex, G.ear * R, er * 0.56, er, 0.10, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ex, G.ear * R, er * 0.56, er, -0.10, 0, TAU); ctx.fill();
    if (mono) return;
    ctx.strokeStyle = rgba(t.S.line, 0.55);
    ctx.lineWidth = Math.max(0.6, 0.022 * R);
    ctx.beginPath(); ctx.arc(-ex, G.ear * R, er * 0.42, -1.2, 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, G.ear * R, er * 0.42, Math.PI - 1.2, Math.PI + 1.2); ctx.stroke();
  }

  /* L4/L5 — the head, its soft box, its falloff and its jaw shading */
  function layerHead(ctx, R, t, lod, mono) {
    headPath(ctx, R, t);
    if (mono) { ctx.fillStyle = MONO_MID; ctx.fill(); return; }
    ctx.fillStyle = t.S.base;
    ctx.fill();

    ctx.save();
    headPath(ctx, R, t); ctx.clip();

    const box = ctx.createRadialGradient(-0.34 * R, -0.42 * R, 0, -0.34 * R, -0.42 * R, 1.15 * R);
    box.addColorStop(0, 'rgba(255,255,255,.16)');
    box.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = box;
    ctx.fillRect(-1.3 * R, -1.3 * R, 2.6 * R, 3.0 * R);

    const fall = ctx.createRadialGradient(0.55 * R, 0.70 * R, 0, 0.55 * R, 0.70 * R, 1.30 * R);
    fall.addColorStop(0, rgba(t.S.shade, 0.30));
    fall.addColorStop(1, rgba(t.S.shade, 0));
    ctx.fillStyle = fall;
    ctx.fillRect(-1.3 * R, -1.3 * R, 2.6 * R, 3.0 * R);

    if (lod >= 1) {                                     // the silhouette line —
      headPath(ctx, R, t);                              // a jaw must survive a
      ctx.strokeStyle = rgba(t.S.deep, 0.30);           // dark window ground
      ctx.lineWidth = Math.max(0.8, 0.026 * R);
      ctx.stroke();
    }

    if (lod >= 2) {
      ctx.fillStyle = rgba(t.S.shade, 0.22);            // jaw band
      ctx.beginPath();
      ctx.moveTo(-t.cw * R, 0.34 * R);
      ctx.bezierCurveTo(-t.cw * R, 0.66 * R, -t.jw * R, 1.00 * R, 0, t.cl * R + 0.02 * R);
      ctx.bezierCurveTo(t.jw * R, 1.00 * R, t.cw * R, 0.66 * R, t.cw * R, 0.34 * R);
      ctx.lineTo(t.cw * R, 0.62 * R);
      ctx.bezierCurveTo(t.jw * R, 1.10 * R, -t.jw * R, 1.10 * R, -t.cw * R, 0.62 * R);
      ctx.closePath(); ctx.fill();

      const temple = (sx) => {                          // temple dab
        const tg = ctx.createRadialGradient(sx * 0.86 * R, -0.42 * R, 0, sx * 0.86 * R, -0.42 * R, 0.34 * R);
        tg.addColorStop(0, rgba(t.S.shade, 0.14));
        tg.addColorStop(1, rgba(t.S.shade, 0));
        ctx.fillStyle = tg;
        ctx.fillRect(sx > 0 ? 0.4 * R : -1.3 * R, -0.9 * R, 0.9 * R, 0.9 * R);
      };
      temple(-1); temple(1);

      /* cheek warmth — lighting, not a trait; it is what stops a sphere
         reading as plastic */
      const ch = ctx.createRadialGradient(-0.52 * R, 0.30 * R, 0, -0.52 * R, 0.30 * R, 0.42 * R);
      ch.addColorStop(0, rgba(mix(t.S.base, '#C9553F', 0.5), 0.10));
      ch.addColorStop(1, rgba(t.S.base, 0));
      ctx.fillStyle = ch;
      ctx.fillRect(-1.1 * R, -0.2 * R, 1.2 * R, 1.0 * R);
    }
    ctx.restore();
  }

  /* L6 — brows */
  function layerBrows(ctx, R, t, dx) {
    const y = G.brow * R + t.browRise * R;
    const arch = BROW_ARCH[t.brow] * R;
    const eX = (0.36 + t.eyeGap) * R;
    const ang = t.brow === 2 ? 0.032 * R : 0;      // 'angled' = relaxed, not stern
    const taper = t.brow === 4 ? 0.55 : 1;
    ctx.strokeStyle = t.H.brow;
    ctx.lineCap = 'round';
    for (let s = -1; s <= 1; s += 2) {
      const cx = s * eX + dx;
      const inner = cx - s * 0.26 * R, outer = cx + s * 0.30 * R;
      ctx.lineWidth = Math.max(1.1, BROW_T[t.brow] * R);
      ctx.beginPath();
      ctx.moveTo(inner, y);                       // inner end level
      ctx.quadraticCurveTo(cx, y + arch, outer, y + ang);   // outer end eases down
      ctx.stroke();
      if (taper < 1) {                            // thin-tapered thins outward
        ctx.lineWidth = Math.max(0.8, BROW_T[t.brow] * R * taper);
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.06 * R, y + arch * 0.7);
        ctx.quadraticCurveTo(cx + s * 0.20 * R, y + arch * 0.4 + ang * 0.5, outer, y + ang);
        ctx.stroke();
      }
    }
  }

  /* L7 — eyes */
  function layerEyes(ctx, R, t, lod, dx, yaw) {
    const eX = (0.36 + t.eyeGap) * R, y = G.eye * R;
    const e = EYE[t.eye];

    if (lod <= 1) {                                     // the house's two dots
      ctx.fillStyle = '#2A1F16';
      const rD = 0.112 * R;
      ctx.beginPath(); ctx.arc(-eX + dx, y, rD, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(eX + dx, y, rD, 0, TAU); ctx.fill();
      return;
    }

    for (let s = -1; s <= 1; s += 2) {
      const far = (yaw > 0 && s < 0) || (yaw < 0 && s > 0);
      const sq = far ? 0.88 : 1;                        // the far eye foreshortens
      const cx = s * eX + dx;
      const w = e[0] * R * sq, hu = e[1] * R, hl = e[2] * R, rise = e[3] * R * s;

      ctx.beginPath();                                  // the lid opening
      ctx.moveTo(cx - w, y - rise * 0.4);
      ctx.quadraticCurveTo(cx, y - hu, cx + w, y + rise * 0.6);
      ctx.quadraticCurveTo(cx, y + hl, cx - w, y - rise * 0.4);
      ctx.closePath();
      ctx.fillStyle = '#FBF7EF';
      ctx.fill();

      ctx.save();
      ctx.clip();
      const ir = 0.128 * R, ix = cx + (yaw * 0.022 * R), iy = y + 0.014 * R;
      ctx.fillStyle = IRIS[t.iris];
      ctx.beginPath(); ctx.arc(ix, iy, ir, 0, TAU); ctx.fill();
      ctx.strokeStyle = rgba(darken(IRIS[t.iris], 0.5), 0.85);
      ctx.lineWidth = Math.max(0.6, 0.020 * R);
      ctx.beginPath(); ctx.arc(ix, iy, ir, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#1A1208';
      ctx.beginPath(); ctx.arc(ix, iy, 0.056 * R, 0, TAU); ctx.fill();
      if (lod >= 3) {
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.beginPath(); ctx.arc(ix - 0.040 * R, iy - 0.042 * R, 0.030 * R, 0, TAU); ctx.fill();
      }
      /* upper lid line, drawn inside the clip so it hugs the opening */
      ctx.strokeStyle = rgba(t.S.deep, 0.85);
      ctx.lineWidth = Math.max(0.9, 0.036 * R);
      ctx.beginPath();
      ctx.moveTo(cx - w, y - rise * 0.4);
      ctx.quadraticCurveTo(cx, y - hu, cx + w, y + rise * 0.6);
      ctx.stroke();
      ctx.restore();

      if (t.eye === 4) {                                // hooded: a crease
        ctx.strokeStyle = rgba(t.S.line, 0.45);
        ctx.lineWidth = Math.max(0.6, 0.024 * R);
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.95, y - hu * 1.25);
        ctx.quadraticCurveTo(cx, y - hu * 1.95, cx + w * 0.95, y - hu * 1.1);
        ctx.stroke();
      }
    }
  }

  /* L8 — nose */
  function layerNose(ctx, R, t, dx) {
    const y = G.nose * R, x = dx * 0.8;
    ctx.strokeStyle = rgba(t.S.deep, 0.85);
    ctx.lineWidth = Math.max(1, 0.056 * R);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    switch (t.nose) {
      case 0:                                           // soft dot
        ctx.arc(x, y - 0.02 * R, 0.055 * R, 0.35, Math.PI - 0.35);
        break;
      case 1:                                           // short line
        ctx.moveTo(x - 0.02 * R, y - 0.14 * R); ctx.lineTo(x - 0.03 * R, y);
        ctx.quadraticCurveTo(x + 0.02 * R, y + 0.05 * R, x + 0.10 * R, y);
        break;
      case 2:                                           // wedge
        ctx.moveTo(x - 0.09 * R, y - 0.20 * R); ctx.lineTo(x - 0.11 * R, y + 0.01 * R);
        ctx.lineTo(x + 0.10 * R, y + 0.01 * R);
        break;
      case 3:                                           // broad
        ctx.moveTo(x - 0.14 * R, y - 0.12 * R); ctx.quadraticCurveTo(x, y + 0.10 * R, x + 0.14 * R, y - 0.12 * R);
        break;
      default:                                          // hooked
        ctx.moveTo(x - 0.01 * R, y - 0.26 * R);
        ctx.quadraticCurveTo(x + 0.13 * R, y - 0.06 * R, x - 0.02 * R, y + 0.02 * R);
    }
    ctx.stroke();
    if (t.nose === 3) {
      ctx.fillStyle = rgba(t.S.line, 0.55);
      ctx.beginPath(); ctx.arc(x - 0.16 * R, y - 0.06 * R, 0.032 * R, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 0.16 * R, y - 0.06 * R, 0.032 * R, 0, TAU); ctx.fill();
    }
  }

  /* L9 — mouth. Weights skew friendly: nobody's card sneers. */
  function layerMouth(ctx, R, t, lod, dx) {
    const y = G.mouth * R, x = dx * 0.6;
    const line = mix(t.S.deep, '#6E332C', 0.40);
    ctx.strokeStyle = line;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.1, 0.072 * R);
    ctx.beginPath();
    switch (t.mouth) {
      case 0:
        ctx.moveTo(x - 0.26 * R, y); ctx.lineTo(x + 0.26 * R, y);
        ctx.stroke();
        break;
      case 1:
        ctx.moveTo(x - 0.26 * R, y - 0.02 * R);
        ctx.quadraticCurveTo(x, y + 0.12 * R, x + 0.26 * R, y - 0.02 * R);
        ctx.stroke();
        break;
      case 2:
        ctx.moveTo(x - 0.32 * R, y - 0.04 * R);
        ctx.quadraticCurveTo(x, y + 0.19 * R, x + 0.32 * R, y - 0.04 * R);
        ctx.stroke();
        if (lod >= 2) {
          ctx.lineWidth = Math.max(0.7, 0.038 * R);
          ctx.beginPath();
          ctx.moveTo(x - 0.32 * R, y - 0.04 * R); ctx.lineTo(x - 0.35 * R, y - 0.09 * R);
          ctx.moveTo(x + 0.32 * R, y - 0.04 * R); ctx.lineTo(x + 0.35 * R, y - 0.09 * R);
          ctx.stroke();
        }
        break;
      case 3:
        if (lod >= 2) {
          ctx.beginPath();
          ctx.moveTo(x - 0.30 * R, y - 0.03 * R);
          ctx.quadraticCurveTo(x, y + 0.26 * R, x + 0.30 * R, y - 0.03 * R);
          ctx.quadraticCurveTo(x, y - 0.09 * R, x - 0.30 * R, y - 0.03 * R);
          ctx.closePath();
          ctx.fillStyle = '#6E3A34'; ctx.fill();
          ctx.save(); ctx.clip();
          ctx.fillStyle = '#FBF7EF';
          ctx.fillRect(x - 0.30 * R, y - 0.05 * R, 0.60 * R, 0.10 * R);
          ctx.restore();
          ctx.strokeStyle = line; ctx.lineWidth = Math.max(0.7, 0.030 * R);
          ctx.beginPath();
          ctx.moveTo(x - 0.30 * R, y - 0.03 * R);
          ctx.quadraticCurveTo(x, y + 0.26 * R, x + 0.30 * R, y - 0.03 * R);
          ctx.stroke();
        } else {
          ctx.moveTo(x - 0.30 * R, y - 0.02 * R);
          ctx.quadraticCurveTo(x, y + 0.20 * R, x + 0.30 * R, y - 0.02 * R);
          ctx.stroke();
        }
        break;
      case 4:
        ctx.lineWidth = Math.max(0.9, 0.042 * R);
        ctx.moveTo(x - 0.25 * R, y - 0.02 * R);
        ctx.quadraticCurveTo(x, y + 0.01 * R, x + 0.25 * R, y - 0.02 * R);
        ctx.stroke();
        break;
      default:                                          // grin
        ctx.moveTo(x - 0.33 * R, y - 0.05 * R);
        ctx.quadraticCurveTo(x, y + 0.21 * R, x + 0.33 * R, y - 0.05 * R);
        ctx.stroke();
        if (lod >= 2) {
          ctx.lineWidth = Math.max(0.7, 0.036 * R);
          ctx.beginPath();
          ctx.moveTo(x - 0.33 * R, y - 0.05 * R); ctx.lineTo(x - 0.37 * R, y - 0.11 * R);
          ctx.moveTo(x + 0.33 * R, y - 0.05 * R); ctx.lineTo(x + 0.37 * R, y - 0.11 * R);
          ctx.stroke();
        }
        if (lod >= 3) {
          ctx.strokeStyle = rgba(t.S.shade, 0.45);
          ctx.lineWidth = Math.max(0.6, 0.028 * R);
          ctx.beginPath();
          ctx.moveTo(x - 0.46 * R, y - 0.16 * R); ctx.quadraticCurveTo(x - 0.50 * R, y - 0.02 * R, x - 0.44 * R, y + 0.06 * R);
          ctx.moveTo(x + 0.46 * R, y - 0.16 * R); ctx.quadraticCurveTo(x + 0.50 * R, y - 0.02 * R, x + 0.44 * R, y + 0.06 * R);
          ctx.stroke();
        }
    }
  }

  /* a fixed Halton pair — stipple and freckles never move, so they bake */
  function halton(i, b) {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  }
  const STIPPLE = (() => {
    const a = new Float32Array(80);
    for (let i = 0; i < 40; i++) { a[i * 2] = halton(i + 3, 2) * 2 - 1; a[i * 2 + 1] = halton(i + 3, 3); }
    return a;
  })();
  const FRECK = (() => {
    const a = new Float32Array(18);
    for (let i = 0; i < 9; i++) { a[i * 2] = halton(i + 5, 2) * 2 - 1; a[i * 2 + 1] = halton(i + 5, 3); }
    return a;
  })();

  /* L10 — facial hair, clipped so it can never spill past the jaw */
  function layerFacial(ctx, R, t, lod, mono, dx) {
    const f = t.facial;
    if (!f) return;
    const col = mono ? MONO_DEEP : t.H.beardCol;
    const chinExt = f === 7 ? 0.10 * R : f === 8 ? 0.46 * R : 0;

    ctx.save();
    headPath(ctx, R, t);                                // clip = head (+ chin ext)
    if (chinExt) {
      ctx.moveTo(0.42 * R + 0, t.cl * R - 0.10 * R);
      ctx.ellipse(0, t.cl * R + chinExt * 0.42, 0.42 * R, chinExt * 0.86 + 0.16 * R, 0, 0, TAU);
    }
    ctx.clip('nonzero');

    ctx.fillStyle = col;
    if (f === 1 || f === 2) {                           // stubble
      ctx.globalAlpha = f === 1 ? 0.22 : 0.38;
      beardPath(ctx, R, t, 0.16 * R, 0);
      ctx.fill();
      moustachePath(ctx, R, t, dx); ctx.fill();
      if (lod >= 3) {
        ctx.globalAlpha = 0.35;
        for (let i = 0; i < 40; i++) {
          const px = STIPPLE[i * 2] * t.cw * 0.92 * R;
          const py = 0.30 * R + STIPPLE[i * 2 + 1] * (t.cl * R - 0.24 * R);
          ctx.beginPath(); ctx.arc(px, py, 0.014 * R, 0, TAU); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else if (f === 3) {                               // moustache
      moustachePath(ctx, R, t, dx); ctx.fill();
    } else if (f === 4) {                               // goatee
      moustachePath(ctx, R, t, dx); ctx.fill();
      ctx.beginPath();
      ctx.ellipse(dx * 0.5, 0.92 * R, 0.17 * R, 0.21 * R, 0, 0, TAU);
      ctx.fill();
    } else if (f === 5) {                               // chinstrap
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.11 * R;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-t.cw * R * 0.98, -0.02 * R);
      ctx.bezierCurveTo(-t.cw * R, 0.42 * R, -t.jw * R, 0.86 * R, 0, t.cl * R);
      ctx.bezierCurveTo(t.jw * R, 0.86 * R, t.cw * R, 0.42 * R, t.cw * R * 0.98, -0.02 * R);
      ctx.stroke();
    } else {                                            // beards
      const topY = f === 6 ? 0.06 * R : f === 7 ? -0.04 * R : -0.06 * R;
      beardPath(ctx, R, t, topY, chinExt);
      ctx.fill();
      moustachePath(ctx, R, t, dx); ctx.fill();
      if (lod >= 2) {                                   // a lit top edge
        ctx.strokeStyle = rgba(mix(col, '#FFFFFF', 0.22), 0.55);
        ctx.lineWidth = Math.max(0.7, 0.030 * R);
        ctx.beginPath();
        ctx.moveTo(-t.cw * R, topY);
        ctx.bezierCurveTo(-0.66 * R, 0.58 * R, -0.36 * R, 0.78 * R, 0, 0.78 * R);
        ctx.bezierCurveTo(0.36 * R, 0.78 * R, 0.66 * R, 0.58 * R, t.cw * R, topY);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function moustachePath(ctx, R, t, dx) {
    const y = 0.50 * R, x = dx * 0.6;
    ctx.beginPath();
    ctx.moveTo(x - 0.24 * R, y);
    ctx.quadraticCurveTo(x, y - 0.09 * R, x + 0.24 * R, y);
    ctx.quadraticCurveTo(x + 0.13 * R, y + 0.13 * R, x, y + 0.09 * R);
    ctx.quadraticCurveTo(x - 0.13 * R, y + 0.13 * R, x - 0.24 * R, y);
    ctx.closePath();
  }

  /* L11 — hair FRONT: a cap path plus up to six extras, one recipe per
     style. Every one of the 22 gets the same care (§11.4 rule 7). */
  function layerHairFront(ctx, R, t, lod, mono) {
    const st = t.hair, rec = HAIR[st], H = t.H;
    const hairY = rec[0] * R, lift = rec[1] * R, spread = rec[2], hl = rec[3], alpha = rec[5];
    const base = mono ? MONO_DARK : H.base;
    const shadow = mono ? MONO_DEEP : H.shadow;
    const sheen = mono ? MONO_MID : H.sheen;

    if (st === 0) {                                     // BALD — a sheen, not a cap
      if (mono) return;
      ctx.save(); headPath(ctx, R, t); ctx.clip();
      const g = ctx.createRadialGradient(-0.30 * R, -0.70 * R, 0, -0.30 * R, -0.70 * R, 0.62 * R);
      g.addColorStop(0, 'rgba(255,255,255,.12)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-1.2 * R, -1.3 * R, 2.4 * R, 1.6 * R);
      ctx.restore();
      return;
    }

    const rx = t.cw * R * spread, ry = 1.06 * R + lift;

    /* --- the cap ------------------------------------------------------- */
    if (st === 8) {                                     // TOP_FADE — faded sides
      const w = t.cw * R * 0.98, top = -1.42 * R;      // under a squared block
      capPath(ctx, R, t, t.cw * R * 1.02, 1.07 * R, hairY, 0);
      ctx.fillStyle = mono ? MONO_DARK : mix(H.base, t.S.base, 0.14);
      ctx.fill();                                       // the fade: scalp through hair
      ctx.strokeStyle = rgba(shadow, 0.30);
      ctx.lineWidth = Math.max(0.7, 0.022 * R);
      ctx.stroke();
      ctx.beginPath();                                  // the block, sitting ON it
      ctx.moveTo(-w * 0.70, -0.62 * R);
      ctx.bezierCurveTo(-w * 0.76, -1.06 * R, -w * 0.74, top + 0.12 * R, -w * 0.52, top);
      ctx.lineTo(w * 0.52, top);
      ctx.bezierCurveTo(w * 0.74, top + 0.12 * R, w * 0.76, -1.06 * R, w * 0.70, -0.62 * R);
      ctx.quadraticCurveTo(0, -1.00 * R, -w * 0.70, -0.62 * R);
      ctx.closePath();
    } else {
      /* Volume styles get a big rx/ry, but the cap is ALWAYS bounded by the
         hairline — a hair mass painted over the whole head is a blob with no
         face, which is exactly what 18% of the roster used to be. The side
         and back volume comes from the L0 mass behind the head. */
      capPath(ctx, R, t, rx, ry, hairY, hl);
    }

    ctx.globalAlpha = alpha;
    ctx.fillStyle = base;
    ctx.fill();
    ctx.globalAlpha = 1;

    /* --- silhouette-defining extras (drawn at every LOD) ---------------- */
    ctx.fillStyle = base;
    /* the cap's own arc, so no lump, twist or dread can stray below the
       hairline and end up sitting beside an eye */
    const _t0 = Math.asin(Math.max(-1, Math.min(1, hairY / ry)));
    const aFrom = Math.PI - _t0, aTo = TAU + _t0;
    const lumpA = (i, n2) => aFrom + (i + 0.5) / n2 * (aTo - aFrom);
    if (st === 9 || st === 10) {                        // afro rim lumps
      const n2 = st === 10 ? 9 : 7;
      for (let i = 0; i < n2; i++) {
        const a = lumpA(i, n2);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rx * 0.93, Math.sin(a) * ry * 0.93, 0.19 * R, 0, TAU);
        ctx.fill();
      }
    } else if (st === 11) {                             // curls
      for (let i = 0; i < 9; i++) {
        const a = lumpA(i, 9);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rx * 0.92, Math.sin(a) * ry * 0.92, 0.20 * R, 0, TAU);
        ctx.fill();
      }
    } else if (st === 13) {                             // twists
      ctx.strokeStyle = base; ctx.lineCap = 'round'; ctx.lineWidth = 0.11 * R;
      for (let i = 0; i < 11; i++) {
        const a = lumpA(i, 11), c = Math.cos(a), s = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(c * rx * 0.72, s * ry * 0.72);
        ctx.lineTo(c * rx * 1.06, s * ry * 1.06);
        ctx.stroke();
      }
    } else if (st === 15 || st === 16) {                // dreads
      /* they hang from the SIDES of the cap. Hung from the crown they fall
         across the eyes, which hides the face the system exists to show. */
      const per = st === 16 ? 5 : 4, len = st === 16 ? 1.24 : 0.54;
      ctx.strokeStyle = base; ctx.lineCap = 'round'; ctx.lineWidth = 0.10 * R;
      for (let sg = -1; sg <= 1; sg += 2) {
        for (let i = 0; i < per; i++) {
          const a = (sg < 0 ? aFrom - 0.12 : aTo + 0.12) + sg * (i + 0.4) / per * 0.72;
          const x0 = Math.cos(a) * rx * 1.00, y0 = Math.sin(a) * ry * 1.00;
          const drop = len * (1 - i * 0.13) * R;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo(x0 * 1.20, y0 + drop * 0.5, x0 * 1.06, y0 + drop);
          ctx.stroke();
        }
      }
      ctx.fillStyle = base;                             // a few coils on the crown
      for (let i = 0; i < 5; i++) {
        const a = aFrom + 0.85 + (i + 0.5) / 5 * (aTo - aFrom - 1.70);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rx * 0.96, Math.sin(a) * ry * 0.96, 0.09 * R, 0, TAU);
        ctx.fill();
      }
    } else if (st === 7) {                              // QUIFF — a real crest
      ctx.beginPath();
      ctx.moveTo(-0.72 * R, -0.74 * R);
      ctx.bezierCurveTo(-0.86 * R, -1.42 * R, -0.06 * R, -1.50 * R, 0.48 * R, -1.30 * R);
      ctx.bezierCurveTo(0.22 * R, -1.16 * R, 0.30 * R, -1.02 * R, 0.62 * R, -0.92 * R);
      ctx.bezierCurveTo(0.20 * R, -0.78 * R, -0.28 * R, -0.72 * R, -0.72 * R, -0.74 * R);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = rgba(sheen, 0.45); ctx.lineWidth = 0.06 * R;
      ctx.beginPath();
      ctx.moveTo(-0.52 * R, -0.86 * R);
      ctx.bezierCurveTo(-0.52 * R, -1.22 * R, -0.02 * R, -1.32 * R, 0.30 * R, -1.24 * R);
      ctx.stroke();
    } else if (st === 17) {                             // ponytail tie
      ctx.fillStyle = shadow;
      ctx.fillRect(-0.16 * R, -1.26 * R, 0.32 * R, 0.09 * R);
      ctx.fillStyle = base;
    } else if (st === 6) {                              // CURTAINS — two lobes
      for (let sg = -1; sg <= 1; sg += 2) {             // parted down the middle
        ctx.beginPath();
        ctx.moveTo(sg * 0.05 * R, -1.04 * R);
        ctx.bezierCurveTo(sg * 0.66 * R, -1.00 * R, sg * 0.98 * R, -0.62 * R, sg * 0.92 * R, 0.06 * R);
        ctx.bezierCurveTo(sg * 0.70 * R, -0.26 * R, sg * 0.34 * R, -0.42 * R, sg * 0.06 * R, -0.46 * R);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = t.S.base;                         // the part: real forehead
      ctx.beginPath();
      ctx.moveTo(0, -1.08 * R);
      ctx.bezierCurveTo(0.05 * R, -0.80 * R, 0.09 * R, -0.56 * R, 0.075 * R, -0.38 * R);
      ctx.quadraticCurveTo(0, -0.30 * R, -0.075 * R, -0.38 * R);
      ctx.bezierCurveTo(-0.09 * R, -0.56 * R, -0.05 * R, -0.80 * R, 0, -1.08 * R);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = base;
    } else if (st === 5) {                              // FRINGE — a deeper edge
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(-t.cw * R * 1.04, -0.70 * R);
      ctx.quadraticCurveTo(-0.40 * R, -0.26 * R, 0.06 * R, -0.32 * R);
      ctx.quadraticCurveTo(0.52 * R, -0.40 * R, t.cw * R * 1.04, -0.72 * R);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if (st === 4) {                              // SIDE_PART
      ctx.beginPath();                                  // the swept-over volume
      ctx.moveTo(-0.42 * R, -1.12 * R);
      ctx.bezierCurveTo(0.30 * R, -1.24 * R, 0.94 * R, -0.94 * R, 0.98 * R, -0.42 * R);
      ctx.bezierCurveTo(0.72 * R, -0.70 * R, 0.10 * R, -0.82 * R, -0.40 * R, -0.90 * R);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = t.S.base;                       // the part: skin, not a line
      ctx.lineWidth = 0.055 * R; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-0.40 * R, -0.42 * R);
      ctx.quadraticCurveTo(-0.46 * R, -0.88 * R, -0.30 * R, -1.14 * R);
      ctx.stroke();
      ctx.strokeStyle = rgba(shadow, 0.55); ctx.lineWidth = 0.028 * R;
      ctx.beginPath();
      ctx.moveTo(-0.33 * R, -0.44 * R);
      ctx.quadraticCurveTo(-0.39 * R, -0.88 * R, -0.24 * R, -1.13 * R);
      ctx.stroke();
    } else if (st === 19) {                             // MULLET keeps a short top
      ctx.beginPath();
      ctx.moveTo(-t.cw * R * 1.03, -0.44 * R);
      ctx.quadraticCurveTo(0, -0.74 * R, t.cw * R * 1.03, -0.44 * R);
      ctx.quadraticCurveTo(0, -0.58 * R, -t.cw * R * 1.03, -0.44 * R);
      ctx.closePath(); ctx.fill();
    }

    if (mono) return;

    /* --- surface detail: L1 and up ------------------------------------- */
    if (lod >= 1) {
      ctx.save();
      if (st === 8) {
        const w = t.cw * R * 1.02;
        ctx.beginPath(); ctx.rect(-w, -1.34 * R, w * 2, hairY + 1.34 * R); ctx.clip();
      } else {
        capPath(ctx, R, t, rx, ry, hairY, hl); ctx.clip();
      }

      if (H.bleach) {                                   // roots, faded out upward
        const rg2 = ctx.createLinearGradient(0, hairY - 0.30 * R, 0, hairY + 0.10 * R);
        rg2.addColorStop(0, rgba(H.root, 0));
        rg2.addColorStop(1, rgba(H.root, 0.60));
        ctx.fillStyle = rg2;
        ctx.fillRect(-rx * 1.1, hairY - 0.34 * R, rx * 2.2, 0.46 * R);
      }

      ctx.strokeStyle = sheen;
      ctx.lineCap = 'round';
      const _tt = Math.asin(Math.max(-1, Math.min(1, hairY / ry)));
      const _a0 = Math.PI - _tt, _a1 = TAU + _tt;
      if (st === 12) {                                  // WAVES
        for (let i = 0; i < 4; i++) {
          const y = -1.00 * R + i * 0.19 * R, dip = 0.10 * R + i * 0.03 * R;
          ctx.strokeStyle = shadow; ctx.lineWidth = 0.048 * R; ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.moveTo(-0.94 * R, y + dip);
          ctx.bezierCurveTo(-0.34 * R, y - 0.09 * R, 0.34 * R, y - 0.09 * R, 0.94 * R, y + dip);
          ctx.stroke();
          ctx.strokeStyle = sheen; ctx.lineWidth = 0.026 * R; ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.moveTo(-0.94 * R, y + dip - 0.05 * R);
          ctx.bezierCurveTo(-0.34 * R, y - 0.14 * R, 0.34 * R, y - 0.14 * R, 0.94 * R, y + dip - 0.05 * R);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (st === 14) {                           // CORNROWS
        for (let i = 0; i < 7; i++) {
          const x = -0.80 * R + i * 0.267 * R;
          ctx.strokeStyle = rgba(mix(shadow, t.S.shade, 0.35), 0.75);
          ctx.lineWidth = 0.024 * R;                    // scalp between the braids
          ctx.beginPath();
          ctx.moveTo(x * 1.02, hairY + 0.02 * R);
          ctx.bezierCurveTo(x * 1.12, -0.52 * R, x * 1.02, -0.92 * R, x * 0.72, -1.24 * R);
          ctx.stroke();
        }
      } else if (st === 13) {                           // TWISTS texture
        ctx.strokeStyle = shadow;
        ctx.lineWidth = 0.042 * R;
        ctx.globalAlpha = 0.5;
        for (let i = 0; i < 10; i++) {
          const a = _a0 + (i + 0.5) / 10 * (_a1 - _a0);
          const c = Math.cos(a), sn = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(c * rx * 0.70, sn * ry * 0.70);
          ctx.lineTo(c * rx * 1.00, sn * ry * 1.00);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (st === 4) {                            // the parting gap
        ctx.strokeStyle = shadow;
        ctx.lineWidth = 0.055 * R;
        ctx.beginPath();
        ctx.moveTo(-0.34 * R, hairY + 0.02 * R);
        ctx.quadraticCurveTo(-0.30 * R, -0.80 * R, -0.12 * R, -1.14 * R);
        ctx.stroke();
      }

      /* the universal sheen band — hair without one is a helmet */
      if (st !== 1) {
        ctx.strokeStyle = sheen;
        ctx.globalAlpha = st === 2 ? 0.30 : 0.45;
        ctx.lineWidth = 0.10 * R;
        ctx.beginPath();
        ctx.moveTo(-0.80 * R, -0.72 * R);
        ctx.quadraticCurveTo(-0.30 * R, -1.16 * R - lift * 0.6, 0.42 * R, -0.94 * R - lift * 0.4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (lod >= 3 && (st === 9 || st === 10 || st === 11)) {   // curl speculars
        ctx.fillStyle = rgba(sheen, 0.5);
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * 1.08 + i / 6 * Math.PI * 0.66;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * rx * 0.74, Math.sin(a) * ry * 0.74, 0.055 * R, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    /* --- the hairline edge: a line, not a colour change ---------------- */
    ctx.strokeStyle = rgba(shadow, 0.35);
    ctx.lineWidth = Math.max(0.7, 0.022 * R);
    if (st === 8) {
      capPath(ctx, R, t, t.cw * R * 1.02, 1.07 * R, hairY, 0);
      ctx.stroke();
    } else {
      capPath(ctx, R, t, rx, ry, hairY, hl);
      ctx.stroke();
    }
  }

  /* L12 — accessories */
  function layerAccessories(ctx, R, t, kit, lod, mono) {
    if (mono || lod < 2) return;
    if (t.band) {
      ctx.save(); headPath(ctx, R, t); ctx.clip();
      const c = t.band === 3 ? kit.c2 : BAND_COL[t.band - 1];
      ctx.fillStyle = c;
      rr(ctx, -t.cw * R * 1.05, -0.56 * R, t.cw * R * 2.1, 0.21 * R, 0.06 * R);
      ctx.fill();
      ctx.strokeStyle = rgba(darken(c, 0.35), 0.8);
      ctx.lineWidth = Math.max(0.6, 0.016 * R);
      ctx.stroke();
      ctx.restore();
    }
    if (t.tape) {
      ctx.save(); headPath(ctx, R, t); ctx.clip();
      ctx.strokeStyle = 'rgba(244,241,232,.92)';
      ctx.lineWidth = 0.13 * R; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-0.86 * R, -0.94 * R); ctx.lineTo(0.02 * R, -0.46 * R);
      ctx.moveTo(-0.86 * R, -0.46 * R); ctx.lineTo(0.02 * R, -0.94 * R);
      ctx.stroke();
      ctx.restore();
    }
    if (t.ering && !t.hidesEars) {
      const ex = t.cw * R * 0.92;
      ctx.fillStyle = '#E9BF63';
      ctx.beginPath(); ctx.arc(-ex, 0.30 * R, 0.048 * R, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ex, 0.30 * R, 0.048 * R, 0, TAU); ctx.fill();
    }
    if (t.tattoo) {                                     // abstract, never a symbol
      ctx.save();
      rr(ctx, -0.28 * R, 0.86 * R, 0.56 * R, 0.94 * R, 0.17 * R); ctx.clip();
      ctx.strokeStyle = rgba(t.S.line, 0.30);
      ctx.lineWidth = 0.038 * R; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-0.20 * R, 1.02 * R); ctx.quadraticCurveTo(-0.02 * R, 1.16 * R, -0.16 * R, 1.30 * R);
      ctx.moveTo(0.06 * R, 1.06 * R); ctx.lineTo(0.20 * R, 1.24 * R);
      ctx.moveTo(-0.06 * R, 1.36 * R); ctx.lineTo(0.14 * R, 1.40 * R);
      ctx.stroke();
      ctx.restore();
    }
    if (t.freck && lod >= 3) {
      ctx.save(); headPath(ctx, R, t); ctx.clip();
      ctx.fillStyle = rgba(t.S.shade, 0.34);
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        ctx.arc(FRECK[i * 2] * 0.62 * R, 0.16 * R + FRECK[i * 2 + 1] * 0.26 * R, 0.024 * R, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* L13 — keeper gloves: role, never a trait */
  function layerGloves(ctx, R, kit, lod, mono) {
    const col = mono ? MONO_MID : hueShift(kit.c2, 40);
    ctx.fillStyle = col;
    for (let s = -1; s <= 1; s += 2) {
      rr(ctx, s * 1.15 * R - 0.31 * R, 1.86 * R, 0.62 * R, 0.46 * R, 0.16 * R);
      ctx.fill();
      if (mono || lod < 1) continue;
      ctx.fillStyle = rgba(darken(col, 0.30), 0.9);
      ctx.fillRect(s * 1.15 * R - 0.31 * R, 1.86 * R, 0.62 * R, 0.08 * R);
      ctx.strokeStyle = rgba(darken(col, 0.45), 0.8);
      ctx.lineWidth = Math.max(0.6, 0.02 * R);
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const x = s * 1.15 * R - 0.31 * R + i * 0.155 * R;
        ctx.moveTo(x, 1.98 * R); ctx.lineTo(x, 2.30 * R);
      }
      ctx.stroke();
      ctx.fillStyle = col;
    }
  }

  /* L14 — the light pass, clipped to the subject. Baked with the CARD light
     (a portrait is furniture, lit by the shell) — except the black tier's
     gold key, which re-lights the face and never recolours the skin. */
  function subjectClip(ctx, R, t, shape) {
    const span = shape === 'b' ? 1.90 : 2.92;
    ctx.beginPath();
    /* head */
    const kw = t.kw * R, tw = t.tw * R, cw = t.cw * R, jw = t.jw * R, cl = t.cl * R;
    ctx.moveTo(0, -1.06 * R);
    ctx.bezierCurveTo(kw, -1.02 * R, tw, -0.55 * R, cw, -0.05 * R);
    ctx.bezierCurveTo(cw, 0.42 * R, jw, 0.86 * R, 0, cl);
    ctx.bezierCurveTo(-jw, 0.86 * R, -cw, 0.42 * R, -cw, -0.05 * R);
    ctx.bezierCurveTo(-tw, -0.55 * R, -kw, -1.02 * R, 0, -1.06 * R);
    ctx.closePath();
    /* hair envelope */
    const rec = HAIR[t.hair];
    ctx.moveTo(0, 0);
    ctx.ellipse(0, -0.10 * R, t.cw * R * rec[2], 1.06 * R + rec[1] * R, 0, 0, TAU);
    /* shoulders */
    ctx.moveTo(-span * R, G.floor * R);
    ctx.lineTo(-1.06 * R, 1.62 * R);
    ctx.quadraticCurveTo(-0.54 * R, 1.48 * R, 0, 1.46 * R);
    ctx.quadraticCurveTo(0.54 * R, 1.48 * R, 1.06 * R, 1.62 * R);
    ctx.lineTo(span * R, G.floor * R);
    ctx.closePath();
    ctx.clip('nonzero');
  }

  function layerLight(ctx, R, t, shape, lod, black, night) {
    const key = black ? '#F6DFA6' : night ? '#EAF2FF' : '#FFF3D6';
    const rim = black ? '#E9BF63' : night ? '#CFE7FF' : '#FFE9C0';
    /* Separation, not correction: every window ground in the game is a dark
       clubDeep, so a deep skin tone needs more RIM to lift off it. This adds
       light behind the subject — the skin fill itself is never touched, which
       is the hard rule (§8.5 rule 3). */
    const lift = (1 - Math.min(0.5, lum(t.S.base) * 2.2)) * 0.30;
    const rec = HAIR[t.hair];
    const rr2 = 1.07 * R + rec[1] * R;
    ctx.save();
    subjectClip(ctx, R, t, shape);
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(key, black ? 0.24 : 0.17);
    ctx.lineWidth = 0.10 * R;
    ctx.beginPath();
    ctx.arc(0, -0.10 * R, rr2, 200 * D2R, 340 * D2R);
    ctx.stroke();
    ctx.strokeStyle = rgba(rim, (black ? 0.52 : night ? 0.44 : 0.34) + lift);
    ctx.lineWidth = 0.085 * R;
    ctx.beginPath();
    ctx.arc(0, -0.10 * R, rr2, 296 * D2R, 392 * D2R);
    ctx.stroke();
    if (lod >= 1) {                                     // the shoulder rim
      ctx.lineWidth = 0.055 * R;
      ctx.beginPath();
      ctx.moveTo(0.30 * R, 1.48 * R);
      ctx.quadraticCurveTo(0.80 * R, 1.52 * R, 1.14 * R, 1.68 * R);
      ctx.lineTo(1.52 * R, 1.84 * R);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* L15 — grain, so the face is not a sticker on a sticker */
  let _grain = null;
  function grainPattern(ctx) {
    if (_grain === undefined) return null;
    if (_grain) return _grain;
    const c = makeCanvas(64, 64);
    if (!c) { _grain = undefined; return null; }
    const g = c.getContext('2d');
    const img = g.createImageData(64, 64);
    for (let i = 0; i < 64 * 64; i++) {
      const v = 110 + (lane(i, 77) & 63);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    try { _grain = ctx.createPattern(c, 'repeat'); } catch (e) { _grain = undefined; return null; }
    return _grain;
  }
  function layerGrain(ctx, R, t, shape) {
    const p = grainPattern(ctx);
    if (!p) return;
    ctx.save();
    subjectClip(ctx, R, t, shape);
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = p;
    ctx.fillRect(-G.halfW * R, G.ceiling * R, G.tileW * R, G.tileH * R);
    ctx.restore();
  }

  const MONO_MID = '#3E4854', MONO_DARK = '#28303A', MONO_DEEP = '#1E252D';

  /* ==================================================================== *
   * 9.  paintPortrait — THE ONLY ENTRY POINT INTO THE DRAWING            *
   *                                                                      *
   *  It is handed a 32-bit seed and a garment. It is NOT given: name,     *
   *  team, nation, region, rating, position (beyond the gk flag), age,    *
   *  price, or any save state. It cannot express a stereotype because it  *
   *  is never told what would be needed to build one. (§11.2)             *
   * ==================================================================== */

  function paintPortrait(ctx, seed, opts) {
    const t = traitsOf(seed);
    const R = opts.R, lod = opts.lod == null ? 3 : opts.lod;
    const shape = opts.shape === 'b' ? 'b' : 'c';
    const kit = opts.kit || DEFAULT_KIT;
    const mono = !!opts.mono, black = !!opts.black;
    const yaw = t.yaw === 0 ? 0 : t.yaw === 1 ? -1 : 1;
    const dx = yaw * 0.10 * R;

    ctx.save();
    ctx.translate(opts.cx, opts.cy);
    ctx.lineJoin = 'round';

    layerHairBack(ctx, R, t, mono);
    layerGarment(ctx, R, t, kit, shape, lod, mono, opts.faceGround);
    if (opts.gk) layerGloves(ctx, R, kit, lod, mono);
    layerNeck(ctx, R, t, mono);

    ctx.save();
    ctx.rotate(t.tilt);                                 // the head tilts, the body does not
    if (lod >= 2) layerEars(ctx, R, t, mono);
    layerHead(ctx, R, t, lod, mono);
    if (!mono && lod >= 1) {
      layerBrows(ctx, R, t, dx);
      layerEyes(ctx, R, t, lod, dx, yaw);
      if (lod >= 2) layerNose(ctx, R, t, dx * 0.8);
      layerMouth(ctx, R, t, lod, dx * 0.6);
    }
    layerFacial(ctx, R, t, lod, mono, dx * 0.6);
    layerHairFront(ctx, R, t, lod, mono);
    layerAccessories(ctx, R, t, kit, lod, mono);
    if (!mono && lod >= 1) layerLight(ctx, R, t, shape, lod, black, opts.night);
    if (!mono && lod >= 3) layerGrain(ctx, R, t, shape);
    ctx.restore();

    ctx.restore();
  }

  /* ==================================================================== *
   * 10.  FRAMING, LOD, TILE BOXES  (§4.1, §9, §10.2)                     *
   * ==================================================================== */

  /* CELL — the card's kit-band window, 1.75:1, R = 0.31 x windowH
     BUST — square, R = 0.30 x side (detail plate, list rows, news art) */
  function boxFor(pose, size, w, h) {
    if (pose === 'b') {
      const s = size;
      return { R: 0.29 * s, cx: 0.50 * s, cy: 0.40 * s, w: w || s, h: h || s, shape: 'b' };
    }
    const H2 = h || size, W2 = w || size * 1.75;
    return { R: 0.33 * H2, cx: 0.50 * W2, cy: 0.40 * H2, w: W2, h: H2, shape: 'c' };
  }

  const R_CLASS = [8, 11, 15, 20, 27, 36, 48];
  function rClass(R) {
    for (let i = 0; i < R_CLASS.length; i++) if (R <= R_CLASS[i] + 0.001) return R_CLASS[i];
    return Math.ceil(R);
  }

  /* LOD is chosen from R_css — the head radius the eye is actually offered */
  function lodFor(Rcss, quality) {
    let l = Rcss < 5 ? 0 : Rcss < 8 ? 1 : Rcss < 14 ? 2 : 3;
    if (quality === 'low' && l > 1) l = 1;
    else if (quality === 'med' && l > 2) l = 2;
    return l;
  }

  function metaFor(t, R, cx, cy) {
    const eX = (0.36 + t.eyeGap) * R;
    return {
      R: R, cx: cx, cy: cy,
      eyeL: { x: cx - eX, y: cy + G.eye * R, r: 0.10 * R },
      eyeR: { x: cx + eX, y: cy + G.eye * R, r: 0.10 * R },
      mouth: { x: cx, y: cy + G.mouth * R, w: 0.60 * R },
      shoulderL: { x: cx - 1.06 * R, y: cy + 1.62 * R },
      shoulderR: { x: cx + 1.06 * R, y: cy + 1.62 * R },
      headBox: { x: cx - t.cw * R, y: cy - 1.06 * R, w: t.cw * 2 * R, h: (t.cl + 1.06) * R }
    };
  }

  /* ==================================================================== *
   * 11.  THE PUBLIC DRAW                                                 *
   * ==================================================================== */

  /* draw(ctx, x, y, size, seedOrTraits, opts)
       size  — the window HEIGHT for pose 'card', the side for pose 'detail'
       opts  — { pose:'card'|'detail', w, h, lod, quality, scale, kit, gk,
                 mono, black, night, clip, faceGround } */
  function draw(ctx, x, y, size, seedOrTraits, opts) {
    opts = opts || EMPTY;
    const t = traitsOf(seedOrTraits);
    const pose = opts.pose === 'detail' || opts.pose === 'b' ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const lod = opts.lod != null ? opts.lod
      : lodFor(box.R * (opts.scale || 1), opts.quality);

    ctx.save();
    if (opts.clip !== false) {
      rr(ctx, x, y, box.w, box.h, opts.radius != null ? opts.radius : Math.min(box.w, box.h) * 0.07);
      ctx.clip();
    }
    PAINT.R = box.R; PAINT.cx = x + box.cx; PAINT.cy = y + box.cy;
    PAINT.lod = lod; PAINT.shape = box.shape; PAINT.kit = opts.kit || DEFAULT_KIT;
    PAINT.gk = !!opts.gk; PAINT.mono = !!opts.mono; PAINT.black = !!opts.black;
    PAINT.night = !!opts.night; PAINT.faceGround = opts.faceGround || null;
    paintPortrait(ctx, t, PAINT);
    ctx.restore();
    return metaFor(t, box.R, x + box.cx, y + box.cy);
  }
  const EMPTY = {};
  const PAINT = {                     // one reused options record: allocation-light
    R: 0, cx: 0, cy: 0, lod: 3, shape: 'c', kit: null, gk: false,
    mono: false, black: false, night: false, faceGround: null
  };

  /* the flat kit-coloured silhouette a queued tile shows until it lands —
     three fills, ~0.02 ms */
  function placeholder(ctx, x, y, size, opts) {
    opts = opts || EMPTY;
    const pose = opts.pose === 'detail' || opts.pose === 'b' ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const R = box.R, cx = x + box.cx, cy = y + box.cy;
    const kit = opts.kit || DEFAULT_KIT;
    ctx.save();
    ctx.fillStyle = rgba(darken(kit.c1, 0.25), 0.85);
    shouldersPathAt(ctx, cx, cy, R, box.shape === 'b' ? 1.90 : 2.92);
    ctx.fill();
    ctx.fillStyle = rgba(darken(kit.c1, 0.42), 0.9);
    ctx.beginPath(); ctx.ellipse(cx, cy, 1.0 * R, 1.14 * R, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function shouldersPathAt(ctx, cx, cy, R, span) {
    ctx.save(); ctx.translate(cx, cy); shouldersPath(ctx, R, span); ctx.restore();
  }

  /* ==================================================================== *
   * 12.  THE TILE CACHE  (§10)                                           *
   *      Two-level by design: this is the portrait tile — a transparent-  *
   *      backed SUBJECT, so a holo tier can animate behind it and the     *
   *      face masks it for free, by draw order alone.                     *
   * ==================================================================== */

  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document && document.createElement) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
    return null;
  }
  const dprOf = () => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);

  const CACHE = new Map();
  const CACHE_MAX = 400;              // entries (the task's cap)
  const CACHE_BYTES = 3.0 * 1024 * 1024;
  let cacheBytes = 0;

  function evict() {
    /* strict LRU by BYTES (entries differ by 36x in size, so an entry-count LRU
       is the wrong instrument) with the entry cap as a second ceiling. `guard`
       bounds the work to a single rotation when every tile is pinned. */
    let guard = CACHE.size + 1;
    while ((CACHE.size > CACHE_MAX || cacheBytes > CACHE_BYTES) && CACHE.size && guard-- > 0) {
      const it = CACHE.entries().next();
      if (it.done) break;
      const k = it.value[0], v = it.value[1];
      if (v.pinned && CACHE.size > 1) {                 // pinned tiles rotate, never die
        CACHE.delete(k); CACHE.set(k, v);
        continue;
      }
      cacheBytes -= v.bytes;
      CACHE.delete(k);
      guard = CACHE.size + 1;
    }
  }

  /* cached(size, seedOrTraits, opts) -> offscreen canvas, LRU */
  function cached(size, seedOrTraits, opts) {
    opts = opts || EMPTY;
    const t = traitsOf(seedOrTraits);
    const pose = opts.pose === 'detail' || opts.pose === 'b' ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const rc = rClass(box.R);
    const lod = opts.lod != null ? opts.lod : lodFor(box.R * (opts.scale || 1), opts.quality);
    const dpr = rc >= 20 ? Math.min(2, opts.dpr || dprOf()) : 1;   // §10.2 the DPR rule
    const kit = opts.kit || DEFAULT_KIT;
    const key = 'pt|' + PORTRAIT_VERSION + '|' + t.seed + '|' + kitKey(kit) + '|' + pose
      + '|r' + rc + '|' + lod + '|' + dpr + (opts.gk ? '|g' : '') + (opts.mono ? '|m' : '')
      + (opts.black ? '|k' : '') + (opts.night ? '|n' : '');

    let hit = CACHE.get(key);
    if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit.cv; }

    const tw = Math.ceil(G.tileW * rc), th = Math.ceil(G.tileH * rc);
    const cv = makeCanvas(tw * dpr, th * dpr);
    if (!cv) return null;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    PAINT.R = rc; PAINT.cx = G.halfW * rc; PAINT.cy = -G.ceiling * rc;
    PAINT.lod = lod; PAINT.shape = pose; PAINT.kit = kit;
    PAINT.gk = !!opts.gk; PAINT.mono = !!opts.mono; PAINT.black = !!opts.black;
    PAINT.night = !!opts.night; PAINT.faceGround = opts.faceGround || null;
    paintPortrait(c, t, PAINT);

    cv.meta = metaFor(t, rc, G.halfW * rc, -G.ceiling * rc);
    cv.tileR = rc; cv.tilePose = pose; cv.tileDpr = dpr; cv.tileLod = lod;
    const bytes = tw * dpr * th * dpr * 4;
    CACHE.set(key, { cv: cv, bytes: bytes, pinned: !!opts.pin });
    cacheBytes += bytes;
    evict();
    return cv;
  }

  /* blit — the whole point of the cache: one drawImage per portrait */
  function blit(ctx, x, y, size, seedOrTraits, opts) {
    opts = opts || EMPTY;
    const cv = cached(size, seedOrTraits, opts);
    if (!cv) return draw(ctx, x, y, size, seedOrTraits, opts);
    const pose = opts.pose === 'detail' || opts.pose === 'b' ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const k = box.R / cv.tileR;
    const w = cv.width / cv.tileDpr * k, h = cv.height / cv.tileDpr * k;
    ctx.save();
    if (opts.clip !== false) {
      rr(ctx, x, y, box.w, box.h, opts.radius != null ? opts.radius : Math.min(box.w, box.h) * 0.07);
      ctx.clip();
    }
    if (opts.alpha != null) ctx.globalAlpha *= opts.alpha;
    ctx.drawImage(cv, x + box.cx - G.halfW * box.R, y + box.cy + G.ceiling * box.R, w, h);
    ctx.restore();
    return metaFor(traitsOf(seedOrTraits), box.R, x + box.cx, y + box.cy);
  }

  function clearCache() { CACHE.clear(); cacheBytes = 0; }
  const cacheStats = () => ({ entries: CACHE.size, bytes: cacheBytes, traits: _traits.size });

  /* ==================================================================== *
   * 13.  THE API                                                         *
   * ==================================================================== */

  const API = {
    VERSION: PORTRAIT_VERSION,
    HONESTY: 'Avatar — invented, not a likeness.',
    /* determinism */
    seedOf: seedOf, fnv1a: fnv1a, lane: lane, unit: unit, chance: chance, pick: pick,
    traitsFor: traitsFor, vectorOf: vectorOf,
    /* drawing */
    draw: draw, blit: blit, cached: cached, placeholder: placeholder,
    paint: paintPortrait,
    /* framing helpers for call sites */
    kitFor: kitFor, boxFor: boxFor, lodFor: lodFor, rClass: rClass, metaFor: metaFor,
    /* cache */
    clearCache: clearCache, cacheStats: cacheStats,
    /* test hooks — the audit script imports these rather than reimplementing */
    SALT: SALT,
    TABLES: {
      SKIN: SKIN, W_SKIN: W_SKIN, HEAD: HEAD, HEAD_NAME: HEAD_NAME, W_HEAD: W_HEAD,
      W_JAW: W_JAW, W_EAR: W_EAR, HAIR_NAME: HAIR_NAME, W_HAIR: W_HAIR,
      SIL_CLASS: SIL_CLASS, SIL_NAME: SIL_NAME, HCOL: HCOL, HCOL_NAME: HCOL_NAME,
      W_HCOL: W_HCOL, W_BROW: W_BROW, BROW_NAME: BROW_NAME, W_EYE: W_EYE,
      EYE_NAME: EYE_NAME, W_IRIS: W_IRIS, IRIS_NAME: IRIS_NAME, W_NOSE: W_NOSE,
      NOSE_NAME: NOSE_NAME, W_MOUTH: W_MOUTH, MOUTH_NAME: MOUTH_NAME,
      W_FACIAL: W_FACIAL, FACIAL_NAME: FACIAL_NAME, FAC_CLASS: FAC_CLASS,
      FAC_NAME_CLASS: FAC_NAME_CLASS, W_YAW: W_YAW
    },
    /* colour helpers, shared so call sites do not re-derive them */
    util: { mix: mix, lighten: lighten, darken: darken, rgba: rgba, lum: lum, hueShift: hueShift }
  };

  if (typeof window !== 'undefined' && window) window.MG_PORTRAIT = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof globalThis !== 'undefined' && !globalThis.MG_PORTRAIT) globalThis.MG_PORTRAIT = API;
})();
