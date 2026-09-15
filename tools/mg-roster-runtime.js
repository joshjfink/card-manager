/* mg-roster-runtime.js — the API half of gibson/web/static/mg-roster.js.
 *
 * SOURCE FILE. It is inlined verbatim into the generated mg-roster.js by
 * tools/build_mg_data.py; editing the generated file is pointless.
 *
 * Contract: define one global function, MG_ROSTER_RUNTIME(D), which takes the
 * packed payload and returns the window.MG_ROSTER API. Nothing here may run
 * work at load time — every table is built on first use (see LAZY below), so
 * booting the game costs one string parse and nothing else.
 *
 * Ratings, clubs, leagues and nations come from EA's PUBLIC FC ratings pages.
 * Card Manager is not affiliated with, endorsed by or licensed by EA.
 */
'use strict';

function MG_ROSTER_RUNTIME(D) {

  /* ---------- base64url symbol table (the only alphabet in the payload) --- */
  var ALPHA = D.alphabet;
  var IDX = new Int16Array(128);
  var _idxReady = false;
  function idx() {
    if (!_idxReady) {
      for (var i = 0; i < 128; i++) IDX[i] = -1;
      for (var j = 0; j < ALPHA.length; j++) IDX[ALPHA.charCodeAt(j)] = j;
      _idxReady = true;
    }
    return IDX;
  }

  /* ---------- LAZY: nothing below exists until something asks for it ------ */
  var L = {
    lines: null,      // names split into "first\tlast\tcommon"
    fold: null,       // one folded lowercase ASCII blob for search
    start: null,      // line offsets into that blob
    squads: null,     // clubId -> [playerId]
    lclubs: null,     // leagueId -> [clubId]
    clubName: null,   // club names split
    leagueName: null, // league names split
    nationName: null, // nation names split
    ab: null,         // per-player playstyle rows
    cards: null,      // album sid -> playerId
    cardOf: null,     // playerId -> album sid
    obj: {},          // memoised player objects
    stats: {},        // memoised stat blocks
    youth: null       // the under-20 prospect index (addendum 22 §2)
  };

  /* ---------- fixed-width column reads ------------------------------------ */
  function colRaw(key, i) {
    var spec = D.cols[key], s = D.c[key], w = spec[0], I = idx();
    var p = i * w, v = 0;
    for (var k = 0; k < w; k++) v = v * 64 + I[s.charCodeAt(p + k)];
    return v;
  }
  function col(key, i) { return colRaw(key, i) + (D.cols[key][1] || 0); }

  /* ---------- bit-packed stat records ------------------------------------- */
  /* Each player owns D.statChars symbols; stat j lives at bit j*D.statBits. */
  function statAt(i, j) {
    var I = idx(), base = i * D.statChars, off = j * D.statBits;
    var sym = (off / 6) | 0, shift = off % 6, need = D.statBits, v = 0;
    while (need > 0) {
      var six = I[D.stats.charCodeAt(base + sym)];
      var avail = 6 - shift, take = avail < need ? avail : need;
      v = (v << take) | ((six >> (avail - take)) & ((1 << take) - 1));
      need -= take; shift += take;
      if (shift === 6) { shift = 0; sym++; }
    }
    return v;
  }

  /* ---------- strings ------------------------------------------------------ */
  function lines() { return L.lines || (L.lines = D.names.split('\n')); }
  function clubNames() { return L.clubName || (L.clubName = D.clubs.split('\n')); }
  function leagueNames() { return L.leagueName || (L.leagueName = D.leagues.split('\n')); }
  function nationNames() { return L.nationName || (L.nationName = D.nations.split('\n')); }

  var FOLD_MAP = { 'ø': 'o', 'Ø': 'o', 'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd',
                   'ł': 'l', 'Ł': 'l', 'ß': 'ss', 'æ': 'ae', 'Æ': 'ae',
                   'œ': 'oe', 'Œ': 'oe', 'þ': 'th', 'Þ': 'th', 'ı': 'i' };
  function fold(s) {
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[øØđĐðÐłŁßæÆœŒþÞı]/g, function (c) { return FOLD_MAP[c]; });
    return s.toLowerCase().replace(/[\t ]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ');
  }

  /* ---------- players ------------------------------------------------------ */
  var POS = D.pos, ABL = D.abl;

  function altOf(i) {
    var I = idx(), s = D.alt, out = [], p = i * D.altSlots;
    for (var k = 0; k < D.altSlots; k++) {
      var v = I[s.charCodeAt(p + k)];
      if (v === 63) break;
      out.push(POS[v][0]);
    }
    return out;
  }

  function abLines() { return L.ab || (L.ab = D.ab.split('\n')); }
  function abilitiesOf(i) {
    var s = abLines()[i];
    if (!s) return [];
    var I = idx(), out = [];
    for (var k = 0; k + 1 < s.length; k += 2) {
      var v = I[s.charCodeAt(k)] * 64 + I[s.charCodeAt(k + 1)];
      out.push({ label: ABL[v], plus: D.abPlus.charAt(v) === '1' });
    }
    return out;
  }

  function bornOf(i) {
    var b = colRaw('birth', i);
    return { y: 1970 + (b >> 9), m: (b >> 5) & 15, d: b & 31 };
  }
  function ageOf(born) {
    var a = D.asOfY - born.y;
    if (D.asOfM < born.m || (D.asOfM === born.m && D.asOfD < born.d)) a--;
    return a;
  }

  function build(i) {
    var ln = lines()[i].split('\t');
    var pi = colRaw('pos', i), ci = colRaw('club', i), ni = colRaw('nat', i);
    var misc = colRaw('misc', i), born = bornOf(i);
    var lg = colRaw('lg', i);          /* his own league, not his club's:
                                          EA lists whole unlicensed leagues
                                          with no club label at all */
    var common = ln[2] || '';
    var p = {
      id: i,
      rank: i + 1,
      ea: colRaw('ea', i),
      name: common || (ln[0] + ' ' + ln[1]).trim(),
      first: ln[0], last: ln[1], common: common,
      short: common || ln[1] || ln[0],
      ovr: col('ovr', i),
      pos: POS[pi][0], posLabel: POS[pi][1], posType: POS[pi][2],
      alt: altOf(i),
      club: ci, clubName: clubNames()[ci],
      league: lg, leagueName: leagueNames()[lg],
      nation: ni, nationName: nationNames()[ni],
      nationCode: natCode(ni),
      height: col('ht', i), weight: col('wt', i),
      foot: (misc & 1) ? 'L' : 'R',
      skill: (misc >> 1) & 7,
      weak: (misc >> 4) & 7,
      gender: (misc >> 7) & 1 ? 'W' : 'M',
      born: born,
      age: ageOf(born),
      playstyles: abilitiesOf(i),
      card: cardOf(i),
      source: 'ea'
    };
    p.cardTeam = p.card ? p.card.replace(/[0-9]+$/, '').toUpperCase() : null;
    return p;
  }

  function byId(id) {
    if (typeof id === 'string') {
      if (/^[0-9]+$/.test(id)) id = +id;
      else return byCard(id);
    }
    if (!(id >= 0 && id < D.n)) return null;
    return L.obj[id] || (L.obj[id] = build(id));
  }

  function byEaId(ea) {
    var m = eaIndex();
    var i = m[ea];
    return i === undefined ? null : byId(i);
  }
  var _ea = null;
  function eaIndex() {
    if (!_ea) {
      _ea = {};
      for (var i = 0; i < D.n; i++) _ea[colRaw('ea', i)] = i;
    }
    return _ea;
  }

  /* ---------- the album merge (Addendum 21 §1) ---------------------------- */
  function cardMap() {
    if (!L.cards) {
      L.cards = {}; L.cardOf = {};
      var rows = D.cards ? D.cards.split(' ') : [];
      for (var k = 0; k < rows.length; k++) {
        if (!rows[k]) continue;
        var f = rows[k].split(':');
        var pid = +f[1];
        L.cards[f[0]] = pid;
        L.cardOf[pid] = f[0];
      }
    }
    return L.cards;
  }
  function cardOf(i) { cardMap(); return L.cardOf[i] || null; }

  /* Album cards with no EA counterpart still answer byCard() — from MG_DATA,
     never from invented ratings. */
  function albumRow(sid) {
    var MD = (typeof window !== 'undefined' && window.MG_DATA) ||
             (typeof globalThis !== 'undefined' && globalThis.MG_DATA);
    if (!MD || !MD.players) return null;
    var code = sid.replace(/[0-9]+$/, '').toUpperCase();
    var rows = MD.players[code];
    if (!rows) return null;
    for (var k = 0; k < rows.length; k++) if (rows[k][0] === sid) return [code, rows[k]];
    return null;
  }
  function byCard(sid) {
    var pid = cardMap()[sid];
    if (pid !== undefined) {
      var p = byId(pid);
      if (p) p.album = albumCard(sid);
      return p;
    }
    var a = albumCard(sid);
    return a ? { id: null, ea: null, card: sid, cardTeam: a.team, name: a.name,
                 short: a.short, pos: a.pos, ovr: a.ovr, source: 'album',
                 album: a, playstyles: [], alt: [] } : null;
  }
  function albumCard(sid) {
    var r = albumRow(sid);
    if (!r) return null;
    var row = r[1];
    return { card: sid, team: r[0], num: row[1], name: row[2], short: row[3],
             pos: row[4], ovr: row[5], sho: row[6], dfn: row[7], x: row[8] || {} };
  }

  /* ---------- clubs, leagues, nations ------------------------------------- */
  function clubLeague(ci) { return colRaw('cl', ci); }
  function natCode(ni) {
    var c = D.ncode.substr(ni * 3, 3);
    return c === '   ' ? null : c;
  }

  function squads() {
    if (!L.squads) {
      var i, s = [];
      for (i = 0; i < D.nc; i++) s.push([]);
      for (i = 0; i < D.n; i++) s[colRaw('club', i)].push(i);
      for (i = 0; i < D.nc; i++) s[i].sort(function (a, b) { return col('ovr', b) - col('ovr', a); });
      L.squads = s;
    }
    return L.squads;
  }
  function leagueClubs() {
    if (!L.lclubs) {
      var i, s = [];
      for (i = 0; i < D.nl; i++) s.push([]);
      for (i = 0; i < D.nc; i++) s[clubLeague(i)].push(i);
      for (i = 0; i < D.nl; i++) s[i].sort(function (a, b) {
        return col('cstr', b) - col('cstr', a);
      });
      L.lclubs = s;
    }
    return L.lclubs;
  }

  function club(ci) {
    if (typeof ci === 'string') { var f = findClub(ci); if (f === null) return null; ci = f; }
    if (!(ci >= 0 && ci < D.nc)) return null;
    var lg = clubLeague(ci);
    var nm = clubNames()[ci], dup = D.cdup.charAt(ci) === '1';
    return { id: ci, name: nm, ea: colRaw('cea', ci),
             label: dup ? nm + ' · ' + leagueNames()[lg] : nm,
             league: lg, leagueName: leagueNames()[lg],
             strength: col('cstr', ci),
             size: squads()[ci].length,
             sharedName: dup,
             synthetic: ci === 0 };
  }
  function league(li) {
    if (typeof li === 'string') { var f = findLeague(li); if (f === null) return null; li = f; }
    if (!(li >= 0 && li < D.nl)) return null;
    return { id: li, name: leagueNames()[li],
             strength: col('lstr', li),
             clubs: leagueClubs()[li].length,
             synthetic: li === 0 };
  }
  function nation(ni) {
    if (!(ni >= 0 && ni < D.nn)) return null;
    return { id: ni, name: nationNames()[ni], code: natCode(ni) };
  }

  function findClub(name) {
    var q = fold(String(name || '')).trim(), n = clubNames();
    if (!q) return null;
    for (var i = 1; i < n.length; i++) if (fold(n[i]).trim() === q) return i;
    for (i = 1; i < n.length; i++) if (fold(n[i]).indexOf(q) >= 0) return i;
    return null;
  }
  function findLeague(name) {
    var q = fold(String(name || '')).trim(), n = leagueNames();
    if (!q) return null;
    for (var i = 1; i < n.length; i++) if (fold(n[i]).trim() === q) return i;
    for (i = 1; i < n.length; i++) if (fold(n[i]).indexOf(q) >= 0) return i;
    return null;
  }

  function playersOfClub(ci, opts) {
    if (typeof ci === 'string') { var f = findClub(ci); if (f === null) return []; ci = f; }
    var ids = squads()[ci] || [];
    if (opts && opts.ids) return ids.slice();
    var out = [];
    for (var i = 0; i < ids.length; i++) out.push(byId(ids[i]));
    return out;
  }
  var _pl = null;
  function playersOfLeague(li, opts) {
    if (typeof li === 'string') { var f = findLeague(li); if (f === null) return []; li = f; }
    if (!_pl) {
      _pl = [];
      for (var k = 0; k < D.nl; k++) _pl.push([]);
      for (k = 0; k < D.n; k++) _pl[colRaw('lg', k)].push(k);
      for (k = 0; k < D.nl; k++) _pl[k].sort(function (a, b) { return col('ovr', b) - col('ovr', a); });
    }
    var ids = _pl[li] || [];
    if (opts && opts.ids) return ids.slice();
    var out = [];
    for (var i = 0; i < ids.length; i++) out.push(byId(ids[i]));
    return out;
  }
  function clubsOfLeague(li, opts) {
    if (typeof li === 'string') { var f = findLeague(li); if (f === null) return []; li = f; }
    var ids = leagueClubs()[li] || [];
    if (opts && opts.ids) return ids.slice();
    var out = [];
    for (var i = 0; i < ids.length; i++) out.push(club(ids[i]));
    return out;
  }

  /* ---------- best XI ------------------------------------------------------ */
  var LINE = { GK: 'GK', DEF: 'DEF', MID: 'MID', ATT: 'ATT' };
  function copy(p) { var o = {}, k; for (k in p) o[k] = p[k]; return o; }
  function lineOf(p) { return LINE[p.posType] || 'MID'; }
  function bestXI(ci, formation) {
    var f = (formation || '4-3-3').split('-').map(Number);
    var want = { GK: 1, DEF: f[0] || 4, MID: f[1] || 3, ATT: f[2] || 3 };
    var squad = playersOfClub(ci), take = { GK: [], DEF: [], MID: [], ATT: [] }, rest = [];
    for (var i = 0; i < squad.length; i++) {
      var p = squad[i], ln = lineOf(p);
      if (take[ln].length < want[ln]) take[ln].push(copy(p)); else rest.push(p);
    }
    /* out-of-position fill, best available first */
    var order = ['GK', 'DEF', 'MID', 'ATT'], xi = [];
    for (var k = 0; k < order.length; k++) {
      var ln2 = order[k];
      while (take[ln2].length < want[ln2] && rest.length) {
        var pick = copy(rest.shift());
        pick.outOfPosition = true;
        take[ln2].push(pick);
      }
      for (var j = 0; j < take[ln2].length; j++) {
        take[ln2][j].slot = ln2 + (ln2 === 'GK' ? '' : (j + 1));
        xi.push(take[ln2][j]);
      }
    }
    return xi;
  }

  /* ---------- search ------------------------------------------------------- */
  function searchIndex() {
    if (!L.fold) {
      var ln = lines(), parts = new Array(ln.length);
      var st = new Int32Array(ln.length + 1), off = 0;
      for (var i = 0; i < ln.length; i++) {
        var f = fold(ln[i]);
        parts[i] = f; st[i] = off; off += f.length + 1;
      }
      st[ln.length] = off;
      L.start = st;
      L.fold = '\n' + parts.join('\n') + '\n';   /* pad so every line starts after \n */
      for (i = 0; i <= ln.length; i++) L.start[i] += 1;
    }
    return L.fold;
  }
  function lineAt(pos) {
    var st = L.start, lo = 0, hi = st.length - 2;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (st[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function search(q, limit) {
    limit = limit || 25;
    var needle = fold(String(q || '')).trim();
    if (!needle) return [];
    var blob = searchIndex(), hits = [], seen = {}, at = 0;
    while (hits.length < 4000) {
      var p = blob.indexOf(needle, at);
      if (p < 0) break;
      at = p + 1;
      var i = lineAt(p);
      if (seen[i]) continue;
      seen[i] = 1;
      var start = L.start[i];
      var score = p === start ? 3 : (blob.charAt(p - 1) === ' ' ? 2 : 1);
      if (p === start && start + needle.length === L.start[i + 1] - 1) score = 4;
      hits.push([i, score, col('ovr', i)]);
    }
    hits.sort(function (a, b) { return b[1] - a[1] || b[2] - a[2] || a[0] - b[0]; });
    var out = [];
    for (var k = 0; k < hits.length && k < limit; k++) out.push(byId(hits[k][0]));
    return out;
  }

  /* ---------- the lazy stat accessor -------------------------------------- */
  var SK = D.sk;
  function stats(id) {
    var p = typeof id === 'object' && id ? id.id : id;
    if (typeof p === 'string') { var r = byId(p); p = r && r.id; }
    if (!(p >= 0 && p < D.n)) return null;
    var c = L.stats[p];
    if (c) return c;
    var o = {};
    for (var j = 0; j < SK.length; j++) o[SK[j]] = statAt(p, j);
    return (L.stats[p] = o);
  }
  var SKI = null;
  function stat(id, key) {
    if (!SKI) { SKI = {}; for (var j = 0; j < SK.length; j++) SKI[SK[j]] = j; }
    var p = typeof id === 'object' && id ? id.id : id;
    if (typeof p === 'string') { var r = byId(p); p = r && r.id; }
    var j2 = SKI[key];
    if (j2 === undefined || !(p >= 0 && p < D.n)) return null;
    return statAt(p, j2);
  }
  function faces(id) {
    var s = stats(id);
    if (!s) return null;
    return { pac: s.pac, sho: s.sho, pas: s.pas, dri: s.dri, def: s.def, phy: s.phy };
  }

  /* ---------- the youth prospect pool (addendum 22 §2) --------------------
   * REAL players aged <= D.youth.maxAge on D.youth.ref, out of this same
   * harvest. Name, age, club, nation, position and CURRENT rating are EA's
   * public numbers; the potential CEILING, its mask, the growth curve, the
   * fee and the SHO/DEF split are made by this project and are not EA's.
   * Nothing is invented — the label is "under-20 prospects" because that is
   * exactly what the data supports. Lazy like everything else here: the
   * index is built the first time somebody asks for a prospect. */
  var Y = D.youth || null;

  function ycol(key, k) {
    var spec = Y.cols[key], s = Y.c[key], w = spec[0], I = idx();
    var p = k * w, v = 0;
    for (var j = 0; j < w; j++) v = v * 64 + I[s.charCodeAt(p + j)];
    return v + (spec[1] || 0);
  }
  function youthIndex() {
    if (!Y) return null;
    if (!L.youth) {
      var byPlayer = {}, ord = [];
      for (var k = 0; k < Y.n; k++) {
        var id = ycol('id', k);
        byPlayer[id] = k;
        ord.push(id);
      }
      L.youth = { byPlayer: byPlayer, ids: ord };
    }
    return L.youth;
  }
  function youthAgeOf(born) {
    var a = Y.refY - born.y;
    if (Y.refM < born.m || (Y.refM === born.m && Y.refD < born.d)) a--;
    return a;
  }
  function isProspect(id) {
    if (!Y) return false;
    if (typeof id === 'object' && id) id = id.id;
    return youthIndex().byPlayer[id] !== undefined;
  }
  /* One prospect, as the game needs him: the whole real player, plus the
   * numbers this project invented for him. `pot` is the TRUE ceiling — a
   * screen must mask it with reveal() until the card has played, or the fog
   * of war the pool is built on is not fog at all. */
  function prospect(id) {
    if (!Y) return null;
    if (typeof id === 'object' && id) id = id.id;
    var k = youthIndex().byPlayer[id];
    if (k === undefined) return null;
    var p = byId(id);
    if (!p) return null;
    var o = copy(p);
    o.prospect = true;
    o.youthIndex = k;
    o.snapshotAge = youthAgeOf(p.born);   /* his real age on Y.ref */
    o.cur = p.ovr;
    o.pot = ycol('pt', k);
    o.pw = ycol('pw', k);
    o.po = ycol('po', k) - 1;
    o.sho = ycol('sho', k);
    o.dfn = ycol('dfn', k);
    o.role = POS[colRaw('pos', id)][2];
    o.fee = youthFee(o.cur, o.snapshotAge);
    o.label = Y.label;
    return o;
  }
  function prospectAt(k) {
    return (Y && k >= 0 && k < Y.n) ? prospect(ycol('id', k)) : null;
  }
  function youthIds() { return Y ? youthIndex().ids.slice() : []; }
  function youthFee(cur, age) {
    if (!Y) return 0;
    var F = Y.fee;
    var v = F.base + (cur - 48) * F.perAbility + (Y.maxAge - age) * F.perYoung;
    v = Math.round(v / 5) * 5;
    return Math.max(F.floor, Math.min(F.cap, v));
  }
  /* The masked ceiling, decoded exactly as MG_DATA.potential.reveal decodes
   * an album card's — one formula, so a prospect's sheet and a card's sheet
   * cannot disagree about what "potential" means. apps is how many games he
   * has played for YOU. */
  function youthReveal(pr, apps, revealApps) {
    var R = revealApps || 15;
    var t = Math.min(apps || 0, R) / R;
    if (!pr.pw) return { lo: pr.pot, hi: pr.pot, exact: true, t: t };
    var hw = Math.ceil(pr.pw * (1 - t));
    var off = Math.round(pr.po * (1 - t));
    var lo = pr.pot - hw + off, hi = pr.pot + hw + off;
    if (lo < pr.cur) { hi += pr.cur - lo; lo = pr.cur; }
    if (hi > 99) { lo = Math.max(pr.cur, lo - (hi - 99)); hi = 99; }
    return { lo: lo, hi: hi, exact: hw === 0, t: t };
  }
  /* One season of development. The ONE implementation of the curve — the
   * game and the audit both call this, so neither can drift from the odds
   * the intake screen prints. Deterministic in (id, season): a save replays
   * to the same numbers, every time, on every device. */
  function youthGrow(id, cur, age, apps, season, seedMix) {
    var pr = prospect(id);
    if (!pr) return null;
    var G = Y.growth;
    var room = pr.pot - cur;
    if (room <= 0) return { cur: cur, gain: 0, carry: 0, done: true };
    var stage = G.stage[G.stage.length - 1][1];
    for (var i = 0; i < G.stage.length; i++)
      if (age <= G.stage[i][0]) { stage = G.stage[i][1]; break; }
    var play = G.playFloor + (1 - G.playFloor) *
               Math.min(1, (apps || 0) / G.playApps);
    var h = (Math.imul(pr.ea, 2654435761) ^ Math.imul(season + 1, 40503) ^
             ((seedMix || 0) >>> 0)) >>> 0;
    var r = mulberry(h)();
    var gain = room * G.rate * stage * play *
               (G.rollLo + (G.rollHi - G.rollLo) * r);
    return { cur: cur, gain: gain, stage: stage, play: play, roll: r,
             room: room, pot: pr.pot, done: false };
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* The season's intake shortlist: prospects you have not signed or passed
   * on, deterministic from (career seed, season). `taken` is a set-like
   * object keyed by roster id or by EA id — either is accepted, because the
   * save stores EA ids and the runtime works in roster ids. Prospects who
   * are ALSO album cards are skipped: the same human is one player. */
  function youthIntake(seed, season, taken, count) {
    if (!Y) return [];
    var ids = youthIndex().ids, n = ids.length;
    var want = count || Y.intake.perSeason;
    var rng = mulberry((Math.imul(seed >>> 0, 2246822519) ^
                        Math.imul(season + 1, 3266489917)) >>> 0);
    var out = [], seen = {}, tries = 0;
    while (out.length < want && tries < n * 4) {
      tries++;
      var k = Math.floor(rng() * n);
      var id = ids[k];
      if (seen[id]) continue;
      seen[id] = 1;
      if (cardOf(id)) continue;                       /* already an album card */
      if (taken && (taken[id] || taken[colRaw('ea', id)])) continue;
      out.push(prospect(id));
    }
    return out;
  }

  /* ---------- api ---------------------------------------------------------- */
  var API = {
    version: D.v,
    built: D.built,
    source: D.source,
    honesty: D.honesty,
    notice: D.notice,
    asOf: D.asOf,
    count: { players: D.n, clubs: D.nc - 1, leagues: D.nl - 1, nations: D.nn,
             clubSlots: D.nc, leagueSlots: D.nl,
             merged: D.merge.matched, albumCards: D.merge.cards,
             albumPeople: D.merge.people, clubless: D.nfree },
    merge: D.merge,
    statKeys: SK,
    positions: POS,
    /* players */
    byId: byId, player: byId, byEaId: byEaId, byCard: byCard, cardOf: cardOf,
    /* the two engine numbers for ANY roster player, so a club takeover can
       field the real squad (addendum 34). null on an older roster file. */
    engineStats: function (id) {
      var p = typeof id === 'object' && id ? id.id : id;
      if (!(p >= 0 && p < D.n) || !D.cols.sho || !D.cols.dfn) return null;
      return { sho: colRaw('sho', p), dfn: colRaw('dfn', p),
               role: POS[colRaw('pos', p)][2], cur: col('ovr', p) };
    },
    albumCard: albumCard,
    search: search,
    /* stats — lazy, decoded per player on demand */
    stats: stats, stat: stat, faces: faces,
    /* graph */
    club: club, league: league, nation: nation,
    playersOfClub: playersOfClub, clubsOfLeague: clubsOfLeague,
    playersOfLeague: playersOfLeague,
    squadIds: function (ci) { return playersOfClub(ci, { ids: 1 }); },
    bestXI: bestXI,
    findClub: findClub, findLeague: findLeague,
    clubs: function (all) { var o = []; for (var i = all ? 0 : 1; i < D.nc; i++) o.push(club(i)); return o; },
    leagues: function (all) { var o = []; for (var i = all ? 0 : 1; i < D.nl; i++) o.push(league(i)); return o; },
    nations: function () { var o = []; for (var i = 0; i < D.nn; i++) o.push(nation(i)); return o; },
    /* the under-20 prospect pool (addendum 22 §2) — real players, EA's
       public ratings, ceilings and growth made here. Lazy: none of this
       exists until something asks for a prospect. */
    youth: Y ? {
      label: Y.label, ref: Y.ref, maxAge: Y.maxAge, n: Y.n, ages: Y.ages,
      honesty: Y.honesty, ageNote: Y.ageNote, curve: Y.curve,
      curveNote: Y.curveNote, growth: Y.growth, growthNote: Y.growthNote,
      intake: Y.intake, intakeNote: Y.intakeNote, fee: Y.fee,
      feeNote: Y.feeNote, reveal: Y.reveal, roomCap: Y.roomCap
    } : null,
    prospect: prospect, prospectAt: prospectAt, isProspect: isProspect,
    youthIds: youthIds, youthFee: youthFee, youthReveal: youthReveal,
    youthGrow: youthGrow, youthIntake: youthIntake,
    /* introspection — the audit proves laziness with this */
    _state: function () {
      var n = 0, k; for (k in L.obj) n++;
      var s = 0; for (k in L.stats) s++;
      return { names: !!L.lines, search: !!L.fold, squads: !!L.squads,
               leagueClubs: !!L.lclubs, cards: !!L.cards, eaIndex: !!_ea,
               youth: !!L.youth, players: n, statBlocks: s };
    },
    raw: D
  };
  return API;
}

if (typeof module !== 'undefined' && module.exports) module.exports = MG_ROSTER_RUNTIME;
