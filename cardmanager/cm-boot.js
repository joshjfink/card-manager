/* cm-boot.js — boots Card Manager as its own page, and owns the saves.
 *
 * Addendum 26: "its own save namespace `cm-save-slot-N` (migrating any
 * `gs-mg-career*` saves in place so nothing is lost)". Addendum 8: "a
 * years-long save that wipes is a broken promise."
 *
 * Two jobs, in this order:
 *
 *  1. SAVES. window.CM_SAVE owns the 'cm-save-slot-N' namespace and runs a
 *     migration that ADOPTS every 'gs-mg-career*' key. Adopt means
 *     COPY: the originals are left exactly where they are, so the arcade
 *     build keeps working and a bad migration is always recoverable. A slot
 *     that already holds data is never overwritten. What moved is written to
 *     'cm-migration-log' so it can be read back instead of guessed at.
 *
 *  2. BOOT. No overlay, no arcade menu, no game picker — the page IS the
 *     game. CM_SHELL.start() as soon as the DOM is ready and a game has
 *     registered, then the splash comes down.
 *
 * THE SEAM THE EXTRACT PHASE WIRES
 * --------------------------------
 * mg-manager.js currently reads and writes `const SLOT_KEY = () => SAVE_KEY;`
 * with SAVE_KEY = 'gs-mg-career'. When the game is extracted into
 * cardmanager/, that one line becomes:
 *
 *     const SLOT_KEY = () => (window.CM_SAVE ? window.CM_SAVE.key() : SAVE_KEY);
 *
 * and nothing else in the save layer changes — the migration chain, the
 * backups and the quota retry all keep working on the new key.
 *
 * Until that line lands, CM_SAVE.bridge() does the same job from outside:
 * it shadows getItem/setItem/removeItem on this page's localStorage and
 * rewrites ONLY keys beginning 'gs-mg-career' into the cm- namespace.
 * Everything else passes straight through to the native method. It verifies
 * itself with a round-trip probe and says so plainly if it could not install.
 */
(() => {
  'use strict';

  const NS = 'cm-save-slot-';
  const ACTIVE_KEY = 'cm-active-slot';
  const MIGRATED_KEY = 'cm-migrated-v1';
  const LOG_KEY = 'cm-migration-log';
  const LEGACY_PREFIX = 'gs-mg-career';
  const SLOTS = 12;                       // R13: 12 slots, 6 visible

  /* native accessors, captured before anything is shadowed */
  const LS = (() => {
    try {
      const s = window.localStorage;
      s.setItem('cm-probe', '1'); s.removeItem('cm-probe');
      return {
        get: k => Storage.prototype.getItem.call(s, k),
        set: (k, v) => Storage.prototype.setItem.call(s, k, v),
        del: k => Storage.prototype.removeItem.call(s, k),
        keys: () => {
          const out = [];
          for (let i = 0; i < s.length; i++) out.push(s.key(i));
          return out;
        },
        ok: true,
      };
    } catch (e) {
      return { get: () => null, set: () => {}, del: () => {}, keys: () => [], ok: false };
    }
  })();

  const slotKey = n => NS + Math.max(1, Math.min(SLOTS, n | 0));

  let active = 1;
  try {
    const a = parseInt(LS.get(ACTIVE_KEY), 10);
    if (a >= 1 && a <= SLOTS) active = a;
  } catch (e) {}

  /* ── the one-time migration ──────────────────────────────────────── */
  /* Every key we know how to adopt, in the order we adopt it. The game's own
   * backup keys ('-bak', '-pre4') come across too: they exist to protect a
   * migration that already succeeded, and throwing them away here would undo
   * exactly the protection addendum 8 asks for. */
  function legacyMap(key) {
    if (key === LEGACY_PREFIX) return slotKey(active);
    const m = /^gs-mg-career-slot-(\d+)$/.exec(key);
    if (m) return slotKey(parseInt(m[1], 10));
    const rest = key.slice(LEGACY_PREFIX.length);       // '-bak', '-pre4', ...
    if (rest && rest[0] === '-') return slotKey(active) + rest;
    return null;
  }

  /* The ledger, not a boolean. A single 'already migrated' flag adopts
   * whatever happened to exist the first time this page was ever opened and
   * then goes deaf: open the standalone page before the arcade save exists
   * (a brand-new phone, a fresh browser) and that career is orphaned for
   * good. A ledger of the legacy keys ALREADY CONSIDERED lets the scan run
   * on every boot — new legacy saves are adopted whenever they turn up —
   * while a career the owner deleted from the cm- namespace stays deleted,
   * because its source key is already on the list. */
  function readLedger() {
    const raw = LS.get(MIGRATED_KEY);
    if (!raw) return null;
    if (raw === '1') return null;                       // the old boolean
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null; }
    catch (e) { return null; }
  }

  function migrate() {
    if (!LS.ok) return { ran: false, why: 'no localStorage' };
    const legacyFlag = LS.get(MIGRATED_KEY) === '1';
    const ledger = readLedger() || [];
    const adopted = [], skipped = [];
    let found = [];
    try {
      const s = window.localStorage;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.indexOf(LEGACY_PREFIX) === 0) found.push(k);
      }
    } catch (e) { found = []; }

    /* upgrading from the boolean: everything present now was its business */
    if (legacyFlag && !ledger.length) {
      for (const k of found) if (ledger.indexOf(k) < 0) ledger.push(k);
      try { LS.set(MIGRATED_KEY, JSON.stringify(ledger)); } catch (e) {}
      let prev = null;
      try { prev = JSON.parse(LS.get(LOG_KEY) || 'null'); } catch (e) {}
      return prev || { ran: false, why: 'already migrated', ledger: ledger.length };
    }
    found = found.filter(k => ledger.indexOf(k) < 0);
    if (!found.length) {
      let prev = null;
      try { prev = JSON.parse(LS.get(LOG_KEY) || 'null'); } catch (e) {}
      return prev || { ran: false, why: 'nothing new to adopt', ledger: ledger.length };
    }

    /* numbered slots first, so 'gs-mg-career' can never claim a slot that an
     * addendum-17 save already owns */
    found.sort((a, b) => (a === LEGACY_PREFIX ? 1 : 0) - (b === LEGACY_PREFIX ? 1 : 0));

    for (const k of found) {
      const dest = legacyMap(k);
      if (!dest) { skipped.push({ from: k, why: 'no rule' }); continue; }
      if (LS.get(dest) != null) { skipped.push({ from: k, to: dest, why: 'destination already has a save' }); continue; }
      const raw = LS.get(k);
      if (raw == null) continue;
      try { LS.set(dest, raw); adopted.push({ from: k, to: dest, bytes: raw.length }); }
      catch (e) { skipped.push({ from: k, to: dest, why: 'write failed: ' + (e && e.name) }); }
    }
    /* the log is a history, so an earlier boot's adoptions stay readable */
    let prior = null;
    try { prior = JSON.parse(LS.get(LOG_KEY) || 'null'); } catch (e) {}
    const log = {
      ran: true, at: new Date().toISOString(),
      adopted: (prior && Array.isArray(prior.adopted) ? prior.adopted : []).concat(adopted),
      skipped: (prior && Array.isArray(prior.skipped) ? prior.skipped : []).concat(skipped),
      note: 'originals left in place — adopted, never abandoned',
    };
    for (const k of found) if (ledger.indexOf(k) < 0) ledger.push(k);
    log.ledger = ledger.length;
    try { LS.set(LOG_KEY, JSON.stringify(log)); LS.set(MIGRATED_KEY, JSON.stringify(ledger)); }
    catch (e) {}
    if (adopted.length) {
      console.info('[cm-save] adopted ' + adopted.length + ' legacy save'
        + (adopted.length === 1 ? '' : 's') + ': '
        + adopted.map(a => a.from + ' -> ' + a.to).join(', ')
        + ' (originals kept)');
    }
    return log;
  }

  /* ── the pre-extract bridge ──────────────────────────────────────── */
  let bridged = false;
  function bridge() {
    if (bridged || !LS.ok) return bridged;
    const s = window.localStorage;
    const nGet = Storage.prototype.getItem;
    const nSet = Storage.prototype.setItem;
    const nDel = Storage.prototype.removeItem;
    const map = k => (typeof k === 'string' && k.indexOf(LEGACY_PREFIX) === 0)
      ? (legacyMap(k) || k) : k;
    try {
      Object.defineProperty(s, 'getItem', {
        value: function (k) { return nGet.call(s, map(k)); },
        writable: true, configurable: true,
      });
      Object.defineProperty(s, 'setItem', {
        value: function (k, v) { return nSet.call(s, map(k), v); },
        writable: true, configurable: true,
      });
      Object.defineProperty(s, 'removeItem', {
        value: function (k) { return nDel.call(s, map(k)); },
        writable: true, configurable: true,
      });
      /* prove it, rather than assume it: write through the legacy name and
       * read it back under the cm- name */
      const probe = LEGACY_PREFIX + '-bridgeprobe';
      s.setItem(probe, 'ok');
      const landed = nGet.call(s, map(probe)) === 'ok';
      s.removeItem(probe);
      nDel.call(s, map(probe));
      bridged = landed;
      if (!landed) console.warn('[cm-save] bridge did not take effect; the game '
        + 'is still writing the legacy key. Wire SLOT_KEY() to CM_SAVE.key().');
    } catch (e) {
      bridged = false;
      console.warn('[cm-save] bridge unavailable: ' + (e && e.message));
    }
    return bridged;
  }
  function unbridge() {
    if (!bridged) return;
    try {
      delete window.localStorage.getItem;
      delete window.localStorage.setItem;
      delete window.localStorage.removeItem;
    } catch (e) {}
    bridged = false;
  }

  /* ── slot listing, for the save-slot screen the game will grow ───── */
  function headline(raw) {
    if (!raw) return null;
    let s = null;
    try { s = JSON.parse(raw); } catch (e) { return { broken: true, bytes: raw.length }; }
    const p = s && s.profiles && s.profiles[s.activeProfile];
    return {
      bytes: raw.length,
      v: s && s.v,
      club: (p && p.clubName) || null,
      /* The field is p.season.n — measured off a real createCareer() save, not
         guessed. It was read as seasonNo/season.no, neither of which exists, so
         every slot reported a null season and a LOAD GAME row would have shown
         a club with no year against it. The other two spellings stay as
         fallbacks in case an older save carried them. */
      season: (p && p.season && (p.season.n || p.season.no))
        || (p && p.seasonNo) || null,
      division: (p && p.division) != null ? p.division : null,
      coins: (p && p.coins) != null ? p.coins : null,
      /* what a slot TILE draws (addendum 32): the real club's badge id, or the
         crest and kit he made; the difficulty he chose; when it was last saved */
      clubId: (p && p.clubId) || 0,
      clubEa: (p && p.clubEa) || 0,
      crest: (p && p.crest) != null ? p.crest : null,
      colors: (p && Array.isArray(p.colors)) ? p.colors.slice(0, 2) : null,
      difficulty: (p && p.difficulty) || null,
      updatedAt: (s && s.updatedAt) || 0,
    };
  }
  function list() {
    const out = [];
    for (let n = 1; n <= SLOTS; n++) {
      const raw = LS.get(slotKey(n));
      out.push({ n, key: slotKey(n), used: raw != null, active: n === active,
                 info: headline(raw) });
    }
    return out;
  }

  const CM_SAVE = {
    NS, SLOTS,
    key: n => slotKey(n == null ? active : n),
    get active() { return active; },
    setActive(n) {
      active = Math.max(1, Math.min(SLOTS, n | 0));
      try { LS.set(ACTIVE_KEY, String(active)); } catch (e) {}
      return active;
    },
    read: n => LS.get(slotKey(n == null ? active : n)),
    write(raw, n) { LS.set(slotKey(n == null ? active : n), raw); },
    erase(n) { LS.del(slotKey(n == null ? active : n)); },
    list, migrate, bridge, unbridge,
    get bridged() { return bridged; },
    get log() { try { return JSON.parse(LS.get(LOG_KEY) || 'null'); } catch (e) { return null; } },
  };
  window.CM_SAVE = CM_SAVE;

  /* Run both immediately, at parse time, so no game code can read a save
   * before the namespace is settled. */
  const migration = migrate();
  if (window.CM_BRIDGE_SAVES !== false) bridge();

  /* ── boot ────────────────────────────────────────────────────────── */
  function splashDown() {
    const s = document.getElementById('cmSplash');
    if (s && !s.classList.contains('gone')) {
      s.classList.add('gone');
      setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 520);
    }
  }

  let booted = false, waited = 0;
  function boot() {
    if (booted) return;
    const S = window.CM_SHELL;
    if (!S) { console.error('[cm-boot] CM_SHELL is missing — load cm-shell.js first.'); return; }
    const want = window.CM_GAME_ID || (S.games.indexOf('manager') >= 0 ? 'manager' : S.games[0]);
    /* A game that registers from its own DOMContentLoaded handler can lose the
     * race with this one. Wait for it rather than showing a splash forever. */
    if (!want) {
      if (waited < 30) { waited++; setTimeout(boot, 100); return; }
      console.error('[cm-boot] no game registered — nothing to start.');
      S.fatal('No game was loaded.');
      return;
    }
    booted = true;
    S.start(want);
    /* the splash stays until there is really something behind it */
    let tries = 0;
    const iv = setInterval(() => {
      const d = S.debug();
      if ((d && d.open && d.state !== 'load') || ++tries > 60) { clearInterval(iv); splashDown(); }
    }, 120);
    setTimeout(splashDown, 9000);              // never a permanent curtain
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    setTimeout(boot, 0);
  }
  /* a late-registering game still boots */
  window.CM_BOOT = { boot, splashDown, get migration() { return migration; } };
})();
