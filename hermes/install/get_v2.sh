#!/usr/bin/env bash
# Hermes Platform v2 one-line installer. Run it on the Hermes server:
#
#   curl -fsSL https://YOUR-SITE/pkg/get_v2.sh | bash -s -- --supabase-url URL --supabase-key KEY --write-key WRITE_KEY
#
# It downloads the package, checks every file against SHA256SUMS, then runs install_v2.sh with your options.
# Add --dry-run to see what would change. Add --rollback to undo.
#
# HERMES_PLATFORM_BASE overrides where the files come from (an https:// or file:// address).
set -euo pipefail
BASE="${HERMES_PLATFORM_BASE:-@@BASE@@}"
case "$BASE" in
  @@*) echo "This copy of get_v2.sh was not built for a website (BASE is empty). Set HERMES_PLATFORM_BASE=https://YOUR-SITE/pkg" >&2; exit 1 ;;
esac
BASE="${BASE%/}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
if command -v sha256sum >/dev/null; then SHA=(sha256sum -c --quiet); elif command -v shasum >/dev/null; then SHA=(shasum -a 256 -c --quiet); else echo "sha256sum is required" >&2; exit 1; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading Hermes Platform v2 from $BASE"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
# the list of files comes from SHA256SUMS; refuse anything that tries to leave the folder
while read -r _ f; do
  f="${f#\*}"
  case "$f" in ""|/*|*..*|*[!A-Za-z0-9._/-]*) echo "Refusing suspicious file name in SHA256SUMS: $f" >&2; exit 1 ;; esac
  mkdir -p "$TMP/$(dirname "$f")"
  curl -fsSL "$BASE/$f" -o "$TMP/$f"
done < "$TMP/SHA256SUMS"
( cd "$TMP" && "${SHA[@]}" SHA256SUMS ) || { echo "A downloaded file does not match SHA256SUMS. Nothing was installed." >&2; exit 1; }
[ -f "$TMP/install/install_v2.sh" ] || { echo "install/install_v2.sh is missing from the package" >&2; exit 1; }
echo "==> Files OK"
bash "$TMP/install/install_v2.sh" "$@"
