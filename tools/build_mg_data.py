#!/usr/bin/env python3
"""Build gibson/web/static/mg-manager-data.js (window.MG_DATA) for Card Manager.

Sources (addendum rules):
  config/sets/panini_wc2026_us.yaml    -> all 980 album cards (48 teams x 20 + FWC; CC skipped)
  config/prices/panini_wc2026_us.yaml  -> trade values (log-curve OVR fallback)
  data/ea_pages.jsonl                  -> top-1500 modern ratings (primary OVR source)
  data/basicplayerdata.csv             -> 18k older ratings (long-tail fallback)
  data/mg-content/bundle.json          -> content-crew bundle (merged if present)
  data/mg-content/*.json               -> individual content-crew drops (merged if present)

Position from checklist number: 1 = team crest (special badge card), 2 = GK,
3-8 DEF, 9-14 MID, 15-20 ATT; star-override table wins. Team Photo (#13) and
all FWC heritage cards are special collectibles (pos SPE).

OVR precedence: star-override > EA pages > CSV (name+nation fuzzy, accents
normalised, capped 85 as it is an older dataset) > price-derived log curve.

Deterministic: stat rolls are seeded per player id, so reruns are stable.

Ratings are FC-27-STYLE / community-sourced guesses for a family game —
NEVER EA data, and the output file says so.

Run: .venv/bin/python tools/build_mg_data.py
"""
from __future__ import annotations

import csv
import glob
import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("needs PyYAML: run with .venv/bin/python")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SET_YAML = os.path.join(ROOT, "config", "sets", "panini_wc2026_us.yaml")
PRICE_YAML = os.path.join(ROOT, "config", "prices", "panini_wc2026_us.yaml")
EA_JSONL = os.path.join(ROOT, "data", "ea_pages.jsonl")
CSV_PATH = os.path.join(ROOT, "data", "basicplayerdata.csv")
CONTENT_DIR = os.path.join(ROOT, "data", "mg-content")
OUT_PATH = os.path.join(ROOT, "gibson", "web", "static", "mg-manager-data.js")

# ---------------------------------------------------------------- name utils

def norm(s):
    """Accent-strip, lowercase, collapse punctuation -> single spaces."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", " ", s)
    return s.strip().lower()


def seeded(sid):
    h = int(hashlib.md5(sid.encode("utf-8")).hexdigest()[:8], 16)
    return random.Random(h)

# ------------------------------------------------------------ portrait seeds
# The face system (.design-portraits.md) hashes a card's IDENTITY and nothing
# else — never its nationality, rating, price, age or checklist number:
#
#     ps = FNV-1a (32-bit) over the UTF-16 code units of  name + "|" + team
#
# This is the same function the game runs (§3.1 of the design), so baking it
# here is a convenience for the module, the audit script and the golden
# vectors — never a second source of truth. seedOf(name, team) at runtime
# agrees with ps bit for bit, and the audit asserts it.
PORTRAIT_VERSION = 1

# Salt register (.design-portraits.md §3.4). APPEND-ONLY: never renumber,
# never reuse, never reorder — a retired trait's salt stays retired.
PORTRAIT_SALTS = {
    "skin": 11, "skinJitter": 12, "head": 13, "jaw": 14, "ear": 15,
    "hair": 16, "hairColor": 17, "root": 18, "brow": 19, "eye": 20,
    "iris": 21, "nose": 22, "mouth": 23, "facial": 24, "yaw": 25,
    "tilt": 26, "band": 27, "bandColor": 28, "tape": 29, "earring": 30,
    "tattoo": 31, "freckles": 32,
    "kitCollar": 40, "kitSleeve": 41, "crestJitter": 42,
}

# The 12-stop skin ramp (§5.1) and the style tokens (§5.3, §5.9). The drawing
# module owns these tables; they are mirrored here only so the authored cast
# pins can be emitted as both a hex and the ramp/table index that names it.
SKIN_RAMP = ["#f6dcc4", "#f0cfaf", "#e8c39a", "#e0b489", "#d3a171", "#c58f63",
             "#b67c52", "#a56a45", "#8e5636", "#77452b", "#5f3520", "#4a2818"]
HAIR_STYLES = ["BALD", "SHAVED", "BUZZ", "CROP", "SIDE_PART", "FRINGE",
               "CURTAINS", "QUIFF", "TOP_FADE", "AFRO_LOW", "AFRO_TALL",
               "CURLS", "WAVES", "TWISTS", "CORNROWS", "DREADS_SHORT",
               "DREADS_LONG", "PONYTAIL", "BUN", "MULLET", "LONG_LOOSE",
               "RECEDING"]
FACIAL_HAIR = ["none", "stubble_light", "stubble_heavy", "moustache", "goatee",
               "chinstrap", "beard_short", "beard_full", "beard_long"]


def _u16(s):
    """The UTF-16 code units of s — exactly what JS's charCodeAt() walks."""
    b = (s or "").encode("utf-16-be")
    return [(b[i] << 8) | b[i + 1] for i in range(0, len(b), 2)]


def fnv1a32(s):
    """FNV-1a, 32-bit, over UTF-16 code units. Matches the game's fnv1a()."""
    h = 0x811C9DC5
    for u in _u16(s):
        h ^= u
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def assert_bmp(s, where):
    """§12.1's astral gate: charCodeAt and code points must agree."""
    for ch in s or "":
        if ord(ch) > 0xFFFF:
            sys.exit("astral character in %s: %r — the portrait seed's UTF-16 "
                     "walk needs a BMP-only roster" % (where, s))


def portrait_seed(name, team):
    assert_bmp(name, "card name")
    return fnv1a32(u"%s|%s" % (name, team))


def skin_stop(hexcol):
    """Nearest stop on the ramp, so an authored skin still has S.shade/light."""
    def rgb(h):
        h = h.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    r, g, b = rgb(hexcol)
    best, bi = None, 0
    for i, stop in enumerate(SKIN_RAMP):
        sr, sg, sb = rgb(stop)
        d = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2
        if best is None or d < best:
            best, bi = d, i
    return bi

# ------------------------------------------------------- nation alias table

# section code -> normalised nation-name aliases seen in EA labels / CSV
NATION_ALIASES = {
    "ALG": ["algeria"], "ARG": ["argentina"], "AUS": ["australia"],
    "AUT": ["austria"], "BEL": ["belgium"],
    "BIH": ["bosnia and herzegovina", "bosnia herzegovina", "bosnia"],
    "BRA": ["brazil"], "CAN": ["canada"],
    "CIV": ["cote d ivoire", "cote divoire", "ivory coast"],
    "COD": ["dr congo", "congo dr", "democratic republic of congo", "congo"],
    "COL": ["colombia"], "CPV": ["cape verde", "cape verde islands", "cabo verde"],
    "CRO": ["croatia"], "CUW": ["curacao"],
    "CZE": ["czechia", "czech republic"], "ECU": ["ecuador"], "EGY": ["egypt"],
    "ENG": ["england"], "ESP": ["spain"], "FRA": ["france"], "GER": ["germany"],
    "GHA": ["ghana"], "HAI": ["haiti"], "IRN": ["iran", "ir iran"],
    "IRQ": ["iraq"], "JOR": ["jordan"], "JPN": ["japan"],
    "KOR": ["south korea", "korea republic", "korea"],
    "KSA": ["saudi arabia"], "MAR": ["morocco"], "MEX": ["mexico"],
    "NED": ["netherlands", "holland"], "NOR": ["norway"],
    "NZL": ["new zealand"], "PAN": ["panama"], "PAR": ["paraguay"],
    "POR": ["portugal"], "QAT": ["qatar"], "RSA": ["south africa"],
    "SCO": ["scotland"], "SEN": ["senegal"], "SUI": ["switzerland"],
    "SWE": ["sweden"], "TUN": ["tunisia"], "TUR": ["turkiye", "turkey"],
    "URU": ["uruguay"], "USA": ["united states", "usa", "united states of america"],
    "UZB": ["uzbekistan"],
}
NATION_LOOKUP = {}
for _code, _names in NATION_ALIASES.items():
    for _n in _names:
        NATION_LOOKUP[_n] = _code

# code -> ISO2 for flag emoji (ENG/SCO get subdivision flags)
ISO2 = {
    "ALG": "DZ", "ARG": "AR", "AUS": "AU", "AUT": "AT", "BEL": "BE",
    "BIH": "BA", "BRA": "BR", "CAN": "CA", "CIV": "CI", "COD": "CD",
    "COL": "CO", "CPV": "CV", "CRO": "HR", "CUW": "CW", "CZE": "CZ",
    "ECU": "EC", "ESP": "ES", "EGY": "EG", "FRA": "FR", "GER": "DE",
    "GHA": "GH", "HAI": "HT", "IRN": "IR", "IRQ": "IQ", "JOR": "JO",
    "JPN": "JP", "KOR": "KR", "KSA": "SA", "MAR": "MA", "MEX": "MX",
    "NED": "NL", "NOR": "NO", "NZL": "NZ", "PAN": "PA", "PAR": "PY",
    "POR": "PT", "QAT": "QA", "RSA": "ZA", "SEN": "SN", "SUI": "CH",
    "SWE": "SE", "TUN": "TN", "TUR": "TR", "URU": "UY", "USA": "US",
    "UZB": "UZ",
}


def flag_emoji(code):
    if code == "ENG":
        return "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"
    if code == "SCO":
        return "\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F"
    iso = ISO2.get(code)
    if not iso:
        return "⚽"
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso)

# fallback kit colours per country (c1 shirt, c2 trim) — flag-derived, authored
KIT = {
    "ALG": ["#0f7a3d", "#ffffff"], "ARG": ["#6cace4", "#12246e"],
    "AUS": ["#ffb81c", "#00843d"], "AUT": ["#ef3340", "#ffffff"],
    "BEL": ["#e30613", "#fdda25"], "BIH": ["#002f6c", "#fecb00"],
    "BRA": ["#ffdc02", "#009739"], "CAN": ["#d80621", "#ffffff"],
    "CIV": ["#ff8200", "#009a44"], "COD": ["#007fff", "#f7d618"],
    "COL": ["#fcd116", "#003893"], "CPV": ["#003893", "#f7d116"],
    "CRO": ["#ed1c24", "#ffffff"], "CUW": ["#002b7f", "#f9e814"],
    "CZE": ["#d7141a", "#11457e"], "ECU": ["#ffdd00", "#034ea2"],
    "EGY": ["#ce1126", "#ffffff"], "ENG": ["#ffffff", "#0b2c5f"],
    "ESP": ["#c60b1e", "#f5c518"], "FRA": ["#22346b", "#ffffff"],
    "GER": ["#f4f4f0", "#1c1c1c"], "GHA": ["#ffffff", "#ce1126"],
    "HAI": ["#00209f", "#d21034"], "IRN": ["#ffffff", "#239f40"],
    "IRQ": ["#007a3d", "#ffffff"], "JOR": ["#ce1126", "#ffffff"],
    "JPN": ["#000f9f", "#ffffff"], "KOR": ["#cd2e3a", "#0f2540"],
    "KSA": ["#006c35", "#ffffff"], "MAR": ["#c1272d", "#006233"],
    "MEX": ["#006847", "#ce1126"], "NED": ["#ff7318", "#ffffff"],
    "NOR": ["#ba0c2f", "#1c2a56"], "NZL": ["#ffffff", "#000000"],
    "PAN": ["#da121a", "#072357"], "PAR": ["#d52b1e", "#0038a8"],
    "POR": ["#da291c", "#046a38"], "QAT": ["#8a1538", "#ffffff"],
    "RSA": ["#ffb612", "#007749"], "SCO": ["#0065bf", "#ffffff"],
    "SEN": ["#00853f", "#fdef42"], "SUI": ["#da291c", "#ffffff"],
    "SWE": ["#fecc02", "#006aa7"], "TUN": ["#e70013", "#ffffff"],
    "TUR": ["#e30a17", "#ffffff"], "URU": ["#55b5e5", "#0b2c5f"],
    "USA": ["#3f5aa8", "#ffffff"], "UZB": ["#1eb53a", "#0099b5"],
    "FWC": ["#e9bf63", "#17141a"],
}

# ------------------------------------------------- star override table (~44)
# Famous names always rate right. FC-27-STYLE community numbers — NOT EA data.
# name(normalised) -> (ovr, pos-or-None)
STAR_OVR = {
    "lionel messi": (92, "ATT"),
    "erling haaland": (91, "ATT"),
    "kylian mbappe": (91, "ATT"),
    "mohamed salah": (90, "ATT"),
    "lamine yamal": (89, "ATT"),
    "harry kane": (88, "ATT"),
    "christian pulisic": (84, "ATT"),
    "rodri": (90, "MID"),
    "jude bellingham": (90, "MID"),
    "virgil van dijk": (89, "DEF"),
    "thibaut courtois": (89, "GK"),
    "luka modric": (86, "MID"),
    "vinicius junior": (90, "ATT"),
    "vinicius jr": (90, "ATT"),
    "kevin de bruyne": (87, "MID"),
    "florian wirtz": (89, "MID"),
    "jamal musiala": (88, "MID"),
    "joshua kimmich": (88, "MID"),
    "bukayo saka": (87, "ATT"),
    "phil foden": (86, "MID"),
    "martin odegaard": (87, "MID"),
    "lautaro martinez": (89, "ATT"),
    "julian alvarez": (87, "ATT"),
    "achraf hakimi": (89, "DEF"),
    "federico valverde": (88, "MID"),
    "alexander isak": (87, "ATT"),
    "cristiano ronaldo": (86, "ATT"),
    "bruno fernandes": (87, "MID"),
    "ruben dias": (87, "DEF"),
    "bernardo silva": (86, "MID"),
    "declan rice": (87, "MID"),
    "cole palmer": (86, "ATT"),
    "alisson": (89, "GK"),
    "marc andre ter stegen": (87, "GK"),
    "mike maignan": (87, "GK"),
    "aurelien tchouameni": (85, "MID"),
    "eduardo camavinga": (85, "MID"),
    "enzo fernandez": (86, "MID"),
    "alexis mac allister": (86, "MID"),
    "frenkie de jong": (86, "MID"),
    "pedri": (87, "MID"),
    "dani olmo": (85, "MID"),
    "nico williams": (85, "ATT"),
    "kaoru mitoma": (84, "ATT"),
    "takefusa kubo": (84, "ATT"),
    "raphinha": (88, "ATT"),
    "casemiro": (83, "MID"),
    "romelu lukaku": (84, "ATT"),
    "jeremy doku": (85, "ATT"),
    "xavi simons": (84, "MID"),
    "cody gakpo": (85, "ATT"),
    "gabriel magalhaes": (86, "DEF"),
    "alphonso davies": (85, "DEF"),
    "weston mckennie": (81, "MID"),
    "antonee robinson": (81, "DEF"),
    "santiago gimenez": (81, "ATT"),
    "edson alvarez": (81, "MID"),
    "jefferson lerma": (79, "MID"),
    "heung min son": (85, "ATT"),
    "son heung min": (85, "ATT"),
    "mohammed kudus": (83, "ATT"),
    "jordan pickford": (84, "GK"),
    "john stones": (84, "DEF"),
    "william saliba": (86, "DEF"),
}

# TUNED — the content crew filed Kane's whole bank under "goal", but every one
# of those lines describes a shot going over the bar. Shipped as "wide".
STAR_COMM_BANK = {"Kane": "wide"}
STAR_COMM_FIX = {
    "That one is still climbing in minute {minute}.":
        "That one is still climbing. Someone call NASA.",
}

# TUNED — day one is fixed, not re-rolled: the family collection is anchored on
# the USA squad. Shape is the spec's GK2 / DEF5 / MID4 / ATT3, all 73-78, no
# quirks, no unlockables. The picker below still runs as the fallback if any of
# these ids ever leaves the album.
PINNED_STARTERS = ["usa16", "usa2", "egy2", "usa3", "usa6", "mex3", "aus8",
                   "cze8", "usa9", "usa14", "aus14", "swe12", "usa18", "cuw15"]

# quirks attach by album name (engine mechanic ids per spec [ENGINE §7])
QUIRK_BY_NAME = {
    "erling haaland": "haaland_ice",
    "harry kane": "kane_pens",
}

# ------------------------------------------------------------- cast (the 9)
# Verbatim from the spec's roster rows (feat ids per the reconciled set).
CAST = [
    ["maradona", "Maradona", "ATT", 95, 94, 42, "#6cace4", "#12246e",
     {"quirk": "maradona_hand", "unlock": "cup-champ", "legend": 1}],
    ["suarez", "Suárez", "ATT", 88, 90, 32, "#55b5e5", "#0b2c5f",
     {"quirk": "suarez_hand", "unlock": "bite-back"}],
    ["wemby", "Wembanyama", "GK", 88, 25, 94, "#1d428a", "#c4ced4",
     {"quirk": "giant_keeper", "unlock": "wall-3", "big": 1}],
    ["dort", "Lu Dort", "DEF", 83, 15, 95, "#0072ce", "#ef3b24",
     {"quirk": "big_tackle", "unlock": "lockdown"}],
    ["caruso", "Caruso", "DEF", 80, 12, 93, "#ce1141", "#fdb927",
     {"quirk": "big_tackle", "unlock": "hustle"}],
    ["phoenix", "Phoenix", "GK", 80, 10, 84, "#d4842f", "#b0631c",
     {"quirk": "phoenix_catch", "unlock": "clean-5", "dog": 1}],
    ["gibson", "Gibson", "ATT", 78, 80, 30, "#d6202a", "#e9bf63",
     {"unlock": "first-win"}],
    ["ellis", "Ellis", "ATT", 76, 78, 22, "#f2c200", "#d6202a",
     {"unlock": "comeback-win", "small": 1}],
    ["grandpa", "Grandpa", "GK", 70, 12, 68, "#e0a32e", "#3a2f22",
     {"unlock": "season-done", "full": "Grandpa Fink"}],
]

# ------------------------------------------- cast portraits (authored, §7.4)
# The family cast must look the same in Card Manager as they do on the shop
# floor, so their faces are PINNED, not rolled: the values below are the ones
# minigames.js's CAST already draws with, plus the design's authored rows.
# Only the named traits are pinned — brows, eyes, nose, mouth, yaw, tilt and
# the accessory lanes still come from the card's own seed, which is what keeps
# a pinned face from looking like a mannequin.
#
#   sk/ski  skin hex + its nearest ramp stop (0-11) for derived shade/light
#   hc      hair colour hex          hs/hsi  hair style token + index
#   fh/fhi  facial-hair token + index
#   hd      head scale        sd  shoulder scale        nk  extra neck, in R
#   bd      body flag in drawChar's own language: "small" | "big"
#   st      life stage — "child" | "elder" | "dog" (line work only; it never
#           exaggerates a feature — .design-portraits.md §11.4 rule 1)
#   var     "dog" = Phoenix, who is not drawn from the human stack at all
CAST_PORTRAIT = {
    # the two kids: bigger head on a smaller body is child proportion, and it
    # is the only body variation the respect rules allow (§7.4)
    "gibson":  {"sk": "#e8c39a", "hc": "#5b3a1e", "hs": "CROP", "fh": "none",
                "hd": 1.06, "st": "child"},
    "ellis":   {"sk": "#e8c39a", "hc": "#c98a3a", "hs": "FRINGE", "fh": "none",
                "hd": 1.10, "bd": "small", "st": "child"},
    # the only authored silver head in the game — silver is never an age proxy
    # anywhere else (§5.4)
    "grandpa": {"sk": "#e3bd93", "hc": "#cfcfcf", "hs": "RECEDING",
                "fh": "moustache", "st": "elder"},
    # Phoenix is a dog: snout, ears and nose dot from drawChar, in a keeper
    # shirt. No skin, no hair, no facial hair.
    "phoenix": {"var": "dog", "st": "dog", "fur": "#d4842f", "furD": "#b0631c",
                "cream": "#f7ead3"},
    "maradona": {"sk": "#e3bd93", "hc": "#3a2a1c", "hs": "CURLS", "fh": "none"},
    "suarez":  {"sk": "#c99368", "hc": "#2b1c12", "hs": "CROP",
                "fh": "stubble_light"},
    # 7 foot of goalkeeper: the tell is shoulders and neck, never the face
    "wemby":   {"sk": "#8e5636", "hc": "#16130f", "hs": "BUZZ", "fh": "none",
                "sd": 1.08, "nk": 0.10, "bd": "big"},
    "dort":    {"sk": "#77452b", "hc": "#241c16", "hs": "TWISTS",
                "fh": "beard_short"},
    "caruso":  {"sk": "#f0cfaf", "hc": "#3a2718", "hs": "RECEDING",
                "fh": "beard_full"},
}


def cast_portrait(cid):
    """Expand an authored pin into the px blob the card carries."""
    pin = CAST_PORTRAIT.get(cid)
    if not pin:
        return None
    px = dict(pin)
    px["pin"] = 1                      # authored — the module must not roll these
    if px.get("sk"):
        px["ski"] = skin_stop(px["sk"])
    if px.get("hs"):
        px["hsi"] = HAIR_STYLES.index(px["hs"])
    if px.get("fh"):
        px["fhi"] = FACIAL_HAIR.index(px["fh"])
    return px


# --------------------------------------------------------------- load album

def load_album():
    with open(SET_YAML) as f:
        doc = yaml.safe_load(f)
    sections = doc["sections"]
    players = doc["players"]
    teams = {}
    for ref, name in players.items():
        code, num = ref.split()
        if code == "CC":
            continue  # skipped as ever
        teams.setdefault(code, {})[int(num)] = name
    return sections, teams


def load_prices():
    with open(PRICE_YAML) as f:
        doc = yaml.safe_load(f)
    out = {}
    for ref, colours in (doc.get("by_sticker") or {}).items():
        if isinstance(colours, dict) and "white" in colours:
            out[ref] = float(colours["white"])
    return out


def load_ea():
    """index: fullname -> [(ovr, nation_code)], (last, nation) -> [ovr], and
    an entity index (date of birth + club) keyed three ways. Nation is part of
    every entity key: an age or a club-mate link must never come from a loose
    name match."""
    by_name, by_last = {}, {}
    ent_full, ent_last, ent_il = {}, {}, {}
    with open(EA_JSONL) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            page = json.loads(line)
            for it in page.get("items", []):
                ovr = it.get("overallRating")
                if not ovr:
                    continue
                nat = it.get("nationality") or {}
                natlbl = norm((nat.get("label") if isinstance(nat, dict) else None)
                              or it.get("nationalityLabel") or "")
                ncode = NATION_LOOKUP.get(natlbl)
                first = norm(it.get("firstName") or "")
                last = norm(it.get("lastName") or "")
                common = norm(it.get("commonName") or "")
                names = set()
                if first or last:
                    names.add((first + " " + last).strip())
                if common:
                    names.add(common)
                for n in names:
                    by_name.setdefault(n, []).append((ovr, ncode))
                if last and ncode:
                    by_last.setdefault((last, ncode), []).append(ovr)
                    if common:
                        by_last.setdefault((norm(common.split()[-1]), ncode),
                                           []).append(ovr)
                if ncode:
                    team = it.get("team")
                    rec = {"bd": it.get("birthdate"),
                           "team": team.get("label") if isinstance(team, dict) else None}
                    for n in names:
                        ent_full.setdefault((n, ncode), []).append(rec)
                        toks = n.split()
                        if toks:
                            ent_last.setdefault((toks[-1], ncode), []).append(rec)
                            ent_il.setdefault((toks[0][0], toks[-1], ncode),
                                              []).append(rec)
    return by_name, by_last, (ent_full, ent_last, ent_il)


def load_csv():
    """index: (fullnorm, nation)->ovr, (initial,last,nation)->[ovr], (last,nation)->[ovr]"""
    full, init_last, last_only = {}, {}, {}
    with open(CSV_PATH, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            name = row.get("Name") or ""
            try:
                ovr = int(row.get("Overall") or 0)
            except ValueError:
                continue
            ncode = NATION_LOOKUP.get(norm(row.get("Nationality") or ""))
            if not ovr or not ncode:
                continue
            n = norm(name)
            toks = n.split()
            if not toks:
                continue
            full.setdefault((n, ncode), []).append(ovr)
            last = toks[-1]
            initial = toks[0][0] if toks else ""
            init_last.setdefault((initial, last, ncode), []).append(ovr)
            last_only.setdefault((last, ncode), []).append(ovr)
    return full, init_last, last_only

# ---------------------------------------------------------------- OVR logic

def price_ovr(value):
    v = max(float(value or 0.29), 0.15)
    return int(max(56, min(91, round(70 + 7.4 * math.log(v)))))


def resolve_ovr(name, code, price, ea_name, ea_last, csv_full, csv_il, csv_lo):
    ovr, src = _resolve_ovr(name, code, price, ea_name, ea_last,
                            csv_full, csv_il, csv_lo)
    return max(56, min(95, int(ovr))), src


def _resolve_ovr(name, code, price, ea_name, ea_last, csv_full, csv_il, csv_lo):
    n = norm(name)
    if n in STAR_OVR:
        return STAR_OVR[n][0], "star"
    # EA full-name
    hits = ea_name.get(n)
    if hits:
        same = [o for (o, c) in hits if c == code]
        if same:
            return max(same), "ea"
        if len(set(o for o, _ in hits)) >= 1 and len(hits) == 1:
            return hits[0][0], "ea"
    # EA last-name + nation (unique only)
    toks = n.split()
    if toks:
        lhits = ea_last.get((toks[-1], code))
        if lhits and len(lhits) == 1:
            return lhits[0], "ea"
    # CSV full name + nation
    fh = csv_full.get((n, code))
    if fh:
        return min(max(fh), 85), "csv"
    # CSV initial+last+nation
    if toks:
        ih = csv_il.get((toks[0][0], toks[-1], code))
        if ih and len(ih) == 1:
            return min(ih[0], 85), "csv"
        lh = csv_lo.get((toks[-1], code))
        if lh and len(lh) == 1:
            return min(lh[0], 85), "csv"
    return price_ovr(price), "price"


def pos_for(code, num, name):
    n = norm(name)
    if n in STAR_OVR and STAR_OVR[n][1]:
        base = STAR_OVR[n][1]
    elif num == 2:
        base = "GK"
    elif 3 <= num <= 8:
        base = "DEF"
    elif 9 <= num <= 14:
        base = "MID"
    elif 15 <= num <= 20:
        base = "ATT"
    else:
        base = "SPE"
    if num == 1 or code == "FWC" or name.endswith("Team Photo") \
            or name.endswith("Team Crest"):
        return "SPE"
    return base


def special_kind(code, num, name):
    if name.endswith("Team Crest") or num == 1:
        return "crest"
    if name.endswith("Team Photo"):
        return "photo"
    if code == "FWC":
        return "heritage"
    return None


def derive_stats(sid, pos, ovr):
    """Spec [DATA] stat generation, seeded per card id."""
    r = seeded(sid)
    if pos == "ATT":
        sho = ovr + r.randint(-2, 4)
        dfn = r.randint(24, 45)
        dfn = min(dfn, 50)
    elif pos == "MID":
        if int(hashlib.md5(sid.encode()).hexdigest()[8:10], 16) % 2 == 0:
            sho = ovr - r.randint(4, 10)      # playmaker half
            dfn = r.randint(40, 62)
        else:
            sho = ovr - r.randint(10, 16)     # box-to-box half
            dfn = ovr - r.randint(6, 14)
    elif pos == "DEF":
        dfn = ovr + r.randint(0, 4)
        sho = r.randint(28, 62)
    elif pos == "GK":
        dfn = ovr + r.randint(-2, 2)
        sho = min(r.randint(8, 25), 30)
    else:  # SPE — collectible, not a footballer; tiny numbers, big charm
        sho = r.randint(1, 9)
        dfn = r.randint(1, 9)
    return max(1, min(99, int(sho))), max(1, min(99, int(dfn)))


def short_name(name):
    """Card-face name <= 11 chars: prefer surname, trim from the front."""
    name = name.replace(" Team Crest", " Crest").replace(" Team Photo", " Photo")
    if len(name) <= 11:
        return name
    parts = name.split()
    for i in range(1, len(parts)):
        cand = " ".join(parts[i:])
        if len(cand) <= 11:
            return cand
    return parts[-1][:11]

# ------------------------------------------------------- content-crew merge

def load_content():
    out = {}
    bundle = os.path.join(CONTENT_DIR, "bundle.json")
    if os.path.exists(bundle):
        try:
            out["bundle"] = json.load(open(bundle))
        except (ValueError, OSError):
            pass
    if os.path.isdir(CONTENT_DIR):
        for fn in sorted(os.listdir(CONTENT_DIR)):
            if fn == "bundle.json" or not fn.endswith(".json"):
                continue
            try:
                out[fn[:-5]] = json.load(open(os.path.join(CONTENT_DIR, fn)))
            except (ValueError, OSError):
                pass
    return out


CODE_RE = re.compile(r"^[A-Z]{3}$")


def _club_identity(d):
    """Normalise one content-crew club record (four shapes seen in the wild)."""
    out = {}
    mgr = d.get("manager")
    if isinstance(mgr, dict):
        out["manager"] = mgr.get("name")
        if mgr.get("card"):
            out["managerCard"] = mgr["card"]
    elif isinstance(mgr, str):
        out["manager"] = mgr
    if d.get("managerName"):
        out["manager"] = d["managerName"]
    for k in ("style", "motto", "nickname"):
        if d.get(k):
            out[k] = d[k]
    if isinstance(d.get("lines"), dict):
        out["lines"] = d["lines"]
    taunts = d.get("taunt") or ([d["tauntLine"]] if d.get("tauntLine") else None)
    if taunts:
        out["taunts"] = taunts if isinstance(taunts, list) else [taunts]
    colors = d.get("colors") or ([d["c1"], d["c2"]] if d.get("c1") and d.get("c2") else None)
    if colors:
        out["colors"] = colors
    return out


def collect_content_clubs(content):
    """code -> merged identity, bundle first, richer per-batch files overlaid."""
    merged = {}

    def absorb(records):
        for code, d in records:
            if not (code and CODE_RE.match(code) and isinstance(d, dict)):
                continue
            ident = _club_identity(d)
            merged.setdefault(code, {}).update(
                {k: v for k, v in ident.items() if v})

    bundle = content.get("bundle") or {}
    if isinstance(bundle.get("clubs"), list):
        absorb([(c.get("code") or c.get("id"), c) for c in bundle["clubs"]])
    for key in sorted(content):
        if key == "bundle" or not key.startswith("clubs"):
            continue
        blob = content[key]
        if not isinstance(blob, dict):
            continue
        if isinstance(blob.get("clubs"), list):
            absorb([(c.get("code") or c.get("id"), c) for c in blob["clubs"]])
        elif isinstance(blob.get("clubs"), dict):
            absorb(list(blob["clubs"].items()))
        elif isinstance(blob.get("countries"), list):
            absorb([(c.get("code") or c.get("id"), c) for c in blob["countries"]])
        else:  # dict keyed by code at top level
            absorb([(k, v) for k, v in blob.items() if isinstance(v, dict)])
    return merged

# ------------------------------------------------------------ static tables

PARALLELS = [
    {"id": "white", "frame": "#f4f1e8", "glow": [244, 241, 232], "score": 40},
    {"id": "blue", "frame": "#3f77c9", "glow": [63, 119, 201], "score": 50},
    {"id": "red", "frame": "#d6202a", "glow": [214, 32, 42], "score": 60},
    {"id": "orange", "frame": "#e8842c", "glow": [232, 132, 44], "score": 70},
    {"id": "purple", "frame": "#8a4fc9", "glow": [138, 79, 201], "score": 80},
    {"id": "green", "frame": "#2f8f52", "glow": [47, 143, 82], "score": 90},
    {"id": "black", "frame": "#17141a", "glow": [233, 191, 99], "score": 99},
]

FORMATIONS = {
    "3-3-2": {"label": "Classic", "slots": ["GK", "D1", "D2", "D3", "M1", "M2", "M3", "A1", "A2"]},
    "2-3-3": {"label": "All-Out", "slots": ["GK", "D1", "D2", "M1", "M2", "M3", "A1", "A2", "A3"]},
    "4-3-1": {"label": "The Bus", "slots": ["GK", "D1", "D2", "D3", "D4", "M1", "M2", "M3", "A1"]},
}

# TUNED VALUES — patched into the shipped data file by the balance crew and
# folded back here so a rebuild cannot undo them. The wide spec spread
# (1.25/1.15/1.10/0.85) made mentality dominate the result; these are the
# numbers the harness balance gates were last measured against.
MENTALITY = {
    "attacking": {"tempo": 1.10, "create": 1.03, "convert": 1, "prevent": 0.97},
    "balanced": {"tempo": 1.00, "create": 1.00, "convert": 1.00, "prevent": 1.00},
    "defensive": {"tempo": 0.96, "create": 0.96, "convert": 1, "prevent": 1.05},
}

QUIRKS = {
    "kane_pens": {"name": "Nerves of Steel*", "desc": "Penalty master. Mostly. 30% sails over; otherwise +10% to score."},
    "suarez_hand": {"name": "Cheeky Hands", "desc": "10% of his chances get ruled out. He says it was an accident."},
    "maradona_hand": {"name": "Hand of God", "desc": "4% of chances become one very cheeky goal."},
    "haaland_ice": {"name": "Ice Cold", "desc": "+8% to score open play; penalties a flat 85%."},
    "phoenix_catch": {"name": "Good Dog", "desc": "Catches 10% of shots before they happen; 20% of penalties."},
    "giant_keeper": {"name": "The Wall", "desc": "Shots at him score 5% less; penalties 8% less. He just… reaches."},
    "big_tackle": {"name": "Big Tackle", "desc": "10% chance to flatten an attack. Family-safe. Mostly."},
}

ECONOMY = {
    "match": {"win": 60, "draw": 25, "loss": 10, "goal": 5, "goalCap": 5,
              "cleanSheet": 15, "streakPer": 5, "streakCap": 25},
    "matchFeats": {"hat_trick": 20, "comeback_win": 25, "five_star": 20,
                   "giant_kill": 40, "shutout_siege": 20},
    "seasonPos": [400, 280, 200, 160, 120, 100, 80, 60],
    "cup": {"winner": 240, "runnerUp": 120, "semi": 60},
    "friendly": {"each": 5, "seasonCap": 30},
    "training": [
        {"to": "blue", "coins": 60, "apps": 2},
        {"to": "red", "coins": 150, "apps": 3},
        {"to": "orange", "coins": 350, "apps": 4},
        {"to": "purple", "coins": 750, "apps": 5},
        {"to": "green", "coins": 1500, "apps": 6},
        {"to": "black", "coins": 3000, "apps": 8, "requires": "black_licence"},
    ],
    "packs": [
        {"id": "bronze", "cost": 100, "cards": 3,
         "rating": [["70-79", 75], ["80-84", 22], ["85+", 3]],
         "parallel": [["white", 80], ["blue", 15], ["red", 4], ["orange", 1]],
         "pity": "every 5th bronze guarantees an un-owned, un-gated card if any remain"},
        {"id": "silver", "cost": 300, "cards": 4,
         "rating": [["70-79", 40], ["80-84", 40], ["85-89", 17], ["90+", 3]],
         "parallel": [["white", 60], ["blue", 25], ["red", 10], ["orange", 4], ["purple", 1]]},
        {"id": "gold", "cost": 750, "cards": 5, "guarantee": "one 88+",
         "rating": [["80-84", 40], ["85-89", 40], ["90+", 20]],
         "parallel": [["white", 45], ["blue", 30], ["red", 15], ["orange", 8], ["purple", 2]]},
        {"id": "legend", "prizeOnly": True, "cards": 1, "guarantee": "90+",
         "parallel": [["white", 40], ["blue", 30], ["red", 18], ["orange", 9], ["purple", 3]]},
    ],
    "dupes": {"bands": [["<80", 15], ["80-84", 30], ["85-89", 60], ["90+", 120]],
              "higherParallelUpgrades": True},
    "squadRule": {"maxBlackInXI": 1},
    "matchSeconds": 40,
    "cardSpace": {"players": 980, "parallels": 7, "combos": 6860},
    "transfer": {"bands": [[60, 8], [70, 20], [80, 60], [85, 150], [90, 400], [95, 900]],
                 "formSwing": 0.15, "note": "engine interpolates; form/goals/league pos move value +-15%"},
}

SPEC_FEATS = [
    {"id": "first-win", "name": "First Whistle", "check": "M", "reward": {"unlock": "gibson"}, "how": "Win your first career match."},
    {"id": "comeback-win", "name": "Never Give Up", "check": "M", "reward": {"unlock": "ellis"}, "how": "Win a match after being behind."},
    {"id": "clean-5", "name": "Guard Dog", "check": "M", "reward": {"unlock": "phoenix"}, "how": "Keep 5 career clean sheets."},
    {"id": "season-done", "name": "The Long Game", "check": "S", "reward": {"unlock": "grandpa"}, "how": "Complete a full season."},
    {"id": "lockdown", "name": "The Lockdown", "check": "M", "reward": {"unlock": "dort"}, "how": "Win; opponent 10+ shots, 0 goals."},
    {"id": "hustle", "name": "The Hustle", "check": "M", "reward": {"unlock": "caruso"}, "how": "Win with a squad rated 3+ below the opponent."},
    {"id": "wall-3", "name": "The Wall", "check": "M", "reward": {"unlock": "wemby"}, "how": "3 straight wins without conceding."},
    {"id": "bite-back", "name": "Bite Back", "check": "M", "reward": {"unlock": "suarez"}, "how": "Beat Uruguay in a competitive match."},
    {"id": "cup-champ", "name": "Champion of Champions", "check": "S", "reward": {"unlock": "maradona"}, "how": "Win the Gibson Cup."},
    {"id": "goals-10", "name": "Ten Goals", "check": "M", "reward": {"coins": 100}, "how": "Score 10 career goals."},
    {"id": "goals-50", "name": "Fifty Goals", "check": "M", "reward": {"pack": "gold"}, "how": "Score 50 career goals."},
    {"id": "first-blue", "name": "First Steps", "check": "M", "reward": {"coins": 50}, "how": "Train your first card to blue."},
    {"id": "black-card", "name": "One of One", "check": "M", "reward": {"coins": 1000}, "how": "Own a black card."},
    {"id": "squad-85", "name": "Galaxy XI", "check": "M", "reward": {"pack": "gold"}, "how": "Field an XI averaging 85+."},
    {"id": "hotseat-10", "name": "Family Derby", "check": "M", "reward": {"coins": 250}, "how": "Play 10 hot-seat friendlies."},
    {"id": "undefeated", "name": "Invincibles", "check": "S", "reward": {"pack": "gold"}, "how": "Finish a season unbeaten."},
    {"id": "pack-20", "name": "Pack Rat", "check": "M", "reward": {"coins": 200}, "how": "Open 20 packs."},
    {"id": "boss-down", "name": "Boss Down", "check": "M", "reward": {"coins": 200}, "how": "Beat the top-ranked team."},
    {"id": "draft-day", "name": "Draft Day", "check": "M", "reward": {"coins": 75}, "how": "Win a Draft Duel."},
    {"id": "hat-hero", "name": "Hat-Trick Hero", "check": "M", "reward": {"coins": 50}, "how": "One player scores three in a match."},
    {"id": "collector-100", "name": "Collector", "check": "M", "reward": {"pack": "silver"}, "how": "Own 100 different cards."},  # TUNED: its rewardText says "Silver pack"
]

COMMENTARY = {
    "kickoff": ["And we're off! {team} get us started.",
                "The whistle goes — game on!",
                "Here we go. Boots laced, cards shuffled."],
    "half_time": ["Half time! Orange slices for everyone.",
                  "The break — time for a team talk."],
    "full_time": ["Full time! That's all, folks.",
                  "The whistle goes for the last time today."],
    "goal": ["GOAL! {p} finds the net!",
             "{p} scores — the bench goes wild!",
             "It's in! {p} with a beauty!",
             "GOAL for {team}! {p} takes a bow.",
             "{p} buries it. No doubt about that one.",
             "What a hit, {p}! WHAT a hit!",
             "Top corner from {p}. Kiss it goodbye.",
             "{p} taps it home — easy as you like.",
             "A scramble, a poke — {p} gets the glory!",
             "{p} strikes and {team} are up and dancing!"],
    "save": ["{k} says no!",
             "Great save by {k}!",
             "{k} palms it away — brilliant!",
             "Smothered by {k}. Safe hands.",
             "{k} gets fingertips to it!",
             "Straight at {k}, who holds on tight.",
             "{k} dives full stretch and denies {p}!",
             "How did {k} keep that out?!"],
    "post": ["Off the post! So close for {p}.",
             "CLANG! {p} rattles the woodwork.",
             "The crossbar saves {team}'s day — sorry, {p}.",
             "{p} hits the frame — inches away!"],
    "wide": ["{p} drags it wide.",
             "Over the bar from {p}.",
             "Wide! {p} can't look.",
             "{p} slices it into the crowd.",
             "Not this time, {p} — just past the post."],
    "big_tackle": ["CRUNCH — a big fair tackle stops it cold!",
                   "What a challenge! Clean as a whistle.",
                   "Stopped! A slide tackle straight out of the textbook.",
                   "The attack ends right there. Massive tackle."],
    "knock": ["{p} is knocked over — he's okay, he's off for a rest.",
              "Down goes {p} — he's fine, just needs a breather."],
    "sub": ["Fresh legs — a change for {team}.",
            "{p} comes on. Straight into the action!"],
    "penalty_awarded": ["PENALTY! The ref points to the spot!",
                        "Down in the box — penalty to {team}!",
                        "A spot kick! The keeper stares down {p}."],
    "pen_goal": ["{p} sends the keeper the wrong way — GOAL!",
                 "Cool as ice, {p} converts.",
                 "{p} smashes the penalty home!"],
    "pen_saved": ["SAVED! {k} guesses right!",
                  "{k} dives and keeps it out — hero!",
                  "The penalty is saved — {k} is mobbed!"],
    "pen_over": ["Over the bar! {p} can't believe it.",
                 "Sky high! {p} looks at his boots."],
    "pen_caught": ["{k} CATCHES the penalty. Just catches it.",
                   "Straight into {k}'s gloves. Extraordinary."],
    "ruled_out": ["No goal! The ref saw a sneaky hand.",
                  "Ruled out — handball, says the whistle."],
    "hand_of_god": ["A little hand… a big goal. Very cheeky, {p}.",
                    "{p} punches it in! The ref missed it — history repeats."],
    "phoenix_catch": ["Caught before it was even a shot. Good dog, {k}!",
                      "{k} plucks it out of the air. Tail wagging."],
    "shootout_kick": ["{p} steps up…",
                      "The walk from halfway — {p}'s turn.",
                      "Deep breath, {p}. The whole shop watches."],
    "buildup": [], "half_chance": [],
}

PLAYER_COMMENTARY = {
    "haaland": {"goal": ["Of course he does. Of course he does.",
                         "The machine scores again. Ice cold."]},
    "yamal": {"goal": ["GOLAZO! Yamal paints one into the corner!",
                       "He's a kid with a paintbrush — golazo, Yamal!"]},
    "ellis": {"goal": ["Nutmeg first, goal second — Ellis, take a bow!",
                       "Ellis! Small player, enormous goal!"]},
    "gibson": {"goal": ["Stepover, stepover, BANG — Gibson scores!",
                        "Gibson dances through and finishes it himself!"]},
    "grandpa": {"save": ["Grandpa saves it sitting down. Legend.",
                         "He didn't even spill his tea. Grandpa save!"]},
    "wemby": {"save": ["He just… reaches. Wemby save.",
                       "That was going top corner. It is not. WEMBY."]},
    "kane": {"pen_over": ["Sky high. Again.",
                          "He's put it over. The curse continues."]},
    "maradona": {"hand_of_god": ["The Hand of God, live in your kitchen.",
                                 "A punch, a goal, a grin. Maradona forever."]},
}

# The circle-method round pattern for any 8-club division (spec [DATA]).
FIXTURES = [
    [[7, 0], [1, 6], [2, 5], [3, 4]],
    [[1, 7], [2, 0], [3, 6], [4, 5]],
    [[7, 2], [3, 1], [4, 0], [5, 6]],
    [[3, 7], [4, 2], [5, 1], [6, 0]],
    [[7, 4], [5, 3], [6, 2], [0, 1]],
    [[5, 7], [6, 4], [0, 3], [1, 2]],
    [[7, 6], [0, 5], [1, 4], [2, 3]],
]

# ============================================================================
#  ADDENDUM 18 FOUNDATIONS — age, potential, archetype, synergy index
#  Data only. Every number here is authored for this shop; the only imported
#  facts are dates of birth and club names for players we matched by name AND
#  nation. Ratings remain FC-style numbers made here, never EA data.
# ============================================================================

# Ages are measured on one fixed day so a rebuild never ages anybody:
# the opening day of the tournament this album is for.
AGE_REF = (2026, 6, 11)

# Shape of a plausible national-squad age curve — weight per age. The pick is
# seeded from the card id, so it is stable across rebuilds.
AGE_BANDS = [(17, 2), (18, 4), (19, 6), (20, 8), (21, 10), (22, 12), (23, 14),
             (24, 16), (25, 17), (26, 17), (27, 16), (28, 14), (29, 12),
             (30, 10), (31, 8), (32, 6), (33, 5), (34, 4), (35, 3), (36, 2),
             (37, 1)]
# keepers last longer; forwards burn brighter, earlier
POS_AGE_SHIFT = {"GK": 2, "DEF": 1, "MID": 0, "ATT": -1, "SPE": 0}

# career stage bands: [lo, hi, label, growth]. growth is an ADVISORY multiplier
# for XP / training pace ONLY. It must never touch effSkill — the 75/25 law
# owns skill; age owns how fast a card learns.
AGE_STAGES = [[0, 15, "Kid", 1.35], [16, 18, "Prospect", 1.30],
              [19, 21, "Wonderkid", 1.22], [22, 24, "Rising", 1.12],
              [25, 28, "Prime", 1.00], [29, 31, "Seasoned", 0.92],
              [32, 34, "Veteran", 0.84], [35, 120, "Twilight", 0.75]]

# The cast's ages are authored, not rolled: (age, tracks-a-real-birthday?, note)
CAST_AGE = {
    "maradona": (35, 0, None),          # the legend card — a veteran forever
    "suarez": (39, 1, None),            # b. 1987-01-24
    "wemby": (22, 1, None),             # b. 2004-01-04
    "dort": (27, 1, None),              # b. 1999-04-19
    "caruso": (32, 1, None),            # b. 1994-02-28
    "phoenix": (5, 0, "5 — that's 35 in dog years"),
    "gibson": (12, 0, None),
    "ellis": (9, 0, None),
    "grandpa": (78, 0, "still the best hands in the family"),
}
# which country each cast member is stitched into (mirrors STITCH in
# mg-manager.js) — it is what gives them same-nation links
CAST_TEAM = {"maradona": "ARG", "wemby": "FRA", "dort": "CAN",
             "caruso": "USA", "suarez": "URU"}

# Headroom ceiling by age: the most a base rating could still grow.
AGE_ROOM = [(12, 22), (15, 20), (17, 18), (19, 15), (20, 13), (21, 12),
            (22, 11), (23, 10), (24, 8), (25, 7), (26, 5), (27, 4), (28, 3),
            (29, 2), (31, 2), (32, 1), (33, 1)]

# Famous names get an authored role, exactly as they get an authored rating —
# a hash calling Modric a Poacher is the sort of thing a kid notices instantly.
# Must be legal for the resolved position (see ARK_LEGAL); ignored if not.
STAR_ARK = {
    "lionel messi": "wg", "erling haaland": "po", "kylian mbappe": "wg",
    "mohamed salah": "wg", "lamine yamal": "wg", "harry kane": "tg",
    "christian pulisic": "wg", "rodri": "pm", "jude bellingham": "pm",
    "virgil van dijk": "bp", "thibaut courtois": "ss", "luka modric": "pm",
    "vinicius junior": "wg", "vinicius jr": "wg", "kevin de bruyne": "pm",
    "florian wirtz": "pm", "jamal musiala": "wg", "joshua kimmich": "pm",
    "bukayo saka": "wg", "phil foden": "wg", "martin odegaard": "pm",
    "lautaro martinez": "po", "julian alvarez": "po", "achraf hakimi": "bp",
    "federico valverde": "pm", "alexander isak": "po",
    "cristiano ronaldo": "po", "bruno fernandes": "pm", "ruben dias": "an",
    "bernardo silva": "pm", "declan rice": "an", "cole palmer": "wg",
    "alisson": "sk", "marc andre ter stegen": "sk", "mike maignan": "sk",
    "aurelien tchouameni": "an", "enzo fernandez": "pm", "pedri": "pm",
    "alexis mac allister": "pm", "frenkie de jong": "pm", "dani olmo": "pm",
    "nico williams": "wg", "raphinha": "wg", "casemiro": "an",
    "romelu lukaku": "tg", "jeremy doku": "wg", "cody gakpo": "wg",
    "gabriel magalhaes": "an", "alphonso davies": "bp",
    "heung min son": "wg", "son heung min": "wg", "mohammed kudus": "wg",
    "jordan pickford": "ss", "john stones": "bp", "william saliba": "an",
    "kaoru mitoma": "wg", "takefusa kubo": "wg", "santiago gimenez": "po",
}
# the cast's roles are authored too
CAST_ARK = {"maradona": "wg", "suarez": "po", "wemby": "ss", "dort": "an",
            "caruso": "an", "phoenix": "ss", "gibson": "wg", "ellis": "wg",
            "grandpa": "ss"}
# which archetypes a position may hold
ARK_LEGAL = {"GK": ("ss", "sk"), "DEF": ("an", "bp"),
             "MID": ("pm", "an", "wg"), "ATT": ("po", "tg", "wg")}

# eight archetypes — the same eight the badge design names (.design-badges.md §1)
ARCHETYPES = {
    "pm": "Playmaker", "wg": "Winger", "po": "Poacher", "tg": "Target Man",
    "an": "Anchor", "bp": "Ball-Playing Defender", "ss": "Shot-Stopper",
    "sk": "Sweeper Keeper",
}
# archetype -> (creator base 0-9, finisher base 0-9, potential factor)
ROLE_BASE = {
    "pm": (9, 4, 1.00), "wg": (7, 7, 1.05), "po": (2, 9, 1.00),
    "tg": (3, 8, 0.95), "an": (4, 2, 0.95), "bp": (6, 2, 1.00),
    "ss": (1, 0, 0.90), "sk": (3, 0, 0.95),
}

# ==================================================================== ATTRIBUTES
# Addendum 17 §2 — FIFA-depth attributes. Design: .design-attributes.md.
#
# 34 sub-attributes (29 outfield + 5 goalkeeping) per fieldable card, six face
# ratings derived from them, all DETERMINISTIC from (position, OVR, archetype)
# — no Math.random, no Date, no clock. The whole generator is a pure function
# of the album, so a rerun is byte-identical.
#
# THE FOUR LAWS (design §0), restated because they are easy to break here:
#   L1  attributes never enter effSkill; 75/25 is untouched by this file
#   L2  an archetype REDISTRIBUTES a rating, it never adds to one — the six
#       faces reconstruct the card's own OVR through OVR_W (gate: |err| <= 1.0)
#   L3  the parallel enters once, at read time, as the uniform (effSkill-base)
#       shift; what we store here is the BASE (white) vector
#   L4  no new rng, no reordering — every value below is arithmetic on the row
#
# The stored vector is the WHITE vector. The card sheet adds (effSkill - base)
# to every sub to show a tier; badges and engine deltas read the white one, so
# a black Yamal and a white Yamal hold the identical badge set.

SUBS = [
    # PACE
    "acceleration", "sprintSpeed",
    # SHOOTING
    "positioning", "finishing", "shotPower", "longShots", "volleys", "penalties",
    # PASSING
    "vision", "crossing", "freeKick", "shortPassing", "longPassing", "curve",
    # DRIBBLING
    "agility", "balance", "reactions", "ballControl", "dribbling", "composure",
    # DEFENDING
    "interceptions", "headingAccuracy", "defAwareness", "standingTackle",
    "slidingTackle",
    # PHYSICAL
    "jumping", "stamina", "strength", "aggression",
    # GOALKEEPING
    "gkDiving", "gkHandling", "gkKicking", "gkReflexes", "gkPositioning",
]
SUB_IDX = {s: i for i, s in enumerate(SUBS)}

# A face is the weighted mean of its own subs. These weights are the contract:
# they build the subs and they read them back, and each set sums to 1.000.
FACE_SUBS = {
    "PAC": {"acceleration": 0.45, "sprintSpeed": 0.55},
    "SHO": {"finishing": 0.45, "shotPower": 0.20, "positioning": 0.20,
            "longShots": 0.05, "volleys": 0.05, "penalties": 0.05},
    "PAS": {"shortPassing": 0.35, "vision": 0.20, "crossing": 0.20,
            "longPassing": 0.15, "curve": 0.05, "freeKick": 0.05},
    "DRI": {"dribbling": 0.42, "ballControl": 0.30, "agility": 0.10,
            "reactions": 0.08, "balance": 0.05, "composure": 0.05},
    "DEF": {"defAwareness": 0.30, "standingTackle": 0.30, "interceptions": 0.20,
            "slidingTackle": 0.10, "headingAccuracy": 0.10},
    "PHY": {"strength": 0.50, "stamina": 0.25, "aggression": 0.20, "jumping": 0.05},
    "DIV": {"gkDiving": 1.0}, "HAN": {"gkHandling": 1.0}, "KIC": {"gkKicking": 1.0},
    "REF": {"gkReflexes": 1.0}, "POS": {"gkPositioning": 1.0},
    "SPD": {"acceleration": 0.45, "sprintSpeed": 0.55},
}
# the six faces a card SHOWS — keepers swap the outfield six for their own
FACE_ORDER = {"OUT": ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"],
              "GK": ["DIV", "HAN", "KIC", "REF", "POS", "SPD"]}

# face -> OVR weights per position. DEF weighing 0 for a striker is deliberate:
# it is what lets a No.9 have DEF 26 without it dragging his rating down.
OVR_W = {
    "ATT": {"PAC": 0.05, "SHO": 0.45, "PAS": 0.05, "DRI": 0.25, "DEF": 0.00, "PHY": 0.20},
    "MID": {"PAC": 0.08, "SHO": 0.15, "PAS": 0.32, "DRI": 0.25, "DEF": 0.10, "PHY": 0.10},
    "DEF": {"PAC": 0.05, "SHO": 0.00, "PAS": 0.05, "DRI": 0.10, "DEF": 0.50, "PHY": 0.30},
    "GK":  {"DIV": 0.22, "HAN": 0.21, "KIC": 0.05, "REF": 0.22, "POS": 0.22, "SPD": 0.08},
}
# the faces the solve is allowed to move (the anchors come off the album row)
FREE = {"ATT": ["PAC", "PAS", "DRI", "PHY"], "MID": ["PAC", "PAS", "DRI", "PHY"],
        "DEF": ["PAC", "PAS", "DRI", "PHY"], "GK": ["DIV", "HAN", "REF", "POS", "SPD"]}
# positional character. Only the DIFFERENCES matter — the solve is an equal
# shift, so the mean of a row is irrelevant.
BOFF = {
    "ATT": {"PAC": +3, "PAS": -16, "DRI": +6, "PHY": -11},
    "MID": {"PAC": -2, "PAS": +8, "DRI": +4, "PHY": -9},
    "DEF": {"PAC": -4, "PAS": -13, "DRI": -17, "PHY": +10},
    "GK":  {"DIV": -2, "HAN": -3, "REF": +2, "POS": -4, "SPD": -26},
}
# the zero-tilt reference per position: what the engine measures a card against
NEUTRAL = {"ATT": "att0", "MID": "mid0", "DEF": "def0", "GK": "gk0"}

TILT_SCALE = {"shooting": 2.2, "defending": 2.2, "gk": 2.0}
# FC files headingAccuracy under DEFENDING. For a centre-back that is right;
# for a No.9 it is a bug — a striker's DEF face is his album dfn (24-45), so
# an unanchored Haaland cannot head a ball. For ATT only, heading is anchored
# on the PHYSICAL face (jumping + strength is what wins a header) and the
# other four defending subs absorb the residual, so the DEF face the radar
# draws is still exactly his album dfn and OVR reconstruction is untouched.
HEAD_ANCHOR_ATT = 0.70
SHO_SUBS = ("positioning", "finishing", "shotPower", "longShots", "volleys", "penalties")
DEF_SUBS = ("interceptions", "headingAccuracy", "defAwareness", "standingTackle",
            "slidingTackle")

# ---- the 18 roles. face{} moves the free faces (the solve absorbs the OVR
# consequence); sub{} redistributes inside a face (the re-centre absorbs the
# face consequence). A poacher and a creator at 84 are both 84 — what differs
# is where the 84 is spent.
ARCH = {
    # ATT
    "poacher": {"pos": "ATT", "face": {"PAC": +2, "PAS": -6, "DRI": -1, "PHY": +2},
                "sub": {"finishing": +5, "positioning": +5, "volleys": +3, "longShots": -6,
                        "penalties": +2, "vision": -5, "crossing": -4, "longPassing": -4,
                        "curve": -2, "agility": +2, "composure": +4, "dribbling": -3,
                        "ballControl": -2, "strength": +2, "aggression": +2, "stamina": -4}},
    "target": {"pos": "ATT", "face": {"PAC": -7, "PAS": -2, "DRI": -5, "PHY": +11},
               "sub": {"shotPower": +7, "finishing": +2, "positioning": +3, "longShots": -3,
                       "volleys": -4, "headingAccuracy": +6, "jumping": +8, "strength": +7,
                       "aggression": +3, "stamina": -5, "agility": -6, "balance": -3,
                       "dribbling": -4, "ballControl": +2, "crossing": -4, "vision": +1,
                       "longPassing": +2}},
    "speedster": {"pos": "ATT", "face": {"PAC": +11, "PAS": -3, "DRI": +4, "PHY": -9},
                  "sub": {"acceleration": +3, "sprintSpeed": +2, "dribbling": +6, "agility": +7,
                          "balance": +4, "ballControl": +2, "composure": -4, "reactions": -2,
                          "finishing": -2, "longShots": -3, "shotPower": -4, "positioning": +3,
                          "volleys": -2, "crossing": +5, "curve": +3, "vision": -3,
                          "longPassing": -4, "headingAccuracy": +1, "strength": -6, "jumping": 0,
                          "aggression": -3, "stamina": +4}},
    "complete": {"pos": "ATT", "face": {"PAC": 0, "PAS": +4, "DRI": +2, "PHY": +2},
                 "sub": {"finishing": +3, "shotPower": +3, "longShots": +2, "penalties": +4,
                         "volleys": +2, "positioning": +1, "composure": +4, "ballControl": +2,
                         "vision": +2, "shortPassing": +2, "strength": +2, "stamina": +1,
                         "aggression": -1}},
    "creator": {"pos": "ATT", "face": {"PAC": -2, "PAS": +11, "DRI": +7, "PHY": -8},
                "sub": {"vision": +7, "shortPassing": +5, "curve": +5, "freeKick": +6,
                        "crossing": -2, "longPassing": +1, "dribbling": +6, "ballControl": +5,
                        "agility": +4, "composure": +3, "balance": +1, "reactions": -1,
                        "finishing": +2, "positioning": -3, "longShots": +3, "shotPower": -3,
                        "penalties": +2, "volleys": -2, "headingAccuracy": +2, "strength": -6,
                        "aggression": -4, "stamina": +2, "jumping": -1}},
    # MID
    "regista": {"pos": "MID", "face": {"PAC": -6, "PAS": +10, "DRI": +2, "PHY": -3},
                "sub": {"vision": +7, "longPassing": +8, "shortPassing": +4, "curve": +3,
                        "freeKick": +4, "crossing": -8, "composure": +6, "ballControl": +3,
                        "dribbling": -3, "agility": -3, "reactions": +2, "longShots": +5,
                        "finishing": -5, "positioning": -4, "shotPower": +2, "defAwareness": +4,
                        "interceptions": +2, "slidingTackle": -4, "standingTackle": -2,
                        "headingAccuracy": +1, "stamina": -3, "strength": +1,
                        "aggression": -2}},
    "engine": {"pos": "MID", "face": {"PAC": +4, "PAS": -2, "DRI": -3, "PHY": +7},
               "sub": {"stamina": +9, "strength": +3, "aggression": +4, "jumping": +2,
                       "interceptions": +5, "standingTackle": +3, "defAwareness": +2,
                       "slidingTackle": +2, "headingAccuracy": +1, "shortPassing": +2,
                       "longPassing": +1, "vision": -3, "curve": -3, "freeKick": -4,
                       "dribbling": -4, "agility": -2, "ballControl": +1, "composure": +1,
                       "longShots": +3, "finishing": +1, "volleys": -2, "penalties": -3}},
    "maestro": {"pos": "MID", "face": {"PAC": -3, "PAS": +8, "DRI": +8, "PHY": -8},
                "sub": {"vision": +6, "shortPassing": +4, "curve": +4, "freeKick": +5,
                        "crossing": -2, "longPassing": -2, "dribbling": +7, "ballControl": +5,
                        "agility": +5, "composure": +4, "balance": +2, "reactions": -2,
                        "finishing": 0, "longShots": +4, "positioning": +2, "penalties": +3,
                        "shotPower": -2, "volleys": -2, "defAwareness": -4, "standingTackle": -5,
                        "slidingTackle": -5, "interceptions": -2, "strength": -6,
                        "aggression": -4, "stamina": -2}},
    "anchor": {"pos": "MID", "face": {"PAC": -5, "PAS": 0, "DRI": -6, "PHY": +7},
               "sub": {"defAwareness": +8, "standingTackle": +7, "interceptions": +6,
                       "slidingTackle": +4, "headingAccuracy": +2, "strength": +6,
                       "aggression": +5, "jumping": +3, "stamina": -2, "shortPassing": +4,
                       "longPassing": +2, "vision": -2, "curve": -5, "crossing": -6,
                       "freeKick": -4, "dribbling": -5, "agility": -4, "composure": +3,
                       "ballControl": 0, "finishing": -6, "longShots": -3, "volleys": -4,
                       "positioning": -4, "penalties": -2}},
    "wideman": {"pos": "MID", "face": {"PAC": +8, "PAS": +3, "DRI": +5, "PHY": -8},
                "sub": {"acceleration": +2, "sprintSpeed": +1, "crossing": +9, "curve": +5,
                        "vision": -2, "longPassing": -4, "shortPassing": -2, "freeKick": +2,
                        "dribbling": +6, "agility": +5, "balance": +3, "ballControl": +1,
                        "composure": -3, "reactions": -2, "finishing": +1, "longShots": +2,
                        "positioning": +1, "shotPower": -2, "volleys": -2, "headingAccuracy": +2,
                        "stamina": +4, "strength": -5, "aggression": -3, "jumping": -2}},
    # DEF
    "stopper": {"pos": "DEF", "face": {"PAC": -5, "PAS": -4, "DRI": -6, "PHY": +9},
                "sub": {"defAwareness": +6, "standingTackle": +5, "headingAccuracy": +6,
                        "interceptions": +2, "slidingTackle": -1, "strength": +7, "jumping": +6,
                        "aggression": +4, "stamina": -3, "shortPassing": -3, "longPassing": -2,
                        "vision": -4, "crossing": -4, "composure": +2, "ballControl": -3,
                        "dribbling": -4, "agility": -4}},
    "ballplayer": {"pos": "DEF", "face": {"PAC": -1, "PAS": +9, "DRI": +6, "PHY": -4},
                   "sub": {"shortPassing": +7, "longPassing": +7, "vision": +5, "curve": +2,
                           "crossing": -6, "freeKick": +2, "composure": +6, "ballControl": +4,
                           "dribbling": +3, "reactions": +2, "agility": -1, "defAwareness": +4,
                           "interceptions": +3, "standingTackle": -1, "slidingTackle": -4,
                           "headingAccuracy": 0, "strength": -2, "aggression": -4,
                           "stamina": +1, "jumping": -1}},
    "fullback": {"pos": "DEF", "face": {"PAC": +10, "PAS": +5, "DRI": +5, "PHY": -9},
                 "sub": {"acceleration": +3, "sprintSpeed": +2, "crossing": +9, "curve": +3,
                         "shortPassing": +1, "vision": -2, "longPassing": -5, "dribbling": +5,
                         "agility": +5, "balance": +3, "ballControl": +1, "composure": -3,
                         "reactions": -2, "slidingTackle": +5, "interceptions": +3,
                         "standingTackle": -2, "defAwareness": -2, "headingAccuracy": -3,
                         "stamina": +7, "strength": -6, "jumping": -2, "aggression": -2}},
    "enforcer": {"pos": "DEF", "face": {"PAC": -6, "PAS": -7, "DRI": -8, "PHY": +13},
                 "sub": {"standingTackle": +7, "slidingTackle": +7, "aggression": +8,
                         "interceptions": +3, "defAwareness": -2, "headingAccuracy": +1,
                         "strength": +7, "jumping": +3, "stamina": -2, "composure": -4,
                         "agility": -3, "dribbling": -4, "ballControl": -2, "balance": +2,
                         "vision": -4, "curve": -4, "freeKick": -4, "shortPassing": +2,
                         "longPassing": +1, "crossing": +1}},
    # GK
    "shotstopper": {"pos": "GK", "face": {"DIV": +5, "HAN": +1, "REF": +5, "POS": -4, "SPD": -4},
                    "sub": {}},
    "sweeper": {"pos": "GK", "face": {"DIV": -3, "HAN": -2, "REF": -2, "POS": +6, "SPD": +12},
                "sub": {}},
    "commander": {"pos": "GK", "face": {"DIV": -2, "HAN": +8, "REF": -2, "POS": +5, "SPD": -8},
                  "sub": {}},
    # the measuring sticks — zero tilt, zero texture
    "att0": {"pos": "ATT", "face": {}, "sub": {}},
    "mid0": {"pos": "MID", "face": {}, "sub": {}},
    "def0": {"pos": "DEF", "face": {}, "sub": {}},
    "gk0":  {"pos": "GK", "face": {}, "sub": {}},
    # SPE — a crest is a collectible, not a footballer
    "mascot": {"pos": "SPE", "face": {}, "sub": {}},
}

# what the ROLE chip says. Every card carries one, so a 61-rated winger still
# has an identity even when he holds no badge (design §8.2).
ROLE_INFO = {
    "poacher": ("Poacher", "ATT", "Spends his shooting on finishing, not on long shots."),
    "target": ("Target Man", "ATT", "Wins it in the air and holds it up until help arrives."),
    "speedster": ("Speedster", "ATT", "Runs past you. Worries about the finish later."),
    "complete": ("Complete Forward", "ATT", "Good at everything, best at nothing."),
    "creator": ("False Nine", "ATT", "Drops in, picks the pass, lets someone else score."),
    "regista": ("Regista", "MID", "Sits deep and reads the whole game. Finishes nothing."),
    "engine": ("Box-to-Box", "MID", "Lungs and tackles. No imagination required."),
    "maestro": ("Maestro", "MID", "The number ten. Everything goes through him."),
    "anchor": ("Anchor", "MID", "The destroyer. Nothing comes through the middle."),
    "wideman": ("Wide Man", "MID", "Chalk on the boots and a cross on a plate."),
    "stopper": ("Stopper", "DEF", "Wins the header, heads the clearance, does it again."),
    "ballplayer": ("Ball-Player", "DEF", "Starts the move and reads the danger."),
    "fullback": ("Attacking Full-Back", "DEF", "Up and down all afternoon. Poor in the air."),
    "enforcer": ("Enforcer", "DEF", "Dives in. Tackles, not positions."),
    "shotstopper": ("Shot-Stopper", "GK", "Stays on his line and saves everything on it."),
    "sweeper": ("Sweeper Keeper", "GK", "Half keeper, half spare defender, all nerve."),
    "commander": ("Commander", "GK", "Owns his box and shouts about it."),
    "att0": ("Forward", "ATT", "A forward, plainly."),
    "mid0": ("Midfielder", "MID", "A midfielder, plainly."),
    "def0": ("Defender", "DEF", "A defender, plainly."),
    "gk0": ("Goalkeeper", "GK", "A goalkeeper, plainly."),
    "mascot": ("Collectible", "SPE", "Not a footballer, but he's in the binder."),
}

# ---- assignment. Shirt numbers lie (Messi is ARG 17), so the famous get an
# authored role exactly as they get an authored rating. Invariant 6 applied to
# attributes: a guessed role is a lie about a real footballer, a generic one is
# not — an unknown name degrades to the shirt-number pair, never to a wrong role.
ARCH_BY_POS = {
    "ATT": {12: ("creator", "speedster"), 14: ("poacher", "complete"),
            15: ("complete", "target"), 16: ("target", "complete"),
            17: ("poacher", "speedster"), 18: ("speedster", "poacher"),
            19: ("speedster", "creator"), 20: ("creator", "poacher")},
    "MID": {8: ("anchor", "engine"), 9: ("regista", "anchor"), 10: ("maestro", "regista"),
            11: ("engine", "maestro"), 12: ("engine", "wideman"), 13: ("wideman", "maestro"),
            14: ("wideman", "engine"), 15: ("maestro", "wideman"), 16: ("engine", "anchor")},
    "DEF": {3: ("stopper", "enforcer"), 4: ("ballplayer", "stopper"),
            5: ("stopper", "ballplayer"), 6: ("enforcer", "stopper"),
            7: ("fullback", "enforcer"), 8: ("fullback", "ballplayer")},
}
# Every name in STAR_OVR has an entry (validated at build time), plus the extra
# names the design names by hand. Illegal-for-position entries are ignored.
STAR_ARCH = {
    "lionel messi": "creator", "erling haaland": "target", "kylian mbappe": "speedster",
    "mohamed salah": "speedster", "lamine yamal": "speedster", "harry kane": "complete",
    "christian pulisic": "speedster", "rodri": "anchor", "jude bellingham": "engine",
    "virgil van dijk": "stopper", "thibaut courtois": "shotstopper", "luka modric": "regista",
    "vinicius junior": "speedster", "vinicius jr": "speedster",
    "kevin de bruyne": "maestro", "florian wirtz": "maestro", "jamal musiala": "maestro",
    "joshua kimmich": "regista", "bukayo saka": "wideman", "phil foden": "maestro",
    "martin odegaard": "maestro", "lautaro martinez": "poacher",
    "julian alvarez": "poacher", "achraf hakimi": "fullback",
    "federico valverde": "engine", "alexander isak": "complete",
    "cristiano ronaldo": "poacher", "bruno fernandes": "maestro", "ruben dias": "stopper",
    "bernardo silva": "maestro", "declan rice": "anchor", "cole palmer": "creator",
    "alisson": "shotstopper", "marc andre ter stegen": "sweeper", "mike maignan": "sweeper",
    "aurelien tchouameni": "anchor", "eduardo camavinga": "engine",
    "enzo fernandez": "regista", "alexis mac allister": "engine",
    "frenkie de jong": "regista", "pedri": "maestro", "dani olmo": "maestro",
    "nico williams": "speedster", "kaoru mitoma": "speedster", "takefusa kubo": "creator",
    "raphinha": "speedster", "casemiro": "anchor", "romelu lukaku": "target",
    "jeremy doku": "speedster", "xavi simons": "maestro", "cody gakpo": "speedster",
    "gabriel magalhaes": "stopper", "alphonso davies": "fullback",
    "weston mckennie": "engine", "antonee robinson": "fullback",
    "santiago gimenez": "poacher", "edson alvarez": "anchor",
    "jefferson lerma": "anchor", "heung min son": "speedster", "son heung min": "speedster",
    "mohammed kudus": "speedster", "jordan pickford": "shotstopper",
    "john stones": "ballplayer", "william saliba": "stopper",
    # named by the design beyond STAR_OVR
    "diego maradona": "creator", "olivier giroud": "target",
    "cristiano ronaldo dos santos aveiro": "poacher",
    "manuel neuer": "sweeper", "gianluigi donnarumma": "shotstopper",
    "emiliano martinez": "shotstopper", "cristian romero": "enforcer",
    "toni kroos": "regista", "antoine griezmann": "creator", "neymar": "speedster",
    "neymar jr": "speedster", "robert lewandowski": "poacher", "kylian mbappe lottin": "speedster",
    "marquinhos": "stopper", "eder militao": "stopper", "theo hernandez": "fullback",
    "trent alexander arnold": "fullback", "nuno mendes": "fullback",
    "andrew robertson": "fullback", "kyle walker": "fullback",
    # famous enough that the shirt-number roll would be noticed and laughed at
    "ousmane dembele": "speedster", "rodrygo": "speedster",
    "khvicha kvaratskhelia": "speedster", "federico chiesa": "speedster",
    "ademola lookman": "speedster", "kingsley coman": "speedster",
    "leroy sane": "speedster", "marcus rashford": "speedster",
    "luis diaz": "speedster", "serge gnabry": "speedster",
    "riyad mahrez": "wideman", "ivan perisic": "wideman", "michael olise": "wideman",
    "viktor gyokeres": "target", "victor osimhen": "target",
    "randal kolo muani": "target", "darwin nunez": "target",
    "dusan vlahovic": "poacher", "hakan calhanoglu": "regista",
    "vitinha": "maestro", "moises caicedo": "anchor",
    "jules kounde": "stopper", "antonio rudiger": "stopper",
    "ibrahima konate": "stopper", "jonathan tah": "stopper",
}
# the nine are authored, never rolled — the archetype IS the personality
CAST_ARCH = {"maradona": "creator", "suarez": "poacher", "wemby": "shotstopper",
             "dort": "enforcer", "caruso": "enforcer", "phoenix": "sweeper",
             "gibson": "creator", "ellis": "speedster", "grandpa": "shotstopper"}


def _h32(s):
    """FNV-1a + two avalanche rounds. Byte-identical in Python and JS."""
    h = 2166136261
    for ch in s:
        h = (h ^ (ord(ch) & 0xFFFF)) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    h = (h ^ (h >> 15)) & 0xFFFFFFFF
    h = (h * 2246822507) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 3266489909) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def _jround(v):
    """JS Math.round — half away from zero toward +inf, not Python's banker's."""
    return int(math.floor(v + 0.5))


def _cl(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def arch_for(sid, pos, num, sho, name=None):
    """One of the 18 roles. Authored for the famous, hashed for everyone else."""
    if pos == "SPE":
        return "mascot"
    star = CAST_ARCH.get(sid) or (STAR_ARCH.get(norm(name)) if name else None)
    if star and ARCH.get(star, {}).get("pos") == pos:
        return star
    if num is None:                     # synthetic / harness cards are the reference
        return NEUTRAL[pos]
    if pos == "GK":
        r = _h32("gk:" + sid) % 100
        if sho >= 21:
            return "sweeper" if r < 50 else ("shotstopper" if r < 80 else "commander")
        return "shotstopper" if r < 55 else ("commander" if r < 80 else "sweeper")
    table = ARCH_BY_POS[pos]
    pair = table.get(num) or table[min(table)]
    return pair[0 if _h32("a:" + sid) % 100 < 62 else 1]


def face_solve(sid, pos, base, sho, dfn, arch):
    """Step 1-3: anchor the album's own two numbers, shape the free faces by
    role, then shift the free faces equally until the positional weighted mean
    lands back on the card's OVR. L2 lives here."""
    W, free = OVR_W[pos], FREE[pos]
    F = {}
    if pos == "GK":
        # the album gives keepers sho 8..25 as a DISTRIBUTION INDEX, not a face;
        # 50+1.5x lands it on the FC scale (8->62, 25->88), monotonic, so the
        # album's own ordering of who kicks well survives. The design offered
        # 45+1.4x, which caps KIC at 80 and made Sweeper Keeper unwinnable for
        # the two most obvious sweeper keepers in the album (.design-attributes
        # §13.2 names both fixes; this is the one that repairs the cause).
        F["KIC"] = float(_cl(_jround(50 + 1.5 * sho), 20, 99))
    else:
        F["SHO"] = float(_cl(sho, 10, 99))
        F["DEF"] = float(_cl(dfn, 10, 99))
    tilt = ARCH[arch]["face"]
    if pos == "GK":
        tilt = {k: v * TILT_SCALE["gk"] for k, v in tilt.items()}
    for f in free:
        F[f] = base + BOFF[pos].get(f, 0) + tilt.get(f, 0)
    if pos == "GK":
        F["REF"] += (dfn - base)        # the album's own GK jitter, kept
    open_f = list(free)
    for _ in range(4):
        if not open_f:
            break
        s = sum(W[f] * F.get(f, 0.0) for f in W)
        r = base - s
        if abs(r) < 0.005:
            break
        w_open = sum(W[f] for f in open_f)
        if w_open <= 0:
            break
        d = r / w_open
        nxt = []
        for f in open_f:
            v = F[f] + d
            F[f] = float(_cl(v, 20, 99))
            if F[f] == v:
                nxt.append(f)
        open_f = nxt
    return {f: _jround(v * 100) / 100.0 for f, v in F.items()}


def subs_for(sid, pos, base, arch, F, no_tex=False):
    """Step 4-5: spread each face across its subs by role tilt plus a per-card
    texture, then re-centre so the face is exactly the weighted mean again.
    Texture therefore changes the BARS and never the FACE."""
    if arch == NEUTRAL.get(pos):
        no_tex = True
    st = ARCH[arch]["sub"]
    A = {}
    faces = (["PAC", "SHO", "PAS", "DRI", "DEF", "PHY", "DIV", "HAN", "KIC", "REF", "POS"]
             if pos == "GK" else ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"])

    def face_val(f):
        if f in F:
            return F[f]
        if pos == "GK":                 # keepers still carry the 29, honestly low
            if f == "PAC":
                return F["SPD"]
            if f == "SHO":
                return float(_cl(base - 42, 8, 60))
            if f == "PAS":
                return float(_cl(base - 30, 12, 70))
            if f == "DRI":
                return float(_cl(base - 40, 10, 60))
            if f == "DEF":
                return float(_cl(base - 55, 8, 40))
            if f == "PHY":
                return float(_cl(base - 20, 20, 80))
        return 50.0

    for f in faces:
        wmap = FACE_SUBS.get(f)
        if not wmap:
            continue
        fv = face_val(f)
        names = list(wmap)
        raw = {}
        for n in names:
            tex = 0 if no_tex else (_h32(sid + ":" + n) % 9) - 4
            sc = (TILT_SCALE["shooting"] if n in SHO_SUBS
                  else TILT_SCALE["defending"] if n in DEF_SUBS else 1.0)
            raw[n] = fv + st.get(n, 0) * sc + tex
        if f == "DEF" and pos == "ATT":
            want = HEAD_ANCHOR_ATT * F["PHY"] + (1 - HEAD_ANCHOR_ATT) * fv
            # /0.90 pre-pays for the equal-shift re-centre below, whose weight
            # on headingAccuracy is 0.10 — the lift lands exactly on `want`
            raw["headingAccuracy"] += (want - fv) / 0.90
        for _ in range(3):
            s = sum(wmap[n] * raw[n] for n in names)
            d = fv - s
            if abs(d) < 0.005:
                break
            for n in names:
                raw[n] = float(_cl(raw[n] + d, 1, 99))
        for n in names:
            A[n] = _cl(_jround(raw[n]), 1, 99)
    if pos == "GK":
        A["gkDiving"] = _jround(F["DIV"]); A["gkHandling"] = _jround(F["HAN"])
        A["gkKicking"] = _jround(F["KIC"]); A["gkReflexes"] = _jround(F["REF"])
        A["gkPositioning"] = _jround(F["POS"])
    else:
        for n in ("gkDiving", "gkHandling", "gkKicking", "gkReflexes", "gkPositioning"):
            A[n] = _cl(6 + (4 if no_tex else _h32(sid + ":" + n) % 9), 1, 20)
    return A


def faces_of(A):
    """The faces the radar draws, read back OUT of the subs.

    EXACT — no intermediate rounding. It used to return round(sum*100)/100 and
    the writer rounded that again to an int; the double round moved 8 cards a
    whole point off their own bars (aut20 PAS 77 stored as 78), because Python
    rounds half to EVEN at both steps while every consumer rounds half UP. One
    round, in the writer, is the fix.
    """
    return {f: sum(w * A[n] for n, w in wmap.items())
            for f, wmap in FACE_SUBS.items()}


# ---- the delta layer: what a future engine reads. Narrow composites on
# purpose — 'finishing' drives conversion, not 'shooting'.
COMP = {
    "FIN": {"finishing": 0.75, "composure": 0.25},
    "CRE": {"vision": 0.60, "shortPassing": 0.40},
    "PACE": {"acceleration": 0.55, "sprintSpeed": 0.45},
    "MRK": {"defAwareness": 0.80, "standingTackle": 0.20},
    "GKS": {"gkReflexes": 0.55, "gkDiving": 0.45},
    "PEN": {"penalties": 0.70, "composure": 0.30},
    "AIR": {"headingAccuracy": 0.60, "jumping": 0.40},
}
# the order the eight deltas are stored in, x10 as integers. This is the layer
# the MATCH ENGINE reads — the runtime never re-derives a delta, it decodes
# this. Frozen: appending is safe, reordering is not.
DELTA_ORDER = ("SHOF", "DEFF", "FIN", "CRE", "PACE", "MRK", "GKS", "PEN", "AIR")

# the match-engine hook constants (.design-attributes §6), shipped so the
# engine, the harness and this generator read ONE set of numbers. Every hook is
# a bounded, mean-zero adjustment to a number the engine already computes; none
# consumes rng, none reorders one.
ENGINE_HOOKS = {
    "dead": 0.75,   # deadband: a card within 3/4 of a point of neutral IS neutral
    "KC": 1.2,      # H1 creation gain per unit of (CRE, PACE)/100
    "CCAP": 0.008,  # H1 team cap: creation may move by at most +-0.8%
    "FINK": 0.025,  # H3 conversion amplitude (tanh-bounded)
    "GKW": 0.30,    # H3 how much of the keeper's dGKS enters conversion
    "DPT": 0.28,    # H4 E per attribute point, outfield
    "DMRK": 1.2,    # H4 weight of dMRK against dDEFF
    "GPT": 0.34,    # H4 E per attribute point, keeper
    "DCAP": 1.2,    # H4 team cap: each role-line may move by at most +-1.2 E
    "PENK": 0.030,  # H6 penalty amplitude (tanh-bounded)
    "SAVEK": 0.05,  # H5 save-split amplitude — redistributes misses, never goals
    "badgeCap": 4,  # design 8.4: total badge points into any one delta
    "fatigueCap": 6,  # H7: total badge energy back on the cost of a start
    "note": "MEASURED on the real album, not on archetype averages: with these "
            "constants the best-composed XI beats the worst-composed one by "
            "10.9 win-points, one colour step is worth 11.2 and the whole "
            "white->black ladder 62.8 (ratio 0.17, gate 0.35). The worst-"
            "composed XI ONE COLOUR UP still beats the best-composed white XI "
            "by 2.8 points. The design's own 2.0 E line cap let a hand-picked "
            "XI out-swing a colour (18.4 vs 11.0), which is the ladder losing "
            "its own law; DCAP, CCAP and FINK were tightened until it did not. "
            "tools/mg-harness.js G30/G31 gate both halves.",
}

# the documented MEAN of derive_stats' own rules, per position — derived, not
# invented, which is why a synthetic squad is exactly neutral
REF_SHO = {"ATT": lambda b: b + 1, "MID": lambda b: b - 10,
           "DEF": lambda b: 45.0, "GK": lambda b: 16.5}
REF_DEF = {"ATT": lambda b: 34.5, "MID": lambda b: 0.5 * b + 20.5,
           "DEF": lambda b: b + 2, "GK": lambda b: float(b)}
_REF_CACHE = {}


def _blend(A, w):
    return sum(v * A[n] for n, v in w.items())


def ref_of(pos, base, sho, dfn):
    k = (pos, base, sho, dfn)
    if k in _REF_CACHE:
        return _REF_CACHE[k]
    sid = "ref:%s:%d:%d:%d" % k
    arch = NEUTRAL[pos]
    F = face_solve(sid, pos, base, sho, dfn, arch)
    A = subs_for(sid, pos, base, arch, F, no_tex=True)
    c = {"A": A}
    for name, w in COMP.items():
        c[name] = _blend(A, w)
    _REF_CACHE[k] = c
    return c


def attr_of(sid, pos, num, base, sho, dfn, name=None, arch=None):
    """The whole card: role, 34 subs, 12 faces, and the engine's eight deltas."""
    if pos == "SPE":
        return None
    arch = arch or arch_for(sid, pos, num, sho, name)
    F = face_solve(sid, pos, base, sho, dfn, arch)
    A = subs_for(sid, pos, base, arch, F)
    faces = faces_of(A)
    R = ref_of(pos, base, sho, dfn)
    d = {
        "SHOF": 0.0 if pos == "GK" else faces["SHO"] - REF_SHO[pos](base),
        "DEFF": 0.0 if pos == "GK" else faces["DEF"] - REF_DEF[pos](base),
    }
    for nm, w in COMP.items():
        d[nm] = _blend(A, w) - R[nm]
    return {"arch": arch, "A": A, "faces": faces, "d": d}


# ======================================================================= BADGES
# Addendum 17 §3 / .design-badges.md §3. Bit indices are FROZEN: never
# renumber, only append; a retired badge leaves its bit dead (the save stores
# earned badges as one int32 mask, so the catalogue is capped at 30 forever).
#
# Law 1: the colour never awards a badge. Thresholds read the BASE (white)
# vector, so a black Yamal and a white Yamal hold the identical set.
#
# Thresholds are the design's, with the deviations marked TUNED below — every
# one measured against the real 980, because a badge nobody holds is dead
# weight and a badge half the album holds is not a badge.
BADGE_DEFS = [
    # (bit, id, name, face, prio, {sub: min}, positions|None, copy)
    (0, "speedster", "Speedster", "PAC", 3,
     {"acceleration": 85, "sprintSpeed": 85}, None, "Gone. Just gone."),
    (1, "quick_step", "Quick Step", "PAC", 5,
     {"agility": 82, "balance": 80, "acceleration": 80}, None,
     "Turns in a phone box. Plays anywhere you put him."),
    (2, "finesse", "Finesse Shot", "SHO", 2,
     {"curve": 80, "finishing": 78}, None, "Doesn't blast it. Places it."),
    (3, "cannon", "Cannon", "SHO", 3,
     {"shotPower": 88}, None, "The net has feelings. He ignores them."),
    (4, "poacher", "Poacher", "SHO", 2,
     {"positioning": 85, "finishing": 82}, None, "Always where the ball ends up."),
    (5, "distance", "Distance Shooter", "SHO", 4,
     {"longShots": 85, "shotPower": 80}, None, "From there? From there."),
    (6, "chip", "Chip Shot", "SHO", 3,
     {"composure": 82, "finishing": 80, "vision": 78}, None,
     "Sees the keeper coming. Waves as it goes over."),
    (7, "power_header", "Power Header", "SHO", 3,
     {"headingAccuracy": 85, "jumping": 80, "strength": 78}, None,
     "Wins it in the air, finishes it in the air."),
    (8, "target", "Target", "SHO", 4,
     {"strength": 80, "headingAccuracy": 80}, ("ATT",),  # TUNED 85/82 -> 80/80
     "Holds it up until help arrives."),
    (9, "playmaker", "Playmaker", "PAS", 1,
     {"vision": 85, "shortPassing": 83}, None, "Sees the pass three seconds early."),
    (10, "metronome", "Metronome", "PAS", 4,
     {"shortPassing": 85, "composure": 80, "stamina": 78}, None,
     "Tick. Tock. The game happens at his speed."),
    (11, "long_ball", "Long Ball", "PAS", 5,
     {"longPassing": 85}, None, "Why walk it in?"),
    (12, "whipped", "Whipped Pass", "PAS", 4,
     {"crossing": 82, "curve": 80}, None, "Puts it on a plate, with a bend on it."),
    (13, "pinpoint", "Pinpoint Cross", "PAS", 4,
     {"crossing": 86}, None, "Right onto the forehead, every time."),
    (14, "deadball", "Dead Ball", "PAS", 2,
     {"freeKick": 82, "penalties": 82}, None, "Ball on the spot. Everyone relaxes."),
    (15, "trickster", "Trickster", "DRI", 3,
     {"dribbling": 86, "agility": 84}, None, "Tackles keep arriving late."),
    (16, "clutch", "Clutch", "DRI", 1,
     {"composure": 88}, None,                                # TUNED 85->88
     "The bigger the moment, the calmer he gets."),
    (17, "acrobatic", "Acrobatic", "DRI", 5,
     {"agility": 84, "balance": 82, "volleys": 80}, None, "Some of these will be on posters."),
    (18, "engine", "Engine", "PHY", 2,
     {"stamina": 88}, None, "Ninety minutes. Every minute."),
    (19, "relentless", "Relentless", "PHY", 4,
     {"stamina": 86, "aggression": 82, "defAwareness": 75}, None,   # TUNED 84/80 -> 86/82
     "Chases the lost cause. Sometimes catches it."),
    (20, "interceptor", "Interceptor", "DEF", 2,
     {"interceptions": 85, "defAwareness": 83}, None, "Reads the pass, borrows the ball."),
    (21, "anchor", "Anchor", "DEF", 3,
     {"defAwareness": 84, "standingTackle": 82, "strength": 80}, ("DEF", "MID"),
     "Everything in front of him is fine."),
    (22, "brick_wall", "Brick Wall", "DEF", 3,
     {"headingAccuracy": 80, "strength": 85, "jumping": 82, "defAwareness": 82}, None,
     "Nothing gets through. Nothing."),
    (23, "aerial", "Aerial", "DEF", 4,
     {"jumping": 85, "headingAccuracy": 82}, None, "Nothing gets over either."),
    (24, "enforcer", "Enforcer", "DEF", 2,
     {"aggression": 85, "standingTackle": 82, "slidingTackle": 80}, None,
     "Firm, fair, and first to it."),
    (25, "bruiser", "Bruiser", "PHY", 4,
     {"strength": 88, "aggression": 82}, None, "Strikers go quiet around him."),
    (26, "reflex_cat", "Reflex Cat", "REF", 1,
     {"gkReflexes": 86, "gkDiving": 84}, ("GK",), "Hands like that shouldn't be legal."),
    (27, "sweeper_keeper", "Sweeper Keeper", "POS", 2,
     {"gkKicking": 74, "gkPositioning": 84, "acceleration": 70}, ("GK",),  # TUNED kick 82->74
     "Half keeper, half spare defender, all nerve."),
]
BADGE_BY_ID = {b[1]: b for b in BADGE_DEFS}

# ---- what a badge actually DOES, in attribute points, into the engine's own
# delta channels. This is the ONLY place a badge effect is written: the runtime
# reads it out of the data file, so the chip's copy and the number the match
# engine adds can never drift apart. Budget: design 8.4 clamps the sum of all
# badge contributions into any one delta to +4 before that delta enters its
# hook, and the hook's own bound (tanh, or the 2.0 E line cap) applies on top.
# `fatigue` is the one non-delta channel — it is the career layer's H7, in
# energy points off the 30-point cost of a start.
# AIR is deliberately absent: no hook reads it, and a badge must not promise
# an effect the engine does not deliver.
BADGE_EFF = {
    "speedster":      {"PACE": 4, "CRE": 2},
    "quick_step":     {"PACE": 2, "CRE": 1},
    "finesse":        {"FIN": 3},
    "cannon":         {"FIN": 2},
    "poacher":        {"FIN": 3},
    "distance":       {"FIN": 1, "CRE": 1},
    "chip":           {"FIN": 2},
    "power_header":   {"FIN": 2},
    "target":         {"CRE": 2, "FIN": 1},
    "playmaker":      {"CRE": 4},
    "metronome":      {"CRE": 2, "MRK": 1},
    "long_ball":      {"CRE": 3},
    "whipped":        {"CRE": 2, "FIN": 1},
    "pinpoint":       {"CRE": 3},
    "deadball":       {"PEN": 4},
    "trickster":      {"CRE": 2, "FIN": 1},
    "clutch":         {"FIN": 3, "when": "behind"},
    "acrobatic":      {"FIN": 1},
    "engine":         {"fatigue": 6},
    "relentless":     {"CRE": 1, "MRK": 1, "fatigue": 3},
    "interceptor":    {"MRK": 3},
    "anchor":         {"MRK": 3},
    "brick_wall":     {"MRK": 4},
    "aerial":         {"MRK": 3},
    "enforcer":       {"MRK": 2},
    "bruiser":        {"MRK": 2, "FIN": 1},
    "reflex_cat":     {"GKS": 4},
    "sweeper_keeper": {"GKS": 2, "CRE": 3},
}
# plain-language effect, shown on the card sheet under the chip. Every line
# describes what BADGE_EFF above actually does — nothing more.
BADGE_FX = {
    "speedster":      "He runs your side into more chances, and gets there first.",
    "quick_step":     "A little more of the ball ends up in dangerous places.",
    "finesse":        "His shots go in more often — he places them.",
    "cannon":         "His shots go in more often. Ask the net.",
    "poacher":        "His shots go in more often, from three yards.",
    "distance":       "A few more chances made, a few more taken from range.",
    "chip":           "His shots go in more often, over a keeper who came out.",
    "power_header":   "His shots go in more often when the ball is in the air.",
    "target":         "He holds it up: your side works more chances around him.",
    "playmaker":      "Your side creates noticeably more while he plays.",
    "metronome":      "More chances made, and the line behind him settles.",
    "long_ball":      "Your side creates more — he skips the middle third.",
    "whipped":        "More chances made, and more of them finished.",
    "pinpoint":       "Your side creates more: the cross is always right.",
    "deadball":       "He is far more likely to score a penalty, shootouts too.",
    "trickster":      "He makes chances out of nothing, and finishes a few.",
    "clutch":         "Level or behind, his shots go in more often. Not when ahead.",
    "acrobatic":      "His shots go in slightly more often, from odd angles.",
    "engine":         "A start costs him 6 less energy. He plays every week.",
    "relentless":     "A little more created, a little firmer, and he tires less.",
    "interceptor":    "The line behind him is harder to break down.",
    "anchor":         "The line behind him is harder to break down.",
    "brick_wall":     "The line behind him is much harder to break down.",
    "aerial":         "The line behind him is harder to break down in the air.",
    "enforcer":       "The line behind him is a little harder to break down.",
    "bruiser":        "Harder to play through, and he still gets a shot away.",
    "reflex_cat":     "He saves more, and shots against him are worth less.",
    "sweeper_keeper": "He saves more, and starts your attacks from his own box.",
}
# the engine channels a badge is allowed to touch
BADGE_CHANNELS = ("FIN", "CRE", "PACE", "MRK", "GKS", "PEN", "fatigue")
# energy, not attribute points — its own budget, applied in the career layer
FATIGUE_CAP = 6
# a quirk is older, funnier and louder than any badge, and always outranks its
# sibling — no double dip on the same engine step (design §5)
QUIRK_SUPPRESSES = {
    "big_tackle": ("enforcer",),
    "giant_keeper": ("reflex_cat",),
    "kane_pens": ("deadball",),
    "haaland_ice": ("clutch", "deadball"),
}
# keepers show at most two, and only from the GK block plus Dead Ball
GK_BADGES = {"reflex_cat", "sweeper_keeper", "deadball"}
# The nine are authored. Phoenix is a Sweeper Keeper because he is a dog who
# roams, and that must never be rolled away (design §8.3) — an authored badge
# goes FIRST in the order, always. None means the card's quirk already owns his
# identity: Wembanyama's giant_keeper suppresses Reflex Cat, and Grandpa not
# moving is the whole joke.
CAST_BADGE = {"maradona": "trickster", "suarez": "poacher", "wemby": None,
              "dort": "brick_wall", "caruso": "interceptor",
              "phoenix": "sweeper_keeper", "gibson": "trickster",
              "ellis": "speedster", "grandpa": None}
MAX_BADGES = 3
MAX_BADGES_GK = 2


def badges_for(A, pos, quirk=None, cap=True, authored=None):
    """Derived playstyle badges, in display order. Reads the WHITE vector."""
    got = []
    for bit, bid, _nm, _face, prio, req, poss, _copy in BADGE_DEFS:
        if poss and pos not in poss:
            continue
        if pos == "GK" and bid not in GK_BADGES:
            continue
        if all(A.get(k, 0) >= v for k, v in req.items()):
            got.append((prio, bit, bid))
    if quirk:
        blocked = QUIRK_SUPPRESSES.get(quirk, ())
        got = [g for g in got if g[2] not in blocked]
    got.sort()                                   # priority first, then bit order
    if authored:
        bd = BADGE_BY_ID.get(authored)
        legal = bd and (not bd[6] or pos in bd[6]) and (pos != "GK" or authored in GK_BADGES)
        if legal and authored not in QUIRK_SUPPRESSES.get(quirk or "", ()):
            # an authored badge goes FIRST, whether or not the thresholds found
            # it — being capped out of your own personality is the bug §8.3 names
            got = [g for g in got if g[2] != authored]
            got.insert(0, (-1, bd[0], authored))
    if cap:
        got = got[:(MAX_BADGES_GK if pos == "GK" else MAX_BADGES)]
    return [g[2] for g in got]

def attr_gates(audit, badge_map, attr_values, face_values, delta_values):
    """Build-time gates for the attribute + badge layer (design §11.2/3/8).

    Fails the build loudly rather than shipping a card whose six faces do not
    add back up to his own rating, or a badge nobody in the album can hold.
    """
    fails, notes = [], []
    # §11.8 content validation
    for nm in STAR_OVR:
        if nm not in STAR_ARCH:
            fails.append("STAR_OVR name with no STAR_ARCH entry: " + nm)
    for cid in CAST_ARCH:
        if cid not in {r[0] for r in CAST}:
            fails.append("CAST_ARCH names a card that is not in CAST: " + cid)
    for r in CAST:
        if r[0] not in CAST_ARCH:
            fails.append("cast member with no authored role: " + r[0])
        if r[0] not in CAST_BADGE:
            fails.append("cast member with no authored badge decision: " + r[0])
        want = CAST_BADGE.get(r[0])
        if want and want not in BADGE_BY_ID:
            fails.append("cast %s authored an unknown badge %s" % (r[0], want))
        if want and want not in badge_map.get(r[0], []):
            fails.append("cast %s lost his authored badge %s" % (r[0], want))
    for k in COMP:
        for sub in COMP[k]:
            if sub not in SUB_IDX:
                fails.append("composite %s names an unknown sub %s" % (k, sub))
    for b in BADGE_DEFS:
        for sub in b[5]:
            if sub not in SUB_IDX:
                fails.append("badge %s names an unknown sub %s" % (b[1], sub))
    bits = [b[0] for b in BADGE_DEFS]
    if len(set(bits)) != len(bits) or max(bits) > 29:
        fails.append("badge bits must be unique and <= 29 (one int32 mask)")

    # §11.3 OVR reconstruction, and the archetype/position agreement
    errs, by_pos, deltas = [], {}, {}
    for sid, name, code, pos, ovr, at, bd in audit:
        if ARCH[at["arch"]]["pos"] != pos:
            fails.append("%s: role %s is illegal for %s" % (sid, at["arch"], pos))
        rec = sum(OVR_W[pos][f] * at["faces"][f] for f in OVR_W[pos])
        errs.append(rec - ovr)
        by_pos.setdefault(pos, []).append(sid)
        for k, v in at["d"].items():
            deltas.setdefault(k, []).append(v)
    worst = max(abs(e) for e in errs)
    mean = sum(errs) / len(errs)
    sd = (sum((e - mean) ** 2 for e in errs) / len(errs)) ** 0.5
    if worst > 1.0:
        fails.append("OVR reconstruction worst |err| %.2f > 1.0" % worst)
    if sd > 0.5:
        fails.append("OVR reconstruction sd %.2f > 0.5" % sd)
    notes.append("OVR reconstruction: mean %+.2f  sd %.2f  worst %.2f"
                 % (mean, sd, worst))

    # §11.2 L2 zero-sum: every delta's roster mean sits inside +-1.0
    bad = []
    for k in sorted(deltas):
        vs = deltas[k]
        m = sum(vs) / len(vs)
        s2 = (sum((v - m) ** 2 for v in vs) / len(vs)) ** 0.5
        if abs(m) > 1.0:
            bad.append("%s mean %+.2f" % (k, m))
        notes.append("  d%-5s mean %+.2f  sd %.2f" % (k, m, s2))
    if bad:
        fails.append("L2 zero-sum breached: " + ", ".join(bad))

    # §11.4 teeth — the system has to MATTER
    fin_att = [at["d"]["FIN"] for _s, _n, _c, p, _o, at, _b in audit if p == "ATT"]
    mrk_def = [at["d"]["MRK"] for _s, _n, _c, p, _o, at, _b in audit if p == "DEF"]
    def _sd(v):
        m = sum(v) / len(v)
        return (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5
    if _sd(fin_att) < 2.0:
        fails.append("teeth: sd(dFIN) over ATT %.2f < 2.0" % _sd(fin_att))
    if _sd(mrk_def) < 2.5:
        fails.append("teeth: sd(dMRK) over DEF %.2f < 2.5" % _sd(mrk_def))
    notes.append("teeth: sd(dFIN|ATT) %.2f   sd(dMRK|DEF) %.2f"
                 % (_sd(fin_att), _sd(mrk_def)))

    # ---- the data file must be internally consistent: every consumer reads
    # these three arrays and NOTHING re-derives them, so a disagreement here is
    # a disagreement nobody downstream can detect.
    face_err = []
    for sid, name, code, pos, ovr, at, bd in audit:
        A = attr_values[sid]
        order = FACE_ORDER["GK" if pos == "GK" else "OUT"]
        want = [_jround(sum(w * A[SUB_IDX[n]] for n, w in FACE_SUBS[f].items()))
                for f in order]
        if want != face_values[sid]:
            face_err.append("%s stored %s vs subs %s" % (sid, face_values[sid], want))
    if face_err:
        fails.append("stored faces are not the rounded weighted mean of the "
                     "stored subs on %d cards: %s"
                     % (len(face_err), "; ".join(face_err[:6])))
    d_err = []
    for sid, name, code, pos, ovr, at, bd in audit:
        want = [_jround(at["d"][k] * 10) for k in DELTA_ORDER]
        if want != delta_values[sid]:
            d_err.append(sid)
    if d_err:
        fails.append("stored deltas do not match the audit on %d cards" % len(d_err))

    # ---- a badge must name a real face and a real engine channel, and must
    # not promise more than the budget allows
    for b in BADGE_DEFS:
        if b[3] not in FACE_SUBS:
            fails.append("badge %s: face '%s' is not one of the twelve faces"
                         % (b[1], b[3]))
        eff = BADGE_EFF.get(b[1])
        if not eff:
            fails.append("badge %s has no engine effect" % b[1])
            continue
        if not BADGE_FX.get(b[1]):
            fails.append("badge %s has no plain-language effect line" % b[1])
        for ch, v in eff.items():
            if ch == "when":
                continue
            cap = FATIGUE_CAP if ch == "fatigue" else ENGINE_HOOKS["badgeCap"]
            if ch not in BADGE_CHANNELS:
                fails.append("badge %s touches unknown channel %s" % (b[1], ch))
            elif v > cap:
                fails.append("badge %s puts %+d into %s (budget %d)"
                             % (b[1], v, ch, cap))
    # ---- no card may exceed the badge budget in any one channel
    for sid, name, code, pos, ovr, at, bd in audit:
        tot = {}
        for bid in bd:
            for ch, v in BADGE_EFF.get(bid, {}).items():
                if ch == "when":
                    continue
                tot[ch] = tot.get(ch, 0) + v
        for ch, v in tot.items():
            cap = FATIGUE_CAP if ch == "fatigue" else ENGINE_HOOKS["badgeCap"]
            # three badges may each contribute; the hook clamps the SUM to the
            # budget, so the gate only has to catch a runaway catalogue
            if v > 3 * cap:
                fails.append("%s stacks %+d into %s before the clamp — the "
                             "catalogue is too generous" % (sid, v, ch))
    notes.append("badge budget: every delta clamped to +%d before its hook, "
                 "fatigue to %d energy"
                 % (ENGINE_HOOKS["badgeCap"], FATIGUE_CAP))

    # badge density and the no-dead-badge / no-everybody-badge rule
    n = len(audit)
    cnt = {b[1]: 0 for b in BADGE_DEFS}
    for bd in badge_map.values():
        for b in bd:
            cnt[b] += 1
    for bid, c in cnt.items():
        if c == 0:
            fails.append("badge '%s' is held by nobody" % bid)
        elif c > 0.25 * n:
            fails.append("badge '%s' on %.1f%% of cards (> 25%%)"
                         % (bid, 100.0 * c / n))
    held = sum(len(v) for v in badge_map.values())
    notes.append("badges: %d awarded over %d cards (mean %.2f), %d cards with none"
                 % (held, n, held / float(n), n - len(badge_map)))
    for sid, name, code, pos, ovr, at, bd in audit:
        cap = MAX_BADGES_GK if pos == "GK" else MAX_BADGES
        if len(bd) > cap:
            fails.append("%s holds %d badges (cap %d)" % (sid, len(bd), cap))
    if fails:
        for f in fails:
            print("  ATTRIBUTE GATE FAILED:", f)
        raise SystemExit("attribute gates failed — data not written")
    return notes


# appearances for THIS card that fully reveal his potential
REVEAL_APPS = 15

# classic footballing rivalries only — sporting, family-safe, no politics
RIVALS = [
    ["ARG", "BRA"], ["ARG", "ENG"], ["ARG", "URU"], ["BRA", "URU"],
    ["ENG", "GER"], ["ENG", "SCO"], ["ENG", "FRA"], ["FRA", "GER"],
    ["GER", "NED"], ["BEL", "NED"], ["ESP", "POR"], ["ESP", "NED"],
    ["MEX", "USA"], ["CAN", "MEX"], ["CAN", "USA"], ["JPN", "KOR"],
    ["AUS", "NZL"], ["AUT", "SUI"],
]
RIVAL_OF = {}
for _a, _b in RIVALS:
    RIVAL_OF.setdefault(_a, set()).add(_b)
    RIVAL_OF.setdefault(_b, set()).add(_a)

# link type ids are FROZEN — the index encodes them as their position here
LINK_TYPES = [
    {"id": "nation", "label": "Same nation", "w": 0.85, "chem": 2,
     "blurb": "Grew up in the same shirt. They find each other."},
    {"id": "club", "label": "Club-mates", "w": 1.00, "chem": 3,
     "blurb": "They train together every week of the year."},
    {"id": "pf", "label": "Passer → finisher", "w": 1.00, "chem": 3,
     "blurb": "One sees it, the other finishes it."},
    {"id": "wall", "label": "Keeper + wall", "w": 0.90, "chem": 2,
     "blurb": "A keeper who trusts the man in front of him."},
    {"id": "spark", "label": "Rival spark", "w": 0.70, "chem": 1,
     "blurb": "Old rivals, same side, everything to prove."},
]
LINK_IDX = {t["id"]: i for i, t in enumerate(LINK_TYPES)}
W_NATION = LINK_TYPES[0]["w"]
W_CLUB = LINK_TYPES[1]["w"]
W_PF = LINK_TYPES[2]["w"]
W_WALL = LINK_TYPES[3]["w"]
W_SPARK = LINK_TYPES[4]["w"]

# how well two lines of the pitch complement each other
_PC = {("GK", "GK"): 0.15, ("GK", "DEF"): 1.00, ("GK", "MID"): 0.70,
       ("GK", "ATT"): 0.50, ("DEF", "DEF"): 0.70, ("DEF", "MID"): 0.90,
       ("DEF", "ATT"): 0.80, ("MID", "MID"): 0.75, ("MID", "ATT"): 1.00,
       ("ATT", "ATT"): 0.70}
POS_PAIR = {}
for _p in ("GK", "DEF", "MID", "ATT"):
    POS_PAIR[_p] = {}
    for _q in ("GK", "DEF", "MID", "ATT"):
        POS_PAIR[_p][_q] = _PC.get((_p, _q)) or _PC.get((_q, _p)) or 0.6

# at most this many of one link type in a card's top-8 (keeps a list varied)
TYPE_CAP = {"nation": 3, "club": 3, "pf": 3, "wall": 2, "spark": 2}
TEAM_CAP = 3            # …and at most three partners from any one album team
TOP_N = 8


def qnorm(ovr):
    """quality 0..1 across the roster's live band (58 filler, 95 grail)."""
    return max(0.0, min(1.0, (ovr - 58) / 37.0))


def parse_birth_age(bd):
    """'6/15/1992 12:00:00 AM' -> age at AGE_REF, or None."""
    if not bd:
        return None
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", str(bd))
    if not m:
        return None
    mo, day, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y, rm, rd = AGE_REF
    age = y - yr - ((rm, rd) < (mo, day))
    return age if 14 <= age <= 55 else None


def ea_entity(name, code, ent_full, ent_last, ent_il):
    """The OVR resolver's match ladder, but nation is ALWAYS required — a loose
    match here would hand a real player somebody else's birthday."""
    n = norm(name)
    hit = ent_full.get((n, code))
    if hit:
        return hit[0]
    toks = n.split()
    if not toks:
        return None
    hit = ent_last.get((toks[-1], code))
    if hit and len(hit) == 1:
        return hit[0]
    hit = ent_il.get((toks[0][0], toks[-1], code))
    if hit and len(hit) == 1:
        return hit[0]
    return None


def rolled_age(sid, pos, ovr):
    """Position-appropriate age off the card id — stable across rebuilds."""
    r = seeded(sid + ":age")
    total = sum(w for _, w in AGE_BANDS)
    pick = r.randint(1, total)
    age = AGE_BANDS[-1][0]
    for a, w in AGE_BANDS:
        pick -= w
        if pick <= 0:
            age = a
            break
    age += POS_AGE_SHIFT.get(pos, 0)
    if ovr >= 85 and age < 22:          # elite and unheard-of is rare
        age += 3
    return max(17, min(38, age))


def player_age(sid, pos, ovr, ent):
    """(age, real?) — a matched date of birth wins, else a shaped roll."""
    real = parse_birth_age(ent.get("bd")) if ent else None
    if real is not None:
        return real, True
    return rolled_age(sid, pos, ovr), False


def age_stage(age):
    for lo, hi, label, _g in AGE_STAGES:
        if lo <= age <= hi:
            return label
    return AGE_STAGES[-1][2]


def age_room(age):
    for cutoff, room in AGE_ROOM:
        if age <= cutoff:
            return room
    return 0


def archetype(sid, pos, ovr, sho, dfn, name=None):
    """One of the eight archetypes: authored for the famous, hashed for the rest."""
    star = CAST_ARK.get(sid) or (STAR_ARK.get(norm(name)) if name else None)
    if star and star in ARK_LEGAL.get(pos, ()):
        return star
    r = seeded(sid + ":ark")
    if pos == "GK":
        return "sk" if r.random() < (0.45 if ovr >= 80 else 0.25) else "ss"
    if pos == "DEF":
        return "bp" if sho >= 50 else "an"
    if pos == "MID":
        # mirrors derive_stats' own playmaker / box-to-box split
        if int(hashlib.md5(sid.encode()).hexdigest()[8:10], 16) % 2 == 0:
            return "pm"
        return "an" if dfn >= sho else "wg"
    if pos == "ATT":
        x = r.random()
        if sho >= ovr + 2:
            return "po" if x < 0.65 else "wg"
        return "wg" if x < 0.55 else ("tg" if x < 0.85 else "po")
    return "an"


def role_indices(ark, ovr, sho):
    """(creator, finisher) on 0-9 — the two numbers the synergy rules read."""
    cb, fb, _f = ROLE_BASE[ark]
    q = qnorm(ovr)
    cr = int(round(cb * (0.62 + 0.38 * q)))
    fn = int(round(fb * (0.62 + 0.38 * q)))
    if sho >= ovr:
        fn += 1
    elif sho < ovr - 14:
        fn -= 1
    return max(0, min(9, cr)), max(0, min(9, fn))


def potential(sid, ovr, age, ark, at_ceiling):
    """(pot, halfWidth, offset).

    pot     the true ceiling, always >= base
    hw/off  how the sheet MASKS it until the card has played for you
    """
    if at_ceiling:
        return ovr, 0, 0
    r = seeded(sid + ":pot")
    q = qnorm(ovr)
    head = age_room(age) * ROLE_BASE[ark][2] * (1.0 - 0.55 * q)
    roll = r.random()
    floor = 0.55 if age <= 18 else 0.30      # the youngest carry sure headroom
    room = int(round(head * (floor + (1.0 - floor) * (roll ** 1.5))))
    if age <= 21 and roll > 0.94:            # the rare gem
        room += 3 + int(2 * r.random())
    pot = max(ovr, min(97, ovr + max(0, room)))
    room = pot - ovr
    if room == 0:
        return pot, 0, 0                     # nothing to hide
    hw = max(1, min(9, int(round(2 + room * 0.55 + 2 * r.random()))))
    return pot, hw, r.choice([-1, 0, 0, 1])


def link_for(a, b):
    """Strongest link between two cards from A's point of view, or None.

    strength = 99 · linkWeight · fit · (0.55 + 0.45 · partnerQuality)
    so a list ranks great links with great players first.
    """
    pc = POS_PAIR[a["pos"]][b["pos"]]
    qf = b["qf"]
    bt, bs = None, 0
    at = a["team"]
    if at and at == b["team"]:
        s = W_NATION * (0.72 + 0.28 * pc) * qf
        if s > bs:
            bt, bs = "nation", s
    ac = a["club"]
    if ac and ac == b["club"]:
        s = W_CLUB * (0.78 + 0.22 * pc) * qf
        if s > bs:
            bt, bs = "club", s
    if a["cr"] >= 6 and b["fn"] >= 6:
        s = W_PF * math.sqrt(a["cr"] * b["fn"] / 81.0) * qf
        if s > bs:
            bt, bs = "pf", s
    if b["cr"] >= 6 and a["fn"] >= 6:
        s = W_PF * math.sqrt(b["cr"] * a["fn"] / 81.0) * qf
        if s > bs:
            bt, bs = "pf", s
    if a["pos"] == "GK" and b["pos"] == "DEF":
        s = W_WALL * math.sqrt(qnorm(a["ovr"]) * b["wallq"]) * qf
        if s > bs:
            bt, bs = "wall", s
    elif a["pos"] == "DEF" and b["pos"] == "GK":
        s = W_WALL * math.sqrt(qnorm(b["ovr"]) * a["wallq"]) * qf
        if s > bs:
            bt, bs = "wall", s
    if bt is None or bs < 0.25:
        # rivalry is flavour: only offered when nothing stronger is on the table
        if at and b["team"] in RIVAL_OF.get(at, ()):
            s = W_SPARK * (0.55 + 0.45 * pc) * qf
            if s > bs:
                bt, bs = "spark", s
    if bt is None:
        return None
    return bt, int(round(99 * min(1.0, bs)))


def build_synergy(cards):
    """cards: link dicts. -> {pid: "partnerId,type,strength …"} (top 8).

    One pass over every ordered pair (~750k for this roster), then a greedy
    top-8 with per-type and per-team caps so no list reads as eight of the
    same idea. Runtime then answers "best available partners" with one lookup.
    """
    subjects = [c for c in cards if c["subject"]]
    partners = [c for c in cards if c["partner"]]
    out = {}
    for a in subjects:
        scored = []
        aid = a["id"]
        for b in partners:
            if b["id"] == aid:
                continue
            hit = link_for(a, b)
            if hit:
                scored.append((-hit[1], b["id"], hit[0], b["team"]))
        scored.sort()
        picked, taken, tcount, teamcount = [], set(), {}, {}
        for capped, teamcapped in ((True, True), (False, True), (False, False)):
            # pass 1 honours both caps, so a list reads varied; passes 2 and 3
            # fill whatever that left behind — a holding midfielder with no
            # known club and no rival neighbour has nothing but his flag, and
            # eight of his countrymen is the honest answer for him
            for negs, pid, tid, team in scored:
                if len(picked) >= TOP_N:
                    break
                if pid in taken:
                    continue
                if capped and tcount.get(tid, 0) >= TYPE_CAP[tid]:
                    continue
                if teamcapped and team and teamcount.get(team, 0) >= TEAM_CAP:
                    continue
                tcount[tid] = tcount.get(tid, 0) + 1
                teamcount[team] = teamcount.get(team, 0) + 1
                taken.add(pid)
                picked.append((negs, pid, tid))
            if len(picked) >= TOP_N:
                break
        picked.sort()                       # best first, whichever pass found it
        if picked:
            out[aid] = " ".join("%s,%d,%d" % (pid, LINK_IDX[tid], -negs)
                                for negs, pid, tid in picked)
    return out


def link_card(pid, pos, ovr, sho, dfn, team, club, ark, subject, partner):
    """The compact record build_synergy scores against."""
    cr, fn = role_indices(ark, ovr, sho)
    return {"id": pid, "pos": pos, "ovr": ovr, "dfn": dfn, "team": team,
            "club": club, "cr": cr, "fn": fn, "ark": ark,
            "qf": 0.55 + 0.45 * qnorm(ovr),
            "wallq": max(0.0, min(1.0, (dfn - 58) / 38.0)),
            "subject": subject, "partner": partner}


# ============================================================ Addendum 21 §1
# THE FC ROSTER LAYER — gibson/web/static/mg-roster.js (window.MG_ROSTER)
#
# data/ea/page-*.json is the complete public EA FC ratings database, harvested
# by tools/fetch_ea_roster.sh. It ships as the game's player universe: real
# clubs, real leagues, real squads. The 980 Panini album cards stay the
# collectible layer in MG_DATA and are MERGED here, never duplicated.
#
# HONESTY (addendum 21 §3): these ratings are EA's own public numbers. The
# game is not affiliated with, endorsed by or licensed by EA, and every screen
# that shows a rating has to say so. ROSTER_HONESTY is the string it says.
#
# Size discipline: a shared strings table, fixed-width base64 columns and a
# 7-bit stat stream. No 17k fat objects, and nothing is deserialised at boot.
#
# Addendum 22 §2's YOUTH PROSPECT POOL rides on this file as a thin section
# of it (see build_youth): the prospects ARE roster players, so the pool ships
# their roster ids and the few numbers this game invents, never a second copy
# of 644 names, clubs and nations.

# Which harvest the roster is built from. Newest first: the FC 27 database
# (tools/fetch_ea_ratings.py, 2026-09-15) wins whenever it is on disk, then the
# FC 26 one (tools/fetch_ea_roster.sh, 2026-06-11). `--ea <dir>` picks one
# explicitly. AS_OF is the day ages are measured on, and the harvest day.
EA_SOURCES = [
    ("ea-fc27", (2026, 9, 15),
     "EA SPORTS FC 27 ratings, www.ea.com/games/ea-sports-fc/ratings, harvested to data/ea-fc27/"),
    ("ea", (2026, 6, 11),
     "EA public FC ratings pages (drop-api.ea.com/rating/ea-sports-fc), harvested to data/ea/"),
]


def _pick_ea_source():
    want = None
    if "--ea" in sys.argv:
        i = sys.argv.index("--ea")
        want = os.path.basename(os.path.normpath(sys.argv[i + 1])) if i + 1 < len(sys.argv) else None
    for name, as_of, source in EA_SOURCES:
        d = os.path.join(ROOT, "data", name)
        if want and name != want:
            continue
        if want or glob.glob(os.path.join(d, "page-*.json")):
            return d, as_of, source
    name, as_of, source = EA_SOURCES[-1]
    return os.path.join(ROOT, "data", name), as_of, source


EA_DIR, AS_OF, ROSTER_SOURCE = _pick_ea_source()
ROSTER_PATH = os.path.join(ROOT, "gibson", "web", "static", "mg-roster.js")
ROSTER_RUNTIME = os.path.join(ROOT, "tools", "mg-roster-runtime.js")
ROSTER_VERSION = 1

ROSTER_HONESTY = (
    "Player ratings, clubs, leagues and nations come from EA's public FC "
    "ratings pages. Card Manager is a family project and is not affiliated "
    "with, endorsed by, or licensed by EA. The Panini album cards, the "
    "parallel colours and everything else in the game are ours."
)
ROSTER_NOTICE = "Ratings: EA's public FC ratings pages. Not affiliated with or endorsed by EA."

B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
NO_CLUB = "(no club listed)"
NO_LEAGUE = "(no league)"

POS_ORDER = ["GK", "CB", "LB", "RB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST"]
POS_TYPE = {"defense": "DEF", "midfielder": "MID", "attack": "ATT"}


def enc_col(vals, w, off=0, what=""):
    """Fixed-width base64 column, w symbols (6 bits each) per value."""
    lim = 64 ** w
    out = []
    for v in vals:
        x = int(v) - off
        if x < 0 or x >= lim:
            raise SystemExit("roster: %s value %r does not fit %d base64 chars "
                             "at offset %d" % (what, v, w, off))
        out.append("".join(B64[(x >> (6 * (w - 1 - k))) & 63] for k in range(w)))
    return "".join(out)


def enc_bits(rows, bits, per):
    """Fixed-width bit-packed record per row: `per` values of `bits` bits,
    MSB first, padded up to a whole number of 6-bit symbols."""
    chars = (per * bits + 5) // 6
    pad = chars * 6 - per * bits
    lim = 1 << bits
    out = []
    for vals in rows:
        acc = 0
        for v in vals:
            if v < 0 or v >= lim:
                raise SystemExit("roster: stat %r does not fit %d bits" % (v, bits))
            acc = (acc << bits) | v
        acc <<= pad
        out.append("".join(B64[(acc >> (6 * (chars - 1 - k))) & 63]
                           for k in range(chars)))
    return "".join(out), chars


def load_ea_roster():
    """Every page-*.json in EA_DIR, deduped by player id, in EA's own rank order."""
    files = sorted(glob.glob(os.path.join(EA_DIR, "page-*.json")))
    if not files:
        return []
    seen, rows = set(), []
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                page = json.load(f)
        except (ValueError, IOError) as exc:
            print("  roster: skipping %s (%s)" % (os.path.basename(path), exc))
            continue
        for it in page.get("items") or []:
            pid = it.get("id")
            if pid is None or pid in seen or not it.get("overallRating"):
                continue
            seen.add(pid)
            rows.append(it)
    rows.sort(key=lambda it: (it.get("rank") or 10 ** 9, -it["overallRating"], it["id"]))
    return rows


def _birth(bd):
    m = re.match(r"(\d+)/(\d+)/(\d{4})", bd or "")
    if not m:
        return 0
    mo, day, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1970 <= yr < 2098):
        return 0
    return ((yr - 1970) << 9) | (mo << 5) | day


def album_people(players_by_team):
    """The album cards that are people: (sid, code, num, name, pos, ovr).
    Crests, team photos and FWC heritage cards (pos SPE) are not people and
    never merge."""
    out = []
    for code in sorted(players_by_team):
        for r in players_by_team[code]:
            if r[4] == "SPE":
                continue
            out.append((r[0], code, r[1], r[2], r[4], r[5]))
    return out


def album_from_data_js():
    """--roster-only: read the album straight out of the shipped MG_DATA so a
    roster rebuild never has to touch mg-manager-data.js."""
    if not os.path.exists(OUT_PATH):
        return {}
    with open(OUT_PATH, encoding="utf-8") as f:
        src = f.read()
    i = src.index("window.MG_DATA=")
    doc = json.loads(src[i + len("window.MG_DATA="):].rstrip().rstrip(";\n").rstrip(";"))
    return doc.get("players") or {}


def merge_album(rows, album):
    """Same person = one entity. Four passes over the whole album, best rule
    first: normalised name + nation, then initial + surname + nation, then
    surname + nation, then a unique name anywhere. A pass never takes an EA
    player another card already holds, and a card refused in one pass tries
    again in the next — which is what stops Dani Olmo (real name Daniel Olmo
    CARVAJAL) from swallowing Dani Carvajal's card."""
    full, init_last, last_only, any_full, women_name = {}, {}, {}, {}, {}
    sur_freq = {}
    men = 0
    for i, it in enumerate(rows):
        woman = ((it.get("gender") or {}).get("id") or 0) == 1
        forms = set()
        f = norm((it.get("firstName") or "") + " " + (it.get("lastName") or ""))
        if f:
            forms.add(f)
        c = norm(it.get("commonName") or "")
        if c:
            forms.add(c)
        if woman:
            for n in forms:
                women_name.setdefault(n, []).append(i)
            continue
        men += 1
        nat = NATION_LOOKUP.get(norm((it.get("nationality") or {}).get("label") or ""))
        for n in forms:
            any_full.setdefault(n, []).append(i)
            t = n.split()
            if t:
                sur_freq[t[-1]] = sur_freq.get(t[-1], 0) + 1
            if nat:
                full.setdefault((n, nat), []).append(i)
                toks = n.split()
                if not toks:
                    continue
                last_only.setdefault((toks[-1], nat), []).append(i)
                if len(toks) > 1:
                    init_last.setdefault((toks[0][0], toks[-1], nat), []).append(i)

    def describe(i):
        it = rows[i]
        team = it.get("team") or {}
        return {"ea": it["id"],
                "name": ((it.get("commonName") or "").strip()
                         or (it.get("firstName", "") + " " + it.get("lastName", "")).strip()),
                "nation": (it.get("nationality") or {}).get("label"),
                "ovr": it["overallRating"], "club": team.get("label")}

    forms_of = {}
    for i, it in enumerate(rows):
        fs = set()
        f = norm((it.get("firstName") or "") + " " + (it.get("lastName") or ""))
        if f:
            fs.add(f)
        c = norm(it.get("commonName") or "")
        if c:
            fs.add(c)
        forms_of[i] = fs

    def _lev(a, b, cap):
        """Edit distance, given up on once it passes cap."""
        if abs(len(a) - len(b)) > cap:
            return cap + 1
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                               prev[j - 1] + (ca != cb)))
            if min(cur) > cap:
                return cap + 1
            prev = cur
        return prev[-1]

    def _same_forename(x, y):
        if x == y:
            return True
        if len(x) > 2 and (y.startswith(x) or x.startswith(y)):
            return True
        n = min(len(x), len(y))
        # one letter, no more: Mohamed/Mohammed yes, Angel/Manuel no.
        return n >= 4 and _lev(x, y, 1) <= 1

    def forename_fits(album_name, i):
        """A surname rule on its own cheerfully turns Santiago Arias into Juan
        Arias, and Jhon Cordoba into Juan Cordoba. Demand that the forenames
        agree on something: a shared token, a prefix (Sam/Samuel, Nico/
        Nicolas), a one-letter spelling drift (Mohamed/Mohammed, Luiz/Luis),
        or a mononym on either side (Vozinha, Morata) with no forename to
        disagree with."""
        a = album_name.split()
        if len(a) < 2:
            return True
        head = a[:-1]
        for f in forms_of[i]:
            t = f.split()
            if len(t) < 2:
                return True
            for x in head:
                for y in t[:-1]:
                    if _same_forename(x, y):
                        return True
        return False

    def pick(cands, ovr):
        best = None
        for i in cands:
            key = (abs(rows[i]["overallRating"] - ovr), -rows[i]["overallRating"], i)
            if best is None or key < best[0]:
                best = (key, i)
        return best[1] if best else None

    TIERS = ["name+nation", "initial+last+nation", "last+nation", "name-only"]
    # Korean names are written surname-first and romanised half a dozen ways;
    # "Son Heung-min" and "Seo Jae Min" share a trailing token and nothing
    # else. For those nations it is an exact name or no merge at all.
    SURNAME_FIRST = {"KOR"}
    SUR_COMMON = 12        # a name-only merge needs a surname rarer than this

    def candidates(card, tier):
        sid, code, num, name, pos, ovr = card
        n = norm(name)
        toks = n.split()
        if tier == TIERS[0]:
            return full.get((n, code)) or []
        if code in SURNAME_FIRST:
            return []          # romanised surname-first names: tier 1 or nothing
        if tier == TIERS[1]:
            return (init_last.get((toks[0][0], toks[-1], code)) or []) if len(toks) > 1 else []
        if tier == TIERS[2]:
            return (last_only.get((toks[-1], code)) or []) if toks else []
        return any_full.get(n) or []

    claimed, card_of, tiers = {}, {}, {}
    merges, notes = [], {}
    pending = list(album)
    for tier in TIERS:
        still = []
        for card in pending:
            sid, code, num, name, pos, ovr = card
            cands = candidates(card, tier)
            free = [i for i in cands if i not in claimed]
            got = None
            if tier == TIERS[2]:
                n = norm(name)
                fits = [i for i in free if forename_fits(n, i)]
                if len(cands) > 3:
                    notes[sid] = ("surname + %s matches %d men — too vague to guess"
                                  % (code, len(cands)),
                                  [describe(i) for i in cands[:3]])
                elif free and not fits:
                    notes[sid] = ("only %s of that surname is %s, and the "
                                  "forenames disagree" % (describe(free[0])["name"], code),
                                  [describe(i) for i in free[:2]])
                elif fits:
                    got = pick(fits, ovr)
            elif tier == TIERS[3]:
                n = norm(name)
                toks_n = n.split()
                sur = toks_n[-1] if toks_n else ""
                if len(free) == 1 and len(toks_n) > 1 and sur_freq.get(sur, 0) <= SUR_COMMON:
                    got = free[0]
                elif len(free) == 1:
                    notes[sid] = ("%s is too common a name to match on its own "
                                  "(%d men share the surname)"
                                  % (name, sur_freq.get(sur, 0)),
                                  [describe(free[0])])
                elif len(free) > 1:
                    notes[sid] = ("name matches %d EA players and none of them is %s"
                                  % (len(free), code), [describe(i) for i in free[:3]])
            elif tier == TIERS[1]:
                n = norm(name)
                fits = [i for i in free if forename_fits(n, i)]
                if fits:
                    got = pick(fits, ovr)
                elif free:
                    notes[sid] = ("shares a surname and an initial with %s, but "
                                  "not a forename" % describe(free[0])["name"],
                                  [describe(i) for i in free[:2]])
            elif free:
                got = pick(free, ovr)
            elif cands:
                notes[sid] = ("only EA match is already another card's player",
                              [describe(i) for i in cands[:2]])
            if got is None:
                still.append(card)
                continue
            claimed[got] = sid
            card_of[got] = sid
            tiers[tier] = tiers.get(tier, 0) + 1
            rec = {"card": sid, "name": name, "nation": code, "albumOvr": ovr,
                   "tier": tier, "ea": describe(got)}
            if NATION_LOOKUP.get(norm(rec["ea"]["nation"] or "")) != code:
                rec["xnat"] = 1        # dual national: EA files him elsewhere
            merges.append(rec)
        pending = still

    rejected = []
    for sid, code, num, name, pos, ovr in pending:
        n = norm(name)
        toks = n.split()
        why, saw = notes.get(sid, (None, []))
        if not why:
            if n in women_name:
                why = "the only player of that name is in the women's game"
                saw = [describe(i) for i in women_name[n][:2]]
            elif toks and any(k[0] == toks[-1] for k in last_only):
                why = "the surname exists in EA's data, but never for %s" % code
                saw = [describe(i) for k, v in last_only.items()
                       if k[0] == toks[-1] for i in v[:1]][:2]
            else:
                why = "EA's public database has no player of that name"
                saw = []
        rejected.append({"card": sid, "name": name, "nation": code,
                         "why": why, "saw": saw})

    report = {
        "cards": len(album),
        "people": len(album),
        "matched": len(card_of),
        "byTier": tiers,
        "unmatched": len(pending),
        "eaMen": men,
        "rule": "four passes over the album, best rule first: normalised name + "
                "nation, then initial + surname + nation, then surname + nation, "
                "then a unique name anywhere, and only for a surname fewer "
                "than 12 men share. Ties go to the OVR closest to the "
                "album card. A pass never takes a player another card already "
                "holds, women's-game players never merge into a men's album "
                "card, and a surname shared by more than three men is refused "
                "rather than guessed.",
    }
    return card_of, report, merges, rejected


def _spread(rows, k):
    """An even sample across the whole list, not the first k of one country."""
    if len(rows) <= k:
        return rows
    step = len(rows) / float(k)
    return [rows[int(i * step)] for i in range(k)]


def _pick_rejects(rows, k):
    """Lead with the refusals that were judgement calls, then the plain
    'EA has never heard of him' ones."""
    def rank(r):
        w = r["why"]
        if w.startswith("only EA match"):
            return 0
        if w.startswith("name matches"):
            return 1
        if w.startswith("surname +"):
            return 2
        if "women" in w:
            return 3
        if w.startswith("the surname exists"):
            return 4
        return 5
    return sorted(rows, key=rank)[:k]



# ======================================================= Addendum 22 §2
# THE YOUTH PROSPECT POOL — real under-20s, honestly labelled.
#
# The pool is a SECTION OF THE ROSTER, not a second copy of it. Every
# prospect is already in data/ea/page-*.json with his name, club, league,
# nation, date of birth, position, playstyles and stat block; the youth
# block ships only the prospect's roster index and the handful of numbers
# this game invents for him. 644 prospects cost about 6 KB, not 50.
#
# WHAT IS REAL, AND WHOSE IT IS:
#   from EA's public FC ratings pages — name, date of birth (hence the age),
#   club, nation, position, and the CURRENT overall rating.
#   made here for this game, and NOT EA's — the potential CEILING, its
#   masked range, the growth/bust curve, the signing fee, and the SHO/DEF
#   split the match engine reads.
# Nobody is invented. The label is "under-20 prospects" because that is
# precisely what the data supports, and no more.

# The pool's measuring day. Deliberately NOT the roster's AS_OF (2026-06-11,
# the opening day of the album's tournament, which pins the album's ages and
# must never move): a scouting database is a DATED SNAPSHOT and says so.
YOUTH_REF = (2026, 8, 29)
YOUTH_MAX_AGE = 19

# Headroom ceiling by age — the most a prospect's base could still grow.
# These are the largest numbers in the game by design. AGE_ROOM, which every
# album card is bound by, gives its most generous case (a 12-year-old) 22
# points and a 19-year-old 15. The pool exists to hold the highest ceilings
# anywhere in Card Manager, so it is allowed to beat that and does.
YOUTH_ROOM_CAP = {17: 36, 18: 34, 19: 31}

# THE GROWTH/BUST CURVE, AS ODDS. Roll a uniform, find the band, take that
# share of the age's headroom. These bands ship in the data and the intake
# screen prints them: addendum 22's guardrail is honest odds, so these are
# the odds, in public, before anybody signs anything.
#           band     share of rolls   share of the headroom it grants
YOUTH_CURVE = [
    ("bust",  0.15, 0.03, 0.14),   # he is roughly what he already is
    ("squad", 0.17, 0.15, 0.26),   # a useful squad player, never a star
    ("first", 0.38, 0.27, 0.47),   # a first-teamer
    ("star",  0.22, 0.48, 0.72),   # a star
    ("gen",   0.08, 0.73, 1.00),   # generational
]
YOUTH_BAND_LABEL = {"bust": "never quite kicks on", "squad": "squad player",
                    "first": "first-teamer", "star": "star",
                    "gen": "generational"}

# A prospect already rated 89 cannot also gain 30. The squeeze is on the
# ABSOLUTE gain and never on the odds, so the band a roll lands in is drawn
# the same way for every prospect and the published table stays true for all
# of them.
YOUTH_Q_SQUEEZE = 0.42
YOUTH_PT_CAP = 99

# What one season of development is worth, for a prospect IN YOUR SQUAD.
# The runtime reads these very numbers out of the shipped data — one set of
# constants, one curve, no second copy to drift away from this one.
YOUTH_GROWTH = {
    "rate": 0.20,          # share of the REMAINING room closed in a median season
    "playFloor": 0.30,     # a prospect who never plays still learns a little
    "playApps": 10,        # …and one who plays ten times learns at full speed
    "rollLo": 0.35,        # the season roll: 0.35x on a bad year …
    "rollHi": 1.65,        # … 1.65x on a good one
    "stage": [[18, 1.30], [21, 1.22], [24, 1.12], [28, 1.00], [120, 0.90]],
}
YOUTH_INTAKE = {"perSeason": 3}
# The fee reads the two PUBLISHED facts only — his rating and his age. Never
# the hidden ceiling: a fee that could be run backwards to recover the
# potential would undo the mask, and the mask is the whole game here.
YOUTH_FEE = {"base": 55, "perAbility": 12, "perYoung": 25, "floor": 40, "cap": 600}


def youth_age(born, ref=YOUTH_REF):
    """(y, m, d) packed birth tuple -> age at ref."""
    y, mo, d = born
    ry, rm, rd = ref
    return ry - y - ((rm, rd) < (mo, d))


def youth_band(roll):
    """(band, lo, hi, t) — which curve band a uniform roll lands in."""
    acc = 0.0
    for name, share, lo, hi in YOUTH_CURVE:
        if roll < acc + share or name == YOUTH_CURVE[-1][0]:
            return name, lo, hi, _cl((roll - acc) / share, 0.0, 1.0)
        acc += share
    return YOUTH_CURVE[-1][0], YOUTH_CURVE[-1][2], YOUTH_CURVE[-1][3], 1.0


def youth_potential(sid, cur, age):
    """(pot, halfWidth, offset, band).

    pot    the TRUE ceiling of the base player — decided HERE, once, and
           never re-rolled at runtime. A bust is not a result the game turns
           against you after you signed; it is a low ceiling that was always
           there, which minutes and scouting REVEAL. That is exactly the
           difference between FM's fog of war and a fake near-miss, and
           addendum 22 forbids the second one.
    hw/off how the sheet masks it until the card has played for you — the
           same two numbers, decoded by the same reveal formula, that every
           album card already uses.
    band   which curve band the roll landed in. AUDIT ONLY — it is never
           shipped, because shipping it would hand over the answer the mask
           exists to hide.
    """
    r = seeded(sid + ":ypot")
    cap = YOUTH_ROOM_CAP.get(age, YOUTH_ROOM_CAP[YOUTH_MAX_AGE])
    band, lo, hi, t = youth_band(r.random())
    room = cap * (lo + (hi - lo) * t)
    q = _cl((cur - 48) / 41.0, 0.0, 1.0)
    room = int(round(room * (1.0 - YOUTH_Q_SQUEEZE * q)))
    pot = min(YOUTH_PT_CAP, cur + max(1, room))
    room = pot - cur
    hw = max(1, min(9, int(round(2 + room * 0.55 + 2 * r.random()))))
    return pot, hw, r.choice([-1, 0, 0, 1]), band


def youth_fee(cur, age):
    """Coins to sign, rounded to 5s — a function of his rating and his age,
    the two things EA published and you can read on the card. Coins are
    earned in matches. Nothing in this game is ever bought with money."""
    fee = (YOUTH_FEE["base"] + (cur - 48) * YOUTH_FEE["perAbility"]
           + (YOUTH_MAX_AGE - age) * YOUTH_FEE["perYoung"])
    return int(_cl(int(round(fee / 5.0)) * 5, YOUTH_FEE["floor"], YOUTH_FEE["cap"]))


def youth_stats(sid, pos, cur, st):
    """SHO / DEF for a prospect: EA's own composite where it means what the
    column means, clamped into the band derive_stats() would have produced
    for that position — so a prospect and an album card are the same kind of
    number to the match engine and nothing about the balance moves. A
    keeper's 'shooting' is the album's roll: gkKicking is not shooting, and
    an 85 in the SHO column of a goalkeeper would be a lie."""
    rsho, rdfn = derive_stats(sid, pos, cur)
    if pos == "GK":
        parts = [x for x in (st.get("gkReflexes"), st.get("gkDiving"),
                             st.get("gkPositioning")) if x]
        dfn = int(round(sum(parts) / float(len(parts)))) if parts else rdfn
        return rsho, int(_cl(dfn, cur - 3, cur + 3))
    ea_sho, ea_dfn = st.get("sho"), st.get("def")
    if pos == "ATT":
        sho, dfn = _cl(ea_sho or rsho, cur - 4, cur + 4), _cl(ea_dfn or rdfn, 20, 50)
    elif pos == "MID":
        sho = _cl(ea_sho or rsho, cur - 16, cur - 2)
        dfn = _cl(ea_dfn or rdfn, 30, max(62, cur - 6))
    else:                                              # DEF
        sho = _cl(ea_sho or rsho, 28, 62)
        dfn = _cl(ea_dfn or rdfn, cur - 2, cur + 4)
    return int(max(1, min(99, sho))), int(max(1, min(99, dfn)))


def build_youth(rows, ovr_col, posc, pos_table, statrows, stat_keys, card_of):
    """The prospect pool, as a section of the roster it already lives in.

    rows      the roster's EA items, in roster-id order
    returns   (payload_block, audit_rows) or (None, []) if the harvest is thin
    """
    ids, pts, pws, pos_, shos, dfns, audit = [], [], [], [], [], [], []
    ski = {k: j for j, k in enumerate(stat_keys)}
    ages = {}
    for i, it in enumerate(rows):
        b = _birth(it.get("birthdate"))
        if not b:
            continue
        born = (1970 + (b >> 9), (b >> 5) & 15, b & 31)
        age = youth_age(born)
        if age > YOUTH_MAX_AGE or age < 10:
            continue
        role = pos_table[posc[i]][2]                  # GK | DEF | MID | ATT
        if role not in ("GK", "DEF", "MID", "ATT"):
            continue
        cur = ovr_col[i]
        sid = "y%d" % it["id"]
        st = {k: statrows[i][ski[k]] for k in
              ("sho", "def", "gkReflexes", "gkDiving", "gkPositioning") if k in ski}
        sho, dfn = youth_stats(sid, role, cur, st)
        pot, pw, po, band = youth_potential(sid, cur, age)
        ids.append(i); pts.append(pot); pws.append(pw)
        pos_.append(po + 1); shos.append(sho); dfns.append(dfn)
        ages[age] = ages.get(age, 0) + 1
        team = it.get("team") or {}
        nat = it.get("nationality") or {}
        audit.append({
            "i": i, "sid": sid, "ea": it["id"],
            "name": ((it.get("commonName") or "").strip()
                     or ((it.get("firstName") or "") + " " + (it.get("lastName") or "")).strip()),
            "pos": role, "cur": cur, "sho": sho, "dfn": dfn, "age": age,
            "pot": pot, "pw": pw, "po": po, "band": band,
            "club": team.get("label") or "(no club listed)",
            "nation": nat.get("label") or "—",
            "league": it.get("leagueName") or "(no league)",
            "woman": ((it.get("gender") or {}).get("id") or 0) == 1,
            "card": card_of.get(i),
            "fee": youth_fee(cur, age),
        })
    if not ids:
        return None, []
    n = len(ids)
    block = {
        "n": n,
        "label": "under-20 prospects",
        "ref": "%04d-%02d-%02d" % YOUTH_REF,
        "refY": YOUTH_REF[0], "refM": YOUTH_REF[1], "refD": YOUTH_REF[2],
        "maxAge": YOUTH_MAX_AGE,
        "ages": ages,
        "honesty":
            "REAL players, honestly labelled. Every prospect's name, age, "
            "club, nation, position and CURRENT rating comes from EA's public "
            "FC ratings pages — the same harvest as the rest of this roster. "
            "Card Manager is not affiliated with, endorsed by or licensed by "
            "EA. The POTENTIAL ceiling, its masked range, the growth/bust "
            "curve, the signing fee and the SHO/DEF split are made here for "
            "this game and are not EA's numbers. Nobody is invented: the pool "
            "is called “under-20 prospects” because that is exactly "
            "what the data supports.",
        "ageNote":
            "Ages are real, taken from published dates of birth, measured on "
            "ref. The pool is a DATED SNAPSHOT, so an unsigned prospect's "
            "listed age does not drift — you are reading the published card. "
            "The moment you SIGN him his career runs on your clock: he ages a "
            "year every season, and that age drives how fast he grows. No "
            "prospect is ever invented to refill the pool, because "
            + str(n) + " real ones is more intake classes than any dynasty "
            "will use.",
        "cols": {"id": [3, 0], "pt": [1, 36], "pw": [1, 0], "po": [1, 0],
                 "sho": [2, 0], "dfn": [2, 0]},
        "c": {
            "id": enc_col(ids, 3, 0, "youth roster id"),
            "pt": enc_col(pts, 1, 36, "youth potential"),
            "pw": enc_col(pws, 1, 0, "youth mask width"),
            "po": enc_col(pos_, 1, 0, "youth mask offset"),
            "sho": enc_col(shos, 2, 0, "youth shooting"),
            "dfn": enc_col(dfns, 2, 0, "youth defending"),
        },
        "format":
            "Same fixed-width base64 columns as the roster, but indexed by "
            "PROSPECT ORDINAL, not by player id: id[k] is the roster player "
            "id of the k-th prospect, ordered by roster rank. po is stored +1 "
            "so the -1 case fits an unsigned column; subtract 1 on read.",
        "keyNote": {
            "id": "the prospect's id in this roster — byId(id) is the whole "
                  "real player, name, club, stats and all",
            "pt": "his TRUE potential ceiling. MADE HERE. Fixed at build time "
                  "and never re-rolled, so a bust is a low ceiling you had not "
                  "yet seen, never a result turned against you afterwards.",
            "pw": "half-width of the masked range; 0 would mean nothing to hide",
            "po": "off-centre bias of that range, -1 | 0 | +1 (stored +1)",
            "sho": "shooting, and dfn defending, as the match engine reads "
                   "them — EA's composite clamped into the album's own band "
                   "for the position, so a prospect and a card are the same "
                   "kind of number",
        },
        "reveal":
            "Identical to MG_DATA.potential.reveal, so a prospect's sheet and "
            "an album card's sheet mask the same way: "
            "t = min(apps, revealApps) / revealApps; hw = ceil(pw * (1 - t)); "
            "off = round(po * (1 - t)); lo = pt - hw + off; hi = pt + hw + "
            "off; slide the band into [cur, 99] rather than squashing it. At "
            "revealApps it collapses onto pt itself.",
        "curve": [{"band": b, "odds": s, "lo": lo, "hi": hi,
                   "label": YOUTH_BAND_LABEL[b]} for b, s, lo, hi in YOUTH_CURVE],
        "curveNote":
            "THE ODDS, SHOWN. odds is the share of prospects whose ceiling was "
            "rolled in that band; lo/hi is the share of the age's roomCap that "
            "band grants. The squeeze on already-good prospects reduces the "
            "GAIN, never the odds, so this table is true for every prospect in "
            "the pool. Print it on the intake screen: honest odds are not a "
            "nicety here, they are the rule.",
        "roomCap": YOUTH_ROOM_CAP,
        "qSqueeze": YOUTH_Q_SQUEEZE,
        "ptCap": YOUTH_PT_CAP,
        "growth": YOUTH_GROWTH,
        "growthNote":
            "One season, for a prospect in your squad. "
            "room = pt - cur; if room <= 0 he has arrived and stops. "
            "stage = the first growth.stage[] entry whose bound >= his age. "
            "play = playFloor + (1 - playFloor) * min(1, apps / playApps). "
            "r = a deterministic roll off (prospect, season). "
            "gain = room * rate * stage * play * (rollLo + (rollHi - rollLo) * r). "
            "Take the whole part and CARRY the remainder into next season, so "
            "a bench year is never silently thrown away. cur only ever rises: "
            "nobody in this game gets worse for being young. PLAYING TIME IS "
            "THE LEVER — a prospect who never starts grows at playFloor, and "
            "that is the strategic choice the whole pool exists to pose.",
        "intake": YOUTH_INTAKE,
        "intakeNote":
            "Each season the academy surfaces intake.perSeason prospects you "
            "have not already signed or passed on, chosen deterministically "
            "from (career seed, season) so a save replays identically. They "
            "arrive as inbox decisions with SIGN and NOT NOW. Nothing counts "
            "down, nothing expires today, passing costs nothing, and there is "
            "no purchase of any kind: the fee is coins earned in matches. "
            "Prospects who are ALSO album cards are skipped — the same human "
            "is one player (addendum 21's merge rule), and you get him from "
            "the album, in colour.",
        "fee": YOUTH_FEE,
        "feeNote":
            "fee = round5(base + (cur - 48) * perAbility + (maxAge - age) * "
            "perYoung), clamped to [floor, cap], shown in full before you "
            "commit. It reads only the two PUBLISHED facts, rating and age, so "
            "it can never be run backwards to recover the hidden ceiling.",
    }
    return block, audit


def build_roster(players_by_team=None, quiet=False):
    rows = load_ea_roster()
    if not rows:
        print("roster: no page-*.json in %s — skipped "
              "(run tools/fetch_ea_ratings.py)" % os.path.relpath(EA_DIR, ROOT))
        return None
    if players_by_team is None:
        players_by_team = album_from_data_js()
    album = album_people(players_by_team)
    n = len(rows)

    # ---- shared strings, in an order that does not move between builds ---
    # Clubs are ordered by EA team id, leagues/nations/playstyles
    # alphabetically. Index 0 of clubs and leagues is the synthetic slot for
    # players EA lists without a club (unlicensed sides keep their real
    # league). Player ids are EA's own rank order, so byId(0) is the best
    # player in the world — that ordering is NOT stable across harvests, so
    # anything persisted (a save, a squad) must store `ea` or the album card
    # id, never a roster index.
    league_names, nation_names, abil_names = set(), set(), set()
    club_by_ea, pos_meta = {}, {}
    for it in rows:
        league_names.add(it.get("leagueName") or NO_LEAGUE)
        nation_names.add((it.get("nationality") or {}).get("label") or "—")
        team = it.get("team") or None
        if team and team.get("id") is not None:
            club_by_ea.setdefault(team["id"], team.get("label") or ("club %s" % team["id"]))
        p = it.get("position") or {}
        if p.get("shortLabel"):
            pos_meta[p["shortLabel"]] = (
                p.get("label") or p["shortLabel"],
                "GK" if p["shortLabel"] == "GK" else
                POS_TYPE.get((p.get("positionType") or {}).get("id"), "MID"))
        for a in (it.get("alternatePositions") or []):
            if a.get("shortLabel"):
                pos_meta.setdefault(a["shortLabel"],
                                    (a.get("label") or a["shortLabel"],
                                     "GK" if a["shortLabel"] == "GK" else "MID"))
        for a in (it.get("playerAbilities") or []):
            if a.get("label"):
                abil_names.add(a["label"])

    leagues = [NO_LEAGUE] + sorted(x for x in league_names if x != NO_LEAGUE)
    league_idx = {x: i for i, x in enumerate(leagues)}
    nations = sorted(nation_names)
    nation_idx = {x: i for i, x in enumerate(nations)}
    abil = sorted(abil_names)
    abil_idx = {x: i for i, x in enumerate(abil)}
    pos_seen = POS_ORDER + sorted(x for x in pos_meta if x not in POS_ORDER)
    pos_idx = {x: i for i, x in enumerate(pos_seen)}
    pos_table = [[s, pos_meta.get(s, (s, "GK" if s == "GK" else "MID"))[0],
                  pos_meta.get(s, (s, "GK" if s == "GK" else "MID"))[1]]
                 for s in pos_seen]

    clubs = [{"ea": 0, "name": NO_CLUB, "league": 0, "synthetic": 1}]
    club_idx = {None: 0}
    for ea_id in sorted(club_by_ea):
        club_idx[ea_id] = len(clubs)
        clubs.append({"ea": ea_id, "name": club_by_ea[ea_id], "league": 0,
                      "synthetic": 0})

    # ---- per-player columns ---------------------------------------------
    stat_keys = sorted(rows[0]["stats"].keys())
    ea_col, ovr_col, posc, clubc, natc, leaguec = [], [], [], [], [], []
    ht, wt, misc, birth, altc, abc, statrows = [], [], [], [], [], [], []
    for it in rows:
        p = it.get("position") or {}
        team = it.get("team") or None
        ea_col.append(it["id"])
        ovr_col.append(it["overallRating"])
        posc.append(pos_idx.get(p.get("shortLabel"), pos_idx["CM"]))
        clubc.append(club_idx[team["id"]] if (team and team.get("id") is not None) else 0)
        leaguec.append(league_idx[it.get("leagueName") or NO_LEAGUE])
        natc.append(nation_idx[(it.get("nationality") or {}).get("label") or "—"])
        ht.append(it.get("height") or 175)
        wt.append(it.get("weight") or 70)
        foot = 1 if it.get("preferredFoot") == 2 else 0
        skill = max(1, min(5, it.get("skillMoves") or 1))
        weak = max(1, min(5, it.get("weakFootAbility") or 1))
        woman = 1 if ((it.get("gender") or {}).get("id") or 0) == 1 else 0
        misc.append(foot | (skill << 1) | (weak << 4) | (woman << 7))
        birth.append(_birth(it.get("birthdate")))
        alts = [pos_idx[a["shortLabel"]] for a in (it.get("alternatePositions") or [])[:3]
                if a.get("shortLabel")]
        altc.append(alts + [63] * (3 - len(alts)))
        abc.append([abil_idx[a["label"]] for a in (it.get("playerAbilities") or [])
                    if a.get("label")])
        st = it["stats"]
        statrows.append([(st[k]["value"] if isinstance(st[k], dict) else st[k])
                         for k in stat_keys])

    # ---- the club and league graph --------------------------------------
    squads = {}
    for i, ci in enumerate(clubc):
        squads.setdefault(ci, []).append(i)
    for ci, club in enumerate(clubs):
        ids = sorted(squads.get(ci, []), key=lambda i: -ovr_col[i])
        club["n"] = len(ids)
        if ids and ci:
            top = ids[:11]
            t11 = sum(ovr_col[i] for i in top) / float(len(top))
            allm = sum(ovr_col[i] for i in ids) / float(len(ids))
            club["str"] = int(round(0.75 * t11 + 0.25 * allm))
            # a club's league is its squad's league (no EA club spans two)
            lv = {}
            for i in ids:
                lv[leaguec[i]] = lv.get(leaguec[i], 0) + 1
            club["league"] = max(lv.items(), key=lambda kv: (kv[1], -kv[0]))[0]
        else:
            club["str"] = 32          # the synthetic slot has no strength
            club["league"] = 0
    name_count = {}
    for club in clubs:
        name_count[club["name"]] = name_count.get(club["name"], 0) + 1
    for club in clubs:
        club["dup"] = 1 if name_count[club["name"]] > 1 else 0

    lclubs = {}
    for ci, club in enumerate(clubs):
        if ci == 0:
            continue
        lclubs.setdefault(club["league"], []).append(ci)
    lstr = []
    for li in range(len(leagues)):
        ids = sorted(lclubs.get(li, []), key=lambda c: -clubs[c]["str"])
        if ids:
            top = ids[:4]
            lstr.append(int(round(0.6 * sum(clubs[c]["str"] for c in top) / float(len(top))
                                  + 0.4 * sum(clubs[c]["str"] for c in ids) / float(len(ids)))))
        else:
            lstr.append(32)

    # ---- the album merge -------------------------------------------------
    card_of, report, merges, rejected = merge_album(rows, album)
    cards_str = " ".join("%s:%d" % (sid, i) for i, sid in sorted(card_of.items()))

    # ---- the youth prospect pool (addendum 22 §2) ------------------------
    youth, youth_audit = build_youth(rows, ovr_col, posc, pos_table, statrows,
                                     stat_keys, card_of)

    # ---- SHO / DEF for every roster player (addendum 34) -----------------
    # A club takeover fields the club's real squad, so every player needs the
    # two numbers the match engine reads. youth_stats() is already the rule
    # that turns EA's composites into them, clamped into the band an album
    # card of that position would have — one rule, applied to everyone.
    ski_all = {k: j for j, k in enumerate(stat_keys)}
    sho_col, dfn_col = [], []
    for i, it in enumerate(rows):
        role = pos_table[posc[i]][2]
        role = role if role in ("GK", "DEF", "MID", "ATT") else "MID"
        st = {k: statrows[i][ski_all[k]] for k in
              ("sho", "def", "gkReflexes", "gkDiving", "gkPositioning") if k in ski_all}
        s1, d1 = youth_stats("r%d" % it["id"], role, ovr_col[i], st)
        sho_col.append(s1); dfn_col.append(d1)

    # ---- pack ------------------------------------------------------------
    stats_str, stat_chars = enc_bits(statrows, 7, len(stat_keys))
    ncode = "".join((next((c for c, al in NATION_ALIASES.items()
                           if norm(nm) in al), None) or "   ") for nm in nations)
    cols = {
        "ea":    [4, 0],
        "ovr":   [1, 32],
        "pos":   [1, 0],
        "club":  [2, 0],
        "lg":    [1, 0],
        "nat":   [2, 0],
        "ht":    [2, 0],
        "wt":    [2, 0],
        "misc":  [2, 0],
        "birth": [3, 0],
        "cea":   [4, 0],
        "cl":    [1, 0],
        "cstr":  [1, 32],
        "lstr":  [1, 32],
        "sho":   [2, 0],
        "dfn":   [2, 0],
    }
    c = {
        "ea":    enc_col(ea_col, 4, 0, "ea id"),
        "ovr":   enc_col(ovr_col, 1, 32, "ovr"),
        "pos":   enc_col(posc, 1, 0, "position"),
        "club":  enc_col(clubc, 2, 0, "club"),
        "lg":    enc_col(leaguec, 1, 0, "league"),
        "nat":   enc_col(natc, 2, 0, "nation"),
        "ht":    enc_col(ht, 2, 0, "height"),
        "wt":    enc_col(wt, 2, 0, "weight"),
        "misc":  enc_col(misc, 2, 0, "misc"),
        "birth": enc_col(birth, 3, 0, "birthdate"),
        "cea":   enc_col([x["ea"] for x in clubs], 4, 0, "club ea id"),
        "cl":    enc_col([x["league"] for x in clubs], 1, 0, "club league"),
        "cstr":  enc_col([x["str"] for x in clubs], 1, 32, "club strength"),
        "lstr":  enc_col(lstr, 1, 32, "league strength"),
        "sho":   enc_col(sho_col, 2, 0, "shooting"),
        "dfn":   enc_col(dfn_col, 2, 0, "defending"),
    }
    payload = {
        "v": ROSTER_VERSION,
        "built": "%04d-%02d-%02d" % time.localtime()[:3],
        "source": ROSTER_SOURCE,
        "honesty": ROSTER_HONESTY,
        "notice": ROSTER_NOTICE,
        "asOf": "%04d-%02d-%02d" % AS_OF,
        "asOfY": AS_OF[0], "asOfM": AS_OF[1], "asOfD": AS_OF[2],
        "alphabet": B64,
        "n": n,
        "nc": len(clubs),
        "nfree": clubs[0]["n"],
        "nl": len(leagues),
        "nn": len(nations),
        "cols": cols,
        "c": c,
        "names": "\n".join("%s\t%s\t%s" % (it.get("firstName") or "",
                                           it.get("lastName") or "",
                                           it.get("commonName") or "")
                           for it in rows),
        "pos": pos_table,
        "clubs": "\n".join(x["name"] for x in clubs),
        "cdup": "".join(str(x["dup"]) for x in clubs),
        "leagues": "\n".join(leagues),
        "nations": "\n".join(nations),
        "ncode": ncode,
        "alt": "".join(B64[v] for a in altc for v in a),
        "altSlots": 3,
        "ab": "\n".join("".join(B64[k >> 6] + B64[k & 63] for k in a) for a in abc),
        "abl": abil,
        "abPlus": "".join("1" if lab.endswith("+") else "0" for lab in abil),
        "sk": stat_keys,
        "stats": stats_str,
        "statBits": 7,
        "statChars": stat_chars,
        "merge": dict(report, sample=_spread(merges, 14),
                      rejected=_pick_rejects(rejected, 14),
                      weak=[m for m in merges
                            if m["tier"] != "name+nation"][:60]),
        "format": {
            "columns": "c[k] is a fixed-width base64 column: cols[k] = [chars, "
                       "offset]; value = base64(c[k][i*w : i*w+w]) + offset. "
                       "Player columns are indexed by player id (= EA rank - 1); "
                       "cea/cl/cstr by club id; lstr by league id.",
            "stats": "stats is one %d-symbol record per player: %d values of "
                     "%d bits, MSB first, in sk order." % (stat_chars, len(stat_keys), 7),
            "misc": "bit0 foot (1 = left) | bits1-3 skill moves | bits4-6 weak "
                    "foot | bit7 gender (1 = women's game)",
            "birth": "(year - 1970) << 9 | month << 5 | day",
            "alt": "%d symbols per player, alternate position indices into pos, "
                   "63 = empty" % 3,
            "ab": "one line per player, two base64 symbols per playstyle index "
                  "into abl; abPlus marks the Play Style + ones",
            "cards": "space-separated 'albumCardId:playerId' — the album merge",
            "strength": "club strength = round(0.75 * mean(best 11 OVR) + 0.25 * "
                        "mean(squad OVR)); league strength = round(0.6 * mean("
                        "best 4 clubs) + 0.4 * mean(all clubs))",
        },
        "cards": cards_str,
    }
    if youth:
        payload["youth"] = youth

    with open(ROSTER_RUNTIME, encoding="utf-8") as f:
        runtime = f.read()
    runtime = runtime.replace(
        "if (typeof module !== 'undefined' && module.exports) "
        "module.exports = MG_ROSTER_RUNTIME;\n", "")
    runtime = runtime.replace("'use strict';\n", "", 1)

    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Built by tools/build_mg_data.py (--roster) from data/ea/page-*.json\n"
        "// plus the album layer in mg-manager-data.js. The API half lives in\n"
        "// tools/mg-roster-runtime.js and is inlined below.\n"
        "//\n"
        "// " + ROSTER_NOTICE + "\n"
        "//\n"
        "// %d players in %d clubs across %d leagues and %d nations.\n"
        "// %d of them are also Panini album cards — one entity, two layers.\n"
        "//\n"
        "// Load AFTER mg-manager-data.js. Nothing is decoded at boot: names,\n"
        "// squads, the search index and every stat block are built on first use.\n"
        % (n, len(clubs) - 1, len(leagues) - 1, len(nations), report["matched"]))

    parts = []
    for key in payload:
        parts.append(json.dumps(key) + ":" + json.dumps(
            payload[key], ensure_ascii=False, separators=(",", ":")))
    body = ("var D={\n" + ",\n".join(parts) + "\n};\n")
    out = (header + ";(function () {\n'use strict';\n" + runtime + "\n" + body +
           "var G = (typeof window !== 'undefined') ? window\n"
           "      : (typeof globalThis !== 'undefined') ? globalThis : this;\n"
           "G.MG_ROSTER = MG_ROSTER_RUNTIME(D);\n"
           "if (typeof module !== 'undefined' && module.exports) "
           "module.exports = G.MG_ROSTER;\n})();\n")
    if "</" in out:
        raise SystemExit("roster: output contains '</' — unsafe to inline in HTML")
    with open(ROSTER_PATH, "w", encoding="utf-8") as f:
        f.write(out)

    if not quiet:
        size = os.path.getsize(ROSTER_PATH)
        print("wrote %s (%.1f KB / %.2f MB)"
              % (os.path.relpath(ROSTER_PATH, ROOT), size / 1024.0, size / 1048576.0))
        print("roster: %d players | %d clubs | %d leagues | %d nations | %d stat keys"
              % (n, len(clubs) - 1, len(leagues) - 1, len(nations), len(stat_keys)))
        print("roster blocks: stats %.1f KB | names %.1f KB | columns %.1f KB | "
              "playstyles %.1f KB"
              % (len(stats_str) / 1024.0, len(payload["names"]) / 1024.0,
                 sum(len(v) for v in c.values()) / 1024.0, len(payload["ab"]) / 1024.0))
        print("merge: %d of %d album people matched (%s), %d unmatched"
              % (report["matched"], len(album),
                 ", ".join("%s %d" % (k, v) for k, v in sorted(report["byTier"].items())),
                 report["unmatched"]))
        if youth:
            ybytes = sum(len(v) for v in youth["c"].values())
            bands = {}
            for a in youth_audit:
                bands[a["band"]] = bands.get(a["band"], 0) + 1
            print("youth: %d prospects <= %d on %s (%s) | %d columns bytes "
                  "(%.1f KB) | %d also album cards"
                  % (youth["n"], YOUTH_MAX_AGE, youth["ref"],
                     ", ".join("age %d: %d" % kv for kv in sorted(youth["ages"].items())),
                     ybytes, ybytes / 1024.0,
                     sum(1 for a in youth_audit if a["card"])))
            print("youth ceilings: %s | pot max %d, mean %.1f (album pt tops out at 96)"
                  % (", ".join("%s %d (%.0f%% rolled, %.0f%% landed)"
                               % (b, bands.get(b, 0), sh * 100,
                                  100.0 * bands.get(b, 0) / youth["n"])
                               for b, sh, _lo, _hi in YOUTH_CURVE),
                     max(a["pot"] for a in youth_audit),
                     sum(a["pot"] for a in youth_audit) / float(youth["n"])))
    return {"n": n, "clubs": len(clubs) - 1, "leagues": len(leagues) - 1,
            "nations": len(nations), "merge": report,
            "merges": merges, "rejected": rejected,
            "youth": youth_audit,
            "size": os.path.getsize(ROSTER_PATH)}

# ------------------------------------------------------------------- build

def main():
    # Addendum 21 §1: the roster layer is its own output file.
    #   --roster-only  rebuild mg-roster.js alone (MG_DATA untouched)
    #   --no-roster    rebuild MG_DATA alone
    if "--roster-only" in sys.argv:
        return 0 if build_roster() else 1
    sections, teams = load_album()
    prices = load_prices()
    ea_name, ea_last, (ent_full, ent_last, ent_il) = load_ea()
    csv_full, csv_il, csv_lo = load_csv()
    content = load_content()

    src_count = {"star": 0, "ea": 0, "csv": 0, "price": 0}
    age_source = {True: 0, False: 0}
    real_clubs, real_club_idx = [], {}
    attr_values, face_values, badge_map, delta_values = {}, {}, {}, {}
    attr_audit = []
    players_by_team = {}
    all_ids = set()
    name_to_id = {}

    for code in sorted(teams):
        rows = []
        for num in sorted(teams[code]):
            name = teams[code][num]
            ref = "%s %d" % (code, num)
            sid = code.lower() + str(num)
            pos = pos_for(code, num, name)
            price = prices.get(ref, 0.29)
            if pos == "SPE":
                # collectible: rated off its real trade value
                ovr, src = price_ovr(price), "price"
            else:
                ovr, src = resolve_ovr(name, code, price, ea_name, ea_last,
                                       csv_full, csv_il, csv_lo)
            src_count[src] += 1
            sho, dfn = derive_stats(sid, pos, ovr)
            x = {}
            # portrait seed: the card's NAME and team code, nothing else
            # (.design-portraits.md §3.1). Same string the game hashes.
            x["ps"] = portrait_seed(name, code)
            kind = special_kind(code, num, name)
            if kind:
                x["special"] = kind
            q = QUIRK_BY_NAME.get(norm(name))
            if q:
                x["quirk"] = q
            if pos != "SPE":
                # ---- Addendum 18: age, ceiling, archetype, real club --------
                ent = ea_entity(name, code, ent_full, ent_last, ent_il)
                age, real_age = player_age(sid, pos, ovr, ent)
                ark = archetype(sid, pos, ovr, sho, dfn, name)
                pot, pw, po = potential(sid, ovr, age, ark, False)
                cr, fn = role_indices(ark, ovr, sho)
                x["ag"] = age
                if real_age:
                    x["ar"] = 1                 # tracks a real date of birth
                x["pt"] = pot
                if pw:
                    x["pw"] = pw                # masked-range half-width
                if po:
                    x["po"] = po                # …and its off-centre bias
                x["ak"] = ark
                x["cr"] = cr
                x["fn"] = fn
                real_club = ent.get("team") if ent else None
                if real_club:
                    if real_club not in real_club_idx:
                        real_club_idx[real_club] = len(real_clubs)
                        real_clubs.append(real_club)
                    x["cl"] = real_club_idx[real_club]
                age_source[bool(real_age)] += 1
                # ---- Addendum 17 §2/§3: the 34 subs, six faces, badges ------
                at = attr_of(sid, pos, num, ovr, sho, dfn, name)
                x["a"] = at["arch"]
                attr_values[sid] = [at["A"][k] for k in SUBS]
                face_values[sid] = [_jround(at["faces"][f]) for f in
                                    FACE_ORDER["GK" if pos == "GK" else "OUT"]]
                delta_values[sid] = [_jround(at["d"][k] * 10) for k in DELTA_ORDER]
                bd = badges_for(at["A"], pos, x.get("quirk"))
                if bd:
                    badge_map[sid] = bd
                attr_audit.append((sid, name, code, pos, ovr, at, bd))
            row = [sid, num, name, short_name(name), pos, ovr, sho, dfn]
            if x:
                row.append(x)
            rows.append(row)
            all_ids.add(sid)
            name_to_id.setdefault(norm(name), sid)
        players_by_team[code] = rows

    # ------- clubs: the 48 countries
    content_clubs = collect_content_clubs(content)
    bundle = content.get("bundle") or {}
    crest_lore = (bundle.get("crests") if isinstance(bundle.get("crests"), dict)
                  else None) or (content.get("crests") or {}).get("byCode", {})

    strengths = {}
    for code, rows in players_by_team.items():
        if code == "FWC":
            continue
        ovrs = sorted((r[5] for r in rows if r[4] != "SPE"), reverse=True)
        strengths[code] = sum(ovrs[:11]) / float(len(ovrs[:11]) or 1)

    ranked = sorted(strengths, key=lambda c: (-strengths[c], c))
    tier_for = {}
    n = len(ranked)
    for i, code in enumerate(ranked):
        # strongest fifth = tier 5 … weakest fifth = tier 1
        tier_for[code] = 5 - min(4, i * 5 // n)

    TIER_PARALLEL = {1: "white", 2: "blue", 3: "red", 4: "orange", 5: "purple"}
    STYLE_TACTICS = {
        "attacking": ("2-3-3", "attacking"),
        "defensive": ("4-3-1", "defensive"),
        "balanced": ("3-3-2", "balanced"),
    }
    clubs = []
    for code in sorted(strengths):
        rows = players_by_team[code]
        cc = content_clubs.get(code, {})
        r = seeded("club:" + code)
        style = cc.get("style") or r.choice(["attacking", "balanced", "defensive"])
        formation, mentality = STYLE_TACTICS.get(style, ("3-3-2", "balanced"))
        squad = [row[0] for row in rows if row[4] != "SPE"]
        best = max((row for row in rows if row[4] != "SPE"), key=lambda x: x[5])
        lore = crest_lore.get(code, {})
        colors = cc.get("colors") or KIT.get(code, ["#888888", "#ffffff"])
        cl = cc.get("lines") or {}
        taunts = cc.get("taunts") or []
        club = {
            "id": code.lower(), "code": code, "name": sections.get(code, code),
            "short": code, "crest": flag_emoji(code),
            "tier": tier_for[code],
            "strength": round(strengths[code], 1),
            "c1": colors[0], "c2": colors[1],
            "manager": cc.get("manager") or ("Coach " + best[3]),
            "formation": formation, "mentality": mentality,
            "squad": squad,
            "parallels": {"default": TIER_PARALLEL[tier_for[code]], "overrides": {}},
            "lines": {
                "intro": cl.get("intro") or (taunts[0] if taunts else None)
                or lore.get("flavor")
                or ("%s are ready. Are you?" % sections.get(code, code)),
                "win": cl.get("win") or cc.get("motto") or ("%s! %s!" % (code, code)),
                "lose": cl.get("lose") or "Well played. We'll be back.",
            },
        }
        if cc.get("nickname"):
            club["nickname"] = cc["nickname"]
        if cc.get("managerCard"):
            club["managerCard"] = cc["managerCard"]
        if len(taunts) > 1:
            club["taunts"] = taunts
        if lore.get("passive"):
            club["lore"] = lore["passive"]
        clubs.append(club)

    # star cards on strong teams shine a step brighter
    star_overrides = {"ARG": {"arg17": "green"}}  # Messi: the season-1 boss card
    for club in clubs:
        club["parallels"]["overrides"] = star_overrides.get(club["code"], {})

    # ------- divisions: 6 x 8 by strength (addendum 5 pyramid; player starts bottom)
    divisions = []
    for d in range(6):
        divisions.append([c.lower() for c in ranked[d * 8:(d + 1) * 8]])

    # ------- starters: 14 white cards, GKx2 DEFx5 MIDx4 ATTx3, <=84, no quirks
    quota = [("GK", 2), ("DEF", 5), ("MID", 4), ("ATT", 3)]
    pool = []
    for code, rows in players_by_team.items():
        if code == "FWC":
            continue
        for row in rows:
            sid, num, name, shortn, pos, ovr = row[0], row[1], row[2], row[3], row[4], row[5]
            x = row[8] if len(row) > 8 else {}
            if pos == "SPE" or x.get("quirk") or not (68 <= ovr <= 84):
                continue
            pool.append((sid, pos, ovr, code))
    rs = seeded("starters:v1")
    rs.shuffle(pool)
    starters, used_teams = [], set()
    if "usa16" in all_ids:            # Pulisic anchors the family collection
        starters.append("usa16")
        used_teams.add("USA")
        quota = [("GK", 2), ("DEF", 5), ("MID", 4), ("ATT", 2)]
    for pos_want, count in quota:
        picked = 0
        for sid, pos, ovr, code in sorted(pool, key=lambda p: (-p[2], p[0])):
            if picked >= count:
                break
            if pos != pos_want or sid in starters or code in used_teams or ovr > 78:
                continue
            starters.append(sid)
            used_teams.add(code)
            picked += 1
        # relax the one-per-team rule if a slot is short
        for sid, pos, ovr, code in sorted(pool, key=lambda p: (-p[2], p[0])):
            if picked >= count:
                break
            if pos != pos_want or sid in starters or ovr > 78:
                continue
            starters.append(sid)
            picked += 1

    if all(s in all_ids for s in PINNED_STARTERS):
        starters = list(PINNED_STARTERS)

    # ------- feats: content copy wins, spec rewards/checks attached
    spec_by_id = {f["id"]: f for f in SPEC_FEATS}
    feats = []
    content_feats = (bundle.get("feats") if isinstance(bundle.get("feats"), list)
                     else None) or (content.get("feats") or {}).get("feats", [])
    seen = set()
    for cf in content_feats:
        fid = cf.get("id")
        base = dict(spec_by_id.get(fid, {"id": fid, "check": "M", "reward": {"coins": 50}}))
        for k, v in cf.items():
            if not v:
                continue
            if k == "reward" and isinstance(v, str):
                base["rewardText"] = v      # content's prose; keep machine reward
            else:
                base[k] = v
        feats.append(base)
        seen.add(fid)
    for f in SPEC_FEATS:
        if f["id"] not in seen:
            feats.append(f)

    # ------- commentary: spec banks + content flow + star lines by player id
    commentary = {k: list(v) for k, v in COMMENTARY.items()}
    EVENT_ALIAS = {"tackle": "big_tackle", "halftime": "half_time",
                   "fulltime": "full_time", "penalty-scored": "pen_goal",
                   "penalty-missed": "pen_over"}
    flows = []
    bcomm = bundle.get("commentary") or {}
    if isinstance(bcomm.get("byEvent"), dict):
        flows.append(bcomm["byEvent"])
    flows.append((content.get("commentary-flow") or {}).get("byEvent", {}))
    for flow in flows:
        for ev, lines in flow.items():
            ev = EVENT_ALIAS.get(ev, ev)
            commentary.setdefault(ev, [])
            for ln in lines:
                if ln not in commentary[ev]:
                    commentary[ev].append(ln)
    players_comm = {k: {e: list(v) for e, v in b.items()} for k, b in PLAYER_COMMENTARY.items()}
    star_comm = {}
    if isinstance(bcomm.get("byName"), dict):
        star_comm.update(bcomm["byName"])
    for nm, lines in ((content.get("commentary-stars") or {}).get("byName", {})).items():
        star_comm.setdefault(nm, lines)
    STAR_NAME_TO_ID = {"Haaland": "haaland", "Yamal": "yamal", "Kane": "kane",
                       "Suárez": "suarez", "Messi": "messi",
                       "Phoenix": "phoenix", "Wembanyama": "wemby",
                       "Maradona": "maradona", "Gibson": "gibson", "Ellis": "ellis",
                       "Ronaldo": "por15", "Mbappé": "fra20"}
    KEEPER_IDS = {"phoenix", "wemby", "grandpa"}
    for nm, lines in star_comm.items():
        pid = STAR_NAME_TO_ID.get(nm) or name_to_id.get(norm(nm))
        if not pid:
            continue
        bank = STAR_COMM_BANK.get(nm) or ("save" if pid in KEEPER_IDS else "goal")
        players_comm.setdefault(pid, {}).setdefault(bank, [])
        for ln in lines:
            ln = STAR_COMM_FIX.get(ln, ln)
            if ln not in players_comm[pid][bank]:
                players_comm[pid][bank].append(ln)
    # star commentary keys also mirrored onto album card ids where they exist
    ALBUM_ALIAS = {"haaland": "nor15", "yamal": "esp15", "kane": "eng18",
                   "messi": "arg17"}
    for cast_id, album_id in ALBUM_ALIAS.items():
        if cast_id in players_comm and album_id in all_ids:
            players_comm[album_id] = players_comm[cast_id]

    # ------- inbox: bundle wins (75 templates, source-tagged), else per-file
    if isinstance(bundle.get("inbox"), list):
        inbox = {
            "club": [i for i in bundle["inbox"] if i.get("source") == "club"],
            "results": [i for i in bundle["inbox"] if i.get("source") == "results"],
        }
    else:
        inbox = {
            "club": (content.get("inbox-club") or {}).get("templates", []),
            "results": (content.get("inbox-results") or {}).get("items", []),
        }

    # ------- cast (the nine unlockables)
    cast_rows = [list(r) for r in CAST]
    for row in cast_rows:
        cid, pos, ovr, sho, dfn = row[0], row[2], row[3], row[4], row[5]
        x = dict(row[8]) if len(row) > 8 and row[8] else {}
        age, real_age, note = CAST_AGE.get(cid, (27, 0, None))
        ark = archetype(cid, pos, ovr, sho, dfn)
        pot, pw, po = potential(cid, ovr, age, ark, bool(x.get("legend")))
        cr, fn = role_indices(ark, ovr, sho)
        x["ag"] = age
        if real_age:
            x["ar"] = 1
        if note:
            x["agn"] = note
        x["pt"] = pot
        if pw:
            x["pw"] = pw
        if po:
            x["po"] = po
        x["ak"] = ark
        x["cr"] = cr
        x["fn"] = fn
        # ---- Addendum 17: the nine are authored roles, never rolled ---------
        at = attr_of(cid, pos, None, ovr, sho, dfn, row[1])
        x["a"] = at["arch"]
        attr_values[cid] = [at["A"][k] for k in SUBS]
        face_values[cid] = [_jround(at["faces"][f]) for f in
                            FACE_ORDER["GK" if pos == "GK" else "OUT"]]
        delta_values[cid] = [_jround(at["d"][k] * 10) for k in DELTA_ORDER]
        bd = badges_for(at["A"], pos, x.get("quirk"),
                        authored=CAST_BADGE.get(cid))
        if bd:
            badge_map[cid] = bd
        attr_audit.append((cid, row[1], "CAST", pos, ovr, at, bd))
        # PIDX in mg-manager.js names a cast card (x.full || row name) and
        # files it under team 'CAST' — seed off exactly that, so a runtime
        # seedOf(card.name, card.team) reproduces ps without consulting it.
        x["ps"] = portrait_seed(x.get("full") or row[1], "CAST")
        px = cast_portrait(cid)
        if px:
            x["px"] = px
        row[8] = x

    # ------- synergy index (Addendum 18b): top partners, precomputed
    # Subjects: every fieldable card, cast included. Partners: album cards only
    # — the cast are unlocked by feats, never signed, so they are never the
    # answer to "who should I go and get".
    link_cards = []
    for code, rows in players_by_team.items():
        for r in rows:
            if r[4] == "SPE":
                continue
            xr = r[8] if len(r) > 8 else {}
            link_cards.append(link_card(r[0], r[4], r[5], r[6], r[7], code,
                                        xr.get("cl"), xr.get("ak", "an"),
                                        True, True))
    for row in cast_rows:
        x = row[8]
        link_cards.append(link_card(row[0], row[2], row[3], row[4], row[5],
                                    CAST_TEAM.get(row[0]), None,
                                    x.get("ak", "an"), True, False))
    synergy_top = build_synergy(link_cards)

    data = {
        "version": 2,
        "generated": True,
        "honesty": "FC-style ratings, made for this shop — not EA data.",
        "portraitHonesty": "Portraits are original stylised avatars generated "
                           "from each player's name. They are not photographs "
                           "and are not intended to resemble the real players.",
        "parallels": PARALLELS,
        "teams": {c: {"name": sections.get(c, c), "crest": flag_emoji(c),
                      "ts": fnv1a32(c)}
                  for c in sorted(players_by_team)},
        "players": players_by_team,     # code -> [ [id,num,name,short,pos,ovr,sho,dfn,x?] ]
        "cast": cast_rows,              # [ [id,name,pos,ovr,sho,dfn,c1,c2,x] ]
        "starters": starters,
        "clubs": clubs,                 # the 48 countries (opposition)
        "divisions": divisions,         # 6 x 8, strongest first; promotion 2 up / 2 down
        "fixtures": FIXTURES,
        "formations": FORMATIONS,
        "mentality": MENTALITY,
        "quirks": QUIRKS,
        "commentary": commentary,
        "playerCommentary": players_comm,
        "feats": feats,
        "economy": ECONOMY,
        "inbox": inbox,
        "taunts": ((bundle.get("taunts") or {}).get("personas")
                   or (content.get("taunts") or {}).get("personas", {})),
        "crestLore": crest_lore,
        "clubNames": {"adj": ["ROYAL", "MIGHTY", "ROCKET", "GOLDEN", "THUNDER", "COSMIC", "LUCKY", "TURBO"],
                      "noun": ["FOXES", "WOLVES", "ROVERS", "UNITED", "DRAGONS", "SHARKS", "COMETS", "KNIGHTS"]},
        "crests": ["⚽", "\U0001F98A", "\U0001F43A", "⭐", "\U0001F525", "\U0001F985", "\U0001F409", "⚡"],
        "kitColors": [
            {"name": "RED", "hex": "#d6202a"}, {"name": "BLUE", "hex": "#3f77c9"},
            {"name": "GOLD", "hex": "#e9bf63"}, {"name": "GREEN", "hex": "#2f8f52"},
            {"name": "PURPLE", "hex": "#8a4fc9"}, {"name": "ORANGE", "hex": "#e8842c"},
            {"name": "SKY", "hex": "#6cace4"}, {"name": "BLACK", "hex": "#2b2b31"},
        ],
        "progression": {"formationsUnlockSeason": 2, "cpuStepPerSeason": 1,
                        "cpuStepCap": 2, "promotion": {"up": 2, "down": 2}},
        # ---- Addendum 17 §2: FIFA-depth attributes --------------------------
        "attributes": {
            "note": "34 sub-attributes per fieldable card (29 outfield + 5 "
                    "goalkeeping), deterministic from position + OVR + role. "
                    "values[pid] is the BASE (WHITE) vector in `subs` order; "
                    "the card sheet adds (effSkill - base) to every sub to show "
                    "a tier, and badges read the white one, so a black card and "
                    "a white card of the same player hold the same badges. "
                    "SPE collectibles carry no attributes and are absent here.",
            "law": "An archetype REDISTRIBUTES a rating, it never adds to one: "
                   "sum(ovrWeights[pos][face] * faces[face]) reconstructs the "
                   "card's own OVR. Attributes never enter effSkill — 75/25 is "
                   "untouched.",
            "subs": SUBS,
            "faceWeights": FACE_SUBS,
            "faceOrder": FACE_ORDER,
            "ovrWeights": OVR_W,
            "composites": COMP,
            "bands": [[88, "gold"], [75, "winText"], [60, "accent"],
                      [45, "dim"], [0, "lossText"]],
            "values": attr_values,
            "faces": face_values,
            "deltaNote": "deltas[pid] is what the MATCH ENGINE reads: the "
                         "card's eight signed deltas against the NEUTRAL "
                         "positional reference, in attribute points x10. The "
                         "reference is the same card generated with the "
                         "zero-tilt role and no texture, so a synthetic or "
                         "harness card has no entry here and every hook is "
                         "exactly a no-op for it. Precomputed because the "
                         "reference needs the whole generator; shipping the "
                         "answer is what lets the runtime delete it.",
            "deltaOrder": list(DELTA_ORDER),
            "deltaScale": 10,
            "deltas": delta_values,
            "engine": ENGINE_HOOKS,
        },
        # ---- the 18 roles behind those numbers ------------------------------
        "roles": {k: {"name": v[0], "pos": v[1], "blurb": v[2]}
                  for k, v in ROLE_INFO.items()},
        # ---- Addendum 17 §3: playstyle badges -------------------------------
        "badges": {
            "note": "Derived from the base (white) attribute vector, never "
                    "stored in a save and never granted by a colour. bit "
                    "indices are frozen — the save's earned-badge mask is one "
                    "int32, so this catalogue is capped at 30 forever.",
            "maxPerCard": MAX_BADGES,
            "maxPerGk": MAX_BADGES_GK,
            "gkOnly": sorted(GK_BADGES),
            "quirkSuppresses": {k: list(v) for k, v in QUIRK_SUPPRESSES.items()},
            "effNote": "eff is what the badge DOES, in attribute points, into "
                       "the engine's own delta channels — the single source for "
                       "both the match engine and the chip's copy. `when` "
                       "narrows it to a match state. `fatigue` is energy off "
                       "the cost of a start, not a delta.",
            "budget": ENGINE_HOOKS["badgeCap"],
            "catalogue": [
                {"bit": b[0], "id": b[1], "name": b[2], "face": b[3], "prio": b[4],
                 "req": b[5], "pos": list(b[6]) if b[6] else None, "copy": b[7],
                 "eff": BADGE_EFF.get(b[1], {}), "fx": BADGE_FX.get(b[1], "")}
                for b in BADGE_DEFS
            ],
            "authored": {k: v for k, v in CAST_BADGE.items() if v},
            "byPlayer": badge_map,
        },
        # ---- Addendum 18 foundations ----------------------------------------
        "cardKeys": {
            "ag": "age in years at 2026-06-11",
            "ar": "1 = that age tracks the player's real date of birth",
            "agn": "age note (cast only)",
            "pt": "potential — the ceiling of the BASE player, always >= ovr",
            "pw": "half-width of the masked potential range (0 = no mask)",
            "po": "off-centre bias of that range, -1|0|+1",
            "ak": "archetype key — see archetypes",
            "a": "role key (Addendum 17) — see roles; drives the 34 attributes",
            "cr": "creator index 0-9 (how much he makes chances)",
            "fn": "finisher index 0-9 (how much he takes them)",
            "cl": "index into synergy.clubs — his real club, when we know it",
            "ps": "portrait seed — see portraits",
            "px": "authored portrait pins (cast only) — see portraits.castKeys",
            "special": "crest | photo | heritage (not fieldable)",
            "quirk": "engine mechanic id — see quirks",
        },
        "ageCurve": {
            "ref": "2026-06-11",
            "stages": AGE_STAGES,
            "note": "stages are [lo, hi, label, growth]. growth is ADVISORY and "
                    "applies to XP and training pace only — it must never touch "
                    "effSkill, which the 75/25 law owns. A card with 'ar' has the "
                    "real player's age; every other age is a plausible, "
                    "position-appropriate one authored here.",
        },
        "potential": {
            "revealApps": REVEAL_APPS,
            "note": "pt is a ceiling for the BASE (white) player and is a "
                    "different axis from the parallel tier: the colour ladder is "
                    "the upgrade path, potential is how far the base can still "
                    "grow. pt >= ovr always. pw 0 means there is nothing to "
                    "hide — what you see is what you get.",
            "reveal": "apps = profile.apps[pid] (plus any scouting credit); "
                      "t = min(apps, revealApps) / revealApps; "
                      "hw = ceil(pw * (1 - t)); off = round(po * (1 - t)); "
                      "lo = pt - hw + off; hi = pt + hw + off; "
                      "if (lo < ovr) { hi += ovr - lo; lo = ovr; } "
                      "if (hi > 99) { lo = max(ovr, lo - (hi - 99)); hi = 99; }. "
                      "SLIDE the band into range, never squash it, or a range "
                      "pinned at the floor gets WIDER as the card plays. "
                      "hw 0 shows the exact number; at revealApps the range "
                      "always collapses onto pt itself. off keeps the band "
                      "off-centre early, so the midpoint is not a free answer.",
            "derivation": "room is capped by age (22 at 12 and under, 0 from 34), "
                          "scaled by archetype and squeezed by current rating "
                          "(1 - 0.55q), then rolled deterministically per card. "
                          "Legend cards sit at their ceiling.",
        },
        "portraits": {
            "version": PORTRAIT_VERSION,
            "seed": "ps = FNV-1a 32-bit over the UTF-16 code units of "
                    "name + '|' + team. Integer-exact in every JS engine "
                    "(Math.imul + >>> 0), so a face is bit-identical on a "
                    "phone and a laptop.",
            "seedFor": {
                "album": "row[2] (the album name) + '|' + the team code",
                "cast": "the display name (x.full when set, else row[1]) + "
                        "'|CAST' — the same name and team mg-manager.js's PIDX "
                        "gives a cast card",
                "team": "teams[code].ts = FNV-1a of the bare team code, for "
                        "the kit lanes (salts 40/41) and the team-photo bake",
            },
            "agree": "ps is a convenience, never a second source of truth: "
                     "seedOf(name, team) at runtime reproduces it exactly. "
                     "tools/mg-portrait-audit.js asserts the two agree for "
                     "every card.",
            "salts": PORTRAIT_SALTS,
            "saltLaw": "Append-only. Never renumber, never reuse, never "
                       "reorder — a retired trait's salt stays retired, and a "
                       "new layer takes a new salt so no existing face moves.",
            "lanes": "Each layer draws from its own lane: "
                     "lane(seed, salt) = splitmix32 finaliser over "
                     "(seed ^ imul(salt, 0x9E3779B1)). Never a sequential "
                     "stream, and never the engine's rng().",
            "skinRamp": SKIN_RAMP,
            "hairStyles": HAIR_STYLES,
            "facialHair": FACIAL_HAIR,
            "tables": "The drawing module owns the weight tables; the three "
                      "above are mirrored here only so the cast's authored "
                      "pins can name a stop by index as well as by hex.",
            "castKeys": {
                "pin": "1 = these traits are authored, not rolled",
                "sk": "skin hex", "ski": "nearest skinRamp stop (0-11)",
                "hc": "hair colour hex",
                "hs": "hairStyles token", "hsi": "its index",
                "fh": "facialHair token", "fhi": "its index",
                "hd": "head scale", "sd": "shoulder scale",
                "nk": "extra neck length, in head-radius units",
                "bd": "body flag in drawChar's language: small | big",
                "st": "life stage: child | elder | dog — line work only",
                "var": "dog = Phoenix, drawn from drawChar's dog, not the "
                       "human stack",
                "fur": "dog fur", "furD": "dog fur shadow", "cream": "dog snout",
                "note": "Only the named traits are pinned. Brows, eyes, nose, "
                        "mouth, yaw, tilt and the accessory lanes still come "
                        "from ps, which is what keeps a pinned face alive.",
            },
            "fairness": "No trait is seeded by nationality, rating, price, "
                        "age, form or parallel tier. The team code's bits are "
                        "diffused into the hash as salt and thrown away before "
                        "a palette is indexed, and the drawing function is "
                        "never handed a name, a country or a number.",
            "honesty": "Original stylised avatars, invented by a hash — never "
                       "likenesses. No photograph is read, fetched or traced, "
                       "and no portrait is ever exported, uploaded or attached "
                       "to a listing.",
            "stability": "A card's face never changes: not with form, not with "
                         "tier, not across a regeneration of this file. Faces "
                         "move only when portraits.version is bumped, which is "
                         "a deliberate product event.",
        },
        "archetypes": ARCHETYPES,
        "synergy": {
            "topN": TOP_N,
            "types": LINK_TYPES,
            "rivals": RIVALS,
            "clubs": real_clubs,
            "top": synergy_top,
            "format": "top[pid] = space-separated 'partnerId,typeIndex,strength' "
                      "entries, best first. typeIndex indexes types[]; strength "
                      "is 0-99. Decode: s.split(' ').map(e => e.split(',')). "
                      "Partners are album cards only — the cast are unlocked by "
                      "feats, never signed.",
            "rules": {
                "quality": "q = clamp((ovr - 58) / 37, 0, 1)",
                "strength": "round(99 * min(1, w * fit * (0.55 + 0.45 * q(partner))))",
                "posPair": POS_PAIR,
                "fit": {"nation": [0.72, 0.28], "club": [0.78, 0.22],
                        "spark": [0.55, 0.45]},
                "pf": "gated on cr >= 6 one side and fn >= 6 the other; "
                      "fit = sqrt(cr * fn / 81)",
                "wall": "GK + DEF; fit = sqrt(q(gk.ovr) * clamp((def.dfn - 58) / 38, 0, 1))",
                "spark": "only offered when no stronger link exists between the two",
                "chem": "points for a live link = max(1, round(type.chem * "
                        "strength / 100)), suggested cap 10 a card. What a point "
                        "is worth is the engine layer's call, inside the badge "
                        "design's effect caps.",
                "note": "these are the same numbers build_mg_data.py scored the "
                        "index with, so the squad panel can score any pair at "
                        "runtime and agree with it exactly.",
            },
        },
    }
    attr_notes = attr_gates(attr_audit, badge_map, attr_values,
                            face_values, delta_values)

    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Built by tools/build_mg_data.py from the shop's own album, price and\n"
        "// ratings files. Regenerate: .venv/bin/python tools/build_mg_data.py\n"
        "//\n"
        "// FC-style ratings, made for this shop — not EA data.\n"
        "// (community-flavoured, price-informed numbers for a family card game)\n"
        "//\n"
        "// Portraits: every card carries x.ps, a portrait seed — FNV-1a over\n"
        "// name + '|' + team. The faces it draws are ORIGINAL STYLISED AVATARS\n"
        "// invented by that hash. They are not photographs, they are not\n"
        "// likenesses of the real players, and nothing about them is seeded by\n"
        "// nationality, rating or price. See .design-portraits.md.\n"
    )
    parts = []
    for key in data:
        parts.append(json.dumps(key) + ":" + json.dumps(
            data[key], ensure_ascii=False, separators=(",", ":")))
    body = "window.MG_DATA={\n" + ",\n".join(parts) + "\n};\n"
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(header + body)

    total = sum(len(v) for v in players_by_team.values())
    size = os.path.getsize(OUT_PATH)
    print("wrote %s (%.1f KB)" % (os.path.relpath(OUT_PATH, ROOT), size / 1024.0))
    print("players: %d in %d teams (+%d cast) | clubs: %d | starters: %d | feats: %d"
          % (total, len(players_by_team), len(cast_rows), len(clubs), len(starters), len(feats)))
    print("ovr sources:", src_count)
    print("attributes: %d cards x %d subs | roles %d | badges %d awarded"
          % (len(attr_values), len(SUBS), len(ROLE_INFO) - 5, len(BADGE_DEFS)))
    for ln in attr_notes:
        print("  " + ln)
    seen_seed, coll = {}, []
    for code, rows in sorted(players_by_team.items()):
        for r in rows:
            s = r[8]["ps"]
            if s in seen_seed:
                coll.append((seen_seed[s], r[2]))
            seen_seed[s] = r[2]
    for r in cast_rows:
        s = r[8]["ps"]
        if s in seen_seed:
            coll.append((seen_seed[s], r[1]))
        seen_seed[s] = r[1]
    print("portraits: v%d | %d seeds, %d collisions | %d cast pinned"
          % (PORTRAIT_VERSION, len(seen_seed), len(coll),
             sum(1 for r in cast_rows if r[8].get("px"))))
    if coll:
        print("  COLLISIONS:", coll)
    tiers = {}
    for c in clubs:
        tiers[c["tier"]] = tiers.get(c["tier"], 0) + 1
    print("club tiers:", dict(sorted(tiers.items())))
    if "--no-roster" not in sys.argv:
        print("")
        build_roster(players_by_team)
    return 0


if __name__ == "__main__":
    sys.exit(main())
