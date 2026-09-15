#!/usr/bin/env python3
"""Harvest EA's public FC ratings database, politely, from the ratings page itself.

Why this exists: the old harvester (tools/fetch_ea_roster.sh) reads
drop-api.ea.com/rating/ea-sports-fc, which on 2026-09-15 still answered with
the FC 26 database (17,873 players, Salah at Liverpool). EA's ratings page at
www.ea.com/games/ea-sports-fc/ratings already renders the FC 27 database
(19,789 players, Mbappé and Haaland at 91) behind a "next ratings release"
switch the bare API does not get. The page is a Next.js site, and its own
data route returns the same page of players as JSON, 100 at a time:

    /_next/data/<buildId>/games/ea-sports-fc/ratings.json?franchiseSlug=ea-sports-fc&page=N

Output matches the old harvest: one {"items": [...], "totalItems": N} file per
100 players, so tools/build_mg_data.py reads either folder the same way.

    python3 tools/fetch_ea_ratings.py                  # FC 27 into data/ea-fc27/
    python3 tools/fetch_ea_ratings.py --out data/ea-x  # somewhere else
    python3 tools/fetch_ea_ratings.py --check          # only report what is on disk

Resumable: a page already on disk and valid is skipped. One request every
1.5 s with a browser user agent. The robots.txt at www.ea.com does not
disallow these pages. Ratings are EA's; the game labels them as such.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE_URL = "https://www.ea.com/games/ea-sports-fc/ratings"
DATA_URL = ("https://www.ea.com/_next/data/{bid}/games/ea-sports-fc/ratings.json"
            "?franchiseSlug=ea-sports-fc&page={page}")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
PER_PAGE = 100
PAUSE = 1.5


def get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def next_data(html: str) -> dict:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("the ratings page carried no __NEXT_DATA__ block")
    return json.loads(m.group(1))


def discover() -> tuple[str, int, str]:
    """buildId, totalItems, and which game the page says it is."""
    d = next_data(get(PAGE_URL).decode("utf-8", "replace"))
    pp = d["props"]["pageProps"]
    return d["buildId"], int(pp["ratingDetails"]["totalItems"]), str(pp.get("themeSlug") or "")


def page_path(out: str, i: int) -> str:
    return os.path.join(out, "page-%03d.json" % i)


def valid(path: str, i: int, total: int) -> bool:
    try:
        d = json.load(open(path))
    except Exception:
        return False
    items = d.get("items") or []
    want = min(PER_PAGE, total - i * PER_PAGE)
    return len(items) == want and int(d.get("totalItems") or 0) == total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ea-fc27"))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    bid, total, theme = discover()
    pages = (total + PER_PAGE - 1) // PER_PAGE
    print(f"EA ratings page: {theme or 'unknown game'} · {total} players · {pages} pages · build {bid}",
          flush=True)
    if a.check:
        have = sum(1 for i in range(pages) if valid(page_path(a.out, i), i, total))
        print(f"{have}/{pages} valid pages in {a.out}")
        return 0 if have == pages else 1

    ok = 0
    for i in range(pages):
        path = page_path(a.out, i)
        if valid(path, i, total):
            ok += 1
            continue
        for attempt in range(4):
            try:
                raw = get(DATA_URL.format(bid=bid, page=i + 1))
                pp = json.loads(raw)["pageProps"]
                rd = pp["ratingDetails"]
                items = rd.get("items") or []
                if int(rd.get("totalItems") or 0) != total:
                    raise RuntimeError(f"the database changed size mid-harvest "
                                       f"({rd.get('totalItems')} vs {total}); start again")
                json.dump({"items": items, "totalItems": total,
                           "source": "www.ea.com/games/ea-sports-fc/ratings",
                           "game": theme}, open(path, "w"), ensure_ascii=False)
                if not valid(path, i, total):
                    raise RuntimeError(f"page {i + 1} came back with {len(items)} players")
                ok += 1
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:                  # EA shipped a new build: the route moved
                    bid, total2, theme = discover()
                    print(f"  new build {bid}", flush=True)
                    if total2 != total:
                        print("  the database changed size; start again", flush=True)
                        return 2
                time.sleep(PAUSE * (attempt + 2))
            except RuntimeError as e:
                print("  " + str(e), flush=True)
                if "changed size" in str(e):
                    return 2
                time.sleep(PAUSE * (attempt + 2))
            except Exception as e:                  # a dropped connection, a timeout
                print(f"  page {i + 1}: {type(e).__name__}, retrying", flush=True)
                time.sleep(PAUSE * (attempt + 2))
        else:
            print(f"  page {i + 1} failed four times; re-run to resume", flush=True)
        if i % 20 == 0:
            print(f"… {ok}/{pages} pages", flush=True)
        time.sleep(PAUSE)

    ids = set()
    for p in sorted(glob.glob(os.path.join(a.out, "page-*.json"))):
        for it in json.load(open(p)).get("items") or []:
            ids.add(it["id"])
    print(f"done: {ok}/{pages} pages · {len(ids)} unique players of {total} in {a.out}", flush=True)
    return 0 if ok == pages and len(ids) == total else 1


if __name__ == "__main__":
    sys.exit(main())
