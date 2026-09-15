#!/bin/bash
# build.sh — bundle Card Manager into ONE self-contained HTML file.
#
#   ./build.sh                 -> dist/cardmanager.html      (the real game)
#   ./build.sh --stub          -> dist/cardmanager-stub.html (the shell check)
#   ./build.sh --out PATH      -> anywhere you like
#
# Addendum 26: "It must run from a single self-contained HTML file." No
# server, no CDN, no external asset — every script is inlined, the icons and
# the PWA manifest are already data URIs in index.html.
#
# The bundle is built FROM index.html, so the page you test is the page you
# ship: the head, the splash, the viewport rules and the script ORDER all
# come from that one file. Only the <script src=...> lines are rewritten.
#
# This script only ever READS the game sources. It never writes outside
# cardmanager/dist/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STATIC="$ROOT/gibson/web/static"
STUB=0
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --stub) STUB=1; shift ;;
    --out)  OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { if [ "$STUB" = 1 ]; then OUT="$HERE/dist/cardmanager-stub.html"
                   else OUT="$HERE/dist/cardmanager.html"; fi; }
mkdir -p "$(dirname "$OUT")"

# ── the game sources, in load order ────────────────────────────────────
# The manager has not been extracted into cardmanager/ yet (seven crews are
# inside mg-manager.js). Until it lands here, the bundle reads it in place —
# reading is safe, and this line is the ONLY thing the extract phase changes.
GAME_DATA="$STATIC/mg-manager-data.js"
GAME_ROSTER="$STATIC/mg-roster.js"
GAME_PORTRAITS="$STATIC/mg-portraits.js"
GAME_KITS="$STATIC/mg-kits.js"
GAME_MAIN="$STATIC/mg-manager.js"
[ -f "$HERE/cm-manager-data.js" ] && GAME_DATA="$HERE/cm-manager-data.js"
[ -f "$HERE/cm-roster.js" ]        && GAME_ROSTER="$HERE/cm-roster.js"
[ -f "$HERE/cm-portraits.js" ]    && GAME_PORTRAITS="$HERE/cm-portraits.js"
[ -f "$HERE/cm-kits.js" ]         && GAME_KITS="$HERE/cm-kits.js"
[ -f "$HERE/cm-manager.js" ]      && GAME_MAIN="$HERE/cm-manager.js"

# ── syntax gate: a bundle that cannot parse is not a bundle ────────────
check() {
  if command -v node >/dev/null 2>&1; then
    node --check "$1" >/dev/null || { echo "SYNTAX FAIL: $1" >&2; exit 1; }
  fi
}
check "$HERE/cm-shell.js"
check "$HERE/cm-boot.js"
if [ "$STUB" = 1 ]; then
  check "$HERE/stub/cm-stub-game.js"
else
  for f in "$GAME_DATA" "$GAME_ROSTER" "$GAME_PORTRAITS" "$GAME_MAIN"; do
    [ -f "$f" ] || { echo "missing game source: $f" >&2; exit 1; }
    check "$f"
  done
fi

# Inline one file as a <script> block. The only thing that can break an
# inline script is a literal </script inside it, so it is neutralised (the
# sequence does not occur in any current source; this keeps it that way).
emit() {
  local path="$1"
  local rel="${path#$ROOT/}"
  printf '<script data-src="%s">\n' "$rel"
  sed 's|</script|<\\/script|g' "$path"
  printf '\n</script>\n'
}

TMP="$(mktemp -t cardmanager.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *'<script src="'*)
      src="$(printf '%s' "$line" | sed -E 's/.*<script src="([^"]+)".*/\1/')"
      case "$src" in
        cm-shell.js)  emit "$HERE/cm-shell.js" ;;
        cm-boot.js)   emit "$HERE/cm-boot.js" ;;
        *mg-manager-data.js|*cm-manager-data.js)
          [ "$STUB" = 1 ] || emit "$GAME_DATA" ;;
        *mg-roster.js|*cm-roster.js)
          [ "$STUB" = 1 ] || emit "$GAME_ROSTER" ;;
        *mg-kits.js|*cm-kits.js)
          [ "$STUB" = 1 ] || emit "$GAME_KITS" ;;
        # kept so an index.html that still lists the retired face engine
        # bundles instead of falling through to "cannot resolve"
        *mg-portraits.js|*cm-portraits.js)
          [ "$STUB" = 1 ] || emit "$GAME_PORTRAITS" ;;
        *mg-manager.js|*cm-manager.js)
          if [ "$STUB" = 1 ]; then emit "$HERE/stub/cm-stub-game.js"
          else emit "$GAME_MAIN"; fi ;;
        *)
          if [ -f "$HERE/$src" ]; then emit "$HERE/$src"
          else echo "  ! cannot resolve $src — left as a link" >&2; printf '%s\n' "$line"; fi ;;
      esac
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$HERE/index.html" > "$TMP"

mv "$TMP" "$OUT"
trap - EXIT

BYTES=$(wc -c < "$OUT" | tr -d ' ')
GZ=$(gzip -9 -c "$OUT" | wc -c | tr -d ' ')
printf 'wrote %s\n' "$OUT"
printf '  %s bytes raw  ·  %s bytes gzip  ·  %s\n' \
  "$BYTES" "$GZ" "$([ "$STUB" = 1 ] && echo 'STUB game' || echo 'Card Manager')"
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const h = fs.readFileSync(process.argv[1], "utf8");
    const n = (h.match(/<script/g) || []).length;
    const links = h.match(/(?:^|\s)(?:src|href)="(?!data:)[^"]+"/g) || [];
    console.log("  " + n + " inline scripts  ·  "
      + (links.length ? "EXTERNAL REFS LEFT: " + links.join(", ") : "no external references"));
    process.exit(links.length ? 1 : 0);
  ' "$OUT"
fi
