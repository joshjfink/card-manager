#!/usr/bin/env python3
"""Build gibson/web/static/mg-badges.js — one crest per club, embedded.

WHY EMBEDDED. The published page runs inside the artifact viewer, whose CSP
blocks external images outright — a remote <img> is not slow there, it simply
never loads and there is no error to see. So every badge ships in the file as a
data URI, like everything else in this game.

WHERE THEY COME FROM, in order:
  1. luukhopman/football-logos — real club badges, 25 European leagues. Matched
     by tools/match_club_logos.py plus a verified per-league agent pass.
  2. EA's own club crest for the club (data/crests-ea/<eaId>.png). For a club
     EA has not licensed this is EA's OWN generic mark, which is the honest
     thing to show for a club EA has deliberately renamed.
  3. Nothing. The game draws its own crest from the club's initials.

A club EA calls "Latium" or "Lombardia FC" never gets the real club's badge:
that would put a real organisation's trademark on a team that is deliberately
not that team.

Third-party marks: club badges are trademarks of their clubs and are used here
only to identify the club inside a private, non-commercial game.

  python3 tools/build_club_badges.py [--box 64] [--quality 80]
"""
import base64, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'gibson/web/static/mg-badges.js')


def arg(flag, default):
    return type(default)(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


def encode(path, box, quality):
    from PIL import Image
    im = Image.open(path).convert('RGBA')
    im.thumbnail((box, box), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=quality, method=6)
    return base64.b64encode(buf.getvalue()).decode(), colours(im)


def colours(im):
    """The club's two colours, read off its own badge.

    EA's data carries no kit colours, and a club drawn in the wrong ones looks
    like a different club. The badge is the one place the real colours are
    guaranteed to be, so they are counted out of it: the two most-used strong
    hues, ignoring the transparent surround and the near-white/near-black that
    every crest uses for outlines and lettering.

    Falls back to the game's own gold and green rather than returning None, so
    a caller never has to handle a club with no colours.
    """
    from collections import Counter
    import colorsys
    c = Counter()
    for r, g, b, a in im.getdata():
        if a < 160:
            continue
        h, l, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if l > 0.92 or l < 0.08:          # outline white / lettering black
            continue
        if sat < 0.12 and 0.35 < l < 0.75:  # flat grey carries no identity
            continue
        c[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1
    if not c:
        # A monochrome crest — Juventus, Newcastle, a black-on-white shield —
        # survives none of the filters above, and the first version of this
        # handed those clubs the game's default gold and green. Count again
        # with only transparency excluded, so black and white can win.
        for r, g, b, a in im.getdata():
            if a < 160:
                continue
            c[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1
    top = [rgb for rgb, _ in c.most_common(8)]
    if not top:
        return ['#e9bf63', '#2f8f52']

    def hexof(t):
        return '#%02x%02x%02x' % tuple(min(255, v + 12) for v in t)

    first = top[0]
    second = None
    for t in top[1:]:
        # a second colour only counts if it is visibly different from the first
        if sum(abs(a - b) for a, b in zip(t, first)) > 90:
            second = t
            break
    if second is None:
        # A single-colour club (Liverpool's all-red badge). Give it a partner
        # with real contrast rather than repeating itself, which would draw a
        # kit with no trim at all.
        lum = (first[0] * 299 + first[1] * 587 + first[2] * 114) / 1000
        second = (18, 18, 18) if lum > 140 else (238, 238, 238)
    return [hexof(first), hexof(second)]


def main():
    box, quality = arg('--box', 64), arg('--quality', 80)
    clubs = json.load(open(os.path.join(ROOT, 'tools/clubdata/clubs.json')))

    # 1. the name-matched repo badges
    src = {}
    mp_path = os.path.join(ROOT, 'tools/clubdata/logo-map.json')
    if os.path.exists(mp_path):
        for cid, v in json.load(open(mp_path)).items():
            src[int(cid)] = ('repo', v['file'])

    # 2. anything the per-league agents resolved and a refuter could not kill
    ag_path = os.path.join(ROOT, 'tools/clubdata/agent-matches.json')
    logo_root = arg('--logos', os.path.join(ROOT, 'tools/clubdata/logos'))
    by_id = {c['id']: c for c in clubs}
    if os.path.exists(ag_path):
        rejected = 0
        for m in json.load(open(ag_path)):
            cid = int(m['clubId'])

            # THE IDENTITY GATE. An agent run once returned twelve confident
            # matches of which ten named a club id that was something else
            # entirely — Tottenham's badge against Borussia Dortmund, Real
            # Betis' against Juve Stabia — because the ids in its prompt had
            # been typed by hand rather than read from clubs.json. The
            # adversarial reviewer caught most of it and not all of it.
            #
            # So the id is checked here, where it cannot be skipped: the club
            # the agent NAMED must be the club that id actually is. A badge on
            # the wrong club is the one output of this pipeline that is worse
            # than no badge at all.
            # Either spelling of the name field is accepted; what is NOT
            # optional is that one of them is present. A match that does not
            # say which club it means cannot be checked, so it is refused.
            club = by_id.get(cid)
            named = str(m.get('eaName') or m.get('clubName') or '').strip().lower()
            real = str((club or {}).get('name') or '').strip().lower()
            if not club or not named or not (named in real or real in named):
                print(f"  ! REJECTED agent match: id {cid} was called "
                      f"{m.get('eaName') or m.get('clubName')!r} but is "
                      f"{(club or {}).get('name')!r}", file=sys.stderr)
                rejected += 1
                continue

            p = os.path.join(logo_root, m['logoLeague'], m['logoName'] + '.png')
            if os.path.exists(p):
                src.setdefault(cid, ('repo-agent', p))
            else:
                print(f"  ! agent named a badge that is not on disk: {p}",
                      file=sys.stderr)
        if rejected:
            print(f"  identity gate rejected {rejected} agent match(es)", file=sys.stderr)

    # 3. EA's own crest, which is the right mark for a club EA renamed
    for c in clubs:
        if c['id'] in src:
            continue
        p = os.path.join(ROOT, 'data/crests-ea', f"{c.get('ea')}.png")
        if c.get('ea') and os.path.exists(p) and os.path.getsize(p) > 0:
            src[c['id']] = ('ea', p)

    out, colmap, stats, bytes_ = {}, {}, {'repo': 0, 'repo-agent': 0, 'ea': 0}, 0
    for cid, (kind, path) in sorted(src.items()):
        try:
            b64, cols = encode(path, box, quality)
        except Exception as e:                       # a bad download is not fatal
            print(f"  ! {cid} {path}: {e}", file=sys.stderr)
            continue
        # keyed by EA's TEAM id, which never changes, not by the roster's club
        # index, which does: the FC 27 harvest added 103 clubs and shifted
        # every index after the first new one (addendum 34)
        ea_key = str(by_id[cid]['ea'])
        out[ea_key] = b64
        colmap[ea_key] = cols
        stats[kind] += 1
        bytes_ += len(b64)

    missing = [c for c in clubs if str(c['ea']) not in out]
    # the club numbering clubs.json was written in — every save made before
    # 2026-09-15 stores its club as one of these indices
    legacy_payload = json.dumps({str(c['id']): c['ea'] for c in clubs}, separators=(',', ':'))
    payload = json.dumps(out, separators=(',', ':'))
    colours_payload = json.dumps(colmap, separators=(',', ':'))
    with open(OUT, 'w') as f:
        f.write(f"""// GENERATED FILE — do not edit by hand.
// Built by tools/build_club_badges.py.
//
// One crest per club, {box}px WebP as a data URI. Embedded because the artifact
// viewer's CSP blocks external images outright — a remote badge does not load
// slowly there, it never loads at all and says nothing about why.
//
// {stats['repo'] + stats['repo-agent']} from luukhopman/football-logos · {stats['ea']} from EA's own club crest
// · {len(missing)} clubs draw their initials instead.
//
// Club badges are trademarks of their clubs, used here only to identify the
// club inside a private, non-commercial game. A club EA has deliberately
// renamed (\"Latium\", \"Lombardia FC\") never carries the real club's badge.
//
// Keyed by EA's team id. MG_BADGES.img(clubId) takes the roster's club index,
// as every caller holds, and translates it through MG_ROSTER; byEa.* takes the
// team id itself. legacyEa(index) reads the numbering saves used before the
// FC 27 roster (addendum 34). Nothing is decoded at load: an Image is built on
// first use and cached. Booting costs one string parse.
;(function () {{
'use strict';
var B = {payload};
/* Each club's two colours, counted out of its own badge at build time — EA
   ships no kit colours, and a club in the wrong ones reads as a different
   club. */
var C = {colours_payload};
/* the pre-FC 27 club index -> EA team id, for old saves */
var L = {legacy_payload};
var cache = {{}}, eaOfIdx = {{}};
function eaOf(id) {{
  var k = String(id);
  if (eaOfIdx[k] !== undefined) return eaOfIdx[k];
  var R = window.MG_ROSTER, c = null;
  try {{ c = (R && R.club && +id > 0) ? R.club(+id) : null; }} catch (e) {{ c = null; }}
  return (eaOfIdx[k] = (c && c.ea) ? String(c.ea) : null);
}}
function has(ea) {{ return !!ea && Object.prototype.hasOwnProperty.call(B, ea); }}
/* An Image, built once per club and cached. Returns null when the club has no
   badge, so the caller draws its own crest instead of a blank hole. */
function img(ea) {{
  if (!ea) return null;
  if (cache[ea] !== undefined) return cache[ea];
  var d = B[ea];
  if (!d) {{ cache[ea] = null; return null; }}
  var im = new Image();
  im.decoding = 'async';
  im.src = 'data:image/webp;base64,' + d;
  cache[ea] = im;
  return im;
}}
/* [primary, secondary] hex, always two entries, never null. */
function colors(ea) {{ return (ea && C[ea]) || ['#e9bf63', '#2f8f52']; }}
window.MG_BADGES = {{
  has: function (id) {{ return has(eaOf(id)); }},
  img: function (id) {{ return img(eaOf(id)); }},
  colors: function (id) {{ return colors(eaOf(id)); }},
  byEa: {{
    has: function (ea) {{ return has(String(ea)); }},
    img: function (ea) {{ return img(String(ea)); }},
    colors: function (ea) {{ return colors(String(ea)); }},
  }},
  legacyEa: function (idx) {{ return L[String(idx)] || null; }},
  count: function () {{ return Object.keys(B).length; }},
}};
}})();
""")
    print(f"  clubs          : {len(clubs)}")
    print(f"  repo badges    : {stats['repo']} name-matched + {stats['repo-agent']} agent-resolved")
    print(f"  EA crests      : {stats['ea']}")
    print(f"  no badge       : {len(missing)}  (drawn from initials)")
    print(f"  wrote {OUT}  {os.path.getsize(OUT)/1024/1024:.2f} MB")


main()
