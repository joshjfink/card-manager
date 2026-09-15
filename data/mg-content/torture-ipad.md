# Torture dossier — Card Manager career demo, iPad 768×1024

Target: `manager-demo.html` (standalone scratchpad page), `?minigame=manager&demo=1`.
Method: the five prescribed virtual-time-budget captures (`tort-ipad-6000/15000/30000/60000/90000.png`,
768×1024 window), then — because those all freeze on the first frame (see H1/H2) — a CDP-driven pass
at **faithful iPad metrics** (`Emulation.setDeviceMetricsOverride 768×1024, DPR 2, mobile`) with real
time, synthetic taps and keys through the page's real input path (`ipad-*.png`, 1536×2048), plus a
phone-window pass (`cdp2-*.png`, 360×800) and geometry probes. The product file was never modified.

Evidence PNGs and console dumps live in the session scratchpad:
`…/scratchpad/tort-ipad-*.png`, `…/scratchpad/ipad-*.png`, `…/scratchpad/cdp-*.png`,
`…/scratchpad/cdp2-*.png`, `…/scratchpad/tort-raf-probe*.png`, `…/scratchpad/tort-cdp*-console.txt`.

**Console-error grep across every run: 0 JS errors, 0 exceptions.** The only console output is the
pre-gesture `AudioContext was not allowed to start` autoplay warning — but see #14: one 4-minute
session logged **320** of them.

---

## SEV-1 — blockers for "plays it on his phone/iPad"

### 1. No `<!doctype>`, no `<meta viewport>`, no `<meta charset>` — iPad Safari renders the whole demo in the legacy 980 px viewport
- Screen: every screen. Evidence: measured geometry under faithful iPad emulation —
  `innerWidth 980 × innerHeight 1307` on a 768×1024 device (run-3 `geom` log:
  canvas 946×593 CSS ⇒ **741×465 pt on screen, ×0.784 scale**). The file's head is
  `<title>` + `<style>` only — nothing else (lines 1–17).
- Consequence on iPad: everything ~21% smaller than designed, quirks-mode layout. On the **phone**
  the owner actually uses, the same 980 px fallback renders at ~0.4× — `cdp2-04-hub.png` /
  `cdp2-14-results.png` (360 px window ⇒ the phone rendering) show hub mail and card text far below
  readable size, touch targets far under 40 device px. No charset declaration also means the page's
  UTF-8 names (Suárez, Özil, ⚽) depend on Chrome/Safari sniffing — one wrong default and the cast
  goes mojibake.
- Fix direction: add `<!doctype html>`, `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width,initial-scale=1">` — the shop's own
  `gibson/web/static/index.html` has all three.

### 2. The attract demo is dead — the page's second auto-open kills demo mode
- Screen: opening flow. Evidence at true iPad metrics: `ipad-01-mode.png` (t=5 s) and
  `ipad-02-attract20s.png` (t=20 s) are **pixel-identical** mode-select screens; nothing ever moves
  with zero input. Same story in the prescribed captures: all five `tort-ipad-*.png` show one frozen
  frame (mode screen + stuck countdown "4").
- Mechanism: the framework's `?minigame=manager&demo=1` handler opens in demo mode at 600 ms;
  the page's last `<script>` calls `MiniGames.open('manager')` at 700 ms **without the demo flag**
  → `startGame(def, false)` recreates the instance, `demoMode=false`, real 3.2 s countdown, then the
  mode screen waits for input forever (`inst.demo()` is only consulted when `demoMode` is true).
- The bar's attract loop is a still frame, and the crew-mandated `?demo=1` verification URL verifies
  nothing. Fix direction: drop the page's second auto-open or forward the demo flag.

## SEV-2 — gameplay bugs the owner will hit with a finger

### 3. Tapping empty space drafts a card the player never touched
- Screen: draft. Evidence: `cdp-04-career-draft.png` → `cdp-05-gap-tap.png`: a tap in the **gutter
  between columns** (game 143,170 — no card there) drafted Militão (the highlighted card 0):
  header flips to "SUÁREZ FC IS CHOOSING…", strip reads "BLUE: Militão".
- Mechanism: draft input does `if (clicked) takeCard(cur)` unconditionally; a missed
  `cardIndexAt` leaves `cur` unchanged. Picks are irreversible — one stray thumb = wrong squad
  for the whole career.
- Fix direction: only take a card when the tap actually lands on one (`hit >= 0`).

### 4. Mode screen: any tap anywhere commits a mode instantly, and the tap zones don't match the buttons
- Screen: mode select (`ipad-01-mode.png`). Mechanism: `modeSel = py<300 ? 0 : py<404 ? 1 : 2`
  followed in the same frame by "clicked ⇒ start". Buttons are drawn at y 212–290 / 316–394 /
  420–498, but the zones cover the **entire canvas**: a tap on the title starts CAREER, a tap on the
  footer disclaimer (or anywhere in the bottom third) instantly launches **VS A FRIEND
  (pass the keyboard)** — on an iPad with no keyboard. No select-then-confirm, unlike the arcade
  menu (first tap selects, second launches).
- Fix direction: hit-test the actual button rects; tap on nothing = no commit.

### 5. A watched career match always calls the opponent "SUÁREZ FC"
- Screen: match (career "WATCH THIS ONE INSTEAD"). Evidence chain: `ipad-07-fixtures.png`
  (WATCH sits on **MD2 vs Kane United**) → `ipad-09-match-kick.png` / `ipad-13-match-end.png`
  (scoreboard: "YOU 0 — 3 **SUÁREZ FC**", 89') → `ipad-14-post-match.png` (hub records
  "MD2 vs Kane United 0–3"). The draw code uses the vsCpu labels unconditionally; the live fixture's
  club name is never shown. Commentary likewise says "Red are coming forward…" about a side labeled
  SUÁREZ FC. The career's central fantasy — beating *that week's* rival — is mislabeled every time.

### 6. One stray tap outside the canvas silently deletes the whole career
- Screen: any. Mechanism (code-verified in the framework block of this same file): the scrim closes
  the arcade on `pointerdown` outside the canvas; reopening runs `def.create(env)` again and the
  career lives only in that closure — no save, no confirm, no localStorage. At iPad portrait the
  canvas fills ~45% of the screen (see #13), so **most of the visible page is the kill zone**.
- Fix direction: confirm before closing mid-career, or persist the career like the framework already
  persists trophies/bests (`gs-mg-*` keys).

## SEV-3 — visual and copy defects at this size

### 7. Card stat line overflows every card
- Screen: draft. Evidence: `ipad-03z-cards.png` (2.2× clip) — "SHO 46 · DEF 88" runs edge-to-edge
  and past the rounded frame; on 3-digit values it collides with the neighbouring card's parallel
  ring. `drawCard` sets the stats font at `h*0.095` which is wider than `w` for the 100×140 grid.

### 8. The draft cursor is nearly invisible
- Screen: draft (`ipad-03-draft.png`, "pick 1 of 18"). The gold "hot" stroke reads as just another
  parallel-colour frame (every card already carries a 3 px coloured rim; gold/orange parallels are
  near-identical to the highlight). On the shop iPad you cannot tell which card Enter/tap-commit
  will take — which is what makes #3 so expensive.

### 9. Results screen is a collage — five layers overprint
- Screen: results (`ipad-17-results.png`, `ipad-18-results-b.png`). The lines block ("No goals. A
  tactical masterclass…", "Shots 3 — 5", the FC-style disclaimer) is drawn **through** the podium
  characters; the frozen match scene (player chips, labels, scoreboard "90' FINAL MINUTES") stays
  visible under a 0.72 scrim; the still-live commentary feed ("Vinícius misses!", "Griezmann buries
  the penalty.") interleaves with "Enter — again      Esc — menu". Bonus copy bug: the match ended
  **1–0 on a penalty shootout**, yet the results claim "No goals. A tactical masterclass,
  apparently." (shootout goals never reach `mm.scorers`, so no man-of-the-match either).
- Fix direction: darker scrim or stop drawing the match/feed under results; move the podium below
  the text block; count shootout goals in the summary.

### 10. Midfield pile-up: both attacking lanes collide at the centre circle
- Screen: match. Evidence: `ipad-09-match-kick.png`, `ipad-15-cpu-state.png` — ATT lanes sit at
  game x=470/490, so up to six chips and their 10 px labels overprint at the centre spot
  (Vinícius/Salah/Haaland/Griezmann/Pulisic unreadable, ball icon buried). Every attack surges the
  pile deeper. Spread the ATT lanes (e.g. 420/540) or fan same-position chips horizontally.

### 11. FM-hub tables misalign — `padEnd` columns in a proportional font
- Squad pane: `ipad-06z-squad.png` — headers VER/LAST/AVG/VALUE sit ~150–500 px left of the columns
  they label (dots, ratings, values are laid out with explicit x offsets; the header is one padded
  string). League table: `ipad-08-table.png` — GF/GA/PTS digits wobble left-right per row because
  each row's number position depends on the club-name width. Draw headers at the same x offsets as
  the data, or use a monospace font for the numeric columns.

### 12. Commentary history fades to invisible — including goals
- Screen: match. Evidence: `ipad-10z-comm.png` (2.2× clip): line 4 — "**Salah scores!**" — is at
  ~0.34 alpha on the dark pitch, effectively unreadable on iPad. The newest line is fine; anything
  older than two events is gone. Goals deserve to persist (colour, or keep goal lines at full
  alpha).

### 13. Portrait letterboxing wastes over half of the iPad screen; intro shows through the scrim
- Screen: every arcade screen (`ipad-01-mode.png` etc.): the 960×600 canvas occupies ~45% of the
  1024 pt height; the top band shows the page intro dimly through the scrim (reads like broken UI),
  the bottom ~500 device px are empty. Sane, never clipped, nothing unreachable — but Football
  Manager it is not. Touch targets that matter all pass 40 device px at DPR 2 (mode buttons ≈115 px,
  cards ≈150×213 px, CONTINUE ≈90 px, sidebar rows ≈70 px, WATCH button ≈60 px — the smallest).
- Copy is keyboard-first everywhere on a touch device: menu "← → and Enter · Esc leaves · M mutes"
  (`ipad-19-menu.png`), draft "arrows + Enter, or tap", results "Enter — again  Esc — menu" (tap can
  only exit, never replay), and a "pass the keyboard" mode one stray tap away (#4).

### 14. Cosmetics: the countdown flashes "4"; AudioContext warning spam
- Every non-demo start counts down from `countT=3.2`, so `Math.ceil` shows a giant "4" for the first
  0.2 s of every 3-2-1 — captured in all five `tort-ipad-*.png`. Framework-owned
  (minigames.js `startGame`/`drawCountdown`).
- `tone()`/`ac()` retry a suspended AudioContext on every SFX before the first gesture: 320
  identical autoplay warnings in one 4-minute session (`tort-cdp2-console.txt`). Harmless on
  device — first sounds are just silently dropped — but it buries real console signal.

---

## Harness findings (for the crews, not the owner)

- **H1 — Virtual-time budgets cannot see this page.** Chrome 151 headless delivers only ~63 rAF
  frames (~570 ms of animation) no matter the budget (`tort-raf-probe.png`: budget 10 000 → "frames
  62, span 517"; compositor flags change nothing). All five prescribed budget captures are the same
  frame. Real-time CDP driving (or a pumped-rAF probe page) is required for anything past the
  opening.
- **H2 — In CDP/remote-debugging mode this Chrome ignores `--window-size` for page targets** (got
  500×713 and 360×800 windows on successive launches) and binds the DevTools socket to `[::1]`
  only. Use `Emulation.setDeviceMetricsOverride` for the viewport (that is what makes the
  `ipad-*.png` set faithful: 768×1024 pt, DPR 2, mobile) and connect via IPv6 loopback.
- With #1 unfixed, mobile emulation reproduces the real-device 980 px fallback — useful for honest
  captures, but it means desktop-window screenshots of this page **overstate** its phone/iPad
  legibility.

## What already looks good at iPad size

Worth saying because it survived the torture: the FM hub shell (header strip, sidebar, inbox cards
with xG/shots/possession lines, CONTINUE pulse) is crisp and readable at DPR 2
(`ipad-05-hub.png`, `ipad-06-squad.png`); the mode screen and menu are clean; card faces (OVR,
position, name, parallel ring + dot) read beautifully in the draft grid (`ipad-03-draft.png`); the
match scoreboard/momentum bar and the newest commentary line are legible; fixtures pane with its
WATCH affordance is clear (`ipad-07-fixtures.png`); and across every run the arcade produced zero
JS errors.
