#!/usr/bin/env bash
# Check a project freshly scaffolded from this template, item by item, the way
# the Scaffold-HBAR bounty gate does: files, install/lint/build, tests, and the
# running app. Used by .github/workflows/fresh-scaffold.yaml; also runs locally:
#
#   .github/scripts/check-scaffold.sh <project dir> <yarn|npm> [port]
#
# Needs no Hedera account: flows are dry-run, nothing is sent to the network.
set -u

SCRIPTS=$(cd "$(dirname "$0")" && pwd)
DIR=$1
PM=$2
PORT=${3:-3105}
LOGS=${LOG_DIR:-"$(dirname "$DIR")/scaffold-logs-$PM"}
mkdir -p "$LOGS"
cd "$DIR" || exit 2

PASS=0
FAIL=0
pass() {
  echo "PASS $1"
  PASS=$((PASS + 1))
}
fail() {
  echo "FAIL $1"
  FAIL=$((FAIL + 1))
}

# A root package script with arguments. npm needs `--` to pass them on; Yarn 3 would pass `--` itself.
run() {
  local script=$1
  shift
  if [ "$PM" = npm ]; then
    npm run "$script" ${1+-- "$@"}
  else
    yarn "$script" "$@"
  fi
}

# check <name> <command...>: run it, keep its output in a log, show the tail on failure.
check() {
  local name=$1
  shift
  if "$@" >"$LOGS/$name.log" 2>&1; then
    pass "$name"
  else
    fail "$name (log: $name.log)"
    tail -20 "$LOGS/$name.log" | sed 's/^/    /'
  fi
}

echo "== $PM project: $DIR"

echo "-- files"
[ -f README.md ] && [ -f AGENTS.md ] && pass "README.md and AGENTS.md" || fail "README.md or AGENTS.md missing"
[ -f LICENSE ] && grep -q "MIT License" LICENSE && pass "MIT licence" || fail "MIT licence missing"
[ ! -f template.json ] && pass "template.json consumed by the CLI" || fail "template.json left in the project"
[ -d .harness ] && pass ".harness recipe" || fail ".harness recipe missing"
TRACKED_ENV=$(git ls-files | grep -E '(^|/)\.env(\.local)?$' || true)
[ -z "$TRACKED_ENV" ] && pass "no .env committed" || fail ".env committed: $TRACKED_ENV"
# With npm, the CLI rewrote the docs' and workflows' commands: each must name a script and pass its flags on.
[ "$PM" = npm ] && check npm-commands node "$SCRIPTS/check-npm-commands.mjs" .

echo "-- quality gates"
check lint run lint
check check-types run check-types
check core-test run core:test
check core-docs run core:docs --check
check hardhat-compile run hardhat:compile
check hardhat-test run hardhat:test
for flow in packages/launchblocks/flows/*.json; do
  id=$(basename "$flow" .json)
  check "dry-run-$id" run core:check "$id"
done
check next-build run next:build

echo "-- the production build, served on :$PORT"
PORT=$PORT run next:serve >"$LOGS/next-serve.log" 2>&1 &
for _ in $(seq 1 90); do
  curl -s -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done
for path in / /launch /debug /blockexplorer /api/launchblocks/steps /api/launchblocks/gallery /api/launchblocks/operator; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$path")
  [ "$code" = 200 ] && pass "GET $path" || fail "GET $path -> $code"
done

# The gallery serves every flow in flows/, and each flow uses only step types the catalog lists.
STEPS=$(curl -s "http://localhost:$PORT/api/launchblocks/steps")
GALLERY=$(curl -s "http://localhost:$PORT/api/launchblocks/gallery")
FLOWS=$(ls packages/launchblocks/flows/*.json | wc -l | tr -d ' ')
RESULT=$(STEPS=$STEPS GALLERY=$GALLERY FLOWS=$FLOWS node -e '
  const types = new Set(JSON.parse(process.env.STEPS).steps.map(step => step.type));
  const flows = JSON.parse(process.env.GALLERY).flows;
  const unknown = flows.flatMap(f => f.flow.steps.map(s => s.type)).filter(t => !types.has(t));
  if (flows.length !== Number(process.env.FLOWS)) console.log(`gallery has ${flows.length} flows, flows/ has ${process.env.FLOWS}`);
  else if (unknown.length) console.log(`unknown step types: ${unknown}`);
  else console.log(`ok ${types.size} step types, ${flows.length} flows`);
' 2>&1)
case $RESULT in
  ok*) pass "catalog and gallery agree (${RESULT#ok })" ;;
  *) fail "catalog and gallery: $RESULT" ;;
esac

# Export works from a flow the user renamed: launch.ts calls the core, the harness recipe has its spec.
FLOW=$(node -e '
  const f = require("./packages/launchblocks/flows/hts-launch-locked-liquidity.json");
  f.id = "my-locked-launch";
  f.name = "My locked launch";
  process.stdout.write(JSON.stringify(f));
')
curl -s -X POST -H 'content-type: application/json' -d "$FLOW" "http://localhost:$PORT/api/launchblocks/flows/codegen" |
  grep -q 'deployContract(ctx' && pass "codegen: launch.ts" || fail "codegen: launch.ts"
curl -s -X POST -H 'content-type: application/json' -d "$FLOW" "http://localhost:$PORT/api/launchblocks/flows/harness" |
  grep -q 'my-locked-launch.spec.yaml' && pass "export: harness recipe" || fail "export: harness recipe"

# Without an operator, a run is refused before anything is sent.
code=$(curl -s -o "$LOGS/run.json" -w "%{http_code}" -X POST -H 'content-type: application/json' -d "$FLOW" \
  "http://localhost:$PORT/api/launchblocks/flows/run")
grep -q OPERATOR_MISSING "$LOGS/run.json" && pass "run without an operator: $code OPERATOR_MISSING" ||
  fail "run without an operator: $code $(head -c 200 "$LOGS/run.json")"

lsof -ti "tcp:$PORT" | xargs kill 2>/dev/null

echo "== $PM: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
