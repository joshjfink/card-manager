# CARD MANAGER — FM SHELL BLUEPRINT (pixel-exact, 960×600)

For the builder of `gibson/web/static/mg-manager.js`. This is the chrome layer
demanded by Owner Addendum 3 ("FOOTBALL MANAGER CARBON COPY") laid over the
governing FM addendum (`.mg-manager-fm.md`). Whimsy lives in content; this
chrome is straight-faced. Original branding only — "Card Manager", never SI's
name, logos or artwork.

FM26 premiere structure references (from `data/fm26_transcript.txt`) and how
they map here:

| FM26 (premiere) | Card Manager shell |
|---|---|
| Six top-level sections, each with an overview page | Left sidebar sections (Addendum 3 overrides top-nav placement), each with sub-tabs |
| "Secondary navigation inside the game" per section | Sub-tab bar at the top of the content pane |
| Portal → tiles → cards ("click a tile, get a card") | Inbox list → reading pane; TABLE group chips → pop-out group card |
| "We've got messages… that obviously is your inbox" as landing | INBOX is the default landing screen on load |
| League table as a pop-out card | ALL GROUPS chips open a mini-table overlay |
| Bookmarks / search bar | CUT (per fm.md §12) — nine sidebar items need no shortcuts |

Global laws restated: every activatable rect ≥48×48 preferred, **absolute
floor 40px** in either dimension; no text <12px; gold focus ring 3.5px, 1.05
pop; hover focuses, tap focuses, second tap activates; every waiting screen
says "tap to continue" (pulsing, v1 house style); Esc leaves the arcade
(framework); no screen requires a keyboard.

---

## 1. Canvas regions (the frame every chromed screen shares)

```
Canvas          (0,   0, 960, 600)
Header bar      (0,   0, 960,  52)
Sidebar         (0,  52, 176, 548)   full height under header
Content pane    (176, 52, 784, 488)
Bottom bar      (176,540, 784,  60)
Content usable  (192, 68, 752, 456)  = content pane inset 16px
```

Chromed screens: INBOX, SQUAD, TACTICS, FIXTURES, TABLE, TRAINING, CARD SHOP,
LEGENDS, FRIENDLY.
Chrome-EXEMPT (full 960×600 takeovers, no sidebar/header/bottom bar): MATCH
playback, instant-result TICKER, PACK OPENING, NEWS DAY overlay, training and
unlock ceremonies, CEREMONY (campaign review), NEW CAREER. They end in a
"tap to continue" pulse, never a stranded state.

### Palette tokens (FM-dark, professional; reuse exact hexes)

```
shellBg   #12161b     sidebarBg #0d1013     headerBg #171c22
panel     #1b222a     rowAlt    #1f2731     edge     #2b3542 (1px lines)
text      #e9edf2     dim       #98a3b0     ink      #10131a (on gold)
gold      #e9bf63     (focus ring, CONTINUE, coins, "your row")
win       #2f8f52     loss      #d6202a     draw     #98a3b0
```

Parallel tier colours come from `MG_DATA.parallels[*].frame` — never restyle
them. The pitch view keeps its turf greens.

### Type scale (px; nothing below 12)

```
12  captions, pips labels, column units
13  hint bar, footers, honesty marker
14  sidebar labels, table body, chips
16  buttons, sub-tab labels, subheads     (bold)
18  club name, section titles             (bold)
22  content-pane screen title             (bold)
26  news headline (≤5 words)              (bold)
28  card EFF number                       (bold)
40  scoreline (ticker/match)              (bold)
```

Tables right-align numerals; draw with a fixed advance (tabular feel).
Line-height 1.3. All caps for labels ≤4 words (spec copy rule).

---

## 2. Header bar — (0, 0, 960, 52)

bg `headerBg`, 1px `edge` bottom line.

| Element | Rect / anchor | Spec |
|---|---|---|
| Club crest disc | (16, 8) 36×36 | player crest emoji/procedural, tier-gold rim |
| Club name | x 60, baseline 24 | 18px bold `text`, e.g. "TURBO DRAGONS" |
| Breadcrumb | x 60, baseline 42 | 12px `dim`: "Gibson Cup · Group C · Matchday 2 of 3" (knockouts: "QUARTER-FINAL") |
| Coins chip | right edge 944, y 10, h 32, min-w 96 | 14px bold gold "🪙 1,240", count-up anim on change |
| Date/round chip | right of name block, right margin 8 from coins, y 10, h 32 | 13px `dim`: "CAMPAIGN 2 · ROUND 5/8" |

Header is informational — no tap targets (the sidebar and Continue do the
driving). Never rendered on chrome-exempt screens.

---

## 3. Sidebar — (0, 52, 176, 548)

bg `sidebarBg`. Items are FULL-WIDTH hit rects 176×48 (stride 52, 4px gap).
Active item: `panel` fill + 3px gold bar on the left edge + `text` label;
inactive: `dim` label. Icon 20px procedural glyph at x 16 (v-centered); label
14px at x 48. Focus = gold ring per the focus model.

| # | Item | y (top) | Rect | Badge | Opens |
|---|---|---|---|---|---|
| 1 | INBOX | 60 | (0,60,176,48) | unread count, gold disc 18px at x 148 | News list + reading pane (§6) |
| 2 | SQUAD | 112 | (0,112,176,48) | — | TEAM LIST \| PITCH \| BINDER sub-tabs (§5) |
| 3 | TACTICS | 164 | (0,164,176,48) | — | formation + mentality + kickoff buttons |
| 4 | FIXTURES | 216 | (0,216,176,48) | — | my campaign road (§8) |
| 5 | TABLE | 268 | (0,268,176,48) | — | WORLD: group table / bracket (§7) |
| 6 | TRAINING | 320 | (0,320,176,48) | dot when a train-up is affordable+eligible | Binder pre-filtered to trainable |
| 7 | CARD SHOP | 372 | (0,372,176,48) | pendingPacks count | PACKS (§9) |
| — | divider | 428 | 1px `edge`, x 12–164 | — | — |
| 8 | LEGENDS | 436 | (0,436,176,48) | dot on new unlock | 3×3 unlock wall |
| 9 | FRIENDLY | 488 | (0,488,176,48) | — | Quick Match / Draft Duel |
| — | EXIT chip | 544 | (8,544,160,48) | — | leave arcade (framework scrim) |

Items 1–7 are the owner's Addendum-3 list verbatim (TABLE = "League Table";
TRAINING deep-links into the binder's card sheets — training itself stays on
the card sheet per spec). Badges are 12px numerals on 18px gold discs, ink
text. Sidebar is identical on every chromed screen — it never reflows.

---

## 4. CONTINUE button — the heartbeat

**Always present on every chromed screen. Never moves, never resizes.**

```
Rect   (768, 546, 176, 48)     bottom-right of bottom bar; margins 16 R / 6 B
Fill   gold  ·  label 16px bold ink  ·  focus ring per model
```

Bottom bar (176,540,784,60), bg `shellBg`, 1px `edge` top line. Left side
carries the 13px hint line at x 192 (v-center y 570): key hints on desktop,
tap wording when `'ontouchstart' in window`. On SQUAD it instead shows
"TEAM RATING 82" (14px bold).

Continue label states (contextual — always advances to the next thing that
needs the manager, in this priority order):

| State | Label | Routes to |
|---|---|---|
| unread news day | `NEWS (2) ▶` | NEWS DAY overlay |
| fixture pending | `MATCH DAY ▶` | TACTICS (scout mask applied) |
| group done / knockout reached | `THE DRAW ▶` | qualification / bracket story |
| campaign decided | `CEREMONY ▶` | campaign ceremony (the env.over) |
| ceremony done | `NEW CAMPAIGN ▶` | campaign n+1 |
| nothing pending | `CONTINUE ▶` | TABLE (next-round preview focused) |

One press, one advance, atomic per the round rules. The button is the same
gold everywhere; only the label swaps. On TACTICS the bottom bar instead
hosts the two kickoff buttons — `PLAY THE MATCH ▶` (544,546,208,48) and
`GET THE RESULT ⏩` (760,546,184,48, pre-focused when routed from SIM) — and
the Continue button hides (kickoff IS the continue).

---

## 5. SQUAD — table first (Addendum 3: data-dense, kid-legible)

Sub-tab bar (192, 68, 752, 48): segments `TEAM LIST` `PITCH` `BINDER`, each
≥160×48, 16px bold; active = panel fill + gold underline 3px. Right-aligned
in the same bar, LIST-only: toggle chips `XI` (736,68,64,48… visual right
edge 944) and `BENCH` beside it, 64×48 each.

### 5.1 TEAM LIST table

Sort header (192, 120, 752, 40) — each header cell is a ≥40px-tall tap
target; tapping sorts (EFF desc default; second tap reverses). Active sort
column shows a 12px arrow. 13px `dim` labels.

Rows start y 160, **row height 40**, full-row hit rect 752 wide (opens the
CARD SHEET). XI = 9 rows (ends 520); BENCH = up to 4 rows + dim "empty slot"
hints. Zebra `panel`/`rowAlt`; knocked/energy-0 rows dimmed 40% with
"RESTING" status (UI blocks starting them, per spec).

| Column | Width px | Content |
|---|---|---|
| SLOT | 56 | GK / D1 / M3 / A2 … (bench: POS) |
| TIER | 40 | parallel ring swatch, 18px |
| NAME | 200 | 14px, ≤11 chars |
| MOOD | 56 | `drawFace` r=9 (morale face, fm.md §7.3) |
| ENERGY | 76 | 3 battery pips |
| EFF | 56 | 16px bold gold, round(effSkill) |
| SHO | 52 | 14px |
| DEF | 52 | 14px |
| APPS | 56 | cumulative apps meter number |
| STATUS | 108 | 12px word: READY / ON FIRE / WANTS TO PLAY! / COLD / RESTING |

Sum = 752 exactly. Sortable: EFF, TIER, SLOT/POS, APPS.

`AUTO ✨` chip: 96×40 at (848, 120), sitting over the STATUS header cell
inside the sort header row (STATUS never sorts, so the cell is free). Fills
best-eff per slot, per spec.

### 5.2 PITCH sub-tab
The spec's 9 slot discs at formation coords, unchanged — rendered inside the
content usable rect, scaled to 752×456. Slot picker overlay per spec.

### 5.3 BINDER sub-tab (fm.md §7.6, fitted to the pane)
The sub-tab bar stays; the filter chips row sits below it at
(192, 124, 752, 48): chips
`TEAM ▾` `POS ▾` `TIER ▾` `SORT: EFF ▾`, each ≥120×48. Grid origin
(192, 180): **page of 18 = 6 cols × 3 rows**, cell 118×92, gaps 8 h / 6 v
(6×118+5×8 = 748; 3×92+2×6 = 288, ends 468). Cell = mini card (tier frame,
name 12px, EFF 14px); silhouette for un-owned combos in album-page view.
Pager: `◀` (192, 476, 64, 40), `▶` (880, 476, 64, 40), "PAGE 3/12 · SO FAR
213 / 6,860" centered 14px between them. Card sheet + ladder strip + TRAIN
button per spec, unchanged.

---

## 6. INBOX — list + reading pane (FM's messages, kid-size)

Landing screen on load (career always opens at the hub ⇒ the hub is INBOX).

```
List column    (192, 68, 264, 456)   rows 64px tall, 7 visible
Reading pane   (468, 68, 476, 456)   panel fill, 12px radius
```

List row (264×64, full-row tap): type icon 24px at x 204; headline 13px bold
2-line max at x 236; round tag 12px `dim`; unread = gold dot 8px at right
edge; selected = `rowAlt` + gold left bar 3px. Order newest first; rows are
the deterministic news items re-derived from state (nothing stored but
`news:[c,r]`).

Reading pane layout: art column left 96px (crest 64px or `drawChar` manager
at 1.4× with speech bubble); headline 26px ≤5 words; body 16px ≤2 lines
(≤70 chars/line); byline 13px `dim` ("— The Sticker Times" / "— the scout" /
"— Grandpa" after season-done); optional deep-link chip bottom-left
(480, 460, ~220×48): `GO TO TRAINING ▸` / `SEE THE TABLE ▸`.

NEWS DAY (post-match flow) stays the fm.md full-canvas overlay: centered card
rr(160, 90, 640, 420, 18), pips "2/4" bottom-center, SKIP chip (704, 102,
80, 44) top-right inside the card, "tap to continue" pulse at (480, 540)
centered. Advancing through the overlay marks list rows read.

---

## 7. TABLE (WORLD) — group table + all-groups + bracket

Group phase layout:

```
Title row      (192, 68)  "GROUP C" 18px bold + campaign-goal chip 13px right
Table header   (192, 96, 752, 32)   13px dim labels
Group rows     y 128, 4 rows × 48   your row gold-edged 2px, movement arrows
Matchday strip (192, 336, 752, 56)  this round's other fixture + your tie;
                                    your tie carries `PLAY ▶` (≥120×48) →
                                    routes to TACTICS; `SIM ⏩` beside it
                                    routes to TACTICS with ⏩ pre-focused
All groups     grid origin (192, 404): 12 chips 120×56, 6 cols × 2 rows,
               gaps 6 h / 8 v (6×120+5×6 = 750; ends y 524)
```

League/group table columns (sum 752):

| POS | TEAM | P | W | D | L | GF | GA | GD | PTS |
|---|---|---|---|---|---|---|---|---|---|
| 32 | 300 (flag 20 + name 14px) | 48 | 48 | 48 | 48 | 56 | 56 | 56 | 60 (16px bold) |

Rows 48px, zebra, numerals right-aligned. Unscouted teams show "?" strength
stars (scout mask is display-only). Group chips tap → pop-out overlay card
(240, 120, 480, 320) with that group's 4-row mini table (rows 48) — the
FM26 "league table pop-out", tap anywhere to dismiss.

From round 4 the pane swaps to the BRACKET: 5 columns R32→FINAL across 752px
(column width 136, gap 18), tie chips 136×36 (display-only; your tie 136×48,
gold-edged, activatable → TACTICS). Eliminated? The one-screen tournament
story renders here — missing out must be visible.

---

## 8. FIXTURES — my campaign road

Header row (192, 68, 752, 40) 13px `dim`. Rows y 108, **48px** × up to 8
(three group matchdays + five knockout rounds as reached; future knockout
rows dim "—"). Ends ≤492.

| Column | Width | Content |
|---|---|---|
| ROUND | 64 | R1…R8 |
| STAGE | 132 | GROUP C / R32 / QF / FINAL |
| OPPONENT | 300 | flag + name (unscouted: name only, "?" stars) |
| VENUE | 64 | H / A / N |
| RESULT | 192 | "2–1 W" coloured win/loss/draw; pens "(4–3p)"; future: "—" |

Played rows tap → nothing (no stored replays — spec law). The next fixture
row is gold-edged and taps to TACTICS.

---

## 9. CARD SHOP (PACKS) + PACK OPENING

Shop (chromed): three pack tiles (192, 100) 240×280 each, gap 16
(240×3+16×2 = 752): BRONZE 100 / SILVER 300 / GOLD 750, card count, odds in
plain English 13px. Pending-prize tray: glowing row of free packs at
(192, 396, 752, 72), each 96×64 chip. Banner 13px at (192, 476):
"Colours come with album luck — ⬛ BLACK is 1 in 500. Training is the sure
road." Footer 13px `dim` in the bottom bar: "packs are earned with match
coins — that's the only way."

PACK OPENING (chrome-exempt takeover):

```
Scrim          full canvas, shellBg 92%
Counter        "CARD 3 OF 5" 14px, centered, y 64
Card back      (364, 96, 232, 324)  centered; parallel-glow TELL radial
               behind it in the tier colour (the kept ceremony beat)
Tear input     the WHOLE canvas is the tap target (3-press tear);
               tear meter strip (380, 436, 200, 10)
Reveal         card flips in place; stamp 18px diagonal at the corner:
               "NEW CARD!" or "SWAP +30 🪙"
Tray           revealed thumbs 64×90, gap 8, bottom strip y 470, centered
               (5 cards span x 304–656)
Prompt         "tap to continue" pulse, 13px, centered y 578
```

Escalating ceremonies unchanged (purple slow-zoom; green/black add the gold
takeover). Summary screen: tray grid centered + `OPEN ANOTHER` (272, 500,
200, 48) and `DONE` (488, 500, 200, 48). Autosave per card, per spec.

---

## 10. Chrome-exempt screens — one-line contracts

- **TACTICS**: chromed, but bottom bar hosts the two kickoff buttons (§4).
  Honesty footer 13px centered in bottom bar left: "FC-style ratings, made
  for this shop — not EA data."
- **MATCH / TICKER**: no chrome; geometry per fm.md §7.2 and the kept match
  renderer. Speed chip is the only focusable in MATCH.
- **POST-MATCH**: no chrome; its own CONTINUE ▶ at (768, 546, 176, 48) —
  same rect as the heartbeat so the thumb never moves.
- **CEREMONY / NEW CAREER / ceremonies**: takeovers; every pause carries the
  "tap to continue" pulse at y 578 centered.

## 11. Builder checklist (shell only)

1. Regions and rects above are exact — draw once, share across screens.
2. Sidebar order/labels verbatim (§3); badges derive from state, never stored.
3. Continue label priority table (§4) is the loop — test each state routes.
4. All column widths sum to 752 (squad 752, group 752, fixtures 752).
5. No text <12px anywhere; no activatable rect under 40px (48 preferred).
6. Tap-only walkthrough of every screen before shipping (phone law).
