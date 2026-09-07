#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/ensure-db-tunnel.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin"

cat >"$TMP_DIR/bin/nc" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -z && "${2:-}" == 127.0.0.1 && "${3:-}" == "${EXPECTED_LOCAL_PORT:-5432}" ]] || exit 98
[[ -f "$NC_OPEN_FILE" ]]
EOF

cat >"$TMP_DIR/bin/ssh" <<'EOF'
#!/usr/bin/env bash
if [[ "${SSH_FAIL:-0}" == 1 ]]; then
    exit 42
fi
printf '%s\n' "$$" >"$SSH_PID_FILE"
printf '%s\n' "$@" >"$SSH_ARGS_FILE"
: >"$NC_OPEN_FILE"
trap 'rm -f "$NC_OPEN_FILE"; exit 0' HUP INT TERM
while :; do sleep 1; done
EOF

cat >"$TMP_DIR/bin/long-command" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >"$COMMAND_PID_FILE"
trap 'touch "$COMMAND_TERM_FILE"; exit 0' TERM
while :; do sleep 1; done
EOF
chmod +x "$TMP_DIR/bin/nc" "$TMP_DIR/bin/ssh" "$TMP_DIR/bin/long-command"

run_status() {
    set +e
    "$@"
    RUN_STATUS=$?
    set -e
}

OPEN_FILE="$TMP_DIR/open"
RUN_FILE="$TMP_DIR/ran"
PID_FILE="$TMP_DIR/ssh.pid"
ARGS_FILE="$TMP_DIR/ssh.args"

# An existing local listener never invokes SSH.
: >"$OPEN_FILE"
PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_FAIL=1 RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ -f "$RUN_FILE" ]]
rm -f "$OPEN_FILE" "$RUN_FILE"

# No local database and no explicit host fails before running the test command.
run_status env -u QUACKBACK_TEST_DB_TUNNEL_HOST \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ "$RUN_STATUS" == 1 ]]
[[ ! -e "$RUN_FILE" ]]

# A failed noninteractive SSH connection is reported and does not run tests.
run_status env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host SSH_FAIL=1 \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" SSH_ARGS_FILE="$ARGS_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ "$RUN_STATUS" == 1 ]]
[[ ! -e "$RUN_FILE" ]]

# An opted-in tunnel runs the command and is removed afterward.
env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host QUACKBACK_TEST_DB_REMOTE_PORT=6432 \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" SSH_ARGS_FILE="$ARGS_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ -f "$RUN_FILE" ]]
[[ ! -e "$OPEN_FILE" ]]
grep -Fx -- "5432:localhost:6432" "$ARGS_FILE" >/dev/null
ssh_pid="$(cat "$PID_FILE")"
! kill -0 "$ssh_pid" 2>/dev/null
rm -f "$RUN_FILE" "$PID_FILE" "$ARGS_FILE"

# The wrapped command's failure is preserved while the tunnel is still cleaned up.
run_status env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" SSH_ARGS_FILE="$ARGS_FILE" \
    "$SUT" bash -c 'exit 23'
[[ "$RUN_STATUS" == 23 ]]
[[ ! -e "$OPEN_FILE" ]]
ssh_pid="$(cat "$PID_FILE")"
! kill -0 "$ssh_pid" 2>/dev/null
rm -f "$PID_FILE" "$ARGS_FILE"

# A mismatched local port is rejected rather than launching tests against Vitest's fixed 5432 URL.
run_status env QUACKBACK_TEST_DB_LOCAL_PORT=6543 QUACKBACK_TEST_DB_TUNNEL_HOST=test-host \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" SSH_ARGS_FILE="$ARGS_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ "$RUN_STATUS" == 64 ]]
[[ ! -e "$RUN_FILE" ]]

# Signaling only the wrapper is forwarded to the command and always tears down the tunnel.
COMMAND_PID_FILE="$TMP_DIR/command.pid"
COMMAND_TERM_FILE="$TMP_DIR/command.term"
env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" SSH_ARGS_FILE="$ARGS_FILE" \
    COMMAND_PID_FILE="$COMMAND_PID_FILE" COMMAND_TERM_FILE="$COMMAND_TERM_FILE" \
    "$SUT" "$TMP_DIR/bin/long-command" &
wrapper_pid=$!
for _ in {1..50}; do
    [[ -s "$COMMAND_PID_FILE" && -s "$PID_FILE" && -e "$OPEN_FILE" ]] && break
    sleep 0.1
done
[[ -s "$COMMAND_PID_FILE" && -s "$PID_FILE" && -e "$OPEN_FILE" ]]
command_pid="$(cat "$COMMAND_PID_FILE")"
ssh_pid="$(cat "$PID_FILE")"
kill -TERM "$wrapper_pid"
run_status wait "$wrapper_pid"
[[ "$RUN_STATUS" == 143 ]]
[[ -e "$COMMAND_TERM_FILE" ]]
[[ ! -e "$OPEN_FILE" ]]
! kill -0 "$command_pid" 2>/dev/null
! kill -0 "$ssh_pid" 2>/dev/null

echo "ensure-db-tunnel: 7 cases passed"
