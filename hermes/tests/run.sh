#!/usr/bin/env bash
# Python and shell tests for the Hermes side (plugin, bridge, installer). Needs python3 and node. No network, no real services.
#   bash hermes/tests/run.sh            run everything
#   HP_TEST_VERBOSE=1 bash hermes/tests/run.sh   show the bridge log while the tests run
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
echo "== plugin, bridge and installer tests"
python3 -m unittest discover -s hermes/tests -p "test_*.py"
echo "== web fixture of plugin events is up to date"
python3 hermes/tools/make_fixture_v2.py --check
echo "== shell syntax"
bash -n hermes/install/install_v2.sh
bash -n hermes/install/get_v2.sh
