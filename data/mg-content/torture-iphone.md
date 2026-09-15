# Torture dossier — Card Manager demo on iPhone (390×844)

Target: `/private/tmp/claude-1386487772/-Users-finkj-Desktop-GibsonStore/13e71ce7-fac0-4585-97bf-3526f828a8ce/scratchpad/manager-demo.html?minigame=manager&demo=1`
Tester viewport: 390×844 ("iphone"). Line numbers refer to `manager-demo.html` as of 2026-08-29 04:02.
Evidence PNGs live in the scratchpad (`tort-iphone-*.png`, `tort-iphone-rt-*.png`, `tort-career-*.png`, `tort-vscpu-*.png`).

Console: **0 JS errors / 0 exceptions** in all runs (virtual-time ×5, real-time CDP ×3).
Only noise is the `AudioContext ... user gesture` autoplay warning, repeated dozens of
times per open (see D17).

---

## Severity 1 — blockers

### D1. The demo never plays: the trailing auto-open stomps `?demo=1`
The framework's own loader opens the game in attract mode at t=600 ms
(`openArcade(g, q.get('demo')==='1')`, ~line 741). The extra script at the bottom of
the file (~line 1874) then runs `MiniGames.open('manager')` at t=700 ms **without the
demo flag**, which calls `startGame(def, false)` — a fresh instance, `demoMode=false`,
a 3.2 s countdown, and a mode-select screen that waits forever for input that never
comes.
**Every** mandated screenshot at budgets 6000/15000/30000/60000/90000
(`tort-iphone-6000..90000.png`) and every real-time capture at 6/15/30/60/90 s
(`tort-iphone-rt-6s..90s.png`) shows the identical frozen mode-select. Draft, hub,
match and results are unreachable in attract mode; headless verification of this game
is blind.
Second, independent layer: the framework merges `inst.demo()` input only while
`state === 'play'` (~line 397), so even with the stomp fixed the attract run dies at
the first framework results screen (career review) waiting for a real Enter.
Third layer: `demo()` drafts one card per frame (~line 1851) — at 60 fps the whole
18-pick draft would be a sub-second blur — and it never presses WATCH, so the attract
would never show the animated match, the game's showcase scene.

### D2. No `<meta name="viewport">` — real iPhones get the 980 px legacy layout
The file's head is `<title>` + one `<style>` block only. On iPhone Safari (and under
CDP `mobile:true` emulation, which is how `tort-career-*.png` / `tort-vscpu-*.png`
were captured) the layout viewport is 980 px, the canvas lays out at 946 px and the
whole page is displayed at 390/980 ≈ 0.40×. Net logical→physical scale ≈ 0.39, so:
- hub body text 12–15 px logical → **4.7–5.9 pt** physical
- pitch name labels `bold 10px` (~line 1777) → **3.9 pt**
- card name/stat lines 13–16 px → **5.1–6.2 pt**
Apple's floor for body text is ~11 pt. The entire FM hub, draft card text, commentary
feed and match clock are illegible on the device the owner actually uses. (At a true
390 px viewport — verified with an iframe probe — the canvas is 356×225 CSS px, and
the same fonts land at 0.365×, i.e. slightly worse.) Fix is one meta tag plus a
mobile-scale pass; without it every other legibility finding below is moot.

### D3. Touch targets miss every guideline (and the task's own 40 device-px bar at dpr 1)
Measured at the real phone scale (0.39×; pt = CSS px on device):
| Control | logical | on-device | verdict |
|---|---|---|---|
| CONTINUE (hub heartbeat, ~line 1069) | 184×46 | **72×18 pt** | fails 44 pt; 36 px at dpr 1 < 40 |
| WATCH THIS ONE INSTEAD (~line 1210) | 200×30 | **78×12 pt** | worst in game |
| Sidebar rows (Inbox/Squad/Fixtures/Table) | 172×46 | **67×18 pt** | fails |
| Mode buttons | 560×78 | **218×30 pt** | height fails 44 pt |
| Draft cards | 100×140, 11 px gaps | **39×55 pt**, 4.3 pt gaps | width borderline, gaps invite mis-taps |
The single most-pressed button in the career (CONTINUE) is 18 pt tall.

### D4. Career-loss traps surround the tiny canvas
The canvas occupies ~27 % of the screen height; the other ~73 % is scrim, and any
tap on scrim **closes the arcade instantly** (`scrim pointerdown → close()`, ~line 695).
The career object lives only in the game instance: re-entering the game from the
menu or launcher calls `def.create(env)` again (`startGame`, ~line 359) — career gone,
no confirmation, no save (`localStorage` persists trophies/bests but never the
career). Same wipe via Esc-to-menu during play (~line 380) and via the results
screen's only touch action (tap → menu). One stray thumb on the huge dead area ends
an FM save. Compound of D3's tiny targets and the letterboxing: on a phone this
*will* happen constantly.

---

## Severity 2 — major

### D5. Results screen is a text pile-up (`tort-vscpu-8-results.png`)
The lines list (y=300+, ~line 633) collides with the podium (base 470, ~line 641):
"Shots 6 — 5" and the FC-style disclaimer render *through* the podium blocks and the
winner characters; the footer "Enter — again  Esc — menu" overlaps the still-visible
match commentary feed behind the 0.72-alpha overlay. With 4 result lines + ranks the
screen is unreadable even on desktop.

### D6. Penalty shootout contradicts itself (`tort-vscpu-8-results.png`)
Pens (~line 1573) increment `mm.score` but not `mm.scorers`, so a 0-0 match decided
on penalties shows the header "You 1 — 2 Suárez FC" directly above "**No goals. A
tactical masterclass, apparently.**" — and no man-of-the-match. Penalty scorers also
never reach `goalsBy`/ratings in career.

### D7. Watched career matches lose their own story
`endMatch()` (~line 1444) calls `applyResult(fx, score0, score1, beats)` with **no
`res` argument**, so `applyResult` (~line 990) fabricates one: `scorers: []`, xG =
goals×0.8, made-up shots/possession. Result: the inbox FT report for the one match
you actually watched carries invented stats ("xG 0.80–0.00 · shots 4–3" for the 1-0
in `tort-career-10-hub-inbox.png`), your scorers get no rating bump and no
`goalsBy` credit — instant-simmed matches are tracked *better* than watched ones.
Backwards incentive for the mode's flagship feature.

### D8. Duplicate players across teams; stacked keepers in one goal
`cpuSquadFor()` (~line 900) samples POOL with no exclusion of `picks[0]`: in career
match 1, **De Paul and Rüdiger play for both sides** (`tort-career-8-match-mid.png`).
And nothing caps GKs at one: CPU squads with two keepers draw both discs stacked
inside the same goal box (Martínez + ter Steg, `tort-career-8`; ter Steg + Courtois,
`tort-vscpu-4-lineup.png`) because the formation lane pins every GK to the goal
(~line 1762). Breaks the card-shop fiction (you drafted *the* card) and looks broken.

### D9. Any tap fires — mode screen and draft have no miss-safety
- Mode screen (~line 1483): `input.clicked` both picks a band (`py<300/404`) **and
  immediately calls `startDraft()`** — tapping the title, the footer, or any blank
  spot instantly starts CAREER / VS CPU / VS FRIEND. No confirm, no second tap.
- Draft (~line 1507): a tap that hits no card leaves `cur` unchanged and the
  `clicked` branch drafts the **currently highlighted card**. A finger that misses
  the 4 pt gap grid spends a pick.

### D10. No touch path to "play again"
Results accepts Enter/Space to rematch, tap only exits to menu (~line 393). On the
phone there is literally no way to run it back — and via D4 the menu → game path
wipes a career. The lineup screen proves the team knows better: it says
"TAP — kick off".

### D11. The 3-2-1-GO countdown plays over a menu
`startGame` always enters `state='count'` (3.2 s) even though this game opens on its
own mode-select menu; the giant numeral sits exactly on the CAREER button (all five
mandated PNGs, `tort-iphone-*.png`). Countdown-into-menu is wrong sequencing; it also
swallows taps for 3.2 s on every open and every rematch.

---

## Severity 3 — moderate / polish

### D12. `setTimeoutSafe` never cancels anything
`timers` (~line 1601) is push-only; the comment "dies with the game instance" is
false. Esc or scrim-close during the FT/pens window still fires `endMatch` 0.9–1.4 s
later — yanking a closed arcade or the menu into a results screen.

### D13. Table columns are ragged; squad header points at the wrong columns
Squad pane header (~line 1168) is one proportional-font `padEnd` string while data
uses absolute x offsets (`px2+322/356/408/458`): VER/LAST/AVG/VALUE labels sit ~100 px
left of their columns (`tort-career-11-hub-squad-after.png`). League table (~line
1230) uses `padEnd` in a proportional font: GF/GA/PTS wander per club-name width
(`tort-career-6-hub-table.png`).

### D14. Hit-boxes drift from their pixels in the hub
Inbox tap divisor 64 vs drawn 66 pitch (~line 1101 vs 1150); sidebar hit assumes rows
start at y, highlight draws from y−6 (top 6 px selects the row above); WATCH hit
y±16 vs drawn y−18..+12. All small, all in the pane where taps are already 12–18 pt.

### D15. Pitch labels collide into hash at kickoff/cluster
`bold 10px`, name sliced to 8 chars, no collision avoidance: the centre-circle
cluster renders "Mbappé/Maradona/Yamal/Messi" as an unreadable mash
(`tort-vscpu-4-lineup.png`, `tort-career-8-match-mid.png`).

### D16. Inbox caps at 7 with no scroll
`career.inbox.slice(0, 7)` (~line 1148): season 1's FT reports scroll off and are
gone; three seasons of history are unreadable in-app.

### D17. Autoplay audio: console spam, inaudible open
Auto-open fires whistle/count tones before any gesture → dozens of AudioContext
warnings per load (measured in `tort-console-*.txt`); all sound is silently dead
until the first tap, so the opening countdown is mute on every phone load.

---

## Harness caveats (not page bugs — but they blind the mandated method)

- **macOS headless Chrome clamps the window to ≥500 px wide.** The mandated
  `--window-size=390,844 --screenshot` renders a 500 px layout cropped to 390:
  the canvas's right ~110 px and the intro headline are cut off in
  `tort-iphone-*.png`. An iframe probe at a true 390 px viewport shows the page
  lays out fine (canvas 356×225 centred, `scrollWidth` 390). Don't file the
  "canvas overflows right" symptom from those PNGs as a page defect.
- **`--virtual-time-budget` starves rAF after ~20 frames**: budgets 6 s→90 s all
  captured the same frame (countdown frozen at "3"/"4"). The budget ladder cannot
  show later screens of any rAF canvas game. Real screens here were captured with
  a CDP driver in real time (`scratchpad/tort-drive.py`, port 9412, since killed);
  recommend that method for re-verification once D1 is fixed.
- First batch shared a Chrome singleton with a concurrent crew's instance
  (stderr crosstalk); re-runs used isolated `--user-data-dir`s.

## What's genuinely good (so it survives the fixes)
Zero exceptions across every run; the mode/draft/fixtures/inbox layouts read well at
desktop scale; the parallel frames on draft cards match the shop's ladder
(white→black); watched career matches do return to the hub instead of dumping to
results; CONTINUE's unread-first rhythm is proper FM.
