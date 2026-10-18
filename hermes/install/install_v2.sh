#!/usr/bin/env bash
# Hermes Platform v2 installer. Run it on the Hermes server (the Oracle VM).
#
#   bash install_v2.sh --supabase-url URL --supabase-key PUBLIC_KEY --write-key WRITE_KEY   install / update
#   bash install_v2.sh --dry-run ...                  show what would change, change nothing
#   bash install_v2.sh --rollback                     put everything back the way it was before the last install
#   bash install_v2.sh --rollback --backup 20261031-101500   go back to one specific backup
#   export DEVIN_API_KEY=cog_...; bash install_v2.sh ... --devin-key-from-env   also set up Devin (optional; see below)
#
# What it does (in this order):
#   1. checks the write key with one harmless call (an empty list of events)
#   2. backs up every file it is about to change to ~/.hermes/backups/<timestamp>/
#   3. installs the 8 SDLC skills, the hermes-platform plugin and the bridge
#   4. switches Telegram off (reversible) and makes sure the Hermes API server is on
#   5. writes ~/.hermes/platform/config.json (mode 600)
#   6. stops the old Agent Room bridge and plugin (unless you say --keep-legacy)
#   7. enables the plugin, restarts the gateway, starts the systemd user service hermes-platform-bridge
#   8. runs the bridge self check and prints a summary
#
# Devin (optional): with --devin-key-from-env the installer reads DEVIN_API_KEY (and DEVIN_ORG_ID, if set) from the
# environment, never from the command line, stores them in ~/.hermes/.env (mode 600), adds the Devin server to
# mcp_servers in ~/.hermes/config.yaml and installs the Devin poller next to the bridge. Without it Devin is skipped.
#
# Nothing here prints a key. Python 3 and the standard Linux tools are enough.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_HOME="${HERMES_HOME%/}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="hermes-platform-bridge"
UNIT="$UNIT_DIR/$UNIT_NAME.service"
LEGACY_UNIT_NAME="agent-room-bridge"
PLUGIN_NAME="hermes-platform"
LEGACY_PLUGIN_NAME="agent-room"
SKILLS=(sdlc-orchestrator sdlc-ba sdlc-architect sdlc-development sdlc-review sdlc-qa sdlc-release sdlc-change-request)

SUPABASE_URL="${HERMES_PLATFORM_SUPABASE_URL:-}"
SUPABASE_KEY="${HERMES_PLATFORM_SUPABASE_KEY:-}"
WRITE_KEY="${HERMES_PLATFORM_WRITE_KEY:-}"
GITHUB_OWNER="${HERMES_PLATFORM_GITHUB_OWNER:-}"
TEMPLATE_REPO="${HERMES_PLATFORM_TEMPLATE_REPO:-}"
LEGACY_URL="" LEGACY_KEY="" LEGACY_WRITE=""
MIRROR_LEGACY=0
KEEP_LEGACY=0
KEEP_TELEGRAM=0
SKIP_VERIFY=0
DEVIN_FROM_ENV=0
DEVIN_KEY="" DEVIN_ORG=""
DRY=0
MODE=install
BACKUP_ARG=""
VERIFY_WAIT="${HERMES_PLATFORM_VERIFY_WAIT:-30}"   # seconds to wait for the Hermes API after the restart

if [ -t 1 ]; then C_B=$'\033[1;34m'; C_Y=$'\033[1;33m'; C_R=$'\033[1;31m'; C_0=$'\033[0m'; else C_B=""; C_Y=""; C_R=""; C_0=""; fi
CHANGES=()
WARNINGS=()
say()   { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; }
info()  { printf '    %s\n' "$*"; }
would() { printf '    [dry-run] would %s\n' "$*"; }
warn()  { printf '%s!! %s%s\n' "$C_Y" "$*" "$C_0"; WARNINGS+=("$*"); }
die()   { printf '%sERROR:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

dry_tag() { if [ "$DRY" = 1 ]; then printf '(dry-run) '; fi; }

usage() { sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --write-key)         WRITE_KEY="${2:?--write-key needs a value}"; shift ;;
    --supabase-url)      SUPABASE_URL="${2:?--supabase-url needs a value}"; shift ;;
    --supabase-key)      SUPABASE_KEY="${2:?--supabase-key needs a value}"; shift ;;
    --github-owner)      GITHUB_OWNER="${2:?--github-owner needs a value}"; shift ;;
    --template-repo)     TEMPLATE_REPO="${2:?--template-repo needs a value}"; shift ;;
    --mirror-legacy)     MIRROR_LEGACY=1 ;;
    --legacy-supabase-url) LEGACY_URL="${2:?}"; shift ;;
    --legacy-supabase-key) LEGACY_KEY="${2:?}"; shift ;;
    --legacy-write-key)  LEGACY_WRITE="${2:?}"; shift ;;
    --keep-legacy)       KEEP_LEGACY=1 ;;
    --keep-telegram)     KEEP_TELEGRAM=1 ;;
    --skip-verify)       SKIP_VERIFY=1 ;;
    --devin-key-from-env) DEVIN_FROM_ENV=1 ;;
    --devin-key|--devin-key=*|--devin-org|--devin-org=*)
                         die "Do not type the Devin key on the command line (it would stay in your shell history). Run:  export DEVIN_API_KEY=...   and then use --devin-key-from-env" ;;
    --dry-run)           DRY=1 ;;
    --uninstall|--rollback) MODE=rollback ;;
    --backup)            BACKUP_ARG="${2:?--backup needs a name}"; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
  shift
done

command -v python3 >/dev/null || die "python3 is required"
HAVE_HERMES=0; command -v hermes >/dev/null && HAVE_HERMES=1
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed"

# ---- systemd helpers -------------------------------------------------------------------------------
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
HAVE_SYSTEMD=0
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then HAVE_SYSTEMD=1; fi

# ---- backup bookkeeping ----------------------------------------------------------------------------
BK=""
MANIFEST=""
TRACKED="|"

ensure_backup() {
  [ -n "$BK" ] && return 0
  local ts base n=2
  ts="$(date +%Y%m%d-%H%M%S)"; base="$HERMES_HOME/backups/$ts"; BK="$base"
  while [ -e "$BK" ] || [ -e "$BK.rolled-back" ]; do BK="$base-$n"; n=$((n + 1)); done
  mkdir -p "$BK/files"; chmod 700 "$HERMES_HOME/backups" "$BK" 2>/dev/null || true
  MANIFEST="$BK/MANIFEST.tsv"; : > "$MANIFEST"
  printf 'note\tmade by hermes-platform install_v2.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
}

# Call before the first change to a file or folder. The old one is copied into the backup (or noted as new).
track() {
  case "$TRACKED" in *"|$1|"*) return 0 ;; esac
  TRACKED="$TRACKED$1|"
  if [ "$DRY" = 1 ]; then
    if [ -e "$1" ] || [ -L "$1" ]; then would "back up $1"; fi
    return 0
  fi
  ensure_backup
  if [ -e "$1" ] || [ -L "$1" ]; then
    mkdir -p "$BK/files$(dirname "$1")"
    cp -a "$1" "$BK/files$1"
    printf 'existed\t%s\n' "$1" >> "$MANIFEST"
  else
    printf 'new\t%s\n' "$1" >> "$MANIFEST"
  fi
}

record_action() { # something done outside of files that rollback must undo
  [ "$DRY" = 1 ] && return 0
  ensure_backup
  printf 'action\t%s\n' "$1" >> "$MANIFEST"
}

# put_file SRC DST MODE LABEL
put_file() {
  local src="$1" dst="$2" mode="$3" label="$4"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then info "unchanged: $label"; return 0; fi
  if [ "$DRY" = 1 ]; then would "install $label -> $dst"; CHANGES+=("(dry-run) $label -> $dst"); return 0; fi
  track "$dst"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"; chmod "$mode" "$dst"
  CHANGES+=("installed $label -> $dst")
}

# put_dir LABEL SRCDIR DSTDIR FILE...   (whole folder is backed up first if anything differs)
put_dir() {
  local label="$1" src="$2" dst="$3" f differs=0; shift 3
  for f in "$@"; do [ -f "$src/$f" ] || die "package file missing: $src/$f"; cmp -s "$src/$f" "$dst/$f" 2>/dev/null || differs=1; done
  if [ "$differs" = 0 ]; then info "unchanged: $label"; return 0; fi
  if [ "$DRY" = 1 ]; then
    [ -e "$dst" ] && would "back up $dst"
    would "install $label -> $dst"; CHANGES+=("(dry-run) $label -> $dst"); return 0
  fi
  track "$dst"
  mkdir -p "$dst"
  for f in "$@"; do cp "$src/$f" "$dst/$f"; chmod 644 "$dst/$f"; done
  CHANGES+=("installed $label -> $dst")
}

# edit CMD FILE LABEL [EXTRA ARGS]: run an edit_config.py command; back the file up first if it will change
edit() {
  local cmd="$1" file="$2" label="$3" out res line
  shift 3
  out="$(python3 "$HERE/edit_config.py" "$cmd" --file "$file" "$@" --dry-run)" || die "could not check $file"
  res="$(printf '%s\n' "$out" | sed -n 's/^RESULT //p')"
  printf '%s\n' "$out" | grep -v '^RESULT ' || true
  [ "$res" = changed ] || return 0
  while IFS= read -r line; do
    case "$line" in "  "*) CHANGES+=("$(dry_tag)${line#  }") ;; esac
  done < <(printf '%s\n' "$out" | grep -v '^RESULT ' || true)
  [ "$DRY" = 1 ] && { would "$label"; return 0; }
  track "$file"
  python3 "$HERE/edit_config.py" "$cmd" --file "$file" "$@" > /dev/null
}

run_hermes() { # never fatal: print a warning with the manual command instead
  if [ "$HAVE_HERMES" = 0 ]; then warn "hermes command not found. Run by hand later:  hermes $*"; return 0; fi
  if [ "$DRY" = 1 ]; then would "run: hermes $*"; return 0; fi
  hermes "$@" >/dev/null 2>&1 && info "ran: hermes $*" || warn "hermes $* failed. Run it by hand and read the message."
}

# Like run_hermes, but for commands that edit ~/.hermes/config.yaml themselves (plugins enable/disable):
# if the file changed, the old copy goes into the backup so --rollback can restore it exactly.
run_hermes_tracked() {
  local cfg="$HERMES_HOME/config.yaml" snap="" had=0
  if [ "$DRY" = 0 ] && [ "$HAVE_HERMES" = 1 ]; then
    snap="$(mktemp)"
    if [ -e "$cfg" ]; then had=1; cp -p "$cfg" "$snap"; fi
  fi
  run_hermes "$@"
  if [ -n "$snap" ]; then
    case "$TRACKED" in *"|$cfg|"*) : ;; *)
      if [ "$had" = 1 ] && ! cmp -s "$snap" "$cfg"; then
        TRACKED="$TRACKED$cfg|"; ensure_backup
        mkdir -p "$BK/files$(dirname "$cfg")"; cp -a "$snap" "$BK/files$cfg"
        printf 'existed\t%s\n' "$cfg" >> "$MANIFEST"
        CHANGES+=("hermes changed $cfg (hermes $*); the old copy is in the backup")
      elif [ "$had" = 0 ] && [ -e "$cfg" ]; then
        TRACKED="$TRACKED$cfg|"; ensure_backup
        printf 'new\t%s\n' "$cfg" >> "$MANIFEST"
      fi ;;
    esac
    rm -f "$snap"
  fi
}

sysd() { # sysd ARGS... ; never fatal
  if [ "$HAVE_SYSTEMD" = 0 ]; then warn "systemd user services are not reachable. Run by hand:  systemctl --user $*"; return 0; fi
  if [ "$DRY" = 1 ]; then would "run: systemctl --user $*"; return 0; fi
  systemctl --user "$@" >/dev/null 2>&1 && info "ran: systemctl --user $*" || warn "systemctl --user $* failed."
}

# ====================================================================================================
# ROLLBACK
# ====================================================================================================
do_rollback() {
  local dir="" d name line kind a
  if [ -n "$BACKUP_ARG" ]; then
    dir="$HERMES_HOME/backups/$BACKUP_ARG"
    [ -f "$dir/MANIFEST.tsv" ] || die "No backup named $BACKUP_ARG in $HERMES_HOME/backups"
  else
    for d in "$HERMES_HOME"/backups/[0-9]*; do
      case "$d" in *.rolled-back) continue ;; esac
      if [ -f "$d/MANIFEST.tsv" ]; then dir="$d"; fi   # glob order is alphabetical = oldest first, so the last wins
    done
    [ -n "$dir" ] || die "No backup found in $HERMES_HOME/backups, so there is nothing to roll back."
  fi
  name="$(basename "$dir")"
  say "Rolling back to the state saved in $dir"
  # safety: only touch paths inside Hermes home or the systemd user folder
  while IFS=$'\t' read -r kind a; do
    case "$kind" in existed|new)
      case "$a" in "$HERMES_HOME"/*|"$UNIT_DIR"/*) : ;; *) die "Refusing to touch $a (outside $HERMES_HOME and $UNIT_DIR). The backup looks damaged." ;; esac
      case "$a" in *..*) die "Refusing odd path $a" ;; esac ;;
    esac
  done < "$dir/MANIFEST.tsv"

  local unit_in_manifest=0 unit_existed=0 plugin_new=0
  while IFS=$'\t' read -r kind a; do
    [ "$a" = "$UNIT" ] && { unit_in_manifest=1; [ "$kind" = existed ] && unit_existed=1; }
    [ "$a" = "$HERMES_HOME/plugins/$PLUGIN_NAME" ] && [ "$kind" = new ] && plugin_new=1
  done < "$dir/MANIFEST.tsv"

  if [ "$unit_in_manifest" = 1 ] && [ "$unit_existed" = 0 ]; then sysd disable --now "$UNIT_NAME.service"; fi
  if [ "$plugin_new" = 1 ]; then run_hermes plugins disable "$PLUGIN_NAME"; fi

  while IFS=$'\t' read -r kind a; do
    case "$kind" in
      existed)
        if [ "$DRY" = 1 ]; then would "restore $a"; else
          rm -rf "$a"; mkdir -p "$(dirname "$a")"; cp -a "$dir/files$a" "$a"; info "restored $a"
        fi ;;
      new)
        if [ "$DRY" = 1 ]; then would "remove $a (it did not exist before)"; else
          rm -rf "$a"; info "removed $a (it did not exist before)"
        fi ;;
    esac
  done < "$dir/MANIFEST.tsv"

  while IFS=$'\t' read -r kind a; do
    [ "$kind" = action ] || continue
    case "$a" in
      legacy_bridge_stopped) sysd enable --now "$LEGACY_UNIT_NAME.service" ;;
      legacy_plugin_disabled) run_hermes plugins enable "$LEGACY_PLUGIN_NAME" ;;
    esac
  done < "$dir/MANIFEST.tsv"

  sysd daemon-reload
  if [ "$unit_existed" = 1 ]; then sysd restart "$UNIT_NAME.service"; fi
  run_hermes gateway restart
  if [ "$DRY" = 0 ]; then
    mv "$dir" "$dir.rolled-back"
    say "Rolled back. The backup was kept as $dir.rolled-back"
    info "Run --rollback again to go back one more step (if there is an older backup)."
  else
    say "Dry run finished. Nothing was changed."
  fi
  exit 0
}

if [ "$MODE" = rollback ]; then do_rollback; fi

# ====================================================================================================
# INSTALL
# ====================================================================================================
CFG="$HERMES_HOME/platform/config.json"

# Fill gaps from an earlier install, so a plain re-run keeps working.
if [ -f "$CFG" ]; then
  for pair in "SUPABASE_URL:supabase_url" "SUPABASE_KEY:supabase_key" "WRITE_KEY:write_key" "GITHUB_OWNER:github_owner" "TEMPLATE_REPO:template_repo"; do
    var="${pair%%:*}"; key="${pair##*:}"
    if [ -z "${!var}" ]; then
      val="$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2],""); print(v if isinstance(v,str) else "")' "$CFG" "$key" 2>/dev/null || true)"
      printf -v "$var" '%s' "$val"
    fi
  done
fi
if [ "$MIRROR_LEGACY" = 1 ] && [ -z "$LEGACY_WRITE" ] && [ -f "$HERMES_HOME/agent-room/config.json" ]; then
  LEGACY_URL="${LEGACY_URL:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("supabase_url",""))' "$HERMES_HOME/agent-room/config.json" 2>/dev/null || true)}"
  LEGACY_KEY="${LEGACY_KEY:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("supabase_key",""))' "$HERMES_HOME/agent-room/config.json" 2>/dev/null || true)}"
  LEGACY_WRITE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("write_key",""))' "$HERMES_HOME/agent-room/config.json" 2>/dev/null || true)"
fi

say "Checking the settings"
[ -n "$SUPABASE_URL" ] || die "Missing --supabase-url (the https://....supabase.co address of the NEW project)."
[ -n "$SUPABASE_KEY" ] || die "Missing --supabase-key (the public sb_publishable_... key of the NEW project)."
[ -n "$WRITE_KEY" ]    || die "Missing --write-key (the machine write key you set in Supabase)."
case "$SUPABASE_URL" in
  https://*|http://127.0.0.1*|http://localhost*) : ;;
  *) die "--supabase-url must start with https:// (got: ${SUPABASE_URL%%/*}//...)" ;;
esac
case "$WRITE_KEY$SUPABASE_KEY" in *[[:space:]]*) die "A key contains a space or a line break. Copy it again without the extra characters." ;; esac
if [ "$MIRROR_LEGACY" = 1 ] && [ -z "$LEGACY_WRITE$LEGACY_URL$LEGACY_KEY" ]; then
  warn "--mirror-legacy given but no old Agent Room settings were found. The mirror stays off."
  MIRROR_LEGACY=0
fi
[ "$MIRROR_LEGACY" = 1 ] && { [ -n "$LEGACY_URL" ] && [ -n "$LEGACY_KEY" ] && [ -n "$LEGACY_WRITE" ] || die "--mirror-legacy needs all three old settings (--legacy-supabase-url, --legacy-supabase-key, --legacy-write-key)."; }

# Devin is optional: the key comes from the environment only
DEVIN_ON=0
if [ "$DEVIN_FROM_ENV" = 1 ]; then
  DEVIN_KEY="${DEVIN_API_KEY:-}"; DEVIN_ORG="${DEVIN_ORG_ID:-}"
  if [ -z "$DEVIN_KEY" ]; then
    warn "--devin-key-from-env was given, but DEVIN_API_KEY is not set in the environment. Devin is skipped. (Run:  export DEVIN_API_KEY=cog_...  and try again.)"
  else
    case "$DEVIN_KEY$DEVIN_ORG" in
      *[[:space:]\"\'\`\$\\#]*) die "DEVIN_API_KEY or DEVIN_ORG_ID has a space, a quote or another odd character. Copy it again without the extra characters." ;;
    esac
    DEVIN_ON=1
  fi
fi

for f in plugin/$PLUGIN_NAME/__init__.py plugin/$PLUGIN_NAME/plugin.yaml bridge/platform_bridge.py; do
  [ -f "$PKG/$f" ] || die "Package file missing: $PKG/$f"
done
for s in "${SKILLS[@]}"; do [ -f "$PKG/skills/$s/SKILL.md" ] || die "Package file missing: $PKG/skills/$s/SKILL.md"; done
[ -f "$HERE/edit_config.py" ] || die "Package file missing: $HERE/edit_config.py"
[ "$HAVE_HERMES" = 1 ] || warn "The hermes command was not found in PATH. Files will be copied, but you must enable the plugin and restart the gateway by hand."
[ -d "$HERMES_HOME" ] || { [ "$DRY" = 1 ] && info "$HERMES_HOME does not exist yet (it would be created)" || mkdir -p "$HERMES_HOME"; }

say "Step 1 of 8: checking the write key"
if [ "$SKIP_VERIFY" = 1 ]; then
  warn "Write key check skipped (--skip-verify)."
elif [ "$DRY" = 1 ]; then
  would "send one empty test call to $SUPABASE_URL/rest/v1/rpc/platform_ingest"
else
  if HP_URL="$SUPABASE_URL" HP_KEY="$SUPABASE_KEY" HP_WRITE="$WRITE_KEY" python3 "$HERE/edit_config.py" verify-key | sed 's/^/    /'; then :; else
    die "The write key check failed, so nothing was changed. Fix the three settings and run again."
  fi
fi

on_error() {
  local code=$?
  printf '\n%sSomething went wrong (exit %s).%s\n' "$C_R" "$code" "$C_0" >&2
  if [ -n "$BK" ]; then
    local me="$HERMES_HOME/platform/install_v2.sh"; [ -f "$me" ] || me="$HERE/install_v2.sh"
    printf 'Your old files are safe in %s\nTo undo everything:  bash %s --rollback\n' "$BK" "$me" >&2
  else
    printf 'No file was changed yet.\n' >&2
  fi
  exit "$code"
}
trap on_error ERR

say "Step 2 of 8: skills ($((${#SKILLS[@]})) SDLC skills)"
for s in "${SKILLS[@]}"; do
  # an older copy of the same skill in a sub-folder (a category) would create a duplicate name: move it to the backup
  if [ -d "$HERMES_HOME/skills" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      [ "$d" = "$HERMES_HOME/skills/$s" ] && continue
      if [ "$DRY" = 1 ]; then would "move the older copy $d into the backup"; else
        track "$d"; rm -rf "$d"
      fi
      CHANGES+=("$(dry_tag)moved the older copy of skill $s from $d into the backup")
    done < <(find "$HERMES_HOME/skills" -mindepth 2 -maxdepth 3 -type d -name "$s" 2>/dev/null || true)
  fi
  put_dir "skill $s" "$PKG/skills/$s" "$HERMES_HOME/skills/$s" SKILL.md
done

say "Step 3 of 8: plugin and bridge"
put_dir "plugin $PLUGIN_NAME" "$PKG/plugin/$PLUGIN_NAME" "$HERMES_HOME/plugins/$PLUGIN_NAME" __init__.py plugin.yaml
put_file "$PKG/bridge/platform_bridge.py" "$HERMES_HOME/platform/platform_bridge.py" 755 "bridge"
put_file "$HERE/install_v2.sh" "$HERMES_HOME/platform/install_v2.sh" 755 "this installer (so --rollback works later)"

say "Step 4 of 8: Telegram and the Hermes API server"
if [ "$KEEP_TELEGRAM" = 1 ]; then
  info "Telegram left as it is (--keep-telegram)"
else
  edit env-telegram "$HERMES_HOME/.env" "remove the TELEGRAM variables from .env"
  edit yaml-telegram "$HERMES_HOME/config.yaml" "set telegram.enabled: false in config.yaml"
fi
edit env-api "$HERMES_HOME/.env" "turn on the API server in .env"

if [ "$DEVIN_ON" = 1 ]; then
  say "Devin (optional)"
  DEVIN_DIR="$PKG/devin"
  if [ -f "$DEVIN_DIR/devin_poller.py" ] && [ -f "$DEVIN_DIR/config.yaml.snippet" ]; then
    put_file "$DEVIN_DIR/devin_poller.py" "$HERMES_HOME/platform/devin_poller.py" 644 "Devin poller"
    HP_DEVIN_KEY="$DEVIN_KEY" HP_DEVIN_ORG="$DEVIN_ORG" edit env-devin "$HERMES_HOME/.env" "store the Devin key in .env (mode 600)"
    if [ "$DRY" = 1 ]; then
      info "this Devin server would be merged into mcp_servers in $HERMES_HOME/config.yaml (the key stays in .env):"
      grep -v '^[[:space:]]*#' "$DEVIN_DIR/config.yaml.snippet" | sed 's/^/        /'
    fi
    edit yaml-devin "$HERMES_HOME/config.yaml" "add the Devin MCP server to config.yaml" --snippet "$DEVIN_DIR/config.yaml.snippet"
  else
    warn "Devin was asked for, but the Devin files are not in this package ($DEVIN_DIR). Devin is skipped."
  fi
else
  info "Devin: skipped (no key given). To add it later:  export DEVIN_API_KEY=cog_...  and run this installer again with --devin-key-from-env"
fi

say "Step 5 of 8: platform settings ($CFG)"
cfg_out="$(HP_URL="$SUPABASE_URL" HP_KEY="$SUPABASE_KEY" HP_WRITE="$WRITE_KEY" HP_GITHUB_OWNER="$GITHUB_OWNER" HP_TEMPLATE_REPO="$TEMPLATE_REPO" \
  HP_LEGACY_URL="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_URL")" HP_LEGACY_KEY="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_KEY")" \
  HP_LEGACY_WRITE="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_WRITE")" \
  python3 "$HERE/edit_config.py" config-json --file "$CFG" --dry-run)" || die "could not prepare $CFG"
printf '%s\n' "$cfg_out" | grep -v '^RESULT ' || true
if [ "$(printf '%s\n' "$cfg_out" | sed -n 's/^RESULT //p')" = changed ]; then
  if [ "$DRY" = 1 ]; then would "write $CFG (mode 600)"; CHANGES+=("(dry-run) write $CFG"); else
    track "$CFG"
    HP_URL="$SUPABASE_URL" HP_KEY="$SUPABASE_KEY" HP_WRITE="$WRITE_KEY" HP_GITHUB_OWNER="$GITHUB_OWNER" HP_TEMPLATE_REPO="$TEMPLATE_REPO" \
      HP_LEGACY_URL="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_URL")" HP_LEGACY_KEY="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_KEY")" \
      HP_LEGACY_WRITE="$([ "$MIRROR_LEGACY" = 1 ] && printf %s "$LEGACY_WRITE")" \
      python3 "$HERE/edit_config.py" config-json --file "$CFG" > /dev/null
    CHANGES+=("wrote $CFG (mode 600, keys not shown)")
  fi
fi
[ "$MIRROR_LEGACY" = 1 ] && info "Events are also mirrored to the old Agent Room (so the old site keeps showing them)."

say "Step 6 of 8: old Agent Room"
if [ "$KEEP_LEGACY" = 1 ]; then
  info "Old bridge and plugin left running (--keep-legacy). Two bridges can fight over the one Hermes API server."
else
  if [ "$HAVE_SYSTEMD" = 1 ] && systemctl --user is-active --quiet "$LEGACY_UNIT_NAME.service" 2>/dev/null; then
    sysd disable --now "$LEGACY_UNIT_NAME.service"
    record_action legacy_bridge_stopped
    CHANGES+=("$(dry_tag)stopped and disabled the old $LEGACY_UNIT_NAME service")
  else
    info "old $LEGACY_UNIT_NAME service is not running"
  fi
  MARKER="$HERMES_HOME/platform/.legacy_plugin_disabled"
  if [ -d "$HERMES_HOME/plugins/$LEGACY_PLUGIN_NAME" ] && [ ! -e "$MARKER" ]; then
    run_hermes_tracked plugins disable "$LEGACY_PLUGIN_NAME"
    if [ "$HAVE_HERMES" = 1 ]; then
      if [ "$DRY" = 0 ]; then
        track "$MARKER"; mkdir -p "$(dirname "$MARKER")"; : > "$MARKER"
        record_action legacy_plugin_disabled
      fi
      CHANGES+=("$(dry_tag)disabled the old $LEGACY_PLUGIN_NAME plugin (its files are kept)")
    fi
  elif [ -e "$MARKER" ]; then
    info "old $LEGACY_PLUGIN_NAME plugin was already disabled by an earlier run"
  else
    info "no old $LEGACY_PLUGIN_NAME plugin folder found"
  fi
fi

say "Step 7 of 8: start everything"
run_hermes_tracked plugins enable "$PLUGIN_NAME"
run_hermes gateway restart
unit_tmp="$(mktemp)"; trap 'rm -f "$unit_tmp"' EXIT
cat > "$unit_tmp" <<EOF
[Unit]
Description=Hermes Platform bridge (website orders -> Hermes)
After=network-online.target

[Service]
Environment=HERMES_HOME=$HERMES_HOME
ExecStart=/usr/bin/env python3 $HERMES_HOME/platform/platform_bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
put_file "$unit_tmp" "$UNIT" 644 "systemd user service"
sysd daemon-reload
sysd enable "$UNIT_NAME.service"
sysd restart "$UNIT_NAME.service"
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" = no ]; then
  warn "User services stop when you log out. Run once:  sudo loginctl enable-linger $(id -un)"
fi

say "Step 8 of 8: self check"
VERIFY_FAILED=0
if [ "$DRY" = 1 ]; then
  would "run the bridge self check: python3 $HERMES_HOME/platform/platform_bridge.py --check"
else
  waited=0
  while :; do
    if out="$(HERMES_HOME="$HERMES_HOME" python3 "$HERMES_HOME/platform/platform_bridge.py" --check 2>&1)"; then
      printf '%s\n' "$out" | sed 's/^/    /'; break
    fi
    if [ "$waited" -ge "$VERIFY_WAIT" ]; then
      printf '%s\n' "$out" | sed 's/^/    /'; VERIFY_FAILED=1; break
    fi
    sleep 3; waited=$((waited + 3))
  done
  [ "$VERIFY_FAILED" = 1 ] && warn "The self check failed (see above). The files are installed; fix the problem and run the same command again."
fi

trap - ERR
echo
echo "------------------------------------------------------------------"
if [ "$DRY" = 1 ]; then echo " DRY RUN summary: nothing was changed. This is what would change:"; else echo " Hermes Platform v2 installer summary"; fi
echo "------------------------------------------------------------------"
if [ "${#CHANGES[@]}" -eq 0 ]; then echo " Nothing needed changing (already up to date)."; else
  for c in "${CHANGES[@]}"; do echo "  - $c"; done
fi
if [ -n "$BK" ]; then
  echo
  echo " Old files saved in: $BK"
  echo " Undo everything:    bash $HERMES_HOME/platform/install_v2.sh --rollback"
fi
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo
  echo " Warnings:"
  for w in "${WARNINGS[@]}"; do echo "  ! $w"; done
fi
if [ "$DRY" = 0 ]; then
  echo
  echo " Bridge logs:        journalctl --user -u $UNIT_NAME -f"
  echo " Bridge self check:  HERMES_HOME=$HERMES_HOME python3 $HERMES_HOME/platform/platform_bridge.py --check"
fi
echo "------------------------------------------------------------------"
[ "$VERIFY_FAILED" = 0 ] || exit 3
exit 0
