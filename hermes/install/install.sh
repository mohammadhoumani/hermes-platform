#!/usr/bin/env bash
# Agent Room installer for the Hermes server.
#
#   bash install.sh --write-key <WRITE_KEY>     install / update (cloud mode: Supabase + website)
#   bash install.sh --local-server              also run the optional local server on port 8787
#   bash install.sh --uninstall                 remove the plugin (and local server if installed)
#
# Cloud mode needs no open port: the plugin only sends HTTPS requests out to Supabase.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER="${USER:-$(id -un)}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DIR="$HERMES_HOME/plugins/agent-room"
DATA_DIR="$HERMES_HOME/agent-room"
APP_DIR="$HOME/agent-room"
UNIT="$HOME/.config/systemd/user/agent-room.service"

SUPABASE_URL="${AGENT_ROOM_SUPABASE_URL:-https://dzqvokssnvsfhixswhtf.supabase.co}"
SUPABASE_KEY="${AGENT_ROOM_SUPABASE_KEY:-sb_publishable_oUWDRiQALHztfBxU0ZBrUQ_DFmDoomJ}"
WRITE_KEY="${AGENT_ROOM_WRITE_KEY:-}"
LOCAL_SERVER=0
FIREWALL=1
ORDERS=1
BRIDGE_UNIT="$HOME/.config/systemd/user/agent-room-bridge.service"
PORT="${AGENT_ROOM_PORT:-8787}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --write-key)    WRITE_KEY="${2:-}"; shift ;;
    --supabase-url) SUPABASE_URL="${2:-}"; shift ;;
    --supabase-key) SUPABASE_KEY="${2:-}"; shift ;;
    --local-server) LOCAL_SERVER=1 ;;
    --no-firewall)  FIREWALL=0 ;;
    --no-orders)    ORDERS=0 ;;
    --uninstall)
      say "Removing Agent Room"
      export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      systemctl --user disable --now agent-room.service agent-room-bridge.service 2>/dev/null || true
      rm -f "$UNIT" "$BRIDGE_UNIT"; systemctl --user daemon-reload 2>/dev/null || true
      command -v hermes >/dev/null && hermes plugins disable agent-room 2>/dev/null || true
      rm -rf "$PLUGIN_DIR" "$APP_DIR"
      rm -f "$DATA_DIR/config.json"
      command -v hermes >/dev/null && hermes gateway restart 2>/dev/null || true
      say "Done. Local event history is still in $DATA_DIR (delete it by hand if you want)."
      exit 0 ;;
    *) warn "Unknown option $1" ;;
  esac
  shift
done

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
command -v hermes  >/dev/null || warn "The hermes command was not found in PATH. Files are copied, but enable the plugin by hand later."

# 1. Plugin --------------------------------------------------------------------
say "Installing the Hermes plugin to $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR" "$DATA_DIR" "$APP_DIR"
cp "$HERE/plugin/agent-room/plugin.yaml" "$HERE/plugin/agent-room/__init__.py" "$PLUGIN_DIR/"
cp "$HERE/tools/simulate_run.py" "$APP_DIR/"
chmod +x "$APP_DIR/simulate_run.py"

# 2. Cloud config (Supabase) ---------------------------------------------------
CFG="$DATA_DIR/config.json"
if [ -z "$WRITE_KEY" ] && [ -f "$CFG" ]; then
  WRITE_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("write_key",""))' "$CFG" 2>/dev/null || true)"
fi
if [ -n "$WRITE_KEY" ]; then
  umask 077
  python3 - "$CFG" "$SUPABASE_URL" "$SUPABASE_KEY" "$WRITE_KEY" <<'PY'
import json, sys
path, url, key, write = sys.argv[1:5]
json.dump({"supabase_url": url, "supabase_key": key, "write_key": write}, open(path, "w"), indent=2)
PY
  umask 022
  chmod 600 "$CFG"
  say "Saved the Supabase settings to $CFG"
  # Quick check that the key is right (sends one 'plugin_loaded' test event).
  if python3 - "$CFG" <<'PY'
import json, sys, time, urllib.request
c = json.load(open(sys.argv[1]))
body = json.dumps({"write_key": c["write_key"], "events": [{"v": 1, "ts": time.time(), "type": "plugin_loaded", "note": "install check"}]}).encode()
req = urllib.request.Request(c["supabase_url"].rstrip("/") + "/rest/v1/rpc/agent_room_ingest", data=body, method="POST")
req.add_header("Content-Type", "application/json"); req.add_header("apikey", c["supabase_key"])
try:
    urllib.request.urlopen(req, timeout=15).read(); print("   Supabase accepted the write key.")
except Exception as e:
    msg = str(e)
    try: msg += " " + e.read().decode()[:200]
    except Exception: pass
    print("   Supabase check failed:", msg); sys.exit(1)
PY
  then :; else warn "Fix the write key (or your internet), then run this script again."; fi
else
  warn "No write key given, so events stay on this server only."
  warn "Run again with:  bash install.sh --write-key <WRITE_KEY>"
fi

# 3. Optional local server -------------------------------------------------------
if [ "$LOCAL_SERVER" = 1 ]; then
  say "Installing the optional local server to $APP_DIR"
  cp "$HERE/server/agent_room_server.py" "$HERE/server/index.html" "$APP_DIR/"
  chmod +x "$APP_DIR/agent_room_server.py"
  ENV_FILE="$APP_DIR/agent-room.env"
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    printf 'AGENT_ROOM_KEY=%s\nAGENT_ROOM_PORT=%s\nAGENT_ROOM_HOST=0.0.0.0\nAGENT_ROOM_EVENTS=%s\n' \
      "$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')" "$PORT" "$DATA_DIR/events.jsonl" > "$ENV_FILE"
    umask 022
  fi
  LKEY="$(grep '^AGENT_ROOM_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Agent Room local dashboard for Hermes
After=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env python3 $APP_DIR/agent_room_server.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable agent-room.service >/dev/null
    systemctl --user restart agent-room.service
  else
    warn "Could not reach your user systemd. Run: systemctl --user daemon-reload && systemctl --user enable --now agent-room"
  fi
  if [ "$FIREWALL" = 1 ] && sudo -n true 2>/dev/null; then
    if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
      LINE="$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
      if [ -n "$LINE" ]; then sudo iptables -I INPUT "$LINE" -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
      else sudo iptables -A INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT; fi
      command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 || true
    fi
  fi
  IP="$(curl -fsS --max-time 4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  say "Local dashboard: http://$IP:$PORT/?key=$LKEY  (also open port $PORT in the Oracle Security List)"
fi

# 4. Orders from the website: Hermes API server (this server only) + bridge -------
if [ "$ORDERS" = 1 ] && [ -n "$WRITE_KEY" ]; then
  say "Turning on the Hermes API server (127.0.0.1 only) so the website can send orders"
  python3 - "$HERMES_HOME/.env" <<'PY'
import os, re, secrets, sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
cur = {}
for l in lines:
    m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", l)
    if m: cur[m.group(1)] = m.group(2).strip().strip('"').strip("'")
want = {"API_SERVER_ENABLED": "true", "API_SERVER_KEY": cur.get("API_SERVER_KEY") or secrets.token_urlsafe(32)}
out, done = [], set()
for l in lines:
    m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=", l)
    if m and m.group(1) in want:
        if m.group(1) not in done:
            out.append(f"{m.group(1)}={want[m.group(1)]}"); done.add(m.group(1))
        continue
    out.append(l)
for k, v in want.items():
    if k not in done: out.append(f"{k}={v}")
os.makedirs(os.path.dirname(path), exist_ok=True)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
os.chmod(path, 0o600)
PY
  cp "$HERE/bridge/agent_room_bridge.py" "$APP_DIR/"
  chmod +x "$APP_DIR/agent_room_bridge.py"
  mkdir -p "$(dirname "$BRIDGE_UNIT")"
  cat > "$BRIDGE_UNIT" <<EOF
[Unit]
Description=Agent Room bridge (website orders -> Hermes)
After=network-online.target

[Service]
Environment=HERMES_HOME=$HERMES_HOME
ExecStart=/usr/bin/env python3 $APP_DIR/agent_room_bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
fi

# 5. Enable the plugin and restart the gateway -----------------------------------
if command -v hermes >/dev/null; then
  hermes plugins enable agent-room || warn "Could not enable the plugin. Run: hermes plugins enable agent-room"
  say "Restarting the Hermes gateway to load the plugin"
  hermes gateway restart || warn "Restart it yourself: hermes gateway restart"
fi
if [ -f "$BRIDGE_UNIT" ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable agent-room-bridge.service >/dev/null
    systemctl --user restart agent-room-bridge.service
    say "Bridge is running (website orders -> Hermes)"
  else
    warn "Could not reach your user systemd. Run: systemctl --user daemon-reload && systemctl --user enable --now agent-room-bridge"
  fi
fi

echo
echo "------------------------------------------------------------------"
echo " Agent Room plugin is installed."
echo
echo " Test it now (fake run, sent to your dashboard):"
echo "   python3 $APP_DIR/simulate_run.py"
echo
echo " Then open your dashboard link and give the agents an order there."
echo " Plugin status:  hermes plugins list"
echo " Bridge logs:    journalctl --user -u agent-room-bridge -f"
echo "------------------------------------------------------------------"
