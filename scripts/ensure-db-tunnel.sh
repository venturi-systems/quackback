#!/usr/bin/env bash
# ensure-db-tunnel.sh — Automatically ensures local port 5432 is accessible for PostgreSQL tests.
# If port 5432 is not responding locally, checks if pop-os host is reachable and opens a background SSH tunnel.
set -euo pipefail

PORT=5432
REMOTE_HOST="pop-os"

if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    exit 0
fi

# If localhost:5432 is not open, probe if remote host is reachable
if ssh -q -o BatchMode=yes -o ConnectTimeout=2 "$REMOTE_HOST" exit 2>/dev/null; then
    # Establish background port-forward
    ssh -f -N -o ExitOnForwardFailure=yes -L "${PORT}:localhost:${PORT}" "$REMOTE_HOST" 2>/dev/null || true
    # Wait up to 2 seconds for port to open
    for _ in {1..20}; do
        if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
            break
        fi
        sleep 0.1
    done
fi

exit 0
