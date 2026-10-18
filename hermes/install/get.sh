#!/usr/bin/env bash
# Agent Room one-line installer. Run on the Hermes server:
#   curl -fsSL https://hermes-agent-room.vercel.app/get.sh | bash -s -- --write-key <WRITE_KEY>
# Downloads the plugin files, checks them, then runs install.sh with your options.
set -euo pipefail
BASE="${AGENT_ROOM_BASE:-https://hermes-agent-room.vercel.app/pkg}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/plugin/agent-room" "$TMP/tools" "$TMP/bridge"
echo "==> Downloading Agent Room from $BASE"
for f in install.sh plugin/agent-room/__init__.py plugin/agent-room/plugin.yaml tools/simulate_run.py bridge/agent_room_bridge.py; do
  curl -fsSL "$BASE/$f" -o "$TMP/$f"
done
( cd "$TMP" && sha1sum -c --quiet - ) <<'SUMS'
e05121ea62994937ed1dfda2f65c6499a8263a1c  install.sh
ce9123b70b9937a9d03b28dacbd37086cb6e6a74  plugin/agent-room/__init__.py
36d071b92986e349c20fd9e66a3e91d7212631ab  plugin/agent-room/plugin.yaml
e8fd53fea5363a25105faa7507737bd7f6e310aa  tools/simulate_run.py
427f498e8a01226955e0885ed013eb79f8c5b8da  bridge/agent_room_bridge.py
SUMS
echo "==> Files OK"
bash "$TMP/install.sh" "$@"
