# Changelog

## v0.0.1 — 2026-09-15

The first tagged release of **Card Manager**, a Football-Manager-style career
game built on the Panini FIFA World Cup 2026 sticker album. You take over a
real club or build your own, collect 980 players in seven colour versions,
and climb a six-division pyramid for as many seasons as you like.

Everything below was checked against the code in this release, not against
the design documents. The documents ask for more than has been built; the
gaps are listed under [Known issues](#known-issues) and
[Not built yet](#not-built-yet).

### Download and play

- **Download `cardmanager.html`** from the assets of this release, or use
  `cardmanager/dist/cardmanager.html` in the repo, and open it in Chrome,
  Safari, Edge or Firefox. It is one self-contained 5.5 MB file: no server, no
  account, no internet connection.
- **On a phone**, see "Fire it up" in the README: serve the file over your
  Wi-Fi, then use Add to Home Screen so it opens full screen like an app.
- **Saves live in the browser that played them.** Move a career between
  devices with a save code: CLUB → CAREER FILE → SAVE CODE, then LOAD GAME →
  FROM A SAVE CODE on the other device.

---

### Highlights

#### Real club squads from EA SPORTS FC 27

Taking over a real club now brings **that club's whole squad**. Before this
release, a takeover handed over the name, badge and colours, plus only those
players who also appear in the Panini album. The album holds national-team
players only, so most clubs brought nobody, and the rest of the squad was the
standard starter cards, most of them American. Taking over Philadelphia Union
gave you, in effect, the US national team.

- The club layer is rebuilt from EA SPORTS FC 27's public ratings pages,
  harvested on 2026-09-15: **19,789 players, 754 clubs, 63 leagues and 164
  nations**.
- The club picker offers the **top 40 leagues** by strength, then any club in
  them with at least 14 players.
- Every player in the squad becomes a card. An album player arrives as his
  album card, an under-20 prospect as his prospect card, and everyone else as
  a club squad card carrying EA's name, age, club, nation, position and
  rating. No potential is invented for them.
- Philadelphia Union now brings its 25 players, with Andre Blake in goal and
  Kai Wagner the best rated, and no filler. Only one club in the top 40
  leagues is listed by EA without a keeper (Carabobo FC); it gets one from
  the starter cards.
- The setup screen says exactly what comes with the job before you start:
  squad size, average rating, best player and keeper.
- Careers now remember a club by EA's permanent team id, so a club stays the
  same club when a new harvest renumbers them. Saves made before this release
  find their club and crest again.
- Club squad cards never appear in packs, the binder or album completion.

#### Icons and mystery guests are excruciatingly rare

- **The icons** are Lionel Messi, Cristiano Ronaldo, Lamine Yamal, Kylian
  Mbappé and Erling Haaland. **The mystery guests** are the nine family and
  celebrity cards: Gibson, Ellis, Grandpa, Phoenix the dog, Maradona, Suárez,
  Wembanyama, Lu Dort and Caruso.
- They now come **only from packs**, on a separate roll for every card:

  | Pack | Chance per card |
  |---|---|
  | Bronze | 1 in 10,000 |
  | Silver | 1 in 2,500 |
  | Gold | 1 in 800 |
  | Legend prize pack | 1 in 120 |

- The shop prints these odds on every pack and at the foot of the page.
- They can no longer be signed in the market, offered in a CPU trade, or
  brought in by a club takeover.
- Completing a guest's feat no longer hands him over. It **spots** him, which
  lets him turn up in packs. Maradona only turns up in gold and legend packs.
- A rare pull keeps the colour it rolled, is always revealed last, and gets
  its own "AN ICON!" or "MYSTERY GUEST!" moment.
- Cards you already own stay yours.

#### A new front door: title screen, six save slots, one setup screen

Starting a new game used to open a club builder with an invented club already
filled in, and the real-club route sat in a corner. It is now three clear
steps, modelled on classic save-select screens.

1. **Title screen:** CONTINUE (your last career, with its crest), NEW GAME
   and LOAD GAME.
2. **Choose a slot:** six big numbered tiles. Each shows the career living
   there — crest, club, season, division, difficulty, coins, and when it was
   last played — or "+ NEW GAME" if it's empty. Starting over on a used
   slot takes two taps. A bin erases a slot after a second tap, keeping a
   backup copy first. LOAD GAME shows the same tiles, plus restore from a
   save code or a file.
3. **New career setup:** your team (a real club, or build your own from 8
   crests, 8 kits and 64 names), your starting division (1 to 6), your
   difficulty, and what comes with the job. Nothing is chosen for you, and
   nothing is written until you press START CAREER.

Also fixed: on a phone, tapping a league used to highlight whatever club was
drawn under your finger on the next screen, so the game appeared to pick Real
Madrid for you. Highlighting now follows a pointer only when it actually moves.

#### Difficulty

| Level | Starting coins | What changes |
|---|---|---|
| Easy | 600 | Your starting cards arrive blue |
| Normal | 300 | The game as designed |
| Hard | 150 | Every opponent plays one colour stronger, still capped |

A career saved before difficulty existed plays as Normal.

#### A standalone game with its own repository

- Card Manager started as a minigame in the Gibson Party arcade. It is now its
  own game, with its own canvas shell, save slots, app icons and single-file
  build.
- Saves from the arcade version are adopted automatically, and the originals
  are kept.
- This repository mirrors the game from the Gibson Store project, which grew
  it. It includes a README for playing and building, `npm test`, `npm run
  build`, and real-tap test scripts.
- The build is deterministic: the same source rebuilds the committed game file
  byte for byte.

---

### The game in full

#### Career

- **A six-division pyramid** of eight teams each, drawn from the 48 nations of
  the World Cup album. Each season one nation in your division is away on a
  world tour, so you play the other seven home and away: 14 rounds.
- **Promotion and relegation:** the top two go up and the bottom two go down.
  The other divisions are simulated and move the same way.
- **Opponents get stronger** by a colour in seasons 2 and 3. Guest players
  turn out for CPU nations: Maradona as a black card for Argentina, and
  Wembanyama, Lu Dort, Caruso and Suárez for France, Canada, the USA and
  Uruguay.
- **The Gibson Cup:** after the league, the top four of your division play
  semi-finals and a final, settled on penalties if level. The winner also
  receives a free legend pack.
- **The Champions competition:** a top-two finish qualifies you for next
  season's, against the seven strongest nations. It has two groups of four,
  semi-finals and a final.
- **Money:** league prize money by finishing position, scaled by division,
  plus a board allowance. The board sets one goal a season (win the league,
  top two, top half, or win three matches) and pays a bonus for meeting it.
- **Dynasty records:** Division 1 titles, cups and promotions. Also a season
  history, record sales, loan spells, a hall of fame, mastery stars, and the
  clubs holding a grudge against you. Winning a division title grants the
  Black Licence.
- **News day:** a daily paper of up to five stories — the board goal,
  results around the league, a scout report, grudge warnings, your next
  opponent — plus decisions to make: swap offers, bids for your players and
  youth prospects.
- **21 feats:** nine spot a mystery guest, and twelve pay coins or packs.
- **A second manager:** CLUB → MANAGER ⇄ starts or switches to a second,
  independent career in the same slot.

#### Match day

- **Play the match** on an animated pitch at 1×, 2× or 4× speed, or **get the
  result** as a text match report. Both run the same seeded engine and pay the
  same.
- **Nine-a-side** in three formations; two of them unlock in season 2. Your
  mentality plays rock-paper-scissors with the opponent's.
- **Team talks** in three tones — Fire them up, Steady, No pressure — whose
  effects are printed on screen and depend on the squad's mood and the
  matchup.
- **Calls at half-time and 70 minutes:** push forward, hold, or shut up shop.
  You can set a standing plan for when you're leading, level or behind, or turn
  on auto calls.
- **A penalty taker** you choose, who also takes the first shootout kick.
- **After the match:** man of the match, shots, shots on target, chances, xG,
  player ratings from 4.0 to 10.0, goals, coins earned, XP, quest progress,
  and a mini table.
- **Rivalries:** beating a club builds a grudge of up to 3, faster after a
  heavy win, and losing to them eases it. A grudging club plays harder against
  you and trades with you less willingly.
- **Broadcast look:** a drawn stadium with a crowd in kit colours that ripples
  on chances and erupts on goals. Kick-offs are by day, dusk or night, some
  knockout ties are played in rain, and goals get camera punch-ins and a
  ghost-trail replay. A Calm Visuals switch turns the motion off.
- **Commentary:** a live feed during the match and key moments in the report.

#### Cards and colours

- **980 album cards × 7 colours = 6,860 cards to collect.** 864 of them are
  footballers. The rest are crests, team photos and World Cup history cards.
- **The colour ladder:** white, blue, red, orange, purple, green, black. A
  card's effective rating is exactly 75% its base rating and 25% its colour,
  so each step up adds 2.5 points, and black is worth 14.75 more than white.
- **The binder** filters by team, position and colour, and has album pages for
  every nation.

#### Packs

| Pack | Cost | Cards | Players drawn |
|---|---|---|---|
| Bronze | 100 coins | 3 | Mostly rated 70–79, sometimes 80–84, rarely 85+ |
| Silver | 300 coins | 4 | 70–79 and 80–84 evenly, 85–89 sometimes, 90+ rarely |
| Gold | 750 coins | 5 | One 88+ guaranteed, the rest 80+ |
| Legend | Prize only | 1 | A player rated 88 or better |

- **Colour odds**, the same for every card in every pack and printed in the
  shop: white 56%, blue 28%, red 10%, orange 4%, purple 1.4%, green 0.4%,
  black 0.2% (1 in 500).
- **Packs cost coins earned in the game,** or come as prizes for cups, titles
  and feats. There are no purchases, no real money and no timers.
- **Opening a pack is a ceremony.** You tear it open in three taps, card backs
  glow their true colour, and cards flip from worst to best. A repeat of a
  card you own becomes coins.

#### Market

- **Sign** the white version of any album footballer in pre-season, for 1.25×
  its value.
- **Sell** for 75% of value in pre-season, or accept bids from bigger clubs.
- **Values move** with base rating, colour and form, with arrows on the squad
  list and a value chart on each card.
- **Trades:** CPU clubs propose swaps at the start of the season and every
  three rounds, bargaining by personality. You can propose your own to any
  club you have scouted. The odds are shown as "about N in 100", and asking
  twice gets the same answer.
- **Loans:** send out up to three players to clubs at your level or below. The
  fee comes up front and per game, and a good spell brings a player back on
  form.
- **Selling upward:** clubs from higher divisions bid for your in-form
  players, and you can offer a player upward to see what the market says.
- **Guard rails:** you can never release your way below a legal nine with a
  keeper, and retrying a trade or bid doesn't change the answer.

#### Training and levelling

- **Climbing a colour** needs both lifetime XP and coins. Black also needs the
  Black Licence.

  | Step to | Blue | Red | Orange | Purple | Green | Black |
  |---|---|---|---|---|---|---|
  | Lifetime XP | 200 | 500 | 900 | 1,400 | 2,000 | 2,800 |
  | Coins | 60 | 150 | 350 | 750 | 1,500 | 3,000 |

- **XP** comes from starts, sub appearances, ratings, goals, clean sheets, man
  of the match awards and wins.
- **The colours double as levels:** Novice, Pro, Star, Elite, Icon, Mythic,
  Legend. A climb plays a LEVEL UP screen and posts to your inbox.
- **A weekly training plan** has three slots: climb, fitness, sharpness or
  solidity. Hire up to three coaches to make a focus free and stronger.
- **Quests:** every card carries a three-step quest chain, with special ones
  for the family guests. Rewards are XP, discounts on the next climb, and
  mastery stars, up to three per card.

#### Youth prospects

- **644 real under-20 players** from EA's public pages. Three appear at a
  youth intake each season, to sign or pass on.
- A prospect grows each season depending on age, room to grow and games
  played, and never gets worse.
- A prospect's ceiling shows as a range that narrows to an exact number after
  15 appearances.

#### Scouting and hidden information

- **You learn about each club over time,** by sending the scout the week you
  play them and by playing them.
- **Each level reveals more:** form, then their starting nine and star player,
  then exact ratings and tactics. After that come badges, links and potential,
  and finally their plan against you.
- **Anything not yet known** shows as a range or "?".
- **Club pages** have overview, squad and rivalry tabs, and open from
  fixtures, the table, news, the market and match day.

#### Player profiles

- **Tabs** for Profile, Stats, Ladder, Quests, Career and Links.
- **Full attributes:** six faces plus 29 outfield and 5 goalkeeping
  sub-attributes, drawn as a hexagon. Attributes affect matches, within limits
  that keep the 75/25 rule exact.
- **28 playstyle badges,** such as Finesse Shot, Engine, Wall and Speedster,
  each with a small, capped effect in matches.
- **Career stats:** appearances, goals, average rating, and value history.

#### Saves

- **The game saves itself after every action,** into the chosen slot.
- **Save codes** are compressed and checksummed text that you can keep
  anywhere and paste back to restore.
- **Export or import** a save as a file.
- **Automatic backups:** the last five per slot, plus extra copies before a
  restore, an erase or a new career.
- **Saves are versioned** and upgraded automatically from any earlier version
  back to version 2. A damaged save is copied aside and shown as damaged,
  never silently lost.

#### Friendlies and Draft Duel

- **Friendlies:** play either manager or any nation, for a small coin reward.
- **Draft Duel:** a back-and-forth draft against the CPU from 24 high-rated
  cards, then a match. Your career cards are never at stake.

#### On phones and computers

- **One self-contained HTML file** with no outside links.
- **On a portrait phone** the board turns sideways to use the long side of the
  screen, with taps mapped correctly.
- **Installable** from the browser, with its own icons and full-screen mode.
  Launched from the home screen, it keeps the screen awake.
- **Controls:** touch, mouse, or keyboard. Arrows or W A S D move the gold
  focus ring, Enter or Space presses, and M mutes.
- **Respects your device's reduced-motion setting.**

---

### How it got here

The game grew through a series of design addenda, kept in
`.mg-manager-addendum.md`. In order, the milestones that shipped:

1. **The whole album.** 980 generated cards, the 48 nations as opposition, and
   every player in all seven colours.
2. **Football Manager's shell.** A left sidebar, the CONTINUE button that
   advances your week, and dense squad, fixture and league tables.
3. **Statistical depth.** Post-match stats and xG, player ratings, moving
   transfer values, season history, and promotion and relegation.
4. **Competitions and the market.** The Champions competition, the transfer
   market, and a browsable player list.
5. **Trades, loans and selling upward.** Plus dynasty records and a hall of
   fame.
6. **Match craft.** Team talks, in-match calls, rivalry memory, the broadcast
   look, the weekly training plan, coaches and mastery stars.
7. **The levelling core.** XP, levels named after the colours, quests and the
   level-up screen.
8. **Depth on every card.** Save slots, full attributes, playstyle badges, the
   player profile screen, and scouting with fog of war.
9. **The real world.** The EA ratings layer merged with the album, 644 youth
   prospects, and the pack opening ceremony.
10. **Your saves in your hands.** Save codes, file export and import, and
    automatic backups.
11. **A game of its own.** A standalone shell and a single-file build, arcade
    saves adopted, file export through the viewer's downloads feature, and
    test scripts that check the screen a player must reach.
12. **Real clubs.** The league-then-club picker, 651 embedded club crests,
    shirts with numbers instead of drawn faces, and the title menu.
13. **2026-09-14.** NEW GAME became one clear choice. Takeovers began bringing
    the club's album players. The club picker's EA-style facelift, with star
    ratings, attack, midfield and defence averages and club colours, had been
    lost from the source in a clash between editing sessions and was restored.
14. **2026-09-15.** The slot screens, the setup screen and difficulty, the
    rare icons and mystery guests, and real squads from EA SPORTS FC 27.

---

### Known issues

**Game**

- **The end of a season returns you to the title screen.** The same happens
  after a Draft Duel. Press CONTINUE to carry on; nothing is lost.
- **No button leads back to the title screen.** Reload the page to get there.
  The game saves itself, so reloading loses nothing.
- **The ratings footer is wrong on some screens.** It reads "FC-style
  ratings, made for this shop — not EA data" even where the numbers come from
  EA's public ratings pages: real club squads, the club picker, youth
  prospects. Card Manager is not affiliated with, endorsed by or licensed by
  EA.
- **The build-your-own-club screen names the wrong nations.** It says the 14
  starter cards come from the USA, Mexico and Canada. They are 7 USA, 2
  Australia, and one each from Mexico, Egypt, Czechia, Sweden and Curaçao.
- **The league opposition is always the 48 nations,** even when you manage a
  real club.
- **Some real clubs are awkward to find or read.**
  - EA's short names are used, so Philadelphia Union appears as
    "Philadelphia".
  - Players can share a short name: Philadelphia's Quinn and Cavan Sullivan
    both read "Sullivan".
  - 129 clubs new in FC 27, including Ajax, Feyenoord and PSV, show their
    initials instead of a crest.
- **The club picker has no search,** and national teams cannot be picked.
- **Screens say "XI",** but matches are nine-a-side.
- **Chemistry links are for display only.** The card's claim of "a small,
  real edge on the day" is not true yet.
- **Some star commentary never plays.** The named lines for Haaland, Messi,
  Yamal and Kane never fire; the guests' lines do.
- **The youth intake's odds line is cut off,** so the star and generational
  odds don't show.
- **No music plays.** The music tracks and crowd sound are written, but only
  the win and loss stings on the results screen play.
- **Crest and team photo cards can't be collected.** Nearly all are rated below
  every pack's floor, and the market sells footballers only.
- **The legend pack draws players rated 88 or better,** though its data says 90.
- **The pity rule is unannounced.** When a bronze pack happens to be your 5th,
  10th or 15th pack of any kind, and so on, its last card is re-rolled looking
  for one you don't own. Nothing on screen says so.
- **A group-stage exit from the Champions competition pays nothing.**
- **Earned playstyle badges don't exist yet.** The badge slot for achievements
  earned in a career never fills.
- **Some finished code has no screen.** Tier perks, skill branches, the forge
  gamble, "The One", prestige after black, and the shards and catalysts they
  would spend are all written but unreachable. Shards and catalysts pile up
  unseen, and shards over 40 quietly turn into coins.

**Hosted copy**

- The copy on claude.ai linked in the README is an earlier build. It has the
  new title and slot screens but not the rare icons or the FC 27 squads.

**Testing**

- **Eleven older tap scripts in `tools/tap-scripts/`** — broadcast-look,
  instant-with-calls, market-verbs, menu-roundtrip, migration-v2, opposition,
  pack-ceremony, phone-law-sweep, talk-and-calls, training-plan and xp-levelup
  — were written before the title screen existed. They fail at their first
  step, waiting for a screen that no longer opens at boot, so they no longer
  exercise the parts of the game they were written for. Replayed through
  today's menus, migration-v2 and pack-ceremony pass.
- **The flow test's "CPU proposes a swap" check can occasionally fail.** About
  one run in six has been seen to fail, because the offer depends on a random
  season seed.
- **`tools/mg-roster-audit.js` can't run from this repository.** It needs the
  EA ratings harvest, which is not committed.

### Not built yet

The design documents ask for these, and they are not in this release:

- **Sync:** saves shared across devices through the hosted page.
- **Pack variety:** pack flavours (nation, position, prospect, colour floor), a
  Prime tier and a weekly special.
- **A full Champions League:** 36 clubs, a league phase, play-offs and
  two-legged ties.
- **Pack extras:** a visible pity meter, a best-pull-of-the-season board and a
  shareable pull card.
- **Trades between the two managers.**
- **More slot controls:** renaming and duplicating slots, and ten or more
  visible slots.
- **Growing album players:** their base ratings don't grow toward potential,
  and age doesn't change how fast a card learns.
- **More card routes:** fusing duplicates, form-streak discounts and temporary
  "flash" upgrades.
- **The full EA roster in CPU squads, the market and scouting.**

---

### Tests run for this release

All on commit `a030c88`, in a fresh clone from GitHub:

| Check | Result |
|---|---|
| Engine gates G14–G32 (`tools/mg-harness.js --sims 200`) | All green |
| Career flow test, including takeovers, difficulty and rare-pull odds | All green |
| Real club squad test (`tools/cm-squad-test.js`) | All green |
| Save test | 16 of 16 |
| Attribute data divergence | Zero |
| Shell check on the stub build | 18 of 18 |
| Rebuild vs. committed `cardmanager.html` | Byte for byte identical |
| 12 current real-tap scripts on iPhone and desktop | 24 of 24 pass, no page or console errors |
| Old-save migration and pack opening, replayed through today's menus | Pass on iPhone and desktop |
| Taking over Philadelphia Union with real taps, desktop | Pass: all 25 players arrive and the career opens in the hub |

### Data and credits

- **The album:** the Panini FIFA World Cup 2026 US sticker checklist.
- **Album cards' ratings** are FC-style ratings made for this game.
- **Real club squads and youth prospects** use EA SPORTS FC 27's public ratings
  pages, harvested on 2026-09-15.
- **Club crests** are embedded images.
- Card Manager is a family project. It is not affiliated with, endorsed by or
  licensed by EA, Panini or FIFA.
