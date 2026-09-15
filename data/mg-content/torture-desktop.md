# Torture dossier — Card Manager career demo, desktop 1920×1080

Target: `manager-demo.html` (standalone page, scratchpad copy the owner plays), viewport 1920×1080,
headless Chrome, `?minigame=manager&demo=1`, virtual-time budgets 6000/15000/30000/60000/90000 ms.

Evidence PNGs live in the session scratchpad
(`…/scratchpad/tort-desktop-*.png`, `…/scratchpad/probe-*.png`, `…/scratchpad/raf-probe.png`).
`tort-desktop-*` are the shipped page exactly as prescribed. Because of defects #1 and #2 those five
captures are all the same frame, so deeper screens were captured through `tort-probe.html` — a
byte-identical copy of the page plus an **appended** test driver (rAF pumped from virtual timers,
seeded `Math.random`, synthetic keyboard taps through the real input path). The product file was not
modified. Console-error grep across every run: **0 JS errors** (only the expected pre-gesture
AudioContext autoplay notices — the auto-open whistle guarantees one on load).

---

## SEV-1 — blockers

### 1. The attract demo is dead: the page double-opens the arcade and the second open kills demo mode
- Screen: opening flow. Evidence: `tort-desktop-6000.png` … `tort-desktop-90000.png` — **all five
  budgets show the identical frame**: mode-select screen with a frozen countdown "4".
- Mechanism: the framework's own `?minigame` handler opens `manager` **in demo mode** at 600 ms
  (framework `DOMContentLoaded` block). The page then has a second inline script that calls
  `MiniGames.open('manager')` at 700 ms **without the demo flag** (last `<script>` of the file).
  `openArcade(id, demo)` does `startGame(GAMES[i], !!demo)` → `demoMode=false`, `countT=3.2`.
  A demo start uses `countT=0.01` (could only ever flash "1"); a "4" on screen is proof of the
  non-demo restart.
- Result in a real browser: mode screen → 3-2-1-GO countdown → a **static mode-select screen that
  never advances**, forever. `inst.demo()` is only consulted when `demoMode` is true. The bar's
  attract loop is a still frame.
- Fix direction (for the fixing crew): delete the page's second auto-open, or pass the demo flag
  through it; the framework auto-open already does the whole job.

### 2. The prescribed screenshot harness cannot see past the first half-second of this page
- Evidence: `raf-probe.png` — under `--virtual-time-budget=15000`, `performance.now()` reaches
  15 046 ms but **rAF delivers only 61 frames spanning 500 ms**, then stops (page never visible in
  headless screenshot mode; `--run-all-compositor-stages-before-draw` does not change it —
  `tort-desktop-15000-comp.png` identical). Timers fast-forward; the rAF-driven game loop does not.
- Consequence: all five required budgets capture the same near-first frame. Any crew "verifying"
  this standalone page with plain virtual-time screenshots is verifying nothing after the opening —
  which is exactly how defect #1 shipped unseen. Verification of this page needs a rAF pump (as the
  probe does) or a live browser.

---

## SEV-2 — high

### 3. Results overlay prints its text through its own podium and through the screen underneath
- Screens: career final review and vs-CPU full time. Evidence: `probe-attract-60000.png`,
  `probe-attract-90000.png`, `probe-vscpu-80000.png`.
- The framework `drawResults` puts `lines` at y=300…378 while podium characters occupy ~322…380
  (`base 470 − h 86 − 4`, head at −58): "Career coins: 1440" and "Three seasons of the pyramid…"
  are physically overprinted by cheering characters; in vs-CPU the podium blocks sit on the
  commentary feed and the "Enter — again" prompt sits inside it. The 72 %-alpha scrim also leaves
  the busy hub inbox / match pitch loudly readable behind the headline. The career finale — the
  payoff screen — is the messiest screen in the game.

### 4. Win on penalties reports "No goals. A tactical masterclass, apparently." under a 2–1 scoreline
- Screen: vs-CPU results. Evidence: `probe-vscpu-80000.png` — "You 2 — 1 Suárez FC" directly above
  "No goals. A tactical masterclass, apparently.".
- Mechanism: the shootout `pk()` increments `mm.score` but never `mm.scorers`, so the
  man-of-the-match line takes the goalless branch. Self-contradicting owner-facing text; shots line
  ignores pens too.

### 5. Even with #1 fixed, attract mode never shows the animated match and never loops
- Code-verified against the probe run of the true demo path (`probe-attract-*`): demo always picks
  CAREER (`modeSel` stays 0), career `hubContinue` always plays rounds via `instantSim` (the WATCH
  path needs a pointer click `demo()` never makes), and the framework results state never consults
  `demo()`, so the attract run parks on the career review forever
  (`probe-attract-60000.png` = `probe-attract-90000.png`).
- The demo reel is: draft → inbox → results-freeze. The flagship animated match, the Squad/Fixtures/
  Table panes and the hero cast never appear. For "better-looking than Football Manager in the bar",
  the best screens are the ones the attract mode skips.

---

## SEV-3 — medium

### 6. Match screen: attacker labels pile up illegibly in the centre circle
- Evidence: `probe-vscpu-30000.png` (26'), `probe-vscpu-50000.png` (67') — "Salah/Ronaldo/Yamal/Son/
  Lautaro" overprint each other and the ball every match.
- Mechanism: blue ATT lane x=470 vs red ATT lane x=W−470=490 — 20 px apart at centre, before surge
  shifts (±44) cross them through each other. MID lanes (360/600) add to the cluster. The 10 px
  chip names (≈11 device px at this viewport) make the pileup unreadable.

### 7. Hub tables can't columnize: headers drift ~200 px off their data, numbers ragged row-to-row
- Squad pane: header "POS EFF PLAYER VER LAST AVG VALUE" is drawn with `padEnd` spacing in a
  proportional font while LAST/AVG/VALUE data sit at fixed x offsets — "VER" lands ≈180 px left of
  the parallel dot column, "VALUE" ≈200 px left of the prices (`probe-hub-down1.png`), so the dot
  column has no visible meaning.
- Table pane: GF/GA/PTS built with `padEnd` per-row — numbers wander ±30 px between rows
  (`probe-hub-down3.png`). `padEnd` cannot align columns in `ui-rounded`; needs fixed x positions
  (as LAST/AVG/VALUE already do) or a monospace font.

### 8. The same card wears two different numbers on different screens, unexplained
- Draft card face prints `eff()` (parallel-blended: Ronaldo white = **76**, `probe-attract-6000.png`)
  while THE TEAMS and the Squad sort/print `ovr` (**88**, `probe-lineup-16600.png`). The lineup
  screen shows no parallel at all, so nothing explains the jump. Pick one number per context and
  label it, or show both ("88 · white 76").

### 9. Career lineup CTA lies: "TAP — kick off" opens the inbox
- `probe-lineup-16600.png` shows the pulsing "TAP — kick off"; in career mode the tap runs
  `newCareer()` → hub (no match). Text is hardcoded for the one-match modes.

### 10. Career throws away the drafted rival squad
- The whole snake draft plays out against "SUÁREZ FC IS CHOOSING…" — then career fixtures all use
  `cpuSquadFor(tier)` generated squads; `picks[1]` from the draft is never used (only the WATCH
  path overwrites it per fixture). Half the draft's tension (denying the rival cards) is fake in
  the mode the demo leads with.

### 11. Mode screen: any click anywhere instantly commits to a mode — and pointer users can never leave
- `update('mode')`: a single `clicked` both sets `modeSel` from a y-band (bands cover the whole
  canvas — title and footer included) **and** starts the draft in the same frame. A stray click on
  the title starts a 3-season CAREER. Exit from any screen is Esc-only (framework); there is no
  on-screen back/quit/mute control anywhere. Desktop: a misclick costs a reload or Esc; on the
  owner's phone (this page's stated audience) it is a hard trap — no Esc, no M, no way out but
  reloading the page.

---

## SEV-4 — low / polish

### 12. Inbox bodies hard-truncate mid-word at 88 chars, no ellipsis
- "Salah finds the", "Sala" — `probe-attract-30000.png` (`m.body.slice(0, 88)`).

### 13. Duplicate commentary beats read like a stutter
- "GOLAZO from Yamal, top corner.  GOLAZO from Yamal, top corner." / "Son finds the net.  Son finds
  the net." — one fixed string per goal (`probe-attract-15000.png`, `probe-attract-30000.png`).

### 14. Career review truncates division names to their first word
- "S1 The: P5 (2-3-2)" — `DIVISIONS[div].split(' ')[0]` turns "The Cardship" into "The"
  (`probe-attract-60000.png`).

### 15. WATCH THIS ONE INSTEAD is a 229×34 device-px target
- Under the 40 px touch minimum (hit box does match the drawing) — `probe-hub-down2.png`.

### 16. Inbox tap-to-read hit grid uses 64 px pitch against 66 px drawn rows
- Drift reaches 12 px by row 7; taps near a card's edge mark the neighbour read
  (`updateHub` vs `drawHub`).

### 17. Career podium renders rival clubs as identical red-shirt Gibson clones
- Club names are first-worded ("Real", "Diego") then looked up in CAST and fall back to the Gibson
  body — three near-identical figures, your club also labelled "Gibson" (`probe-attract-60000.png`).

### 18. Page intro ghosts through the 86 %-alpha scrim above the canvas at 1080p
- "CARD MANAGER — early demo" floats half-legible over the letterbox in every capture. Either an
  opaque scrim or hide the intro when the arcade opens.

### 19. Two drafted keepers both stand inside the same goal box
- Alisson + Grandpa stacked in the six-yard box all match (`probe-vscpu-30000.png`) — the
  "every pick plays" rule reads as a rendering bug to a viewer.

### 20. Canvas caps at `min(96vw, 1100px)` — 57 % of a 1920 screen
- Letterboxing is sane and centred; noting only that the bar-TV presence is smaller than the screen
  allows. Design choice, not a defect.

---

## What passed
- Zero JS console errors across 14 runs, including three full careers and a 90-minute match with
  penalties. The framework's crash-guard never fired.
- Hub (FM shell) at this viewport: strong. Header, sidebar, inbox cards, CONTINUE pulse, xG/shots/
  possession stat lines — legible, well-spaced, honest empty space (`probe-attract-15000.png`).
- Draft grid: 24 cards fit with margin, parallel frames and dots read at a glance, taken-card
  dimming works, squad strips legible (`probe-attract-6000.png`).
- All primary touch targets except WATCH (#15) are ≥40 device px.
- No horizontal overflow, no clipped canvas, no stale-frame artifacts at any budget.
