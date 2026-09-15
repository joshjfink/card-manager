# Torture dossier — Card Manager standalone demo on Android (360×800)

Target: `scratchpad/manager-demo.html?minigame=manager&demo=1` (version of 2026-08-29 04:02, 1878 lines).
Method: the five prescribed headless screenshots (`tort-android-<B>.png`, B = 6000…90000, 360×800 desktop viewport), plus real-time CDP sessions with Android emulation (360×800, mobile, dpr 2 — `tort-a-*.png`, `tort-c-*.png`, `tort-d-*.png`, `tort-f-*.png`, `tort-g-*.png`, `tort-h-*.png` in the scratchpad). All PNGs were read, console captured per run.

Console: **0 errors, 0 exceptions** in every run. But 124–266 *warnings* per session (defect 13).

Key scale fact used below: the page has no viewport meta, so Android lays it out at 980 CSS px and zooms to 360/980 ≈ 0.37. One canvas px ≈ **0.362 device px**. (The prescribed desktop-360 harness lands at almost the same scale, 0.36, plus right-edge clipping — defect 2a.)

---

## SEV-1 — blockers

### 1. A stray tap on the letterbox freezes the game forever (close() cannot hide the scrim)
- **Screen:** everywhere; ~73 % of the phone screen is scrim letterbox.
- **What:** `close()` sets `scrim.hidden = true`, but the scrim's inline `display:grid` (in `style.cssText`) overrides the UA `[hidden]{display:none}` rule. The loop stops (`open=false`), input is dead, yet the overlay stays fully painted and keeps swallowing every tap (it also covers the 🎮 launcher, z-index 800 < 900). Tapping outside the canvas triggers this (`scrim` pointerdown → `close()`); the Esc-leaves path hits the same wall.
- **Result:** game looks alive but is frozen; only recovery is reloading the page.
- **Evidence:** `tort-a-17-after-stray-tap.png` (hub frozen, identical to `tort-a-16`), `tort-a-18-arcade-menu.png` (launcher tap does nothing — still the frozen hub), `tort-c-02-after-close.png` / `tort-c-03-still-frozen.png` (mode screen frozen the same way), DOM probe after close: `{hiddenAttr: true, display: "grid", visible: true}`.
- **Fix direction:** `scrim.style.display = 'none'` in close() (and `'grid'` in open), or drop `display` from cssText.

### 2. No `<meta name="viewport">` — the phone renders the page at 37 % scale
- **Screen:** all.
- **What:** under mobile emulation `innerWidth` is **980**, not 360 — Android's legacy-viewport fallback. The whole game shrinks to ~0.37×: hub body text 12 px → **4.4 device px**, card stat lines 13 px → 4.7, match player names 10 px → **3.6**, header status (season/division/record/coins — the only place they exist) 14 px → 5.1, commentary 17 px → 6.2. Nothing in the FM hub, draft or match is readable on the owner's phone.
- **Evidence:** metrics dump (innerWidth 980, canvas 946×593.5 CSS at x 17, y 792 in a 980×2178 page); every `tort-a/f/g` PNG shows the game as a small strip in the middle of the tall page.
- **2a — prescribed-harness variant:** in a real 360 CSS px viewport (desktop layout, the given verification command) the canvas takes `max-width:min(96vw,1100px)` = 345.6 px, which is wider than the scrim's 320 px content box; the grid overflows and **~26 px of the game (right edge) is cut off-screen**, the panel sits off-centre and the page scrolls horizontally. `tort-android-6000.png`: "VS THE CPU (one match — Suárez FC cheats" clipped at the right edge; intro `h1` clipped too.
- **Fix direction:** add `<meta name="viewport" content="width=device-width, initial-scale=1">`, make the canvas `width:min(100%, 1100px)`, and add a portrait layout or rotate hint — at 360×800 the 960×600 scene occupies ~27 % of the screen between huge dead bands.

### 3. `&demo=1` attract mode is dead — the page's own auto-open clobbers it
- **Screen:** boot.
- **What:** the framework opens `?minigame=manager&demo=1` at +600 ms (demoMode true), then the page's extra `DOMContentLoaded` script calls `MiniGames.open('manager')` at +700 ms with no demo flag — `startGame` re-runs with `demoMode=false` and a human 3.2 s countdown, then the game waits forever at the mode screen. Attract mode never plays.
- **Evidence:** all five prescribed budget PNGs are the same frame — a frozen countdown "4" over the mode screen at 6 s and still at 90 s (`tort-android-6000.png` … `tort-android-90000.png`); clean real-time run confirms a static mode screen at any wait (`tort-a-02-mode.png`).
- **Consequence for the crews:** the standard `?minigame=<id>&demo=1` screenshot verification shows only this screen for this page — nothing beyond boot is being verified.
- **Fix direction:** delete the extra auto-open script (the framework already handles the param), or pass `demo: q.get('demo')` through it.

---

## SEV-2 — major usability at 360×800

### 4. Touch targets far below 40 device px
Canvas px × 0.362 → device px on the phone:

| control | canvas | device px |
|---|---|---|
| mode buttons | 560×78 | 203×**28** |
| draft cards | 100×140 | **36**×51 |
| hub sidebar rows | 172×52 | 62×**19** |
| hub CONTINUE | 184×46 | 67×**17** |
| fixtures WATCH button | 200×30 | 72×**11** |
| launcher 🎮 button | 144×34 CSS | 53×**12** |
| menu card | 200×250 | 72×91 (ok) |

Everything the owner must tap in the FM hub is 11–19 px tall. Evidence: `tort-a-06-hub-inbox.png`, `tort-a-08-hub-fixtures.png` scaled to phone size.

### 5. Single-tap fall-through: one tap selects *and* commits; whole screens get skipped
- **Mode screen:** any tap anywhere sets `modeSel` from y-zone and starts the draft the same frame — no way to browse modes by touch; a tap on the title or below the third box also launches (zones `py<300 / <404 / else` cover the entire screen).
- **Lineup screen:** advances on ANY tap or key. The transition from the last draft pick uses the same gesture the player is already rhythm-tapping, so the team sheet flashes past unseen. Reproduced twice with paced input: `tort-a-05-lineup.png` is already the hub; in the keyboard run the leftover Enters blew through lineup and **simulated the entire season** (`tort-f-01-lineup.png` shows S1 MD7/7 4-0-2 with six FT reports — the player "played" seven matches without seeing one).
- **Results screen:** any tap → menu, same hazard.
- **Fix direction:** 300–400 ms input cooldown when a state begins; on the mode screen require a second tap on the selected row.

### 6. Draft taps are unforgiving and silent
- A tap that misses a card (4 px gutters at phone scale) keeps the previous cursor and **drafts the highlighted card anyway** (`cardIndexAt` miss → `cur` unchanged → `clicked` → `takeCard(cur)`); no confirm, no undo.
- A tap on a taken card does nothing, with zero feedback — indistinguishable from the game hanging (`tort-d-05-continue3.png`: three taps later, still "pick 17 of 18").
- **Fix direction:** ignore clicks with no card hit; flash/shake on a dead tap; two-tap confirm at phone widths.

### 7. Hub CONTINUE is modal without saying so
Each press first marks one unread mail read; with the two seed messages it takes **three** presses before MD1 actually plays, and at phone scale nothing visibly changes. Evidence: `tort-a-06` (Inbox (2)) → two CONTINUE taps → `tort-a-10-hub-after-round.png` still MD1/7 0-0-0, both mails merely dimmed. Also the button keeps its green "pulse" state even when a press will only read mail. **Fix direction:** label it ("READ MAIL" / "PLAY MD1"), or open the unread mail *and* keep CONTINUE meaning "play".

### 8. Results screen visual collisions
`tort-g-05-results.png`: podium sprites are drawn over the stat lines ("Shots 7 — 6" hidden behind the cheering #19 sprite); the frozen match (players, "90' FINAL MINUTES", commentary feed) bleeds through the 72 % veil; the footer "Enter — again  Esc — menu" overlaps commentary text; two empty podium slabs float on the pitch. Layout was authored for lines ≤ 4 *or* a podium, not both plus a busy backdrop.

### 9. Keyboard-only copy on a touch device
Menu: "pick a game · ← → and Enter · Esc leaves · M mutes" (`tort-h-01-arcade-menu.png`); results footer: "Enter — again  Esc — menu". Neither mentions tapping; there is no on-screen close/back button at all, which combined with defect 1 means the only touch route out of the arcade is the fatal scrim tap.

### 10. Ghost page text bleeds through the letterbox
The intro copy above the canvas stays half-legible through the 86 % scrim in every shot (`tort-a-01-load.png` top) — reads as a rendering bug and invites the deadly stray tap (defect 1). Countdown digit also lands on the CAREER button text mid-boot (`tort-a-01-load.png`).

---

## SEV-3 — polish / code-level (verified by code read; screens cited where visible)

11. **Ragged columns from padEnd + proportional font** — league table GF/GA/PTS zigzag per row and don't sit under headers (`tort-a-09-hub-table.png`); squad pane VER/LAST/AVG/VALUE labels offset from their fixed-x data columns (`tort-a-07-hub-squad.png`).
12. **Parallel colour — the shop's own mechanic — is invisible on phone:** the version dot is r=5.5 canvas px (≈ 2 device px) and the coloured frame ≈ 1 device px (`tort-a-03-draft-early.png`); card stat line "SHO xx · DEF xx" runs flush against the card borders.
13. **AudioContext warning flood:** every SFX call before the first user gesture retries `resume()` and logs "The AudioContext was not allowed to start" — 124–266 warnings per session (all CDP console captures). Gate `tone()` until unlocked.
14. **Game timers leak across instances:** `setTimeoutSafe` only pushes to `timers[]`; nothing clears them. Esc during the PENALTIES sequence leaves `endMatch` timeouts alive that later call `env.over()` from a dead instance — phantom results screen over the menu, and in career a stale `applyResult`.
15. **Inbox tap drift:** hit test divides by 64 but rows are drawn on a 66 px pitch — taps on lower messages toggle the wrong one; taps in the empty pane below index into off-screen inbox entries.
16. **WATCH hit box misaligned and ephemeral:** hit zone `ry±16` vs drawn `ry-18..ry+12` (misses the top 2 px, extends 4 px below); the button exists only on the *current* round's row, so it silently vanishes/moves after CONTINUE — two paced sessions missed it entirely (`tort-a-12`–`a-16` never left the fixtures pane).
17. **Prescribed harness gap:** under `--virtual-time-budget` this Chrome starves requestAnimationFrame — one frame renders regardless of budget (five byte-similar PNGs). Even with defect 3 fixed, budget screenshots of this page can only ever verify the first frame; real-time capture (CDP) or a virtual-time-friendly step mode is needed.

---

## What held up under torture
Career loop runs end-to-end (7 fixtures, standings, promotion "⬆ PROMOTED!", division names, coins, per-player ratings/values, top-scorer note, Season 2 rollover) — `tort-f-01`, `tort-f-03`. Match renderer is the best screen: score/clock, momentum bar, surging chips, GOOOAL banner, commentary feed all fit 960×600 with no clipping (`tort-g-03-match-mid.png`). Draft grid itself fits without scrolling; trophies/bests persist via localStorage (menu shows "🏆 best 385" after a won match). Zero console errors in every run.

## Test-environment note
Port 9333 turned out to be contested by a second headless Chrome (another crew); its driver attached to the first sessions and injected ArrowRight/Enter events (`EV-KEY` logs in `tort-cdp2/3-console.txt`). Runs `tort-b-*` are contaminated and were discarded; `tort-d/f/g/h` and the c-series were re-taken on a private port (9741) with clean consoles. Layout evidence in `tort-a-*` is unaffected (geometry doesn't depend on input).
