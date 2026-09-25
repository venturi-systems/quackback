#!/usr/bin/env bash
# One cold-start trial: wipe Vite caches, start dev server, probe like Playwright.
cd "$(dirname "$0")/../apps/web"
rm -rf node_modules/.vite node_modules/.vite-temp ../../node_modules/.vite 2>/dev/null
log=$1
setsid bun --env-file=../../.env vite dev > "$log.server" 2>&1 &
spid=$!
node ../../.cih-scratch/probe.mjs 3417 ${2:-120000} > "$log.probe" 2>&1
rc=$?
kill -TERM -- -$spid 2>/dev/null; sleep 1; kill -KILL -- -$spid 2>/dev/null
wait $spid 2>/dev/null
echo "rc=$rc"
