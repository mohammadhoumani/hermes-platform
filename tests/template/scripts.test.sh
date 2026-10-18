#!/usr/bin/env bash
# Runs the template scripts against fake `gh` and `vercel` programs. No network, no real GitHub or Vercel.
#   bash tests/template/scripts.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$ROOT/template/scripts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"
export FAKE_LOG="$TMP/calls.log"

# ---- fake gh: logs its arguments, saves stdin / body files, answers like the real one would ----
cat > "$BIN/gh" <<'SHIM'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = "--input" ]; then cat > "$FAKE_LOG.stdin"; fi
  if [ "${!i}" = "--body-file" ]; then j=$((i + 1)); cp "${!j}" "$FAKE_LOG.body"; fi
done
if [ -n "${FAKE_GH_FAIL:-}" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi
case "$1 $2" in
  "repo view") echo "acme/calc" ;;
  "issue list") ;;
  "issue create") echo "https://github.com/acme/calc/issues/7" ;;
  "api repos/acme/calc/commits/"*) echo "${FAKE_CHECK_RESULT:-success}" ;;
esac
exit 0
SHIM

# ---- fake vercel: prints a site address like the real CLI ----
cat > "$BIN/vercel" <<'SHIM'
#!/usr/bin/env bash
echo "vercel $*" >> "$FAKE_LOG"
case "$1" in
  deploy) echo "Inspect: https://vercel.com/acme/calc/abc" >&2; echo "https://calc-abc123-acme.vercel.app" ;;
  inspect) printf 'Aliases\n  https://calc-abc123-acme.vercel.app\n  https://calc.vercel.app\n  https://vercel.com/acme\n' ;;
esac
SHIM
chmod +x "$BIN/gh" "$BIN/vercel"
export PATH="$BIN:$PATH"

pass=0
fail=0
check() { # check "name" command...
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "ok   - $name"; else fail=$((fail + 1)); echo "FAIL - $name"; fi
}
calls() { cat "$FAKE_LOG" 2>/dev/null || true; }
reset() { rm -f "$FAKE_LOG" "$FAKE_LOG.stdin" "$FAKE_LOG.body"; }
has() { grep -qF -- "$1" "$2"; }
lacks() { ! grep -qF -- "$1" "$2"; }

# ================= protect-main.sh =================
reset
out="$("$S/protect-main.sh" --dry-run --repo acme/calc 2>&1)"
check "protect-main dry run prints the endpoint" grep -q "PUT repos/acme/calc/branches/main/protection" <<< "$out"
check "protect-main dry run prints the required checks" grep -q '"build-test", "secret-scan", "dep-audit"' <<< "$out"
check "protect-main dry run does not call gh" test ! -e "$FAKE_LOG"

reset
check "protect-main sends the rules" "$S/protect-main.sh" --repo acme/calc
check "  it calls gh api PUT on the branch" has "gh api --method PUT -H Accept: application/vnd.github+json repos/acme/calc/branches/main/protection --input -" "$FAKE_LOG"
cp "$FAKE_LOG.stdin" "$TMP/body1.json"
rules_ok() {
  python3 - "$TMP/body1.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
assert b["required_status_checks"]["contexts"] == ["build-test", "secret-scan", "dep-audit"]
assert b["allow_force_pushes"] is False and b["allow_deletions"] is False
assert b["enforce_admins"] is True
assert b["required_pull_request_reviews"]["required_approving_review_count"] == 0
assert b["required_linear_history"] is True and b["restrictions"] is None
PY
}
check "  the body is valid JSON with the expected rules" rules_ok
"$S/protect-main.sh" --repo acme/calc >/dev/null 2>&1
check "  running it again sends the same body (idempotent)" cmp -s "$TMP/body1.json" "$FAKE_LOG.stdin"

reset
"$S/protect-main.sh" --repo acme/calc --branch develop --checks "a, b" --no-enforce-admins >/dev/null 2>&1
check "protect-main options: branch" has "repos/acme/calc/branches/develop/protection" "$FAKE_LOG"
check "protect-main options: checks and enforce_admins" grep -q '"contexts": \["a", "b"\]' "$FAKE_LOG.stdin"
check "protect-main options: enforce_admins false" grep -q '"enforce_admins": false' "$FAKE_LOG.stdin"

reset
check "protect-main finds the repo through gh when there is no remote" bash -c "cd '$TMP' && '$S/protect-main.sh'"
check "  and uses it" has "repos/acme/calc/branches/main/protection" "$FAKE_LOG"
check "protect-main rejects a bad check name" bash -c "! '$S/protect-main.sh' --dry-run --repo a/b --checks 'x\";y'"
check "protect-main rejects a bad repo name" bash -c "! '$S/protect-main.sh' --repo 'a b'"
check "protect-main rejects an unknown option" bash -c "! '$S/protect-main.sh' --nope"
FAKE_GH_FAIL="HTTP 403: Upgrade to GitHub Pro or make this repository public" "$S/protect-main.sh" --repo acme/calc >"$TMP/err.txt" 2>&1
rc=$?
check "protect-main fails with a clear hint when GitHub refuses" bash -c "[ $rc -eq 1 ] && grep -q 'private repository of a free account' '$TMP/err.txt'"

# ================= setup-repo.sh =================
reset
"$S/setup-repo.sh" --dry-run --repo acme/calc >/dev/null 2>&1
check "setup-repo dry run does not call gh" test ! -e "$FAKE_LOG"
reset
check "setup-repo creates labels and the Team sync issue" "$S/setup-repo.sh" --repo acme/calc
check "  labels task, bug, sync" bash -c "grep -q 'label create task' '$FAKE_LOG' && grep -q 'label create bug' '$FAKE_LOG' && grep -q 'label create sync' '$FAKE_LOG'"
check "  issue created with the sync label" has "issue create --repo acme/calc --title Team sync --label sync" "$FAKE_LOG"
check "  issue body has no front matter" lacks "name: Team sync" "$FAKE_LOG.body"
check "  issue body has the comment format" has "BLOCKER|INTERFACE|READY" "$FAKE_LOG.body"

# ================= vercel-deploy.sh =================
export VERCEL_BIN="$BIN/vercel"
export VERCEL_TOKEN="vtest-not-real" VERCEL_ORG_ID="org_test" VERCEL_PROJECT_ID="prj_test" GITHUB_SHA="0123456789abcdef0123456789abcdef01234567"
reset
export GITHUB_OUTPUT="$TMP/gh_output"
: > "$GITHUB_OUTPUT"
url="$("$S/vercel-deploy.sh" staging 2>/dev/null | tail -n 1)"
check "vercel-deploy staging prints the address" test "$url" = "https://calc-abc123-acme.vercel.app"
check "  writes url= to GITHUB_OUTPUT" has "url=https://calc-abc123-acme.vercel.app" "$GITHUB_OUTPUT"
check "  uses the preview environment" has "pull --yes --environment=preview" "$FAKE_LOG"
check "  does not use --prod" lacks "--prod" "$FAKE_LOG"
check "  tags the deployment with the commit" has "githubCommitSha=$GITHUB_SHA" "$FAKE_LOG"

reset
url="$("$S/vercel-deploy.sh" production 2>/dev/null | tail -n 1)"
check "vercel-deploy production prefers the public alias" test "$url" = "https://calc.vercel.app"
check "  uses the production environment and --prod" bash -c "grep -q 'pull --yes --environment=production' '$FAKE_LOG' && grep -q 'build --prod' '$FAKE_LOG' && grep -q 'deploy --prebuilt --prod' '$FAKE_LOG'"
url="$(PRODUCTION_URL=https://shop.example.com "$S/vercel-deploy.sh" production 2>/dev/null | tail -n 1)"
check "  PRODUCTION_URL overrides the alias" test "$url" = "https://shop.example.com"

check "vercel-deploy stops when a secret is missing" bash -c "! VERCEL_TOKEN= '$S/vercel-deploy.sh' staging"
check "vercel-deploy rejects an unknown target" bash -c "! '$S/vercel-deploy.sh' moon"
unset GITHUB_OUTPUT

# ================= publish-url.sh =================
export GITHUB_STEP_SUMMARY="$TMP/summary.md"
: > "$GITHUB_STEP_SUMMARY"
reset
DRY_RUN=1 "$S/publish-url.sh" staging https://calc-abc123-acme.vercel.app >/dev/null 2>&1
check "publish-url writes the address to the job summary" has "https://calc-abc123-acme.vercel.app" "$GITHUB_STEP_SUMMARY"
check "  dry run does not call gh" test ! -e "$FAKE_LOG"
export GITHUB_REPOSITORY="acme/calc"
"$S/publish-url.sh" production https://calc.vercel.app >/dev/null 2>&1
check "publish-url sets the commit status" has "repos/acme/calc/statuses/$GITHUB_SHA -f state=success -f context=production-url -f target_url=https://calc.vercel.app" "$FAKE_LOG"
check "publish-url rejects a non-https address" bash -c "! DRY_RUN=1 '$S/publish-url.sh' staging http://x.test"
check "publish-url rejects an address with shell characters" bash -c "! DRY_RUN=1 '$S/publish-url.sh' staging 'https://x.test;rm'"

# ================= verify-release.sh =================
git_() { git -c user.name=t -c user.email=t@example.com "$@"; }
ORIGIN="$TMP/origin.git"
WORK="$TMP/work"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$WORK"
(
  cd "$WORK" || exit 1
  git remote add origin "$ORIGIN"
  mkdir docs
  printf 'QA result: passed\n\n| ID | Result |\n' > docs/QA.md
  git add . && git_ commit -q -m "qa passed" && git push -q origin main
) >/dev/null 2>&1
head_sha="$(git -C "$WORK" rev-parse HEAD)"
vr() { (cd "$WORK" && GITHUB_SHA="${1:-$head_sha}" SKIP_CI_CHECK="${2:-}" "$S/verify-release.sh"); }
check "verify-release passes: on main, QA passed, CI skipped" vr "$head_sha" 1
reset
check "verify-release passes with green CI" vr "$head_sha"
check "  it asked for each check" bash -c "grep -c 'check-runs' '$FAKE_LOG' | grep -qx 3"
check "verify-release blocks when a check is not green" bash -c "! FAKE_CHECK_RESULT=not-success bash -c \"cd '$WORK' && GITHUB_SHA=$head_sha '$S/verify-release.sh'\""
(
  cd "$WORK" || exit 1
  git checkout -q -b side
  echo x > side.txt && git add . && git_ commit -q -m side
) >/dev/null 2>&1
side_sha="$(git -C "$WORK" rev-parse HEAD)"
check "verify-release blocks a commit that is not on main" bash -c "! (cd '$WORK' && GITHUB_SHA=$side_sha SKIP_CI_CHECK=1 '$S/verify-release.sh')"
(
  cd "$WORK" || exit 1
  git checkout -q main
  printf 'QA result: failed\n' > docs/QA.md
  git add . && git_ commit -q -m "qa failed" && git push -q origin main
) >/dev/null 2>&1
failed_sha="$(git -C "$WORK" rev-parse HEAD)"
check "verify-release blocks when QA did not pass" bash -c "! (cd '$WORK' && GITHUB_SHA=$failed_sha SKIP_CI_CHECK=1 '$S/verify-release.sh')"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
