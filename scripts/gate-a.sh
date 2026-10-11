#!/usr/bin/env bash
# v15 gate A harness — 72 h soak with fault injection on two gateway instances sharing one Redis, plus a report JSON.
# Runs on any dedicated Linux machine (no GitHub needed) and is what .github/workflows/gate-a.yml calls on a
# self-hosted runner. See docs/v15/gates.md for what the gate requires and what the report means.
#
#   scripts/gate-a.sh [--version <npm version>|checkout] [--duration 72h] [--baseline 13.3.0|none]
#                     [--baseline-duration 6h] [--out-dir gate-a-<timestamp>] [--max-plateau-mb-per-hour 45]
#
#   --version            gateway under test: a published version (e.g. 15.0.0-rc.2, installed from npm into the out
#                        dir) or `checkout` (this repository's dist/, built with npm run build). Default: checkout.
#   --duration           soak length (default 72h — the gate; shorter runs are rehearsals and fail criterion A1)
#   --baseline           release measured first with the same harness, settings and machine (default 13.3.0;
#                        `none` skips it). Its numbers fill vsBaseline in the report (gate B uses the same data).
#   --baseline-duration  baseline length (default 6h)
#
# Output (all in --out-dir, written while the run is going so a crash leaves evidence):
#   soak-report.json / soak.log            scripts/soak.mjs report and progress log of the run under test
#   soak-baseline.json / soak-baseline.log the baseline run (when --baseline is not none)
#   rss.jsonl / rss-baseline.jsonl         RSS of both instances every 10 s (scripts/gate-a-sampler.mjs)
#   gate-a-report.json                     criteria A1–A8 evaluated (scripts/gate-a-report.mjs); exit code 0 when all hold
#   env.json                               machine, kernel, Node, Redis, CPU and memory of the box
#
# Requirements: Linux (reads /proc), Node 22, npm, redis-server on PATH (or MGW_REDIS_SERVER), ~2 GB free RAM, a box
# with nothing else running. Faults (every 5 min, rotating): kill -9 + restart of instance A, a 20 s network partition
# between instance B and Redis, a Redis SIGKILL + restart (AOF). Settings are fixed (rps 60, concurrency 8, fault
# every 5m) so runs and baselines stay comparable.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=checkout; DURATION=72h; BASELINE=13.3.0; BDUR=6h; OUTDIR=; MAXP=45
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=$2; shift 2 ;;
    --duration) DURATION=$2; shift 2 ;;
    --baseline) BASELINE=$2; shift 2 ;;
    --baseline-duration) BDUR=$2; shift 2 ;;
    --out-dir) OUTDIR=$2; shift 2 ;;
    --max-plateau-mb-per-hour) MAXP=$2; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo "gate A harness needs Linux (/proc)" >&2; exit 2; }
REDIS=${MGW_REDIS_SERVER:-redis-server}
command -v "$REDIS" >/dev/null || { echo "redis-server not found (install it or set MGW_REDIS_SERVER)" >&2; exit 2; }
OUTDIR=${OUTDIR:-gate-a-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$OUTDIR"; OUTDIR=$(cd "$OUTDIR" && pwd)
SETTINGS=(--rps 60 --concurrency 8 --fault-every 5m)

install_release() { # $1 version → prints package dir
  local d="$OUTDIR/impl-$1"
  mkdir -p "$d" && (cd "$d" && echo '{"private":true}' > package.json && npm i -s --no-audit --no-fund "@winstonsayno/mcp-gateway@$1" >/dev/null)
  echo "$d/node_modules/@winstonsayno/mcp-gateway"
}

if [ "$VERSION" = checkout ]; then
  (cd "$ROOT" && { [ -d node_modules ] || npm ci --ignore-scripts; } && npm run build >/dev/null)
  IMPL=$ROOT
else
  IMPL=$(install_release "$VERSION")
fi

node -e '
const os = require("os"); const { execSync } = require("child_process");
const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return null; } };
console.log(JSON.stringify({ host: os.hostname(), kernel: os.release(), arch: process.arch, cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model, memGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version,
  redis: sh(`${process.argv[1]} --version`), impl: process.argv[2], version: process.argv[3], startedAt: new Date().toISOString() }, null, 2));
' "$REDIS" "$IMPL" "$VERSION" > "$OUTDIR/env.json"

run_soak() { # $1 label (run|baseline) $2 impl $3 duration $4 report $5 log $6 rss [extra args]
  local label=$1 impl=$2 dur=$3 rep=$4 lg=$5 rss=$6; shift 6
  echo "gate A: $label soak of $(node -p "require('$impl/package.json').version") for $dur → $rep"
  node "$ROOT/scripts/soak.mjs" --duration "$dur" "${SETTINGS[@]}" --impl "$impl" --out "$rep" --log "$lg" "$@" > /dev/null 2>&1 &
  local pid=$!
  node "$ROOT/scripts/gate-a-sampler.mjs" --soak-pid "$pid" --out "$rss" --impl "$impl" &
  local spid=$!
  local rc=0; wait "$pid" || rc=$?
  wait "$spid" 2>/dev/null || true
  echo "gate A: $label soak exit $rc"
  return 0
}

BARGS=()
if [ "$BASELINE" != none ]; then
  BIMPL=$(install_release "$BASELINE")
  run_soak baseline "$BIMPL" "$BDUR" "$OUTDIR/soak-baseline.json" "$OUTDIR/soak-baseline.log" "$OUTDIR/rss-baseline.jsonl"
  [ -f "$OUTDIR/soak-baseline.json" ] && BARGS=(--baseline "$OUTDIR/soak-baseline.json")
fi
run_soak run "$IMPL" "$DURATION" "$OUTDIR/soak-report.json" "$OUTDIR/soak.log" "$OUTDIR/rss.jsonl" "${BARGS[@]}"

set +e
node "$ROOT/scripts/gate-a-report.mjs" --soak "$OUTDIR/soak-report.json" --rss "$OUTDIR/rss.jsonl" "${BARGS[@]}" \
  --min-duration 72h --window 6h --plateau-window 24h --max-plateau-mb-per-hour "$MAXP" --out "$OUTDIR/gate-a-report.json"
RC=$?
echo "gate A evidence in $OUTDIR (send gate-a-report.json, soak-report.json, rss.jsonl, env.json and the logs)"
exit $RC
