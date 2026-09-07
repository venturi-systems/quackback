#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/ensure-db-tunnel.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin"

cat >"$TMP_DIR/bin/nc" <<'EOF'
#!/usr/bin/env bash
[[ -f "$NC_OPEN_FILE" ]]
EOF

cat >"$TMP_DIR/bin/ssh" <<'EOF'
#!/usr/bin/env bash
if [[ "${SSH_FAIL:-0}" == 1 ]]; then
    exit 42
fi
printf '%s\n' "$$" >"$SSH_PID_FILE"
: >"$NC_OPEN_FILE"
trap 'rm -f "$NC_OPEN_FILE"; exit 0' HUP INT TERM
while :; do sleep 1; done
EOF
chmod +x "$TMP_DIR/bin/nc" "$TMP_DIR/bin/ssh"

run_status() {
    set +e
    "$@"
    RUN_STATUS=$?
    set -e
}

OPEN_FILE="$TMP_DIR/open"
RUN_FILE="$TMP_DIR/ran"
PID_FILE="$TMP_DIR/ssh.pid"

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
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ "$RUN_STATUS" == 1 ]]
[[ ! -e "$RUN_FILE" ]]

# An opted-in tunnel runs the command and is removed afterward.
env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" RUN_FILE="$RUN_FILE" \
    "$SUT" bash -c 'touch "$RUN_FILE"'
[[ -f "$RUN_FILE" ]]
[[ ! -e "$OPEN_FILE" ]]
ssh_pid="$(cat "$PID_FILE")"
! kill -0 "$ssh_pid" 2>/dev/null
rm -f "$RUN_FILE" "$PID_FILE"

# The wrapped command's failure is preserved while the tunnel is still cleaned up.
run_status env QUACKBACK_TEST_DB_TUNNEL_HOST=test-host \
    PATH="$TMP_DIR/bin:$PATH" NC_OPEN_FILE="$OPEN_FILE" SSH_PID_FILE="$PID_FILE" \
    "$SUT" bash -c 'exit 23'
[[ "$RUN_STATUS" == 23 ]]
[[ ! -e "$OPEN_FILE" ]]
ssh_pid="$(cat "$PID_FILE")"
! kill -0 "$ssh_pid" 2>/dev/null

echo "ensure-db-tunnel: 5 cases passed"
