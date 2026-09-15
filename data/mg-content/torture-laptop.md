# Torture dossier — Card Manager demo, laptop viewport (1280×800)

Target: `/private/tmp/claude-1386487772/-Users-finkj-Desktop-GibsonStore/13e71ce7-fac0-4585-97bf-3526f828a8ce/scratchpad/manager-demo.html`
Method: headless Chrome 151.0.7922.174, `--window-size=1280,800`, `--virtual-time-budget` ∈ {6000, 15000, 30000, 60000, 90000}, `?minigame=manager&demo=1`. Every PNG was read.
All screenshots live in the scratchpad dir above (`tort-*.png`). Nothing in the target was edited; deep screens were reached with instrumented **copies** (`tort-diag-*.html`) — see "Method notes" for exactly what each copy changes and why it was necessary.

**Console:** 0 page-level JS errors across all ~20 runs (verified twice: default stderr grep, then `--enable-logging=stderr` plus an injected `window.onerror` reporter). All stderr lines are Chrome-internal noise (task_policy_set, SharedImageManager, allocator).

---

## S1 — blockers

### S1-1. Attract mode is dead on arrival: a second auto-open without the demo flag kills it
- Screen: everything after mode select. PNGs: `tort-laptop-6000/15000/30000/60000/90000.png` — **all five budgets, 6 s to 90 s, show the identical frozen frame**: mode select with a countdown "4" stamped over the CAREER button.
- Cause (code-level, verified): the framework's own DOMContentLoaded handler honours the URL (`openArcade('manager', demo=true)` at 600 ms), but the page's inline script at the bottom of manager-demo.html fires 100 ms later: `setTimeout(function () { window.MiniGames.open('manager'); }, 700)` — **no demo argument** → `startGame(def, false)`. The attract run is torn down, the game restarts in interactive mode (3.2 s countdown, `demoMode=false`), and the demo driver is never consulted again. The game then sits on mode select waiting for input forever.
- Proof: `tort-diag-A.html` (identical file, 700 ms call removed) progresses — `tort-diagA-6000.png` shows the draft grid.
- In a real browser the `?demo=1` contract fails the same way (100 ms of attract, then a countdown into a menu that waits forever). The phone flow without query params survives only because the 600 ms handler no-ops there.

### S1-2. The verification recipe itself is blind: `--virtual-time-budget` does not pump rAF on this Chrome
- Measured: an injected heartbeat (`tort-diag-B.html`, log every 1 s + rAF counter) under a 30 s budget printed 30 heartbeats but **rafFrames=4**. Virtual time fast-forwards timers instantly; the rAF loop gets ~4 real frames before the screenshot. Every screenshot of this canvas — any budget — captures < 0.1 s of arcade time.
- This also explains S1-1's frozen "4": the 700 ms restart timer fires instantly in virtual time, then only ~2 frames of the 3.2 s countdown ever run.
- Consequence: any crew "verifying" a rAF-driven demo with this exact recipe is seeing frame ~4 and nothing else. Workaround used for the rest of this dossier: shim `requestAnimationFrame` onto `setTimeout(16)` so virtual time genuinely drives the loop (`tort-diag-C.html` and later).

---

## S2 — major, player-visible

### S2-1. Career-end results screen is a collision pile-up (the payoff screen of the flagship mode)
- Screen: results after season 3. PNGs: `tort-diagC-60000.png`, `tort-diagC-90000.png`, `tort-diagF-vscpu-70000.png` (three independent runs, same wreckage).
- Defects, all visible at once:
  - The summary line and podium overlap: "Three seas⟨figure⟩ons of the pyramid — the full career is⟨figure⟩ill growing." — podium characters are drawn straight through two lines of text; "Career c⟨winner⟩ns: 1580" is half-hidden behind the champion figure.
  - Division names are truncated to their first word: **"S1 The: P4 (3-1-3)"**, **"S2 League: P4"**, "S2 Premier: P6" — `DIVISIONS[h.div].split(' ')[0]` turns "The Cardship" into "The" and "League Two-and-a-Half" into "League". Reads as nonsense.
  - The 0.72-alpha scrim leaves the busy hub inbox bleeding through behind the headline.
- Root cause is shared framework/game: `drawResults` draws `lines` at y=300–378 and podium figures whose heads reach y≈310 — any game that passes 4 lines **and** ranks collides by construction; the manager game passes exactly that.

### S2-2. Watched career match shows the wrong opponent on the scoreboard
- Screen: live match entered via Fixtures → "WATCH THIS ONE INSTEAD". PNGs: `tort-diagF-watch-16000/30000/58000.png`, `tort-diagG-watchht-37300.png`, `tort-diagG-watchgoal-25000.png` — every one says **"YOU — SUÁREZ FC"** even when the fixture is vs Real Haaland / Phoenix Town / Kane United.
- Code: the scoreboard name is hardcoded `vsCpu ? 'SUÁREZ FC' : 'RED'` (line ~1805); `careerFixtureLive.vs` is ignored. The FT inbox report then names the real club — the game contradicts itself about who you just played.

### S2-3. Live match: 4–6 player name labels pile up illegibly at the centre line, every match
- PNGs: `tort-diagF-watch-30000.png` ("Haaland/Pulisic/Neymar/Neymar/Lautaro/Griezman" stacked at midfield, several half-hidden), `tort-diagG-watchht-37300.png` (Kane/Yamal/Pulisic/Lautaro/Son), `tort-diagG-watchgoal-25000.png` (Gibson/Messi/Ellis/Neymar/Pulisic — Messi and Neymar unreadable behind other labels).
- Both formations place their attacking ranks on the halfway line, so the two teams' forwards occupy the same spots. 100% reproduction across three independent matches.
- Related: same-position players stack in identical slots — `tort-diagF-watch-58000.png` shows **three** red players (Courtois, Phoenix, Alisson) crammed inside the goal area; `tort-diagF-watch-16000.png` shows blue with two keepers stacked in its own box. CPU squads aren't position-balanced and the renderer has one slot per position class.

### S2-4. Attract mode never shows the good stuff
- The demo auto-enters CAREER on its first mode frame (demo `pressed('enter')` every frame, `modeSel` stuck at 0), and career weeks are **instant sims** — so the attract loop is: draft, then minutes of reading an inbox. Observed across `tort-diagC-*.png`: never the live match engine, never Squad/Fixtures/Table (hubContinue resets the pane — see S3-4), never VS CPU / VS FRIEND.
- The attract run also never loops: when the career ends, the framework's results state only listens to real input (demo output is merged in `play` only), so the demo parks on the results screen forever (`tort-diagC-60000/90000.png`). For a bar attract mode: no football is ever seen, and it ends on a frozen screen.
- (Also why my injected mode-click at 1200 ms couldn't reach VS CPU: the demo had already left mode select on frame 1 — `tort-diagF-vscpu-*.png` landed in career.)

---

## S3 — moderate

### S3-1. Squad pane: headers misaligned with columns by up to ~200 px
- PNG: `tort-diagH-squad.png`. Header "POS EFF PLAYER VER LAST AVG VALUE" is one `padEnd` string in a **proportional** font while the data columns are drawn at fixed pixel offsets: 'VER' header sits ~190 px left of the VER dots, 'VALUE' ~200 px left of the values. The name column is ragged too — GK rows ("GK 82 Alisson") start visibly left of ATT/MID rows because `padEnd` spaces don't align in a proportional font.

### S3-2. Table pane: GF/GA/PTS numbers are ragged per row
- PNG: `tort-diagH3-table.png`. Same `padEnd` disease: each row's numbers start wherever the club name happens to end ("Suárez FC 7 5 8" vs "Diego Dynamo  6 4 8" land ~30 px apart); the # / GF / GA / PTS headers float over nothing.

### S3-3. Results podium draws the wrong characters
- PNGs: `tort-diagF-vscpu-70000.png` — league champion "Phoenix · 15" is drawn as **Phoenix the dog** (club "Phoenix Town" → `name.split(' ')[0]` → collides with the dog in CAST); "Kane · 11" (Kane United) is drawn as Kane the player. `tort-diagC-90000.png` — "Diego · 13" and "Zizou · 13" both fall back to identical Gibson clones, so the podium is three near-identical red-shirt-19 figures. Club-vs-player identity is scrambled on the final screen.

### S3-4. CONTINUE force-resets the hub pane to Inbox
- Code: both branches of `hubContinue()` set `career.pane = 0`. A player reading Squad/Fixtures/Table who presses Enter or CONTINUE is yanked back to Inbox every time. Measured side effect: 11 of 13 injected pane-clicks in this dossier were reverted within one continue tick — the same will happen to a human skimming the table between weeks.

### S3-5. Match/inbox copy is repetitive and context-blind
- "They nicked one back." is attached to an opponent's **only** goal — three identical usages under three 0–1 losses in one inbox (`tort-diagC-15000.png`). Nobody was behind; nothing was nicked back.
- "Your team sweeps forward…" appears twice in the 4-line live feed in 3 of 3 matches captured (`tort-diagF-watch-30000.png`, `tort-diagG-watchht-37300.png`, `tort-diagG-watchgoal-25000.png`).
- Countdown-over-a-menu: the framework runs a "3…2…1…GO!" match countdown and then reveals… mode select (the manager's first screen is a menu). Every interactive session opens with a pointless countdown; the "4"/"1" also lands dead-centre on the CAREER button, obscuring its label (`tort-laptop-6000.png`, `tort-diagA-15000.png`).

## S4 — minor / polish

1. **Pitch labels truncated mid-name, no ellipsis** — `name.slice(0, 8)`: "Bellingh", "Griezman", "ter Steg" (`tort-diagF-watch-16000/58000.png`, `tort-diagG-watchht-37300.png`).
2. **Inbox bodies hard-cut at 88 chars mid-word** — "…and scores. The mach", "Words will be ha" (`tort-diagC-60000.png`, `tort-diagH2-table.png`).
3. **WATCH THIS ONE INSTEAD is the smallest touch target in the hub** — ~230×35 device px (30 canvas px tall), under the 40 px minimum, and it's the only door to the live match (`tort-diagH2-fixtures.png`). Sidebar/CONTINUE/mode buttons are all fine (≥53 px).
4. **Draft taken-card watermark near-illegible** — the pale "BLUE"/"RED" stamp on tan/brown parallel card faces has almost no contrast (Özil/Araújo/Bellingham cards in `tort-diagC-6000.png`).
5. **Page furniture at 1280×800** — the page h1 "CARD MANAGER — early demo" is half-clipped behind the arcade canvas top edge; the "🎮 Gibson Party" launcher pill pokes out from under the scrim bottom-right (z-index 800 < 900) reading "…n Party" (all `tort-laptop-*.png`).
6. **Results screen hint says "Enter — again · Esc — menu" only** — the phone player has neither; tap does work but is never mentioned.
7. Observation, owner's call: both teams can field the same card (De Bruyne, Rüdiger, Courtois on both sides in one match; two "Neymar" labels adjacent at midfield) — defensible for a card game, but it reads like a bug on the pitch.
8. Observation: after watching a career match there is no FT interstitial — 90 minutes of watching cuts straight to the hub; the result only appears as an inbox row.

## What's fine at this viewport
Letterboxing is sane (1100×687 canvas centred, no horizontal scroll). Mode buttons, draft grid, hub inbox, fixtures list, scoreboard, and feed are all comfortably readable at 1280×800; draft card stats are small but legible. Match clock/"FINAL MINUTES" tag, momentum bar, half-time feed line, GOLAZO/Kane-misses flavor, promotion/relegation flow, header record arithmetic (checked against inbox in four captures), and points math in the table all check out.

## Method notes (for whoever fixes S1)
- `tort-diag-A.html` = target minus the 700 ms `MiniGames.open('manager')` (proves S1-1).
- `tort-diag-B.html` = A + heartbeat logger (proves S1-2; 30 virtual s → 4 rAF frames).
- `tort-diag-C.html` = A + rAF→`setTimeout(16)` shim; with it, virtual budgets genuinely simulate gameplay (6 s→draft, 15 s→hub, 60 s→career end).
- `tort-diag-D/E/F/G/H.html` = C + synthetic PointerEvents on virtual timers to reach Squad/Table/Fixtures panes and the WATCH match. Pane clicks race the demo's 0.75 s CONTINUE tick (S3-4), hence the rapid-fire cadence.
- Keyboard injection does NOT work under demo mode (the demo's `pressed` override swallows real keys in hub state); clicks pass through — relevant to anyone else driving this demo headlessly.
