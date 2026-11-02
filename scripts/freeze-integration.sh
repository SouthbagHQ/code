#!/usr/bin/env bash
# Integration test: the account-level freeze on Code's real HTTP surface (website worker),
# against `wrangler dev` and a faithful local Identity fixture
# (test-fixtures/identity-fixture.mjs). The central status is checked fresh per request.
# Static assets and /auth/login stay reachable in every mode.
#
#   bash scripts/freeze-integration.sh          # KEEP=1 keeps the temp dir
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/packages/website"
PORT="${PORT:-8810}"
FIXTURE_PORT="${FIXTURE_PORT:-8811}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/southbag-code-freeze.XXXXXX")"
DEV_PID=""; FIXTURE_PID=""

cleanup() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true
  [ "${KEEP:-}" = 1 ] && echo "kept $TMP" || rm -rf "$TMP"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
ok() { printf '\033[32mok\033[0m %s\n' "$*"; }

WR=(npx --prefix "$WEB" wrangler)
start_fixture() { FIXTURE_SECRET=itsec node "$ROOT/test-fixtures/identity-fixture.mjs" "$FIXTURE_PORT" "$1" >"$TMP/fixture.log" 2>&1 & FIXTURE_PID=$!; sleep 0.3; }
stop_fixture() { [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true; FIXTURE_PID=""; }

step "session cookie (HMAC, same shape as seal() in src/worker.ts)"
node - "$TMP/cookie.txt" session <<'EOF'
import { writeFileSync } from 'node:fs';
const [,, out] = process.argv;
const secret = 'testsec';
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const user = { sub: 'dev-alice', email: 'alice@example.com', name: 'Alice' };
const kind = process.argv[3];
const body = b64u(JSON.stringify({ kind, exp: Date.now() + 3600e3, user }));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
writeFileSync(out, `${body}.${b64u(new Uint8Array(sig))}`);
EOF
node - "$TMP/access.txt" access <<'EOF'
import { writeFileSync } from 'node:fs';
const [,, out, kind] = process.argv;
const secret = 'testsec';
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const user = { sub: 'dev-alice', email: 'alice@example.com', name: 'Alice' };
const body = b64u(JSON.stringify({ kind, exp: Date.now() + 3600e3, user }));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
writeFileSync(out, `${body}.${b64u(new Uint8Array(sig))}`);
EOF
COOKIE="$(cat "$TMP/cookie.txt")"
ACCESS="$(cat "$TMP/access.txt")"

step "placeholder assets (astro's full site build needs the monorepo toolchain; the freeze"
# logic under test lives entirely in src/worker.ts, so a placeholder dist/ only stands in for
# the ASSETS binding's reachability check - it is not the real site HTML)
mkdir -p "$WEB/dist"
[ -f "$WEB/dist/index.html" ] || printf '<!doctype html><title>southbag code</title>' > "$WEB/dist/index.html"
mkdir -p "$WEB/dist/account"
[ -f "$WEB/dist/account/index.html" ] || printf '<!doctype html><title>account</title>' > "$WEB/dist/account/index.html"

step "code worker on :$PORT + identity fixture (active)"
start_fixture active
(cd "$WEB" && exec "${WR[@]}" dev --port "$PORT" \
  --var DEV_AUTH:true --var SESSION_SECRET:testsec --var IDENTITY_ORIGIN:http://127.0.0.1:$FIXTURE_PORT --var IDENTITY_INTERNAL_SECRET:itsec >"$TMP/dev.log" 2>&1) &
DEV_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/auth/login" && break
  sleep 1
  [ "$i" = 90 ] && fail "code worker did not start: $(tail -5 "$TMP/dev.log")"
done
ok "started"

# The cookie session covers the web routes; completions authenticate with a Bearer ACCESS token.
AUTH=(-H "Cookie: southbag_code_session=$COOKIE")
BEARER=(-H "Authorization: Bearer $ACCESS")
check() { # $1 label $2 completions status $3 usage status $4 account status
  local comp usage account static login
  comp=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BEARER[@]}" -H 'content-type: application/json' \
    -d '{"model":"southbag/standard","messages":[{"role":"user","content":"hi"}]}' "http://127.0.0.1:$PORT/v1/chat/completions")
  usage=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "http://127.0.0.1:$PORT/api/usage")
  account=$(curl -sL -o /dev/null -w '%{http_code}' "${AUTH[@]}" "http://127.0.0.1:$PORT/account")
  static=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
  login=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/auth/login")
  [ "$comp" = "$2" ] || fail "$1: completions $comp, want $2"
  [ "$usage" = "$3" ] || fail "$1: usage $usage, want $3"
  [ "$account" = "$4" ] || fail "$1: account $account, want $4"
  [ "$static" = 200 ] || fail "$1: static / $static, want 200 (always reachable)"
  case "$login" in 200|302) ;; *) fail "$1: /auth/login $login, want 200/302 (always reachable)";; esac
  ok "$1: completions=$2 usage=$3 account=$4 static=200 login=$login"
}

# Active completions get past the freeze to 503 'not configured' (no OPENROUTER_KEY locally) -
# that proves the request was authorized. Frozen must be 423 and unknown 503 BEFORE that point.
check "active" 503 200 200
stop_fixture; start_fixture frozen
check "frozen" 423 423 423
stop_fixture; start_fixture reject
check "secret rejected" 503 503 503
stop_fixture
check "identity down" 503 503 503
start_fixture active
check "active again (no stale cache)" 503 200 200

printf '\n\033[32mAll code freeze integration checks passed.\033[0m\n'
