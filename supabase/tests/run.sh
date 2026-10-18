#!/usr/bin/env bash
# Runs the SQL migrations and SQL tests against a throwaway local PostgreSQL cluster.
#   supabase/tests/run.sh            # all tests
#   KEEP=1 supabase/tests/run.sh     # keep the cluster directory (prints its path)
# Needs the PostgreSQL server binaries (initdb, pg_ctl, psql). Works as root (uses the "postgres" OS user) or as a normal user.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"

BIN=""
for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin; do
  [ -x "$d/initdb" ] && BIN="$d"
done
if [ -z "$BIN" ] && command -v initdb >/dev/null; then BIN="$(dirname "$(command -v initdb)")"; fi
[ -n "$BIN" ] || { echo "PostgreSQL server binaries not found (need initdb, pg_ctl, psql)." >&2; exit 2; }

DIR="$(mktemp -d /tmp/hermes-pg.XXXXXX)"
RUN=()
if [ "$(id -u)" = "0" ]; then
  chown postgres:postgres "$DIR"
  chmod 755 "$HERE" "$HERE/.." 2>/dev/null || true
  RUN=(runuser -u postgres --)
fi

cleanup() {
  "${RUN[@]}" "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
  if [ -z "${KEEP:-}" ]; then rm -rf "$DIR"; else echo "Kept $DIR"; fi
}
trap cleanup EXIT

"${RUN[@]}" "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
PORT=$(( 20000 + RANDOM % 20000 ))
"${RUN[@]}" "$BIN/pg_ctl" -D "$DIR/data" -w -l "$DIR/pg.log" \
  -o "-p $PORT -c listen_addresses='' -c unix_socket_directories=$DIR -c fsync=off -c synchronous_commit=off" start >/dev/null

psqlx() { "$BIN/psql" -h "$DIR" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
"$BIN/createdb" -h "$DIR" -p "$PORT" -U postgres hermes_test
# Same default search_path as a Supabase database (so citext operators resolve in plain SQL)
psqlx -d hermes_test -c "alter database hermes_test set search_path = \"\$user\", public, extensions"

OUT="$DIR/out.txt"
: > "$OUT"
run_file() {
  echo "-- $(basename "$1")" >> "$OUT"
  PGOPTIONS="${2:--c client_min_messages=notice}" psqlx -d hermes_test -f "$1" >> "$OUT" 2>&1 \
    || { cat "$OUT"; echo "ERROR while running $1" >&2; exit 1; }
}
QUIET="-c client_min_messages=warning"

run_file "$HERE/00_stub_supabase.sql" "$QUIET"
run_file "$HERE/01_helpers.sql" "$QUIET"
for f in "$MIGRATIONS"/*.sql; do run_file "$f" "$QUIET"; done
# Idempotency: apply every migration a second time.
for f in "$MIGRATIONS"/*.sql; do run_file "$f" "$QUIET"; done
run_file "$HERE/02_fixtures.sql" "$QUIET"
for f in "$HERE"/[1-9]*_*.sql; do run_file "$f"; done

grep -E '^(psql:.*)?(ok   -|FAIL -|-- )' "$OUT" | sed -E 's/^psql:[^ ]+ NOTICE:  //' || true
PASS=$(grep -cE 'NOTICE:  ok   -' "$OUT" || true)
FAIL=$(grep -cE 'NOTICE:  FAIL -' "$OUT" || true)
echo
echo "SQL TESTS: $PASS passed, $FAIL failed (migrations applied twice without error)"
[ "$FAIL" = "0" ] && [ "$PASS" -gt 0 ]
