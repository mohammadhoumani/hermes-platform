"""Installer v2 (install_v2.sh, get_v2.sh, edit_config.py) in a fake HERMES_HOME.

Nothing real is touched: HOME and HERMES_HOME are temporary folders, `hermes` and `systemctl` are shell
shims that only write to a log, Supabase is the in-process mock and the Hermes API is a tiny health server.

Run:  python3 -m unittest hermes/tests/test_installer.py -v
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # the hermes/ folder
REPO = ROOT.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "install"))

from mock_platform import KEY, WRITE, MockPlatform  # noqa: E402
import edit_config  # noqa: E402

INSTALL = ROOT / "install" / "install_v2.sh"
GET = ROOT / "install" / "get_v2.sh"
TG_TOKEN = "fake-telegram-token-123456"
SKILLS = ["sdlc-orchestrator", "sdlc-ba", "sdlc-architect", "sdlc-development", "sdlc-review", "sdlc-qa", "sdlc-release", "sdlc-change-request"]

HERMES_SHIM = """#!/usr/bin/env bash
echo "hermes $*" >> "$HP_SHIM_LOG"
if [ "${HP_SHIM_FAIL:-}" = "$1 $2" ]; then echo "boom" >&2; exit 1; fi
CFG="$HERMES_HOME/config.yaml"
# the real hermes keeps the list of enabled plugins in config.yaml; imitate that
if [ "$1 $2" = "plugins enable" ] && [ -f "$CFG" ]; then grep -q -- "- $3\\$" "$CFG" || printf '    - %s\\n' "$3" >> "$CFG"; fi
if [ "$1 $2" = "plugins disable" ] && [ -f "$CFG" ]; then sed -i "/^ *- $3\\$/d" "$CFG"; fi
exit 0
"""

SYSTEMCTL_SHIM = """#!/usr/bin/env bash
echo "systemctl $*" >> "$HP_SHIM_LOG"
STATE="$HP_SHIM_STATE"
args="$*"
case "$args" in
  *"is-active"*agent-room-bridge*) [ -f "$STATE/legacy_active" ] && exit 0 || exit 3 ;;
  *"disable --now agent-room-bridge"*) rm -f "$STATE/legacy_active"; exit 0 ;;
  *"enable --now agent-room-bridge"*) touch "$STATE/legacy_active"; exit 0 ;;
  *"is-active"*) exit 3 ;;
esac
exit 0
"""


class Health:
    """Stands in for the Hermes API server: only /health."""

    def __init__(self):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200 if self.path == "/health" else 404)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


mock = MockPlatform()
health = None


def setUpModule():
    global health
    mock.start()
    health = Health()


def tearDownModule():
    mock.stop()
    health.stop()


def snapshot(root: Path, skip=("backups",)) -> dict:
    """{relative path: bytes} of every file under root (symlinks and empty folders are ignored)."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if rel.parts and (rel.parts[0] in skip or "backups" in rel.parts):
            continue
        if p.is_file():
            out[str(rel)] = p.read_bytes()
    return out


class Fake:
    """One fake machine: HOME, HERMES_HOME, shims and a way to run the scripts."""

    def __init__(self, case: unittest.TestCase, legacy=True, telegram=True):
        self.base = Path(tempfile.mkdtemp(prefix="hp-inst-"))
        case.addCleanup(shutil.rmtree, self.base, True)
        self.home = self.base / "home"
        self.h = self.home / ".hermes"
        self.bin = self.base / "bin"
        self.state = self.base / "state"
        self.log = self.base / "shim.log"
        self.unit_dir = self.home / ".config" / "systemd" / "user"
        for d in (self.h, self.bin, self.state, self.unit_dir):
            d.mkdir(parents=True)
        self.log.write_text("")
        for name, body in (("hermes", HERMES_SHIM), ("systemctl", SYSTEMCTL_SHIM)):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        env_lines = ["OPENROUTER_API_KEY=fake-openrouter-key", "OTHER_VAR=keepme", f"API_SERVER_PORT={health.port}"]
        yaml = ["model: fake-model", "plugins:", "  enabled:", "    - agent-room", "    - some-other-plugin", "platforms:"]
        if telegram:
            env_lines += [f"TELEGRAM_BOT_TOKEN={TG_TOKEN}", "TELEGRAM_ALLOWED_USERS=12345"]
            yaml += ["  telegram:", "    enabled: true", f"    bot_token: {TG_TOKEN}", "    home_channel: 12345  # keep me"]
        yaml += ["  discord:", "    enabled: false"]
        (self.h / ".env").write_text("\n".join(env_lines) + "\n")
        (self.h / ".env").chmod(0o600)
        (self.h / "config.yaml").write_text("\n".join(yaml) + "\n")
        (self.h / "skills" / "sdlc-ba").mkdir(parents=True)
        (self.h / "skills" / "sdlc-ba" / "SKILL.md").write_text("OLD BA SKILL\n")
        (self.h / "skills" / "software" / "sdlc-qa").mkdir(parents=True)
        (self.h / "skills" / "software" / "sdlc-qa" / "SKILL.md").write_text("OLD NESTED QA\n")
        (self.h / "skills" / "keep-me").mkdir(parents=True)
        (self.h / "skills" / "keep-me" / "SKILL.md").write_text("unrelated\n")
        (self.h / "plugins" / "agent-room").mkdir(parents=True)
        (self.h / "plugins" / "agent-room" / "__init__.py").write_text("# legacy plugin\n")
        (self.h / "agent-room").mkdir()
        (self.h / "agent-room" / "config.json").write_text(json.dumps({"supabase_url": "https://old.example.supabase.co", "supabase_key": "old-public", "write_key": "old-write"}))
        if legacy:
            (self.unit_dir / "agent-room-bridge.service").write_text("[Service]\nExecStart=/bin/true\n")
            (self.state / "legacy_active").write_text("")

    def env(self, **extra) -> dict:
        e = {k: v for k, v in os.environ.items() if not k.startswith(("HERMES_", "HP_"))}
        e.update(HOME=str(self.home), HERMES_HOME=str(self.h), PATH=f"{self.bin}:{os.environ['PATH']}", XDG_RUNTIME_DIR=str(self.base / "run"),
                 HP_SHIM_LOG=str(self.log), HP_SHIM_STATE=str(self.state), HERMES_PLATFORM_VERIFY_WAIT="0")
        e.pop("XDG_CONFIG_HOME", None)
        e.update(extra)
        return e

    def args(self, *more, key=WRITE):
        return ["--supabase-url", mock.url, "--supabase-key", KEY, "--write-key", key, *more]

    def run(self, script=INSTALL, *args, env=None, timeout=120):
        return subprocess.run(["bash", str(script), *args], env=env or self.env(), capture_output=True, text=True, timeout=timeout)

    def install(self, *more, key=WRITE, **kw):
        return self.run(INSTALL, *self.args(*more, key=key), **kw)

    def shim_calls(self) -> list:
        return [l for l in self.log.read_text().splitlines() if l]

    def backups(self) -> list:
        d = self.h / "backups"
        return sorted(p for p in d.iterdir()) if d.exists() else []

    def tree(self) -> dict:
        """everything under HOME except backups and the installer's own files, so before/after rollback can be compared."""
        return snapshot(self.home)


class InstallTests(unittest.TestCase):
    def setUp(self):
        mock.reset()

    def test_dry_run_changes_nothing_and_says_what_it_would_do(self):
        f = Fake(self)
        before = snapshot(f.base)
        r = f.install("--dry-run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(snapshot(f.base, skip=("shim.log",)), {k: v for k, v in before.items() if k != "shim.log"})
        self.assertFalse((f.h / "backups").exists(), "a dry run must not create a backup folder")
        self.assertIn("DRY RUN", r.stdout)
        self.assertIn("TELEGRAM_BOT_TOKEN", r.stdout)
        self.assertIn("would install skill sdlc-ba", r.stdout)
        calls = " ".join(f.shim_calls())
        for verb in ("daemon-reload", "enable", "disable", "restart", "plugins", "gateway"):
            self.assertNotIn(verb, calls, f"dry run must not run: {verb}")
        self.assertEqual(mock.calls, [], "a dry run must not call Supabase")
        self.assertNotIn(TG_TOKEN, r.stdout + r.stderr)
        self.assertNotIn(WRITE, r.stdout + r.stderr)

    def test_install_does_everything_and_prints_no_secret(self):
        f = Fake(self)
        r = f.install()
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        for secret in (WRITE, TG_TOKEN, "fake-openrouter-key"):
            self.assertNotIn(secret, out)
        # skills
        for s in SKILLS:
            self.assertEqual((f.h / "skills" / s / "SKILL.md").read_bytes(), (ROOT / "skills" / s / "SKILL.md").read_bytes(), s)
        self.assertTrue((f.h / "skills" / "keep-me" / "SKILL.md").exists(), "unrelated skills are not touched")
        self.assertFalse((f.h / "skills" / "software" / "sdlc-qa").exists(), "a second copy of a skill name is moved away")
        # plugin and bridge
        for name in ("__init__.py", "plugin.yaml"):
            self.assertEqual((f.h / "plugins" / "hermes-platform" / name).read_bytes(), (ROOT / "plugin" / "hermes-platform" / name).read_bytes())
        self.assertEqual((f.h / "platform" / "platform_bridge.py").read_bytes(), (ROOT / "bridge" / "platform_bridge.py").read_bytes())
        self.assertTrue((f.h / "plugins" / "agent-room" / "__init__.py").exists(), "legacy plugin files are kept")
        # config.json
        cfg = json.loads((f.h / "platform" / "config.json").read_text())
        self.assertEqual((cfg["supabase_url"], cfg["supabase_key"], cfg["write_key"]), (mock.url, KEY, WRITE))
        self.assertEqual(oct((f.h / "platform" / "config.json").stat().st_mode & 0o777), "0o600")
        # .env: telegram off, API server on, rest kept
        env = (f.h / ".env").read_text()
        self.assertNotIn("TELEGRAM_BOT_TOKEN=", env)
        self.assertNotIn("TELEGRAM_ALLOWED_USERS=", env)
        self.assertIn("OTHER_VAR=keepme", env)
        self.assertIn("OPENROUTER_API_KEY=fake-openrouter-key", env)
        self.assertIn("API_SERVER_ENABLED=true", env)
        self.assertRegex(env, r"(?m)^API_SERVER_KEY=\S{20,}$")
        self.assertEqual(oct((f.h / ".env").stat().st_mode & 0o777), "0o600")
        # config.yaml: telegram off, token blanked, comment and others kept
        y = (f.h / "config.yaml").read_text()
        self.assertIn("    enabled: false", y)
        self.assertNotIn(TG_TOKEN, y)
        self.assertIn('bot_token: ""', y)
        self.assertIn("home_channel: 12345  # keep me", y)
        self.assertIn("discord:", y)
        self.assertIn("model: fake-model", y)
        # systemd unit
        unit = (f.unit_dir / "hermes-platform-bridge.service").read_text()
        self.assertIn(f"Environment=HERMES_HOME={f.h}", unit)
        self.assertIn(f"ExecStart=/usr/bin/env python3 {f.h}/platform/platform_bridge.py", unit)
        self.assertIn("Restart=always", unit)
        # what ran
        calls = f.shim_calls()
        self.assertIn("hermes plugins enable hermes-platform", calls)
        self.assertIn("hermes plugins disable agent-room", calls)
        self.assertIn("hermes gateway restart", calls)
        self.assertIn("systemctl --user enable hermes-platform-bridge.service", calls)
        self.assertIn("systemctl --user restart hermes-platform-bridge.service", calls)
        self.assertIn("systemctl --user disable --now agent-room-bridge.service", calls)
        self.assertFalse((f.state / "legacy_active").exists(), "the old bridge is stopped")
        self.assertLess(calls.index("hermes plugins enable hermes-platform"), calls.index("hermes gateway restart"))
        # the write key was checked with a harmless RPC and the bridge self check ran
        self.assertTrue(any(n == "platform_ingest" and a.get("events") == [] for n, a in mock.calls), mock.calls)
        self.assertIn("ok   Supabase accepted the write key", out)
        self.assertIn("ok   the Hermes API server answers", out)
        # backup holds the old files, with owner-only permissions
        self.assertEqual(len(f.backups()), 1)
        bk = f.backups()[0]
        self.assertEqual(oct(bk.stat().st_mode & 0o777), "0o700")
        self.assertIn(TG_TOKEN, (bk / "files" / str(f.h).lstrip("/") / ".env").read_text())
        self.assertEqual((bk / "files" / str(f.h).lstrip("/") / "skills" / "sdlc-ba" / "SKILL.md").read_text(), "OLD BA SKILL\n")
        # the summary says what changed
        self.assertIn("Hermes Platform v2 installer summary", out)
        self.assertIn("TELEGRAM_BOT_TOKEN", out)
        self.assertIn("telegram.enabled", out)
        self.assertIn("--rollback", out)
        self.assertIn(str(bk), out)

    def test_running_it_twice_changes_nothing_the_second_time(self):
        f = Fake(self)
        self.assertEqual(f.install().returncode, 0)
        after_first = f.tree()
        r = f.install()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Nothing needed changing", r.stdout)
        self.assertEqual(len(f.backups()), 1, "a second run with no change makes no new backup")
        self.assertEqual(f.tree(), after_first)

    def test_a_wrong_write_key_stops_before_any_change(self):
        f = Fake(self)
        before = snapshot(f.base)
        r = f.install(key="not-the-key")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("write key check failed", r.stderr)
        self.assertIn("write key is wrong", r.stdout)
        self.assertEqual(snapshot(f.base, skip=("shim.log",)), {k: v for k, v in before.items() if k != "shim.log"})
        self.assertNotIn("not-the-key", r.stdout + r.stderr)

    def test_missing_or_bad_settings_are_explained(self):
        f = Fake(self)
        r = f.run(INSTALL, "--supabase-url", mock.url)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Missing --supabase-key", r.stderr)
        r = f.run(INSTALL, "--supabase-url", "http://example.com", "--supabase-key", KEY, "--write-key", WRITE)
        self.assertEqual(r.returncode, 1)
        self.assertIn("must start with https://", r.stderr)
        r = f.run(INSTALL, "--bogus")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Unknown option", r.stderr)
        r = f.run(INSTALL, "--supabase-url", mock.url, "--supabase-key", KEY, "--write-key", "a b")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(f.backups(), [])

    def test_rollback_puts_every_file_back(self):
        f = Fake(self)
        before = f.tree()
        self.assertEqual(f.install().returncode, 0)
        self.assertNotEqual(f.tree(), before)
        r = f.run(INSTALL, "--rollback")
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertEqual(f.tree(), before, "after rollback the files are exactly as before")
        self.assertTrue((f.state / "legacy_active").exists(), "the old bridge is started again")
        calls = f.shim_calls()
        self.assertIn("hermes plugins enable agent-room", calls)
        self.assertIn("hermes plugins disable hermes-platform", calls)
        self.assertIn("systemctl --user disable --now hermes-platform-bridge.service", calls)
        self.assertEqual(calls[-1], "hermes gateway restart")
        self.assertEqual([p.name.endswith(".rolled-back") for p in f.backups()], [True])
        self.assertNotIn(TG_TOKEN, out)
        r = f.run(INSTALL, "--rollback")
        self.assertEqual(r.returncode, 1)
        self.assertIn("No backup found", r.stderr)

    def test_uninstall_is_the_same_as_rollback_and_works_from_the_saved_copy(self):
        f = Fake(self)
        before = f.tree()
        self.assertEqual(f.install().returncode, 0)
        saved = f.h / "platform" / "install_v2.sh"
        self.assertTrue(saved.exists(), "a copy of the installer is kept so --rollback works after the download is gone")
        r = f.run(saved, "--uninstall")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(f.tree(), before)

    def test_rollback_dry_run_changes_nothing(self):
        f = Fake(self)
        self.assertEqual(f.install().returncode, 0)
        installed = f.tree()
        n = len(f.shim_calls())
        r = f.run(INSTALL, "--rollback", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("would restore", r.stdout)
        self.assertEqual(f.tree(), installed)
        self.assertEqual([p.name.endswith(".rolled-back") for p in f.backups()], [False])
        self.assertFalse(any("enable" in c or "disable" in c or "restart" in c for c in f.shim_calls()[n:]))

    def test_update_backs_up_only_what_changes_and_rollback_goes_one_step_back(self):
        f = Fake(self)
        self.assertEqual(f.install().returncode, 0)
        first = f.tree()
        # a new package version: copy the package, change the bridge
        pkg = f.base / "pkg2"
        shutil.copytree(ROOT, pkg, ignore=shutil.ignore_patterns("__pycache__", "tests", "tools"))
        (pkg / "bridge" / "platform_bridge.py").write_text((ROOT / "bridge" / "platform_bridge.py").read_text() + "\n# v2.1\n")
        r = f.run(pkg / "install" / "install_v2.sh", *f.args())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(f.backups()), 2)
        newest = f.backups()[-1]
        manifest = (newest / "MANIFEST.tsv").read_text()
        self.assertIn("platform_bridge.py", manifest)
        self.assertNotIn("skills", manifest)
        self.assertIn("# v2.1", (f.h / "platform" / "platform_bridge.py").read_text())
        r = f.run(INSTALL, "--rollback")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(f.tree(), first)
        self.assertNotIn("legacy", " ".join(c for c in f.shim_calls()[-4:] if "agent-room" in c))

    def test_flags_keep_telegram_and_keep_legacy(self):
        f = Fake(self)
        r = f.install("--keep-telegram", "--keep-legacy")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("TELEGRAM_BOT_TOKEN=" + TG_TOKEN, (f.h / ".env").read_text())
        self.assertIn("enabled: true", (f.h / "config.yaml").read_text())
        self.assertTrue((f.state / "legacy_active").exists())
        self.assertNotIn("hermes plugins disable agent-room", f.shim_calls())
        self.assertIn("hermes plugins enable hermes-platform", f.shim_calls())

    def test_mirror_legacy_writes_the_old_settings_into_config_json(self):
        f = Fake(self)
        r = f.install("--mirror-legacy")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        cfg = json.loads((f.h / "platform" / "config.json").read_text())
        self.assertEqual(cfg["legacy"], {"supabase_url": "https://old.example.supabase.co", "supabase_key": "old-public", "write_key": "old-write"})
        self.assertNotIn("old-write", r.stdout + r.stderr)

    def test_github_owner_and_template_go_to_config_json_and_a_rerun_keeps_them(self):
        f = Fake(self)
        self.assertEqual(f.install("--github-owner", "my-org", "--template-repo", "my-org/template").returncode, 0)
        cfg = json.loads((f.h / "platform" / "config.json").read_text())
        self.assertEqual((cfg["github_owner"], cfg["template_repo"]), ("my-org", "my-org/template"))
        # re-run without the settings: they are read from config.json, so the run still works and changes nothing
        r = f.run(INSTALL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Nothing needed changing", r.stdout)

    def test_without_hermes_or_systemd_it_still_copies_files_and_tells_what_to_do(self):
        f = Fake(self, legacy=False)
        (f.bin / "hermes").unlink()
        (f.bin / "systemctl").unlink()
        # keep python, bash and the usual tools but no hermes/systemctl on the PATH
        r = f.install(env=f.env(PATH=f"{f.bin}:/usr/bin:/bin"))
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 3 if "FAIL the Hermes API" in out else 0, out)
        self.assertIn("hermes command not found", out)
        self.assertIn("systemd user services are not reachable", out)
        self.assertTrue((f.h / "plugins" / "hermes-platform" / "__init__.py").exists())
        self.assertTrue((f.h / "platform" / "config.json").exists())

    def test_a_failing_gateway_restart_is_a_warning_not_a_crash(self):
        f = Fake(self)
        r = f.install(env=f.env(HP_SHIM_FAIL="gateway restart"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("hermes gateway restart failed", r.stdout)

    def test_self_check_failure_gives_exit_3_and_keeps_the_files(self):
        f = Fake(self)
        env = (f.h / ".env").read_text().replace(f"API_SERVER_PORT={health.port}", "API_SERVER_PORT=9")
        (f.h / ".env").write_text(env)
        r = f.install()
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("FAIL the Hermes API server", r.stdout)
        self.assertTrue((f.h / "platform" / "platform_bridge.py").exists())

    def test_no_telegram_in_the_files_is_fine(self):
        f = Fake(self, telegram=False)
        r = f.install()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("no TELEGRAM variables found", r.stdout)

    def test_fresh_machine_with_no_hermes_files_at_all(self):
        f = Fake(self, legacy=False)
        shutil.rmtree(f.h)
        r = f.install()
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)  # no API server to answer the self check
        self.assertTrue((f.h / "skills" / "sdlc-ba" / "SKILL.md").exists())
        self.assertTrue((f.h / ".env").exists())
        self.assertIn("API_SERVER_ENABLED=true", (f.h / ".env").read_text())
        rr = f.run(INSTALL, "--rollback")
        self.assertEqual(rr.returncode, 0, rr.stdout + rr.stderr)
        self.assertFalse((f.h / ".env").exists())
        self.assertFalse((f.h / "skills" / "sdlc-ba").exists())

    def test_rollback_refuses_a_damaged_backup_that_points_outside(self):
        f = Fake(self)
        self.assertEqual(f.install().returncode, 0)
        bk = f.backups()[0]
        (bk / "MANIFEST.tsv").write_text("new\t/etc/passwd\n")
        r = f.run(INSTALL, "--rollback")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Refusing to touch /etc/passwd", r.stderr)


class GetScriptTests(unittest.TestCase):
    def setUp(self):
        mock.reset()
        self.pkg = Path(tempfile.mkdtemp(prefix="hp-pkg-"))
        self.addCleanup(shutil.rmtree, self.pkg, True)
        subprocess.run(["node", str(REPO / "apps" / "web" / "scripts" / "build-pkg.mjs"), "--out", str(self.pkg), "--base", f"file://{self.pkg}"],
                       check=True, capture_output=True, text=True, cwd=REPO)

    def test_download_check_and_install(self):
        f = Fake(self)
        r = f.run(self.pkg / "get_v2.sh", *f.args())
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("Files OK", out)
        self.assertTrue((f.h / "skills" / "sdlc-release" / "SKILL.md").exists())
        self.assertEqual(hashlib.sha256((f.h / "platform" / "platform_bridge.py").read_bytes()).hexdigest(),
                         hashlib.sha256((ROOT / "bridge" / "platform_bridge.py").read_bytes()).hexdigest())
        self.assertTrue((f.h / "platform" / "install_v2.sh").exists())
        r2 = f.run(f.h / "platform" / "install_v2.sh", "--rollback")  # the download folder is long gone
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)

    def test_a_changed_file_is_refused_and_nothing_is_installed(self):
        f = Fake(self)
        (self.pkg / "bridge" / "platform_bridge.py").write_text("print('evil')\n")
        before = snapshot(f.base)
        r = f.run(self.pkg / "get_v2.sh", *f.args())
        self.assertEqual(r.returncode, 1)
        self.assertIn("does not match SHA256SUMS", r.stderr)
        self.assertEqual(snapshot(f.base), before)

    def test_odd_file_names_in_the_list_are_refused(self):
        f = Fake(self)
        sums = self.pkg / "SHA256SUMS"
        sums.write_text(sums.read_text() + f"{'0' * 64}  ../../etc/passwd\n")
        r = f.run(self.pkg / "get_v2.sh", *f.args())
        self.assertEqual(r.returncode, 1)
        self.assertIn("suspicious file name", r.stderr)

    def test_the_repo_copy_without_a_website_address_explains_itself(self):
        f = Fake(self)
        r = f.run(GET, *f.args(), env=f.env())
        self.assertEqual(r.returncode, 1)
        self.assertIn("HERMES_PLATFORM_BASE", r.stderr)
        r = f.run(GET, "--dry-run", *f.args(), env=f.env(HERMES_PLATFORM_BASE=f"file://{self.pkg}"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("DRY RUN", r.stdout)


class EditConfigTests(unittest.TestCase):
    def tmp(self, text: str, name="f", crlf=False) -> Path:
        d = Path(tempfile.mkdtemp(prefix="hp-edit-"))
        self.addCleanup(shutil.rmtree, d, True)
        p = d / name
        p.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode())
        return p

    def run_cmd(self, cmd, path, dry=False):
        r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), cmd, "--file", str(path)] + (["--dry-run"] if dry else []),
                           capture_output=True, text=True, env={**os.environ, "HP_URL": "", "HP_KEY": "", "HP_WRITE": ""})
        return r

    def test_env_telegram_handles_export_prefix_spaces_comments_and_crlf(self):
        p = self.tmp("# TELEGRAM_BOT_TOKEN=commented\nexport TELEGRAM_BOT_TOKEN = abc\nA=1\nTELEGRAM_HOME_CHANNEL=\"x y\"\nNOT_TELEGRAM=2\n", crlf=True)
        r = self.run_cmd("env-telegram", p)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("RESULT changed", r.stdout)
        text = p.read_bytes().decode()
        self.assertIn("\r\n", text)
        self.assertNotIn("abc", text)
        self.assertNotIn("x y", text)
        self.assertIn("A=1", text)
        self.assertIn("NOT_TELEGRAM=2", text)
        self.assertIn("# TELEGRAM_BOT_TOKEN=commented", text)
        self.assertNotIn("abc", r.stdout)

    def test_dry_run_never_writes(self):
        p = self.tmp("TELEGRAM_BOT_TOKEN=abc\n")
        r = self.run_cmd("env-telegram", p, dry=True)
        self.assertIn("RESULT changed", r.stdout)
        self.assertEqual(p.read_text(), "TELEGRAM_BOT_TOKEN=abc\n")

    def test_env_api_keeps_an_existing_key_and_fixes_a_false_flag(self):
        p = self.tmp("API_SERVER_ENABLED=false\nAPI_SERVER_KEY=mine-123\nAPI_SERVER_ENABLED=false\nX=1\n")
        r = self.run_cmd("env-api", p)
        self.assertIn("RESULT changed", r.stdout)
        text = p.read_text()
        self.assertEqual(text.count("API_SERVER_ENABLED"), 1)
        self.assertIn("API_SERVER_ENABLED=true", text)
        self.assertIn("API_SERVER_KEY=mine-123", text)
        r = self.run_cmd("env-api", p)
        self.assertIn("RESULT unchanged", r.stdout)

    def test_env_api_creates_the_file_with_a_random_key_and_mode_600(self):
        d = Path(tempfile.mkdtemp(prefix="hp-edit-"))
        self.addCleanup(shutil.rmtree, d, True)
        p = d / "sub" / ".env"
        r = self.run_cmd("env-api", p)
        self.assertIn("RESULT changed", r.stdout)
        self.assertEqual(oct(p.stat().st_mode & 0o777), "0o600")
        key = [l for l in p.read_text().splitlines() if l.startswith("API_SERVER_KEY=")][0].split("=", 1)[1]
        self.assertGreaterEqual(len(key), 30)
        self.assertNotIn(key, r.stdout)

    YAML_CASES = [
        ("block", "telegram:\n  enabled: true\n  token: abc\n  chat: 1\nother: 1\n", ["enabled: false", 'token: ""', "chat: 1", "other: 1"], ["abc"]),
        ("already off", "telegram:\n  enabled: false\n", ["enabled: false"], []),
        ("no enabled key", "telegram:\n  bot_token: abc\n", ["enabled: false", 'bot_token: ""'], ["abc"]),
        ("flow style", "telegram: {enabled: true, token: abc}\nx: 1\n", ["telegram: {enabled: false}", "x: 1"], ["abc"]),
        ("env reference kept", "telegram:\n  enabled: yes\n  token: ${TELEGRAM_BOT_TOKEN}\n", ["enabled: false", "token: ${TELEGRAM_BOT_TOKEN}"], []),
        ("empty section", "telegram:\nnext: 1\n", ["enabled: false", "next: 1"], []),
        ("comment kept", "telegram:\n  enabled: true  # on\n", ["enabled: false  # on"], []),
    ]

    def test_yaml_telegram_cases(self):
        for name, text, must, must_not in self.YAML_CASES:
            with self.subTest(name):
                p = self.tmp(text, "config.yaml")
                r = self.run_cmd("yaml-telegram", p)
                self.assertEqual(r.returncode, 0, r.stderr)
                out = p.read_text()
                for m in must:
                    self.assertIn(m, out)
                for m in must_not:
                    self.assertNotIn(m, out)
                self.assertNotIn("abc", r.stdout)
                again = self.run_cmd("yaml-telegram", p)
                self.assertIn("RESULT unchanged", again.stdout, "a second run changes nothing")

    def test_config_json_merges_and_keeps_unknown_keys(self):
        p = self.tmp(json.dumps({"poll_seconds": 5, "write_key": "old"}), "config.json")
        env = {**os.environ, "HP_URL": "https://x.supabase.co", "HP_KEY": "pub", "HP_WRITE": "new-write"}
        r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), "config-json", "--file", str(p)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("RESULT changed", r.stdout)
        self.assertNotIn("new-write", r.stdout)
        data = json.loads(p.read_text())
        self.assertEqual(data, {"poll_seconds": 5, "write_key": "new-write", "supabase_url": "https://x.supabase.co", "supabase_key": "pub"})
        self.assertEqual(oct(p.stat().st_mode & 0o777), "0o600")
        r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), "config-json", "--file", str(p)], capture_output=True, text=True, env=env)
        self.assertIn("RESULT unchanged", r.stdout)

    def test_config_json_refuses_a_broken_file(self):
        p = self.tmp("{not json", "config.json")
        r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), "config-json", "--file", str(p)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("not valid JSON", r.stderr)
        self.assertEqual(p.read_text(), "{not json")

    def test_verify_key_messages(self):
        for key, code, text in ((WRITE, 0, "accepted"), ("bad", 1, "write key is wrong")):
            r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), "verify-key"], capture_output=True, text=True,
                               env={**os.environ, "HP_URL": mock.url, "HP_KEY": KEY, "HP_WRITE": key})
            self.assertEqual(r.returncode, code, r.stdout)
            self.assertIn(text, r.stdout)
        r = subprocess.run([sys.executable, str(ROOT / "install" / "edit_config.py"), "verify-key"], capture_output=True, text=True,
                           env={**os.environ, "HP_URL": "http://127.0.0.1:9", "HP_KEY": KEY, "HP_WRITE": WRITE})
        self.assertEqual(r.returncode, 1)
        self.assertIn("could not reach Supabase", r.stdout)


if __name__ == "__main__":
    unittest.main()
