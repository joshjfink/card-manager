# Card Manager

A Football-Manager-style career game drawn entirely on a 960×600 canvas,
built on the Panini World Cup 2026 sticker album: 980 players, 48 nations,
seven parallel colour versions of every card. No server, no account, no
images on the wire — the whole game is one self-contained HTML file.

**Play it:** open `cardmanager/dist/cardmanager.html` in a browser, or add it
to a phone's home screen (it installs as an app).

Player ratings are FC-style ratings made for this game — not EA data. The
game is not affiliated with, endorsed by, or licensed by EA or Panini.

## Where things are

| Path | What it is |
|---|---|
| `cardmanager/index.html` | The page. Script order is load-bearing; the bundle is built from it. |
| `cardmanager/cm-shell.js` | Canvas host: main loop, touch + keyboard input, audio, particles, phone rotation. |
| `cardmanager/cm-boot.js` | Save slots (`cm-save-slot-N`), boots the game. |
| `cardmanager/build.sh` | Bundles everything into `cardmanager/dist/cardmanager.html`. |
| `gibson/web/static/mg-manager.js` | The game: career layer (pure, headless, gateable) and the screens. |
| `gibson/web/static/mg-manager-data.js` | Generated album + ratings data. Never hand-edit; run `tools/build_mg_data.py`. |
| `gibson/web/static/mg-roster.js` | The real-club layer: every club and league, merged with the album. |
| `gibson/web/static/mg-kits.js` / `mg-badges.js` | Procedural kits; club crests as data URIs. |
| `.mg-manager-spec.md` + `.mg-manager-addendum.md` | **The design docs are the source of truth.** Each addendum overrides the spec where they conflict. Read them before changing anything. |
| `.mg-manager-fm.md`, `.mg-manager-depth-plan.md` | The Football Manager reference and the depth plan. |

The directory layout mirrors the Gibson Store repo the game grew up in, so
every script here runs unchanged in both places. This repo is a **one-way
mirror**: the game is edited in Gibson Store and copied here with
`tools/sync_cardmanager_repo.sh` (kept in that repo). Edits made only here
are overwritten by the next sync.

## Build

```bash
bash cardmanager/build.sh            # → cardmanager/dist/cardmanager.html
bash cardmanager/build.sh --stub     # the shell alone, for the shell check
```

## Test

Every gate must stay green. The first two need only Node:

```bash
node tools/mg-harness.js --sims 200  # engine, economy, anti-exploit gates G14–G32
node tools/mg-flow-test.js           # boot → seasons → market → takeover → Draft Duel, headless
```

The real-tap suite drives the built page in headless Chrome with genuine
touch events. It needs `npm install` and Google Chrome at
`/Applications/Google Chrome.app` (see `CHROME` in `tools/mg-tap-suite.js`):

```bash
node tools/mg-tap-suite.js --page cardmanager/dist/cardmanager.html \
     --device iphone --script cardmanager/tap-scripts/cm-realclub.json
```

Tap scripts assert the destination the player must reach, never a waypoint
(`tools/tap-scripts/README.md`). `cardmanager/tap-scripts/` are the game's
own; `tools/tap-scripts/` also holds older arcade-era scripts, some of which
predate the title screen.

## Data

`tools/build_mg_data.py` regenerates `mg-manager-data.js` from
`data/ea_pages.jsonl`, `data/basicplayerdata.csv`, `data/mg-content/` and
the album checklist and price list under `config/`. The crest PNGs the
badges were baked from are not in this repo; `mg-badges.js` already carries
them.
