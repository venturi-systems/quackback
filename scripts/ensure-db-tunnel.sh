#!/usr/bin/env bash
# Run a test command against local PostgreSQL, or an explicitly opted-in SSH tunnel.
set -euo pipefail

if (( $# == 0 )); then
    echo "usage: $0 COMMAND [ARG ...]" >&2
    exit 64
fi

LOCAL_PORT=5432
REMOTE_PORT="${QUACKBACK_TEST_DB_REMOTE_PORT:-5432}"
REMOTE_HOST="${QUACKBACK_TEST_DB_TUNNEL_HOST:-}"

valid_port() {
    [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

if [[ -n "${QUACKBACK_TEST_DB_LOCAL_PORT:-}" && "${QUACKBACK_TEST_DB_LOCAL_PORT}" != "$LOCAL_PORT" ]]; then
    echo "QUACKBACK_TEST_DB_LOCAL_PORT must remain 5432 because Vitest binds DATABASE_URL to that port" >&2
    exit 64
fi

if ! valid_port "$REMOTE_PORT"; then
    echo "database tunnel ports must be integers from 1 through 65535" >&2
    exit 64
fi

port_is_open() {
    if command -v nc >/dev/null 2>&1; then
        nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null
        return
    fi
    # Bash is already required by this wrapper. Its TCP redirection keeps
    # minimal Bun + Docker development environments from needing netcat.
    (exec 3<>"/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null
}

if port_is_open; then
    exec "$@"
fi

if [[ -z "$REMOTE_HOST" ]]; then
    echo "PostgreSQL is not listening on 127.0.0.1:${LOCAL_PORT}. Run 'bun run setup' or explicitly set QUACKBACK_TEST_DB_TUNNEL_HOST." >&2
    exit 1
fi
if [[ "$REMOTE_HOST" == -* ]]; then
    echo "QUACKBACK_TEST_DB_TUNNEL_HOST must not begin with '-'" >&2
    exit 64
fi
if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh is required when QUACKBACK_TEST_DB_TUNNEL_HOST is set" >&2
    exit 127
fi

ssh -N \
    -o BatchMode=yes \
    -o ConnectTimeout=2 \
    -o ConnectionAttempts=1 \
    -o ExitOnForwardFailure=yes \
    -L "${LOCAL_PORT}:localhost:${REMOTE_PORT}" \
    -- "$REMOTE_HOST" &
SSH_PID=$!
COMMAND_PID=""

cleanup() {
    if [[ -n "$SSH_PID" ]] && kill -0 "$SSH_PID" 2>/dev/null; then
        kill "$SSH_PID" 2>/dev/null || true
    fi
    if [[ -n "$SSH_PID" ]]; then
        wait "$SSH_PID" 2>/dev/null || true
        SSH_PID=""
    fi
}

forward_signal() {
    local signal="$1"
    local status="$2"
    trap - HUP INT TERM
    if [[ -n "$COMMAND_PID" ]] && kill -0 "$COMMAND_PID" 2>/dev/null; then
        kill "-$signal" "$COMMAND_PID" 2>/dev/null || true
    fi
    # Tear down the tunnel even if the wrapped command does not cooperate.
    cleanup
    if [[ -n "$COMMAND_PID" ]]; then
        wait "$COMMAND_PID" 2>/dev/null || true
    fi
    exit "$status"
}

trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

opened=false
for _ in {1..50}; do
    if port_is_open; then
        opened=true
        break
    fi
    if ! kill -0 "$SSH_PID" 2>/dev/null; then
        set +e
        wait "$SSH_PID"
        ssh_status=$?
        set -e
        echo "SSH tunnel exited before PostgreSQL became reachable (status ${ssh_status})" >&2
        exit 1
    fi
    sleep 0.1
done

if [[ "$opened" != true ]]; then
    echo "SSH tunnel did not expose PostgreSQL on 127.0.0.1:${LOCAL_PORT}" >&2
    exit 1
fi

set +e
"$@" &
COMMAND_PID=$!
wait "$COMMAND_PID"
status=$?
COMMAND_PID=""
set -e
exit "$status"
