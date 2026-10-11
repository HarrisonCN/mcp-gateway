#!/usr/bin/env bash
# 14.9.0: upgrade / rollback test against real state stores (test/upgrade-14-9-0.test.ts).
# Installs the published releases to upgrade from (default 13.9.5, and 14.8.0 + 14.9.0 since 15.0.0-rc.1) into a temp
# dir and runs the test once per 14.x release with this checkout as the target. Needs network access to the npm
# registry; the redis variants need redis-server.
#   bash scripts/upgrade-test.sh [from13=13.9.5] ["from14 list"="14.8.0 14.9.0"]
set -euo pipefail
FROM13=${1:-13.9.5}; FROM14=${2:-14.8.0 14.9.0}
D=$(mktemp -d "${TMPDIR:-/tmp}/mgw-upgrade-XXXX")
for v in "$FROM13" $FROM14; do
  mkdir -p "$D/$v" && (cd "$D/$v" && echo '{"private":true}' > package.json && npm i -s --no-audit --no-fund "@winstonsayno/mcp-gateway@$v" >/dev/null)
done
cd "$(dirname "$0")/.."
for v in $FROM14; do
  echo "== upgrade / rollback: 13.9 ($FROM13) and $v → this checkout"
  MGW_UPGRADE_V13="$D/$FROM13" MGW_UPGRADE_V14="$D/$v" npx vitest run test/upgrade-14-9-0.test.ts
done
