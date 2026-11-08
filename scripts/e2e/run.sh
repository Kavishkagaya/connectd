#!/usr/bin/env bash
# connectd end to end, the way a developer uses it (docs: contributing/validation). The packed
# tarballs installed with npm into a new project and run on Node: init, add, dev, the SDK, keys,
# dashboard, restarts; then the Worker deploy generates, on wrangler dev (local Durable Objects and
# D1), with the keys a deploy derives. Nothing reaches Cloudflare or GitHub.
#
#   scripts/e2e/run.sh                       (from the repo; needs bun, node >= 22.5, npm)
#   PLAYWRIGHT=/path/to/playwright-core/index.mjs CHROME=/usr/bin/google-chrome scripts/e2e/run.sh
#                                            (adds the dashboard in a real browser)
#   KEEP=1 scripts/e2e/run.sh                (keeps the project to poke at; its path is printed)
#
# Ports: DEV_PORT (8791) and WORKER_PORT (8792). Exits non-zero on the first failed check.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$REPO/scripts/e2e"
DEV_PORT=${DEV_PORT:-8791}
WORKER_PORT=${WORKER_PORT:-8792}
DIR=$(mktemp -d "${TMPDIR:-/tmp}/connectd-e2e-XXXXXX")
PIDS=()

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
step() { echo; echo "== $*"; }
cleanup() {
  for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || true; done
  if [ -n "${KEEP:-}" ]; then echo "kept $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT

cx() { npx --no-install connectd "$@" 2>&1 | grep -v '^npm notice' || true; }
up() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://localhost:$1/" && return 0; sleep 1; done; return 1; }
down() { kill -- "-$1" 2>/dev/null || true; for _ in $(seq 1 20); do curl -s -o /dev/null "http://localhost:$2/" || return 0; sleep 0.5; done; }
# Starts a background command in its own process group; its pgid lands in $BG.
bg() { local log=$1; shift; setsid "$@" >"$log" 2>&1 & BG=$!; PIDS+=("$BG"); }
status() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $2" "$1/connections"; }
envv() { sed -n "s/^$1=//p" "${2:-.env}"; }

step "pack and install, as from npm"
(cd "$REPO" && bun run pack >/dev/null)
cd "$DIR"
npm init -y >/dev/null && npm pkg set type=module
npm i -D "$REPO"/.pack/kavishkagaya-connectd-*.tgz wrangler@4 >/dev/null 2>&1
cp "$HERE"/*.mjs .
check "connectd runs on Node" bash -c 'npx --no-install connectd --help 2>/dev/null | grep -q "connectd <command>"'

step "init and add"
cx init --port "$DEV_PORT" --target cloudflare --skip-install >/dev/null
check "init wrote the root key into .env" grep -q '^CONNECTD_ROOT_KEY=ocroot_' .env
check "init wrote oc.config.ts with the Cloudflare target" grep -q 'cloudflare({' oc.config.ts
ROOT=$(envv CONNECTD_ROOT_KEY)
cx init --port "$DEV_PORT" --skip-install >/dev/null
check "init again never replaces the root key" test "$(envv CONNECTD_ROOT_KEY)" = "$ROOT"
cx add github >/dev/null
check "add copied the provider" test -f oc/github/connection.ts
sed -i 's/^GITHUB_CLIENT_ID=.*/GITHUB_CLIENT_ID=dev-id/; s/^GITHUB_CLIENT_SECRET=.*/GITHUB_CLIENT_SECRET=dev-secret/' .env

step "dev"
bg dev.log npx --no-install connectd dev; DEV=$BG
check "dev is up" up "$DEV_PORT"
sleep 1
D="http://localhost:$DEV_PORT"
check "dev wrote the app's API key into .env" grep -q '^CONNECTD_API_KEY=ock_' .env
check "dev wrote the app's events secret into .env" grep -q '^CONNECTD_EVENTS_SECRET=whsec_' .env
KEY=$(envv CONNECTD_API_KEY)
check "no key: 401" test "$(status "$D" "")" = 401
check "a wrong key: 401" test "$(status "$D" ock_000000000000_nope)" = 401
check "the app's key: 200" test "$(status "$D" "$KEY")" = 200
node --env-file=.env app.mjs "github/alice:pending"

step "keys against dev: shown once, .env never touched"
ENVSUM=$(sha256sum .env)
OUT=$(cx keys create worker)
W=$(echo "$OUT" | sed -n 's/^ *CONNECTD_API_KEY=//p')
check "create shows the secret once" test -n "$W"
check "the new key works" test "$(status "$D" "$W")" = 200
check "the list never shows a secret" bash -c "! npx --no-install connectd keys 2>/dev/null | grep -q -- '$W'"
W2=$(cx keys roll worker --grace 1h | sed -n 's/^ *CONNECTD_API_KEY=//p')
check "rolled: the new secret works" test "$(status "$D" "$W2")" = 200
check "rolled: the old one works in its grace period" test "$(status "$D" "$W")" = 200
cx keys revoke worker >/dev/null
check "revoked: refused" test "$(status "$D" "$W2")" = 401
check "--events finds the events secret named dev" bash -c "npx --no-install connectd keys roll dev --events --grace 1h 2>/dev/null | grep -q 'rolled events secret dev'"
check "keys never changed .env" test "$(sha256sum .env)" = "$ENVSUM"
LINK=$(cx dashboard --print | grep -o 'http://[^ ]*#login=[^ ]*')
check "dashboard --print gives a sign-in link" test -n "$LINK"

step "dev restarts"
ENVSUM=$(sha256sum .env)
down "$DEV" "$DEV_PORT"; bg dev.log npx --no-install connectd dev; DEV=$BG; up "$DEV_PORT"; sleep 1
check "restart: .env untouched" test "$(sha256sum .env)" = "$ENVSUM"
node --env-file=.env app.mjs "github/alice:pending" list
down "$DEV" "$DEV_PORT"; bg dev.log npx --no-install connectd dev --reset; DEV=$BG; up "$DEV_PORT"; sleep 1
check "--reset: .env untouched, the key still works" test "$(sha256sum .env)" = "$ENVSUM" -a "$(status "$D" "$KEY")" = 200
node --env-file=.env app.mjs "" list
down "$DEV" "$DEV_PORT"

step "deploy, generated and run on wrangler dev"
printf 'GITHUB_CLIENT_ID=prod-id\nGITHUB_CLIENT_SECRET=prod-secret\nAPP_URL=https://app.example.com\n' >.env.production
cx deploy --dry-run >/dev/null
check "deploy --dry-run wrote the Worker" test -f .connectd/deploy/wrangler.json -a -f .connectd/deploy/worker.ts
printf 'CONNECTD_STATE_KEY=x\n' >.env.bad
check "deploy refuses a derived key in the env file" bash -c 'npx --no-install connectd deploy --dry-run --env-file .env.bad 2>&1 | grep -q "derived from CONNECTD_ROOT_KEY"'
node worker-vars.mjs "http://localhost:$WORKER_PORT"
DB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".connectd/deploy/wrangler.json","utf8")).d1_databases[0].database_name)')
npx --no-install wrangler d1 migrations apply "$DB" --local -c .connectd/deploy/wrangler.json >/dev/null 2>&1
bg worker.log npx --no-install wrangler dev -c .connectd/deploy/wrangler.json --port "$WORKER_PORT"; WK=$BG
check "the Worker is up" up "$WORKER_PORT"
P=(--env production --url "http://localhost:$WORKER_PORT")
check "a fresh deployment has no keys" bash -c "npx --no-install connectd keys ${P[*]} 2>/dev/null | grep -q 'no keys in production'"
PK=$(cx keys create app "${P[@]}" | sed -n 's/^ *CONNECTD_API_KEY=//p')
PE=$(cx keys create app --events "${P[@]}" | sed -n 's/^ *CONNECTD_EVENTS_SECRET=//p')
printf 'CONNECTD_URL=http://localhost:%s\nCONNECTD_API_KEY=%s\nCONNECTD_EVENTS_SECRET=%s\n' "$WORKER_PORT" "$PK" "$PE" >app.production.env
node --env-file=app.production.env app.mjs "github/alice:pending"
check "dev's key isn't production's" test "$(status "http://localhost:$WORKER_PORT" "$KEY")" = 401
mkdir -p other && printf 'CONNECTD_ROOT_KEY=ocroot_%s\n' "$(head -c32 /dev/urandom | base64)" >other/.env
check "another project's root key is refused" bash -c "cd other && npx --prefix .. --no-install connectd keys ${P[*]} 2>&1 | grep -q \"aren't this root key's\""
down "$WK" "$WORKER_PORT"; bg worker.log npx --no-install wrangler dev -c .connectd/deploy/wrangler.json --port "$WORKER_PORT"; WK=$BG; up "$WORKER_PORT"
check "Worker restarted: the app's key still works" test "$(status "http://localhost:$WORKER_PORT" "$PK")" = 200
node --env-file=app.production.env app.mjs "github/alice:pending" list

if [ -n "${PLAYWRIGHT:-}" ]; then
  step "the dashboard in a real browser"
  LINK=$(cx dashboard --print "${P[@]}" | grep -o 'http://[^ ]*#login=[^ ]*')
  node browser.mjs "$LINK" "$PLAYWRIGHT" "${CHROME:-}"
else
  echo; echo "(skipped the browser: set PLAYWRIGHT, and CHROME for playwright-core)"
fi

echo; echo "all checks passed"
