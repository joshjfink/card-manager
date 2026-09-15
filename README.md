# Card Manager

A Football-Manager-style career game built on the Panini World Cup 2026
sticker album. There are 980 players, 48 nations and seven colour versions of
every card. You pick a club, collect and upgrade cards, and climb a six-division
pyramid season after season.

The whole game is **one self-contained HTML file**. It needs no server, no
account and no internet connection.

Player ratings are FC-style ratings made for this game, not EA data. The game
is not affiliated with, endorsed by, or licensed by EA or Panini.

---

## Fire it up

### On a computer: open the file

Open this file in any modern browser (Chrome, Safari, Edge or Firefox):

```
cardmanager/dist/cardmanager.html
```

Double-clicking it works. That's all there is to it.

### On a phone or tablet

**The hosted copy.** The owner's copy lives at
<https://claude.ai/artifact/TxMdxLhUBSUSgYvQBPcvbr>. It opens only for the
owner's claude.ai account unless it is shared from the page's share menu.

**From your computer over Wi-Fi.** Serve the repo from the computer, then open
it on a phone on the same Wi-Fi network:

```bash
# in the repo folder, on the computer
python3 -m http.server 8080 --bind 0.0.0.0

# find the computer's address (macOS)
ipconfig getifaddr en0
```

On the phone, open `http://<that address>:8080/cardmanager/dist/cardmanager.html`.
macOS may ask whether Python can accept incoming connections; allow it. Press
Ctrl-C in the terminal to stop the server.

**Add it to the home screen** (Safari: Share → Add to Home Screen). It then opens
full screen like an app. Hold the phone either way: in portrait the board turns
itself sideways to use the long side of the screen.

### Controls

- **Touch or mouse:** tap anything.
- **Keyboard:** arrow keys (or W A S D) move the gold focus ring, and Enter or
  Space presses it.
- **M** mutes the sound.

---

## Your saves

- **New Game** asks you to pick one of six save slots, then set up the career:
  your team, starting division and difficulty. Nothing is written until you
  press START CAREER.
- **Load Game** shows the same six slots. Tap a career to carry on.
- **The game saves itself after every action.** Closing the tab loses nothing.
  To get back to the title screen, reload the page.
- **Saves live in the browser that played them**, separately for each address.
  The file on your computer, the Wi-Fi address and the hosted link are three
  separate places, each with its own saves.

To move a career between devices or browsers:

1. In the game, go to **CLUB → CAREER FILE**, then choose **SAVE CODE** (text you
   can paste anywhere) or **EXPORT A FILE**.
2. On the other device, go to **LOAD GAME → FROM A SAVE CODE**, then press
   **RESTORE FROM A CODE** and paste it. For a file, use **FROM A FILE**, then
   **IMPORT A FILE**.

A restored career goes into the slot played most recently on that device. If a
career was already there, a copy of it is kept under **CAREER FILE → BACKUPS**.

---

## Working on the game

This repo is a **one-way mirror**. The game is edited in the Gibson Store repo
it grew up in, and copied here with `tools/sync_cardmanager_repo.sh`, which is
kept in that repo. Edits made only in this repo are overwritten by the next
sync. The folders keep the same paths in both repos, so every command below
works in either.

### What you need

| For | Needs |
|---|---|
| Playing | A browser |
| Building and the headless tests | Node.js (tested on 26) and bash |
| The real-tap suite | `npm install`, plus Google Chrome at `/Applications/Google Chrome.app` |
| Rebuilding the player data | Python 3 with PyYAML |

### Run the unbundled page while editing

The development page loads the source files directly, so an edit shows up on
reload with no build step:

```bash
python3 -m http.server 8123
# then open http://localhost:8123/cardmanager/index.html
```

### Build the single file

```bash
npm run build          # same as: bash cardmanager/build.sh
```

This writes `cardmanager/dist/cardmanager.html`.

### Test

```bash
npm test               # engine gates (G14–G32), the career flow, and real-club squads; Node only

npm install            # once, for the real-tap suite
npm run tap:boot       # title → slots → setup → picker, with real taps on an iPhone-sized page
npm run tap:realclub   # a whole real-club career start, into the hub
npm run tap:welcome    # continue, load, and the slot screens
```

Every gate must stay green. Screenshots land in `mg-tap-shots/`. To run any
tap script on another device size, call the suite directly:

```bash
node tools/mg-tap-suite.js --page cardmanager/dist/cardmanager.html \
     --device desktop --script cardmanager/tap-scripts/cm-realclub.json
```

Devices are `iphone`, `android`, `ipad` and `desktop`. Tap scripts assert the
screen the player must reach, never a screen passed on the way
(`tools/tap-scripts/README.md`).

### Debug switches

Add these to the page address, for example `cardmanager.html?cmrotate=0`:

| Switch | Effect |
|---|---|
| `?cmrotate=0` | Never turn the board sideways on a portrait screen |
| `?cmdpr=1` | Draw at 1× pixel density |
| `?cmmax=1600` | Cap the board's width in CSS pixels |
| `?cmharness=1` | Use the old tap mapping that legacy tap scripts expect |

### Where things are

| Path | What it is |
|---|---|
| `cardmanager/index.html` | The page. Its script order is load-bearing, and the build reads it. |
| `cardmanager/cm-shell.js` | Canvas host: main loop, touch and keyboard input, audio, particles, phone rotation. |
| `cardmanager/cm-boot.js` | The six save slots (`cm-save-slot-N`); starts the game. |
| `cardmanager/build.sh` | Bundles everything into `cardmanager/dist/cardmanager.html`. |
| `gibson/web/static/mg-manager.js` | The game: the career rules (pure, headless, tested) and every screen. |
| `gibson/web/static/mg-manager-data.js` | Generated player and album data. Never edit by hand. |
| `gibson/web/static/mg-roster.js` | Every real club and league, merged with the album. |
| `gibson/web/static/mg-kits.js`, `mg-badges.js` | Procedural kits, and club crests as embedded images. |
| `tools/mg-harness.js`, `tools/mg-flow-test.js` | The engine gates and the career flow test. |
| `tools/mg-tap-suite.js`, `*/tap-scripts/` | The real-tap suite and its scripts. |

### The design docs come first

`.mg-manager-spec.md` and `.mg-manager-addendum.md` are the source of truth.
Each addendum overrides the spec where they conflict. Read them before changing
anything. `.mg-manager-fm.md` and `.mg-manager-depth-plan.md` hold the Football
Manager reference and the depth plan.

### Rebuilding the player data

```bash
python3 tools/build_mg_data.py
```

It regenerates `mg-manager-data.js` from `data/ea_pages.jsonl`,
`data/basicplayerdata.csv`, `data/mg-content/`, and the album checklist and
price list under `config/`, in a few seconds. The output is deterministic, so an
unchanged checkout rebuilds the committed file exactly. Then rebuild the single
file.

The real-club layer, `mg-roster.js`, holds EA SPORTS FC 27's clubs and squads,
harvested on 2026-09-15. The harvest itself is not committed. To refresh it, run
`python3 tools/fetch_ea_ratings.py` (about ten minutes, one polite request every
1.5 seconds), then `python3 tools/build_mg_data.py --roster-only` and rebuild
the single file. Without a harvest on disk the data script reports
"roster: skipped" and leaves `mg-roster.js` as it is.
