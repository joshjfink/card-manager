/* mg-kits.js — Card Manager's KIT engine.
 *
 * Replaces the procedural face on a card with the thing football itself uses
 * for a player it cannot photograph: a SHIRT. Club colours, a real pattern
 * (plain, stripes, hoops, halves, sash, chevron, pinstripe, gradient, chest
 * band, quarters, checks, yoke), collar and cuff trim, a fabric sheen, and the
 * player's SQUAD NUMBER on the back as the hero of the image.
 *
 * ZERO ASSETS, ZERO NETWORK, ZERO PHOTOGRAPHS. Every pixel is a canvas path.
 * Nothing here is a likeness of a real person and nothing here reads, fetches
 * or traces an image.
 *
 * DETERMINISM: the seed is mg-portraits' FNV-1a over name + '|' + team, bit
 * identical in every engine (Math.imul + >>> 0). Same card, same shirt, on a
 * phone, on a laptop, and in a save from three seasons ago.
 *
 * COSMETIC BY CONSTRUCTION: consumes no engine rng(), writes no save state,
 * never touches Math.random. Deleting this file leaves every simulated result
 * byte-identical.
 *
 *   window.MG_KIT = {
 *     seedOf(name, team) -> int32              // matches MG_PORTRAIT.seedOf
 *     kitFor(seed, club) -> frozen kit record  // pattern, colours, trim, collar
 *     draw(ctx, x, y, size, kitOrSeed, opts)   // opts { number, pose:'card'|'detail' }
 *     cached(size, kitOrSeed, opts) -> offscreen canvas (LRU ~400)
 *     blit(ctx, x, y, size, kitOrSeed, opts)   // cached tile, one drawImage
 *     placeholder(ctx, x, y, size, opts)
 *   }
 *
 * Load before mg-manager.js; also `require`-able from node for the audit and
 * contact-sheet harnesses.
 */
;(function () {
  'use strict';

  /* ==================================================================== *
   * 1.  VERSION AND SALTS                                                *
   * ==================================================================== */

  /* Part of every cache key, so a stale tile can never survive a bump.
     Bumped ONLY when kits deliberately change. */
  const KIT_VERSION = 1;

  const TAU = Math.PI * 2;

  /* Salt register — APPEND ONLY. Never renumber, never reuse, never reorder;
     a new trait takes a NEW salt so no existing shirt moves. Deliberately
     disjoint from mg-portraits' 11-42 range so the two engines can share a
     seed without ever sharing a lane. */
  const SALT = {
    PATTERN: 101, STRIPES: 102, HOOPS: 103, SASH: 104, COLLAR: 105,
    CUFF: 106, SIDE: 107, SHOULDER: 108, YOKE: 109, GRAD: 110,
    CHEV: 111, HEM: 112, SWAP: 113, TRIM: 114, CHECK: 115
  };

  /* ==================================================================== *
   * 2.  THE SEED AND THE LANE LAW                                        *
   *     Identical arithmetic to mg-portraits.js — the two must agree.    *
   * ==================================================================== */

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function seedOf(name, team) {
    return fnv1a(String(name) + '|' + String(team == null ? '' : team));
  }

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

  /* ==================================================================== *
   * 3.  COLOUR                                                           *
   * ==================================================================== */

  const _rgbCache = new Map();
  function rgbOf(hex) {
    let v = _rgbCache.get(hex);
    if (v) return v;
    let h = String(hex || '#888888');
    h = h.charCodeAt(0) === 35 ? h.slice(1) : h;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    v = isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [136, 136, 136];
    if (_rgbCache.size < 600) _rgbCache.set(hex, v);
    return v;
  }
  const _h2 = (n) => {
    n = Math.round(n); n = n < 0 ? 0 : n > 255 ? 255 : n;
    return (n < 16 ? '0' : '') + n.toString(16);
  };
  const hexOf = (r, g, b) => '#' + _h2(r) + _h2(g) + _h2(b);

  function mix(a, b, t) {
    const A = rgbOf(a), B = rgbOf(b);
    return hexOf(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  const lighten = (c, t) => mix(c, '#FFFFFF', t);
  const darken = (c, t) => mix(c, '#000000', t);
  function rgba(c, a) {
    const A = rgbOf(c);
    return 'rgba(' + A[0] + ',' + A[1] + ',' + A[2] + ',' + a + ')';
  }
  /* perceptual-ish luminance, 0..1 — the one number every contrast rule uses */
  function lum(c) {
    const A = rgbOf(c);
    return (0.2126 * A[0] + 0.7152 * A[1] + 0.0722 * A[2]) / 255;
  }
  function hueOf(c) {
    const A = rgbOf(c), r = A[0] / 255, g = A[1] / 255, b = A[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-6) return -1;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; return h < 0 ? h + 360 : h;
  }
  function hueDist(a, b) {
    const ha = hueOf(a), hb = hueOf(b);
    if (ha < 0 || hb < 0) return 180;                 // a grey clashes with nothing
    let d = Math.abs(ha - hb) % 360;
    return d > 180 ? 360 - d : d;
  }
  /* two colours are "separable" if the eye can tell the shapes apart */
  function separable(a, b) {
    return Math.abs(lum(a) - lum(b)) >= 0.16 || hueDist(a, b) >= 42;
  }

  const INK = '#12151C';
  const SNOW = '#FFFFFF';

  /* ==================================================================== *
   * 4.  THE PATTERN REGISTRY                                             *
   * ==================================================================== */

  const PATTERNS = [
    'plain', 'stripes', 'hoops', 'halves', 'sash', 'chevron',
    'pinstripe', 'gradient', 'band', 'quarters', 'checks', 'yoke'
  ];
  const P_PLAIN = 0, P_STRIPES = 1, P_HOOPS = 2, P_HALVES = 3, P_SASH = 4,
    P_CHEVRON = 5, P_PINSTRIPE = 6, P_GRADIENT = 7, P_BAND = 8,
    P_QUARTERS = 9, P_CHECKS = 10, P_YOKE = 11;

  /* Weighted so a page of cards reads like a shelf of real shirts: plain is
     the commonest single design, but eleven others between them outnumber it.
     FROZEN AT SHIP — changing a weight moves shirts. */
  const W_PATTERN = [
    /* plain     */ 20,
    /* stripes   */ 13,
    /* hoops     */ 10,
    /* halves    */  6,
    /* sash      */  9,
    /* chevron   */  7,
    /* pinstripe */  8,
    /* gradient  */  8,
    /* band      */  8,
    /* quarters  */  4,
    /* checks    */  3,
    /* yoke      */  7
  ];

  /* A handful of shirts a football kid would notice getting wrong. Colours
     still come from the club record — this table only fixes the GEOMETRY.
     Everything not named here is seeded. */
  const ICONIC = {
    ARG: P_STRIPES, PAR: P_STRIPES, CRO: P_CHECKS, USA: P_SASH,
    GER: P_BAND, NED: P_PLAIN, BRA: P_PLAIN, ENG: P_PLAIN
  };

  const W_COLLAR = [30, 22, 24, 16, 12];      // crew · deep-v · polo · banded · piped
  const W_CUFF = [26, 30, 20, 14];            // soft · solid · double line · hooped

  /* ==================================================================== *
   * 5.  KIT RESOLUTION                                                   *
   * ==================================================================== */

  /* Lift a shirt that would vanish into the card's dark ground or blow out
     under the key light. Real kits are never pure #000 and rarely pure #FFF
     on a screen. */
  function guardField(hex) {
    const L = lum(hex);
    if (L < 0.045) return mix(hex, '#FFFFFF', 0.16);
    if (L > 0.965) return mix(hex, '#0B0E13', 0.045);
    return hex;
  }

  /* the club colours, from whatever shape the call site has to hand */
  const _clubIdx = { built: false, byCode: null };
  function clubLookup(code) {
    try {
      if (!_clubIdx.built) {
        _clubIdx.built = true;
        const D = (typeof window !== 'undefined' && window && window.MG_DATA) || null;
        if (D && D.clubs && D.clubs.length) {
          const m = Object.create(null);
          for (let i = 0; i < D.clubs.length; i++) {
            const c = D.clubs[i];
            if (c && c.code) m[String(c.code).toUpperCase()] = c;
            if (c && c.id) m[String(c.id).toUpperCase()] = c;
          }
          _clubIdx.byCode = m;
        }
      }
      return _clubIdx.byCode ? _clubIdx.byCode[String(code).toUpperCase()] || null : null;
    } catch (e) { return null; }
  }

  const DEFAULT_CLUB = { c1: '#3F5AA8', c2: '#E9BF63', code: 'DEF' };

  function clubOf(club) {
    if (!club) return DEFAULT_CLUB;
    if (typeof club === 'string') {
      if (club.charCodeAt(0) === 35) return { c1: club, c2: '#FFFFFF', code: club };
      return clubLookup(club) || { c1: DEFAULT_CLUB.c1, c2: DEFAULT_CLUB.c2, code: club };
    }
    return club;
  }

  const _kits = new Map();
  const KITS_MAX = 900;

  /* kitFor(seed, club) -> frozen kit record.
     Also accepts the legacy portrait signature kitFor(c1, c2, key). */
  function kitFor(seed, club, legacyKey) {
    if (typeof seed === 'string') {                     // legacy (c1, c2, key)
      return kitFor(seedOf(legacyKey || '', ''), { c1: seed, c2: club, code: legacyKey || 'def' });
    }
    const C = clubOf(club);
    const code = String(C.code || C.id || C.short || 'DEF').toUpperCase();
    const rawA = C.c1 || DEFAULT_CLUB.c1;
    const rawB = C.c2 || DEFAULT_CLUB.c2;
    const s = seed >>> 0;
    const key = 'k' + KIT_VERSION + '|' + s + '|' + code + '|' + rawA + rawB;
    let hit = _kits.get(key);
    if (hit) return hit;

    /* The club's OWN hash drives the design, so eleven Argentinians wear one
       Argentina shirt; the player seed is kept for the fabric's own jitter. */
    const cs = fnv1a('kit|' + code + '|' + rawA + '|' + rawB);

    let field = guardField(rawA);
    let alt = guardField(rawB);

    /* Some club records give two colours the eye cannot separate (two navies,
       two whites). A pattern needs two readable colours or it is a smudge. */
    if (!separable(field, alt)) {
      alt = lum(field) > 0.52 ? mix(field, INK, 0.72) : mix(field, SNOW, 0.80);
    }

    let pattern = ICONIC[code];
    if (pattern == null) pattern = pick(cs, SALT.PATTERN, W_PATTERN);

    /* A very light field with a very light alt reads as one white blob under a
       pattern; swap so the DESIGN carries the dark colour. */
    if (pattern !== P_PLAIN && lum(field) > 0.80 && lum(alt) > 0.72) {
      alt = mix(alt, INK, 0.62);
    }

    /* trim: the club's alt, unless that is the pattern's own colour and would
       disappear into it — then a tone of the field. */
    let trim = alt;
    if (pattern === P_PLAIN || pattern === P_GRADIENT || pattern === P_PINSTRIPE) {
      trim = alt;
    } else if (!separable(alt, field)) {
      trim = lum(field) > 0.52 ? darken(field, 0.55) : lighten(field, 0.62);
    } else if (chance(cs, SALT.TRIM, 0.24)) {
      trim = lum(field) > 0.52 ? darken(field, 0.62) : SNOW;
    }
    const trimInk = lum(trim) > 0.52 ? darken(trim, 0.55) : lighten(trim, 0.45);

    /* the number's ground: what the eye actually sees behind the digits */
    let ground = field;
    if (pattern === P_STRIPES || pattern === P_HOOPS || pattern === P_CHECKS ||
        pattern === P_QUARTERS || pattern === P_HALVES) {
      ground = mix(field, alt, 0.5);
    } else if (pattern === P_BAND || pattern === P_CHEVRON || pattern === P_SASH) {
      ground = mix(field, alt, 0.34);
    } else if (pattern === P_GRADIENT) {
      ground = mix(field, darken(field, 0.42), 0.5);
    } else if (pattern === P_PINSTRIPE) {
      ground = mix(field, alt, 0.16);
    }
    /* A number laid over stripes crosses BOTH colours, so the honest test is
       the worst case, not the average: score each candidate by its WEAKEST
       contrast against any colour it will actually sit on. (Red/yellow stripes
       are the case that breaks an average — white averages fine and then
       vanishes on the yellow.) Then always outline in the other extreme. */
    /* Which colours sit behind the digits is a per-pattern FACT, not a guess:
       a chest band, a yoke and a chevron all live above the number, so letting
       them vote turns a white Germany shirt's number white. (Measured: white
       field 0.955 vs black band 0.110 scored SNOW 0.045 / INK 0.044 and picked
       an invisible white number on a white shirt.) */
    const crossing = pattern === P_STRIPES || pattern === P_HOOPS ||
      pattern === P_HALVES || pattern === P_QUARTERS || pattern === P_CHECKS ||
      pattern === P_SASH;
    const under = crossing ? [field, alt] : [field];
    const worst = (cand) => {
      let m = 1;
      for (let i = 0; i < under.length; i++) m = Math.min(m, Math.abs(lum(cand) - lum(under[i])));
      return m;
    };
    const wSnow = worst(SNOW), wInk = worst(INK);
    let numFill = wSnow >= wInk ? SNOW : INK;
    let best = Math.max(wSnow, wInk);
    /* Black-and-white quarters defeat both extremes at once (measured: NZL
       scored SNOW 0.045 / INK 0.044 — a number visible on neither half). Only
       there, where neither extreme works at all, fall back to a metal tone
       that clears both. Everywhere else the two extremes stay, because that is
       what real shirts use. */
    if (best < 0.10) {
      const alts = ['#C6CDD6', '#5A6470'];
      for (let i = 0; i < alts.length; i++) {
        const w = worst(alts[i]);
        if (w > best) { best = w; numFill = alts[i]; }
      }
    }
    const numOut = lum(numFill) > 0.50 ? INK : SNOW;
    /* When the best available contrast is still thin (yellow-and-navy stripes),
       the outline stops being decoration and becomes the legibility. */
    const numTight = best < 0.34;

    /* the silhouette rim — what keeps a navy shirt off a navy card */
    const rim = lum(field) < 0.34 ? mix(field, SNOW, 0.44) : mix(field, '#0B0E13', 0.40);

    const rec = Object.freeze({
      version: KIT_VERSION,
      key: key,
      code: code,
      seed: s,
      clubSeed: cs,
      pattern: PATTERNS[pattern],
      patternId: pattern,
      c1: rawA, c2: rawB,
      field: field,
      alt: alt,
      trim: trim,
      trimInk: trimInk,
      ground: ground,
      numFill: numFill,
      numOut: numOut,
      numTight: numTight,
      rim: rim,
      shade: darken(field, 0.30),
      hi: lighten(field, 0.20),
      /* counts and geometry, resolved once */
      stripes: 5 + 2 * pick(cs, SALT.STRIPES, [22, 30, 26, 14]),      // 5 · 7 · 9 · 11
      hoops: 4 + pick(cs, SALT.HOOPS, [20, 28, 26, 16, 10]),          // 4..8
      checkN: 5 + pick(cs, SALT.CHECK, [30, 26, 18]),                 // 5..7
      sashDir: chance(cs, SALT.SASH, 0.5) ? 1 : -1,
      chevUp: chance(cs, SALT.CHEV, 0.42),
      gradDown: chance(cs, SALT.GRAD, 0.62),
      yokeDeep: chance(cs, SALT.YOKE, 0.4),
      collar: pick(cs, SALT.COLLAR, W_COLLAR),
      cuff: pick(cs, SALT.CUFF, W_CUFF),
      sideTrim: chance(cs, SALT.SIDE, 0.34),
      sleeveAlt: chance(cs, SALT.SHOULDER, 0.34),
      hemTrim: chance(cs, SALT.HEM, 0.30),
      /* per-player fabric jitter: invisible at a glance, alive in a grid */
      sheen: 0.86 + 0.28 * unit(s, SALT.GRAD)
    });
    if (_kits.size > KITS_MAX) _kits.clear();
    _kits.set(key, rec);
    return rec;
  }

  const kitKey = (k) => (k && k.key) || 'k?';

  /* A keeper wears his own colours — the one football fact the outfield kit
     cannot express. Colour only: the silhouette stays identical, so nothing
     downstream has to know. Opt in with opts.gk (call sites already pass it). */
  const GK_FIELDS = ['#2F8F52', '#39424D', '#E8842C', '#7A4FC9', '#D8D24A', '#1F6F8B', '#B02A6B'];
  const _gk = new Map();
  function gkVariant(kit) {
    let hit = _gk.get(kit.key);
    if (hit) return hit;
    const field = GK_FIELDS[pick(kit.clubSeed, SALT.PATTERN + 1, [16, 16, 12, 10, 10, 14, 8])];
    const alt = separable(field, kit.field) ? kit.field
      : (lum(field) > 0.52 ? darken(field, 0.60) : lighten(field, 0.66));
    const pattern = chance(kit.clubSeed, SALT.GRAD + 1, 0.42) ? P_GRADIENT : P_PLAIN;
    const fl = lum(field);
    const numFill = Math.abs(fl - 1) >= Math.abs(fl - lum(INK)) ? SNOW : INK;
    const rec = Object.freeze(Object.assign({}, kit, {
      key: kit.key + '|gk',
      pattern: PATTERNS[pattern], patternId: pattern,
      field: field, alt: alt, trim: alt,
      trimInk: lum(alt) > 0.52 ? darken(alt, 0.55) : lighten(alt, 0.45),
      ground: field, numFill: numFill, numOut: numFill === SNOW ? INK : SNOW,
      numTight: false,
      rim: lum(field) < 0.34 ? mix(field, SNOW, 0.44) : mix(field, '#0B0E13', 0.40),
      shade: darken(field, 0.30), hi: lighten(field, 0.20),
      sleeveAlt: true, gk: true
    }));
    if (_gk.size > 400) _gk.clear();
    _gk.set(kit.key, rec);
    return rec;
  }

  function kitOf(kitOrSeed, opts) {
    let k;
    if (kitOrSeed && typeof kitOrSeed === 'object' && kitOrSeed.patternId != null) k = kitOrSeed;
    else {
      const club = (opts && opts.club) || null;
      k = kitFor(typeof kitOrSeed === 'number' ? kitOrSeed : seedOf(String(kitOrSeed || ''), ''), club);
    }
    if (opts && opts.gk && !k.gk) k = gkVariant(k);
    return k;
  }

  /* ==================================================================== *
   * 6.  THE SHIRT, IN UNIT SPACE                                         *
   *     x -0.50 .. 0.50 (sleeve to sleeve) · y -0.50 .. 0.535 (yoke to    *
   *     hem). Everything below is drawn inside a ctx.scale(S, S), so a     *
   *     line width of 0.012 is 0.012 of the shirt's width at every size.  *
   * ==================================================================== */

  const SH = {
    neckHalf: 0.126, neckDip: -0.416, shoulderY: -0.500, shoulderPtY: -0.466,
    shoulderX: 0.292, sleeveTopX: 0.500, sleeveTopY: -0.394,
    sleeveBotX: 0.474, sleeveBotY: -0.048, armpitX: 0.288, armpitY: 0.034,
    hipX: 0.266, hipY: 0.556, hemDip: 0.590,
    top: -0.500, bot: 0.590, half: 0.500,
    W: 1.000, H: 1.090, midY: 0.045          // (top + bot) / 2 — the bbox centre
  };

  function shirtPath(ctx) {
    const s = SH;
    ctx.beginPath();
    ctx.moveTo(-s.neckHalf, s.shoulderY);
    /* back neck: a shallow arc, the shape that says "this is the back" */
    ctx.quadraticCurveTo(0, s.neckDip, s.neckHalf, s.shoulderY);
    /* shoulder seam — it SLOPES, which is most of what stops a shirt
       reading as a rectangle with arms */
    ctx.quadraticCurveTo(s.shoulderX * 0.60, s.shoulderY + 0.006, s.shoulderX, s.shoulderPtY);
    /* sleeve: out over the cap, down to the cuff */
    ctx.quadraticCurveTo(s.sleeveTopX * 0.88, s.sleeveTopY - 0.032, s.sleeveTopX, s.sleeveTopY);
    ctx.lineTo(s.sleeveBotX, s.sleeveBotY);
    /* under-sleeve seam back to the armpit */
    ctx.lineTo(s.armpitX, s.armpitY);
    /* the body side, gently waisted */
    ctx.bezierCurveTo(s.armpitX - 0.022, s.armpitY + 0.24, s.hipX + 0.008, s.hipY - 0.22, s.hipX, s.hipY);
    /* hem, with the small dip a shirt hangs into */
    ctx.quadraticCurveTo(0, s.hemDip, -s.hipX, s.hipY);
    ctx.bezierCurveTo(-s.hipX - 0.008, s.hipY - 0.22, -s.armpitX + 0.022, s.armpitY + 0.24, -s.armpitX, s.armpitY);
    ctx.lineTo(-s.sleeveBotX, s.sleeveBotY);
    ctx.lineTo(-s.sleeveTopX, s.sleeveTopY);
    ctx.quadraticCurveTo(-s.sleeveTopX * 0.88, s.sleeveTopY - 0.032, -s.shoulderX, s.shoulderPtY);
    ctx.quadraticCurveTo(-s.shoulderX * 0.60, s.shoulderY + 0.006, -s.neckHalf, s.shoulderY);
    ctx.closePath();
  }

  /* the body only (no sleeves) — several patterns stop at the shoulder seam */
  function bodyPath(ctx) {
    const s = SH;
    ctx.beginPath();
    ctx.moveTo(-s.neckHalf, s.shoulderY);
    ctx.quadraticCurveTo(0, s.neckDip, s.neckHalf, s.shoulderY);
    ctx.quadraticCurveTo(s.shoulderX * 0.60, s.shoulderY + 0.006, s.shoulderX, s.shoulderPtY);
    ctx.lineTo(s.armpitX, s.armpitY);
    ctx.bezierCurveTo(s.armpitX - 0.022, s.armpitY + 0.24, s.hipX + 0.008, s.hipY - 0.22, s.hipX, s.hipY);
    ctx.quadraticCurveTo(0, s.hemDip, -s.hipX, s.hipY);
    ctx.bezierCurveTo(-s.hipX - 0.008, s.hipY - 0.22, -s.armpitX + 0.022, s.armpitY + 0.24, -s.armpitX, s.armpitY);
    ctx.lineTo(-s.shoulderX, s.shoulderPtY);
    ctx.quadraticCurveTo(-s.shoulderX * 0.60, s.shoulderY + 0.006, -s.neckHalf, s.shoulderY);
    ctx.closePath();
  }

  function sleevePath(ctx, side) {                 // side +1 right, -1 left
    const s = SH, k = side;
    ctx.beginPath();
    ctx.moveTo(k * s.shoulderX, s.shoulderPtY);
    ctx.quadraticCurveTo(k * s.sleeveTopX * 0.88, s.sleeveTopY - 0.032, k * s.sleeveTopX, s.sleeveTopY);
    ctx.lineTo(k * s.sleeveBotX, s.sleeveBotY);
    ctx.lineTo(k * s.armpitX, s.armpitY);
    ctx.closePath();
  }

  /* ==================================================================== *
   * 7.  THE PATTERNS                                                     *
   *     Every one is drawn clipped to the shirt, in unit space, with a    *
   *     moire guard: a band narrower than ~2.6 device px is merged away   *
   *     rather than left to shimmer on a phone.                           *
   * ==================================================================== */

  /* how many bands of `span` unit-widths survive at this pixel scale */
  function guardBands(n, span, S, minPx) {
    let k = n;
    while (k > 2 && (span * S) / k < (minPx || 2.6)) k = Math.max(2, Math.floor(k / 2) | 1);
    return k;
  }

  function pat_plain(ctx, kit) {
    ctx.fillStyle = kit.field;
    ctx.fill();
  }

  function pat_stripes(ctx, kit, S) {
    ctx.fillStyle = kit.field; ctx.fill();
    /* An ODD count centres a field stripe on the spine, which is what makes a
       striped shirt look symmetrical rather than merely striped. */
    const n = guardBands(kit.stripes, SH.W, S, 2.8);
    const w = SH.W / n;
    ctx.fillStyle = kit.alt;
    const start = -SH.half;
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) continue;                       // field · alt · field · alt · field
      ctx.fillRect(start + i * w, SH.top - 0.02, w, (SH.bot - SH.top) + 0.04);
    }
  }

  function pat_hoops(ctx, kit, S) {
    ctx.fillStyle = kit.field; ctx.fill();
    const span = SH.bot - SH.top;
    const n = guardBands(kit.hoops * 2 - 1, span, S, 3.0);
    const h = span / n;
    ctx.fillStyle = kit.alt;
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) continue;
      ctx.fillRect(-SH.half - 0.02, SH.top + i * h, SH.W + 0.04, h);
    }
  }

  function pat_halves(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    ctx.fillStyle = kit.alt;
    ctx.fillRect(0, SH.top - 0.02, SH.half + 0.02, (SH.bot - SH.top) + 0.04);
  }

  function pat_sash(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    /* A sash is a band of constant WIDTH, not a band of constant height —
       measure it perpendicular to its own run or it fattens as it steepens. */
    const d = kit.sashDir;                             // +1 = high-left to low-right
    const bw = 0.185;                                  // perpendicular width
    const ax = -0.52 * d, ay = SH.top - 0.06;          // start, above the shoulder
    const bx = 0.52 * d, by = SH.bot + 0.06;           // end, below the hem
    const dx = bx - ax, dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = (-dy / len) * (bw / 2), ny = (dx / len) * (bw / 2);
    ctx.fillStyle = kit.alt;
    ctx.beginPath();
    ctx.moveTo(ax + nx, ay + ny);
    ctx.lineTo(bx + nx, by + ny);
    ctx.lineTo(bx - nx, by - ny);
    ctx.lineTo(ax - nx, ay - ny);
    ctx.closePath();
    ctx.fill();
    /* the thin piping either side that stops a sash reading as a smear */
    ctx.strokeStyle = rgba(kit.trimInk, 0.55);
    ctx.lineWidth = 0.010;
    ctx.beginPath();
    ctx.moveTo(ax + nx, ay + ny); ctx.lineTo(bx + nx, by + ny);
    ctx.moveTo(ax - nx, ay - ny); ctx.lineTo(bx - nx, by - ny);
    ctx.stroke();
  }

  function pat_chevron(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    const up = kit.chevUp;
    const yc = -0.330, w = 0.150, drop = 0.132;
    ctx.fillStyle = kit.alt;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(-SH.half - 0.02, yc + drop);
      ctx.lineTo(0, yc - drop * 0.30);
      ctx.lineTo(SH.half + 0.02, yc + drop);
      ctx.lineTo(SH.half + 0.02, yc + drop + w);
      ctx.lineTo(0, yc - drop * 0.30 + w);
      ctx.lineTo(-SH.half - 0.02, yc + drop + w);
    } else {
      ctx.moveTo(-SH.half - 0.02, yc - drop);
      ctx.lineTo(0, yc + drop * 0.30);
      ctx.lineTo(SH.half + 0.02, yc - drop);
      ctx.lineTo(SH.half + 0.02, yc - drop + w);
      ctx.lineTo(0, yc + drop * 0.30 + w);
      ctx.lineTo(-SH.half - 0.02, yc - drop + w);
    }
    ctx.closePath();
    ctx.fill();
  }

  function pat_pinstripe(ctx, kit, S, lod) {
    ctx.fillStyle = kit.field; ctx.fill();
    /* Pinstripes below ~2.6 px of separation shimmer. Rather than draw a
       shimmer, spend the ink on a flat tonal shift — the shirt still reads as
       "the pinstriped one" beside its neighbours. */
    const n = 15;
    if (lod < 1 || (SH.W * S) / n < 3.0) {
      ctx.fillStyle = rgba(kit.alt, 0.13);
      ctx.fillRect(-SH.half, SH.top - 0.02, SH.W, (SH.bot - SH.top) + 0.04);
      return;
    }
    const gap = SH.W / n;
    ctx.strokeStyle = rgba(kit.alt, 0.82);
    ctx.lineWidth = Math.max(0.008, Math.min(0.017, 1.5 / S));
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = -SH.half + i * gap + gap / 2;
      ctx.moveTo(x, SH.top - 0.02); ctx.lineTo(x, SH.bot + 0.02);
    }
    ctx.stroke();
  }

  function pat_gradient(ctx, kit) {
    const a = kit.field;
    const b = separable(kit.field, kit.alt) ? kit.alt : darken(kit.field, 0.52);
    const g = kit.gradDown
      ? ctx.createLinearGradient(0, SH.top, 0, SH.bot)
      : ctx.createLinearGradient(-SH.half, SH.top, SH.half, SH.bot);
    g.addColorStop(0, lighten(a, 0.06));
    g.addColorStop(0.34, a);
    g.addColorStop(0.72, mix(a, b, 0.72));
    g.addColorStop(1, b);
    ctx.fillStyle = g; ctx.fill();
  }

  function pat_band(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    const y = -0.398, h = 0.172;
    ctx.fillStyle = kit.alt;
    ctx.fillRect(-SH.half - 0.02, y, SH.W + 0.04, h);
    ctx.fillStyle = rgba(kit.trimInk, 0.42);
    ctx.fillRect(-SH.half - 0.02, y - 0.014, SH.W + 0.04, 0.012);
    ctx.fillRect(-SH.half - 0.02, y + h + 0.002, SH.W + 0.04, 0.012);
  }

  function pat_quarters(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    const ym = -0.02;
    ctx.fillStyle = kit.alt;
    ctx.fillRect(0, SH.top - 0.02, SH.half + 0.02, ym - SH.top + 0.02);
    ctx.fillRect(-SH.half - 0.02, ym, SH.half + 0.02, SH.bot - ym + 0.02);
  }

  function pat_checks(ctx, kit, S) {
    ctx.fillStyle = kit.field; ctx.fill();
    const n = guardBands(kit.checkN, SH.W, S, 3.4);
    const c = SH.W / n;
    const rows = Math.ceil((SH.bot - SH.top) / c) + 1;
    ctx.fillStyle = kit.alt;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < n; i++) {
        if ((r + i) % 2 === 0) continue;
        ctx.fillRect(-SH.half + i * c, SH.top - 0.02 + r * c, c + 0.002, c + 0.002);
      }
    }
  }

  function pat_yoke(ctx, kit) {
    ctx.fillStyle = kit.field; ctx.fill();
    const y = kit.yokeDeep ? -0.175 : -0.275;
    ctx.fillStyle = kit.alt;
    ctx.beginPath();
    ctx.moveTo(-SH.half - 0.02, SH.top - 0.04);
    ctx.lineTo(SH.half + 0.02, SH.top - 0.04);
    ctx.lineTo(SH.half + 0.02, y + 0.045);
    ctx.quadraticCurveTo(0, y - 0.070, -SH.half - 0.02, y + 0.045);
    ctx.closePath();
    ctx.fill();
  }

  const PAT_FN = [
    pat_plain, pat_stripes, pat_hoops, pat_halves, pat_sash, pat_chevron,
    pat_pinstripe, pat_gradient, pat_band, pat_quarters, pat_checks, pat_yoke
  ];

  /* ==================================================================== *
   * 8.  THE NUMBER — a vector kit font                                   *
   *     Stroked skeletons, not a system typeface: identical weight and    *
   *     identical shape on every device, and an outline for free by       *
   *     stroking the same path twice. Digit box: x 0..0.66, y 0..1.       *
   * ==================================================================== */

  const DW = 0.68;            // digit advance width, in units of digit HEIGHT
  const DLW = 0.170;          // skeleton stroke width, same units
  const DGAP = 0.050;         // gap between digits

  /* Each digit is a list of subpaths; a subpath is a flat command list:
     0=moveTo(x,y) 1=lineTo(x,y) 2=bezierCurveTo(x1,y1,x2,y2,x,y)
     3=ellipse(cx,cy,rx,ry). Skeletons live inside x 0.10-0.58, y 0.10-0.90,
     so a 0.100 half-stroke lands exactly on the 0.68 x 1.00 advance box. */
  const DIGITS = [
    /* 0 */[[3, 0.340, 0.500, 0.238, 0.396]],
    /* 1 */[[0, 0.130, 0.315, 1, 0.340, 0.112, 1, 0.340, 0.890],
      [0, 0.145, 0.890, 1, 0.535, 0.890]],
    /* 2 */[[0, 0.115, 0.305, 2, 0.115, 0.165, 0.235, 0.105, 0.350, 0.105,
      2, 0.480, 0.105, 0.565, 0.190, 0.565, 0.305,
      2, 0.565, 0.425, 0.455, 0.510, 0.115, 0.890, 1, 0.575, 0.890]],
    /* 3 */[[0, 0.120, 0.205, 2, 0.190, 0.130, 0.285, 0.105, 0.360, 0.105,
      2, 0.485, 0.105, 0.565, 0.180, 0.565, 0.280,
      2, 0.565, 0.380, 0.470, 0.450, 0.345, 0.450,
      2, 0.480, 0.450, 0.578, 0.530, 0.578, 0.665,
      2, 0.578, 0.805, 0.470, 0.895, 0.345, 0.895,
      2, 0.240, 0.895, 0.155, 0.855, 0.110, 0.785]],
    /* 4 */[[0, 0.376, 0.098, 1, 0.086, 0.678, 1, 0.614, 0.678],
      [0, 0.512, 0.098, 1, 0.512, 0.895]],
    /* 5 */[[0, 0.555, 0.115, 1, 0.180, 0.115, 1, 0.150, 0.425,
      2, 0.255, 0.360, 0.340, 0.350, 0.400, 0.350,
      2, 0.520, 0.350, 0.578, 0.455, 0.578, 0.605,
      2, 0.578, 0.785, 0.462, 0.895, 0.315, 0.895,
      2, 0.220, 0.895, 0.155, 0.862, 0.110, 0.810]],
    /* 6 */[[0, 0.465, 0.107, 2, 0.210, 0.205, 0.120, 0.400, 0.124, 0.640],
      [3, 0.345, 0.668, 0.225, 0.222]],
    /* 7 */[[0, 0.105, 0.118, 1, 0.580, 0.118, 1, 0.290, 0.895]],
    /* 8 */[[3, 0.340, 0.298, 0.216, 0.206], [3, 0.340, 0.690, 0.234, 0.220]],
    /* 9 */[[0, 0.556, 0.360, 2, 0.560, 0.600, 0.470, 0.795, 0.215, 0.893],
      [3, 0.335, 0.332, 0.225, 0.222]]
  ];

  function digitPath(ctx, d, ox, oy, h) {
    const subs = DIGITS[d];
    for (let s = 0; s < subs.length; s++) {
      const p = subs[s];
      let i = 0;
      while (i < p.length) {
        const op = p[i];
        if (op === 0) { ctx.moveTo(ox + p[i + 1] * h, oy + p[i + 2] * h); i += 3; }
        else if (op === 1) { ctx.lineTo(ox + p[i + 1] * h, oy + p[i + 2] * h); i += 3; }
        else if (op === 2) {
          ctx.bezierCurveTo(ox + p[i + 1] * h, oy + p[i + 2] * h,
            ox + p[i + 3] * h, oy + p[i + 4] * h,
            ox + p[i + 5] * h, oy + p[i + 6] * h);
          i += 7;
        } else {
          ctx.moveTo(ox + (p[i + 1] + p[i + 3]) * h, oy + p[i + 2] * h);
          ctx.ellipse(ox + p[i + 1] * h, oy + p[i + 2] * h, p[i + 3] * h, p[i + 4] * h, 0, 0, TAU);
          i += 5;
        }
      }
    }
  }

  function numberPath(ctx, digits, cx, cy, h) {
    const n = digits.length;
    const total = n * DW * h + (n - 1) * DGAP * h;
    let ox = cx - total / 2;
    const oy = cy - h / 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      digitPath(ctx, digits[i], ox, oy, h);
      ox += (DW + DGAP) * h;
    }
  }

  function digitsOf(num) {
    let v = Math.abs(Math.round(Number(num) || 0));
    if (v > 99) v = v % 100;
    const out = [];
    if (v >= 10) out.push(Math.floor(v / 10) % 10);
    out.push(v % 10);
    return out;
  }

  /* drawNumber — outline first, fill second: the classic double-stroke that
     keeps a digit legible where it crosses a stripe. */
  function drawNumber(ctx, kit, num, S, lod) {
    const digits = digitsOf(num);
    const two = digits.length > 1;
    /* A binder card is 44 px: the digits get a deliberate 7% at LOD 0, where
       legibility beats proportion. */
    const boost = lod < 1 ? 1.07 : 1;
    const h = (two ? 0.368 : 0.468) * boost;          // number HEIGHT, shirt units
    const cy = 0.046, cx = 0;                         // the back number sits high

    /* a whisper of shadow so the digits sit ON the fabric — and on a kit whose
       colours fight the number, at every LOD */
    if (lod >= 1 || kit.numTight) {
      ctx.save();
      ctx.lineWidth = DLW * h + h * 0.045;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.30)';
      numberPath(ctx, digits, cx + h * 0.020, cy + h * 0.028, h);
      ctx.stroke();
      ctx.restore();
    }

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    /* outline */
    ctx.lineWidth = DLW * h + h * ((lod >= 1 ? 0.060 : 0.048) + (kit.numTight ? 0.042 : 0));
    ctx.strokeStyle = kit.numOut;
    numberPath(ctx, digits, cx, cy, h);
    ctx.stroke();
    /* body */
    ctx.lineWidth = DLW * h;
    ctx.strokeStyle = kit.numFill;
    ctx.stroke();
    /* the sheen down the top third of the digits — only where it can be seen */
    if (lod >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - 0.34, cy - h / 2 - 0.02, 0.68, h * 0.42);
      ctx.clip();
      ctx.lineWidth = DLW * h;
      ctx.strokeStyle = kit.numFill === SNOW ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
      numberPath(ctx, digits, cx, cy, h);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ==================================================================== *
   * 9.  TRIM — collar, cuffs, seams                                      *
   * ==================================================================== */

  function neckPath(ctx, spread) {
    const s = SH, k = spread || 1;
    ctx.beginPath();
    ctx.moveTo(-s.neckHalf * k, s.shoulderY + 0.004);
    ctx.quadraticCurveTo(0, s.neckDip + (1 - k) * 0.02, s.neckHalf * k, s.shoulderY + 0.004);
  }

  function drawCollar(ctx, kit, lod) {
    const s = SH;
    const style = kit.collar;
    if (style === 1) {                                  // deep V — a longer dip
      ctx.save();
      ctx.strokeStyle = kit.trim; ctx.lineWidth = 0.036; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-s.neckHalf - 0.018, s.shoulderY + 0.006);
      ctx.quadraticCurveTo(0, s.neckDip + 0.062, s.neckHalf + 0.018, s.shoulderY + 0.006);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (style === 2) {                                  // polo band: thick, two-tone
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = kit.trim; ctx.lineWidth = 0.060;
      neckPath(ctx, 1.10); ctx.stroke();
      if (lod >= 1) {
        ctx.strokeStyle = rgba(kit.trimInk, 0.62); ctx.lineWidth = 0.012;
        neckPath(ctx, 1.10); ctx.stroke();
      }
      ctx.restore();
      return;
    }
    if (style === 3) {                                  // banded: trim with a keyline
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = kit.trim; ctx.lineWidth = 0.046;
      neckPath(ctx, 1.0); ctx.stroke();
      if (lod >= 1) {
        ctx.strokeStyle = rgba(kit.field, 0.85); ctx.lineWidth = 0.013;
        neckPath(ctx, 1.0); ctx.stroke();
      }
      ctx.restore();
      return;
    }
    if (style === 4) {                                  // piped: field collar, trim edge
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = darken(kit.field, 0.34); ctx.lineWidth = 0.048;
      neckPath(ctx, 1.0); ctx.stroke();
      ctx.strokeStyle = kit.trim; ctx.lineWidth = 0.015;
      neckPath(ctx, 1.06); ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();                                         // crew
    ctx.lineCap = 'round';
    if (lod >= 2) {                                     // back-neck tape
      ctx.strokeStyle = rgba(kit.trimInk, 0.30); ctx.lineWidth = 0.014;
      neckPath(ctx, 1.24); ctx.stroke();
    }
    ctx.strokeStyle = kit.trim; ctx.lineWidth = 0.042;
    neckPath(ctx, 1.0); ctx.stroke();
    ctx.restore();
  }

  /* the neck HOLE — a dark crescent under the collar, the single detail that
     makes the shape read as a garment rather than a paper cut-out */
  function drawNeckHole(ctx, kit) {
    const s = SH;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.26)';
    ctx.beginPath();
    ctx.moveTo(-s.neckHalf * 0.80, s.shoulderY + 0.012);
    ctx.quadraticCurveTo(0, s.neckDip + 0.026, s.neckHalf * 0.80, s.shoulderY + 0.012);
    ctx.quadraticCurveTo(0, s.neckDip + 0.048, -s.neckHalf * 0.80, s.shoulderY + 0.012);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawCuffs(ctx, kit, lod) {
    const s = SH;
    for (let k = -1; k <= 1; k += 2) {
      ctx.save();
      sleevePath(ctx, k); ctx.clip();
      const x0 = k > 0 ? s.sleeveBotX - 0.062 : -s.sleeveBotX;
      const y0 = s.sleeveTopY - 0.10, hh = 0.60;
      if (kit.cuff === 1) {
        ctx.fillStyle = kit.trim;
        ctx.fillRect(x0, y0, 0.062, hh);
      } else if (kit.cuff === 2 && lod >= 1) {
        ctx.fillStyle = kit.trim;
        ctx.fillRect(x0 + 0.008, y0, 0.016, hh);
        ctx.fillRect(x0 + 0.036, y0, 0.016, hh);
      } else if (kit.cuff === 3) {
        ctx.fillStyle = kit.trim;
        ctx.fillRect(x0, y0, 0.062, hh);
        ctx.fillStyle = rgba(kit.field, 0.92);
        ctx.fillRect(x0 + 0.022, y0, 0.020, hh);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,.18)';
        ctx.fillRect(x0 + 0.016, y0, 0.046, hh);
      }
      ctx.restore();
    }
  }

  /* CONTRAST SLEEVES — the kit feature that actually survives 44 px. Three
     white ticks on a sleeve read as dirt at binder size; a whole sleeve in the
     second colour reads as a shirt design from across the room. */
  function drawSleeveAlt(ctx, kit) {
    const flat = kit.patternId === P_PLAIN || kit.patternId === P_GRADIENT ||
      kit.patternId === P_PINSTRIPE;
    const col = flat ? kit.alt
      : (lum(kit.field) > 0.52 ? darken(kit.field, 0.30) : lighten(kit.field, 0.26));
    for (let k = -1; k <= 1; k += 2) {
      ctx.fillStyle = col;
      sleevePath(ctx, k); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,.24)'; ctx.lineWidth = 0.012; ctx.lineCap = 'round';
    for (let k = -1; k <= 1; k += 2) {
      ctx.beginPath();
      ctx.moveTo(k * (SH.shoulderX - 0.002), SH.shoulderPtY + 0.006);
      ctx.lineTo(k * (SH.armpitX + 0.002), SH.armpitY - 0.006);
      ctx.stroke();
    }
  }

  function drawSideTrim(ctx, kit) {
    const s = SH;
    ctx.save();
    ctx.strokeStyle = rgba(kit.trim, 0.85);
    ctx.lineWidth = 0.014; ctx.lineCap = 'round';
    for (let k = -1; k <= 1; k += 2) {
      ctx.beginPath();
      ctx.moveTo(k * (s.armpitX - 0.028), s.armpitY + 0.026);
      ctx.lineTo(k * (s.hipX - 0.026), s.hipY - 0.012);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHemTrim(ctx, kit) {
    const s = SH;
    ctx.save();
    ctx.strokeStyle = rgba(kit.trim, 0.88);
    ctx.lineWidth = 0.020;
    ctx.beginPath();
    ctx.moveTo(-s.hipX, s.hipY - 0.014);
    ctx.quadraticCurveTo(0, s.hemDip - 0.014, s.hipX, s.hipY - 0.014);
    ctx.stroke();
    ctx.restore();
  }

  /* ==================================================================== *
   * 10.  LIGHT — the token sheet's model: KEY upper-left 32°,            *
   *      innerTop rgba(255,255,255,.10), innerBottom rgba(0,0,0,.30)     *
   * ==================================================================== */

  function drawFabricLight(ctx, kit, lod) {
    const s = SH;
    /* ambient: the vertical ramp every panel in this game carries */
    let g = ctx.createLinearGradient(0, s.top, 0, s.bot);
    g.addColorStop(0, 'rgba(255,255,255,.13)');
    g.addColorStop(0.34, 'rgba(255,255,255,.02)');
    g.addColorStop(1, 'rgba(0,0,0,.30)');
    ctx.fillStyle = g;
    ctx.fillRect(-s.half - 0.02, s.top - 0.04, s.W + 0.04, (s.bot - s.top) + 0.08);

    /* key light, upper left, elliptical and soft */
    const k = kit.sheen;
    const bright = lum(kit.field) > 0.60 ? 0.42 : 1;    // a white shirt needs no key
    const rg = ctx.createRadialGradient(-0.20, -0.26, 0.02, -0.14, -0.18, 0.60 * k);
    rg.addColorStop(0, 'rgba(255,255,255,' + (0.20 * bright).toFixed(3) + ')');
    rg.addColorStop(0.55, 'rgba(255,255,255,' + (0.07 * bright).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(-s.half - 0.02, s.top - 0.04, s.W + 0.04, (s.bot - s.top) + 0.08);

    if (lod < 1) return;

    /* the sleeves fall away from the key — darken them, or the shirt reads
       as a flat sticker */
    for (let side = -1; side <= 1; side += 2) {
      ctx.save();
      sleevePath(ctx, side); ctx.clip();
      const sg = ctx.createLinearGradient(side * s.shoulderX, 0, side * s.sleeveTopX, 0);
      sg.addColorStop(0, 'rgba(0,0,0,0)');
      sg.addColorStop(1, side > 0 ? 'rgba(0,0,0,.26)' : 'rgba(0,0,0,.16)');
      ctx.fillStyle = sg;
      ctx.fillRect(-s.half - 0.02, s.top - 0.06, s.W + 0.04, 0.70);
      ctx.restore();
    }

    /* the sleeve seam: the one line that says "these are sleeves" */
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 0.013; ctx.lineCap = 'round';
    for (let k2 = -1; k2 <= 1; k2 += 2) {
      ctx.beginPath();
      ctx.moveTo(k2 * (s.shoulderX - 0.002), s.shoulderY + 0.012);
      ctx.lineTo(k2 * (s.armpitX + 0.002), s.armpitY - 0.006);
      ctx.stroke();
    }
    ctx.restore();

    if (lod < 2) return;

    /* two soft folds down the back */
    ctx.save();
    ctx.globalAlpha = 0.42;
    for (let i = 0; i < 2; i++) {
      const x = (i === 0 ? -1 : 1) * 0.175;
      const fg = ctx.createLinearGradient(x - 0.075, 0, x + 0.075, 0);
      fg.addColorStop(0, 'rgba(0,0,0,0)');
      fg.addColorStop(0.5, 'rgba(0,0,0,.16)');
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(x - 0.075, s.shoulderY, 0.15, s.bot - s.shoulderY);
    }
    ctx.restore();

    /* a fine diagonal weave — the difference between vector art and cloth.
       It is baked into the tile, so it costs nothing per frame. */
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 0.006;
    ctx.beginPath();
    for (let i = -14; i <= 14; i++) {
      const o = i * 0.056;
      ctx.moveTo(-0.55 + o, s.top - 0.05);
      ctx.lineTo(0.35 + o, s.bot + 0.05);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.05)';
    ctx.beginPath();
    for (let i = -14; i <= 14; i++) {
      const o = i * 0.056 + 0.028;
      ctx.moveTo(-0.55 + o, s.top - 0.05);
      ctx.lineTo(0.35 + o, s.bot + 0.05);
    }
    ctx.stroke();
    ctx.restore();

    /* the hem's own shadow — a shirt hangs, it does not float */
    ctx.save();
    const hg = ctx.createLinearGradient(0, s.hipY - 0.10, 0, s.hemDip);
    hg.addColorStop(0, 'rgba(0,0,0,0)');
    hg.addColorStop(1, 'rgba(0,0,0,.16)');
    ctx.fillStyle = hg;
    ctx.fillRect(-s.half, s.hipY - 0.10, s.W, 0.16);
    ctx.restore();
  }

  /* ==================================================================== *
   * 11.  THE PAINT                                                       *
   * ==================================================================== */

  /* P: { S, cx, cy, lod, number, ground, alpha } — S is the unit scale, i.e.
     the on-canvas WIDTH of the shirt from sleeve to sleeve. */
  function paintKit(ctx, kit, P) {
    const S = P.S, lod = P.lod;
    ctx.save();
    ctx.translate(P.cx, P.cy);
    ctx.scale(S, S);

    /* the shirt lifts off whatever ground it lands on */
    if (lod >= 1) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.46)';
      ctx.shadowBlur = Math.max(2, S * 0.055);
      ctx.shadowOffsetY = Math.max(1, S * 0.020);
      ctx.fillStyle = kit.field;
      shirtPath(ctx); ctx.fill();
      ctx.restore();
    }

    /* fabric */
    ctx.save();
    shirtPath(ctx); ctx.clip();
    (PAT_FN[kit.patternId] || pat_plain)(ctx, kit, S, lod);
    drawFabricLight(ctx, kit, lod);
    if (kit.sideTrim && lod >= 1) drawSideTrim(ctx, kit);
    if (kit.hemTrim && lod >= 1) drawHemTrim(ctx, kit);
    if (kit.sleeveAlt) drawSleeveAlt(ctx, kit);
    drawCuffs(ctx, kit, lod);
    if (P.number != null && P.number !== '') drawNumber(ctx, kit, P.number, S, lod);
    ctx.restore();

    /* collar sits ON the seam, so it is drawn after the clip is released and
       clipped to the shirt again — a collar that spills is the first thing a
       kid notices */
    ctx.save();
    shirtPath(ctx); ctx.clip();
    drawNeckHole(ctx, kit);
    drawCollar(ctx, kit, lod);
    ctx.restore();

    /* the silhouette rim: what keeps a navy shirt off a navy card */
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(kit.rim, 0.72);
    ctx.lineWidth = Math.max(0.006, Math.min(0.016, 1.15 / S));
    shirtPath(ctx); ctx.stroke();

    ctx.restore();
  }

  /* ==================================================================== *
   * 12.  BOXES AND LOD                                                   *
   * ==================================================================== */

  const MARGIN = { c: 0.985, b: 0.925 };

  /* boxFor(pose, size, w, h) -> { w, h, S, cx, cy, pose }
       pose 'c' (card)   — cover-fits a wide window, contains a square one
       pose 'b' (detail) — always contains, with the plate's breathing room */
  function boxFor(pose, size, w, h) {
    const p = pose === 'b' ? 'b' : 'c';
    const bw = w || size || 1;
    const bh = h || size || 1;
    /* CONTAIN, always. A shirt cropped to a 1.75:1 band stops reading as a
       garment and starts reading as a torn strip of cloth — measured on the
       binder card, iteration 1. A window too wide for a shirt gets a ground
       (opts.ground), not a crop. */
    const S = Math.min(bw / SH.W, bh / SH.H) * MARGIN[p];
    return { w: bw, h: bh, S: S, cx: bw / 2, cy: bh / 2 - S * SH.midY, pose: p };
  }

  /* LOD by the shirt's on-screen width in CSS px. L0 is the binder at phone
     scale; L2 is the detail plate. */
  function lodFor(S, quality) {
    const q = quality == null ? 1 : quality;
    const w = S * q;
    if (w < 34) return 0;
    if (w < 96) return 1;
    return 2;
  }
  /* quantised size classes, so a grid of near-identical sizes shares tiles */
  function sClass(S) {
    if (S <= 40) return Math.max(8, Math.round(S / 2) * 2);
    if (S <= 128) return Math.round(S / 4) * 4;
    return Math.round(S / 8) * 8;
  }

  /* ==================================================================== *
   * 13.  THE PUBLIC DRAW                                                 *
   * ==================================================================== */

  const EMPTY = {};

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

  /* The backdrop for a window wider than a shirt: the club's own colours,
     dimmed until the shirt is unmistakably the subject. Used by the card's
     1.75:1 art band, where a contained shirt would otherwise sit in a hole. */
  const _grounds = new Map();
  function paintGround(ctx, kit, x, y, w, h) {
    /* Drawn in a translated space so the gradients are origin-relative and can
       be memoised: a binder page of twenty cards would otherwise build forty
       gradient objects every frame. */
    const key = kit.key + '|' + Math.round(w) + 'x' + Math.round(h);
    let g = _grounds.get(key);
    if (!g) {
      const lin = ctx.createLinearGradient(0, 0, w * 0.35, h);
      lin.addColorStop(0, mix(kit.field, '#0B0E13', 0.52));
      lin.addColorStop(0.62, mix(kit.field, '#0B0E13', 0.78));
      lin.addColorStop(1, '#0A0D12');
      const rad = ctx.createRadialGradient(w * 0.5, h * 0.42, 1,
        w * 0.5, h * 0.42, Math.max(w, h) * 0.62);
      rad.addColorStop(0, rgba(kit.alt, 0.16));
      rad.addColorStop(1, rgba(kit.alt, 0));
      g = { lin: lin, rad: rad };
      if (_grounds.size > 96) _grounds.clear();
      _grounds.set(key, g);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = g.lin; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = g.rad; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  const P_REC = { S: 0, cx: 0, cy: 0, lod: 2, number: null };

  /* draw(ctx, x, y, size, kitOrSeed, opts)
       opts { number, pose:'card'|'detail', w, h, club, lod, quality, radius,
              clip, alpha, ground } */
  function draw(ctx, x, y, size, kitOrSeed, opts) {
    opts = opts || EMPTY;
    const kit = kitOf(kitOrSeed, opts);
    const pose = (opts.pose === 'detail' || opts.pose === 'b') ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const lod = opts.lod != null ? opts.lod : lodFor(box.S * (opts.scale || 1), opts.quality);

    ctx.save();
    if (opts.clip !== false) {
      rr(ctx, x, y, box.w, box.h,
        opts.radius != null ? opts.radius : Math.min(box.w, box.h) * 0.07);
      ctx.clip();
    }
    if (opts.alpha != null) ctx.globalAlpha *= opts.alpha;
    if (opts.ground) {
      paintGround(ctx, kit, x, y, box.w, box.h);
    }
    P_REC.S = box.S; P_REC.cx = x + box.cx; P_REC.cy = y + box.cy;
    P_REC.lod = lod; P_REC.number = opts.number != null ? opts.number : null;
    paintKit(ctx, kit, P_REC);
    ctx.restore();
    return kit;
  }

  /* the flat shape a queued tile shows until it lands — two fills */
  function placeholder(ctx, x, y, size, opts) {
    opts = opts || EMPTY;
    const kit = kitOf(opts.kit || opts.seed || 0, opts);
    const pose = (opts.pose === 'detail' || opts.pose === 'b') ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    ctx.save();
    ctx.translate(x + box.cx, y + box.cy);
    ctx.scale(box.S, box.S);
    ctx.fillStyle = rgba(darken(kit.field, 0.22), 0.9);
    shirtPath(ctx); ctx.fill();
    ctx.restore();
  }

  /* ==================================================================== *
   * 14.  THE TILE CACHE                                                  *
   *      A kit tile is a transparent-backed SUBJECT, so a tier holo can   *
   *      animate behind it and the shirt masks it for free.               *
   * ==================================================================== */

  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document && document.createElement) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
    }
    return null;
  }
  const dprOf = () =>
    (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);

  const CACHE = new Map();
  const CACHE_MAX = 400;
  const CACHE_BYTES = 8.0 * 1024 * 1024;
  let cacheBytes = 0;

  function evict() {
    let guard = CACHE.size + 1;
    while ((CACHE.size > CACHE_MAX || cacheBytes > CACHE_BYTES) && CACHE.size && guard-- > 0) {
      const it = CACHE.entries().next();
      if (it.done) break;
      const k = it.value[0], v = it.value[1];
      if (v.pinned && CACHE.size > 1) { CACHE.delete(k); CACHE.set(k, v); continue; }
      cacheBytes -= v.bytes;
      CACHE.delete(k);
      guard = CACHE.size + 1;
    }
  }

  /* the tile is the shirt's own bounding box plus the room its shadow and rim
     need — in unit terms, 1.10 x 1.15 */
  const TILE = { w: 1.10, h: 1.19, cx: 0.55, cy: 0.550 };

  /* cached(size, kitOrSeed, opts) -> offscreen canvas, LRU ~400 */
  function cached(size, kitOrSeed, opts, _kit, _box) {
    opts = opts || EMPTY;
    const kit = _kit || kitOf(kitOrSeed, opts);
    const pose = (opts.pose === 'detail' || opts.pose === 'b') ? 'b' : 'c';
    const box = _box || boxFor(pose, size, opts.w, opts.h);
    const S = sClass(box.S);
    const lod = opts.lod != null ? opts.lod : lodFor(box.S * (opts.scale || 1), opts.quality);
    const dpr = S >= 60 ? Math.min(2, opts.dpr || dprOf()) : 1;
    const num = opts.number != null ? opts.number : '';
    const key = 'kt|' + KIT_VERSION + '|' + kitKey(kit) + '|' + num + '|' + pose
      + '|s' + S + '|' + lod + '|' + dpr;

    const hit = CACHE.get(key);
    if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit.cv; }

    const tw = Math.ceil(TILE.w * S), th = Math.ceil(TILE.h * S);
    const cv = makeCanvas(tw * dpr, th * dpr);
    if (!cv) return null;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    P_REC.S = S; P_REC.cx = TILE.cx * S; P_REC.cy = TILE.cy * S;
    P_REC.lod = lod; P_REC.number = opts.number != null ? opts.number : null;
    paintKit(c, kit, P_REC);

    cv.tileS = S; cv.tilePose = pose; cv.tileDpr = dpr; cv.tileLod = lod;
    const bytes = tw * dpr * th * dpr * 4;
    CACHE.set(key, { cv: cv, bytes: bytes, pinned: !!opts.pin });
    cacheBytes += bytes;
    evict();
    return cv;
  }

  /* blit — the point of the cache: one drawImage per shirt */
  function blit(ctx, x, y, size, kitOrSeed, opts) {
    opts = opts || EMPTY;
    const kit = kitOf(kitOrSeed, opts);
    const pose = (opts.pose === 'detail' || opts.pose === 'b') ? 'b' : 'c';
    const box = boxFor(pose, size, opts.w, opts.h);
    const cv = cached(size, kitOrSeed, opts, kit, box);
    if (!cv) return draw(ctx, x, y, size, kitOrSeed, opts);
    const k = box.S / cv.tileS;
    const w = (cv.width / cv.tileDpr) * k, h = (cv.height / cv.tileDpr) * k;
    ctx.save();
    if (opts.clip !== false) {
      rr(ctx, x, y, box.w, box.h,
        opts.radius != null ? opts.radius : Math.min(box.w, box.h) * 0.07);
      ctx.clip();
    }
    if (opts.alpha != null) ctx.globalAlpha *= opts.alpha;
    if (opts.ground) {
      paintGround(ctx, kit, x, y, box.w, box.h);
    }
    ctx.drawImage(cv, x + box.cx - TILE.cx * box.S, y + box.cy - TILE.cy * box.S, w, h);
    ctx.restore();
    return kit;
  }

  function clearCache() { CACHE.clear(); cacheBytes = 0; }
  const cacheStats = () => ({ entries: CACHE.size, bytes: cacheBytes, kits: _kits.size });

  /* ==================================================================== *
   * 15.  THE API                                                         *
   * ==================================================================== */

  const API = {
    VERSION: KIT_VERSION,
    HONESTY: 'Kit — an invented shirt in the club\'s colours, not a licensed design.',
    /* determinism */
    seedOf: seedOf, fnv1a: fnv1a, lane: lane, unit: unit, chance: chance, pick: pick,
    /* kits */
    kitFor: kitFor, kitOf: kitOf, gkVariant: gkVariant, PATTERNS: PATTERNS, W_PATTERN: W_PATTERN, ICONIC: ICONIC,
    /* drawing */
    draw: draw, blit: blit, cached: cached, placeholder: placeholder, paint: paintKit,
    /* framing */
    boxFor: boxFor, lodFor: lodFor, sClass: sClass, shirtPath: shirtPath, SH: SH,
    /* cache */
    clearCache: clearCache, cacheStats: cacheStats,
    /* test hooks */
    SALT: SALT, DIGITS: DIGITS, digitsOf: digitsOf, numberPath: numberPath,
    util: { mix: mix, lighten: lighten, darken: darken, rgba: rgba, lum: lum,
      hueDist: hueDist, separable: separable, rgbOf: rgbOf, hexOf: hexOf }
  };

  if (typeof window !== 'undefined' && window) window.MG_KIT = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof globalThis !== 'undefined' && !globalThis.MG_KIT) globalThis.MG_KIT = API;
})();
