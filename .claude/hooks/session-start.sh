#!/usr/bin/env bash
# Fleet session bootstrap (vendored engine; identical in every repository).
#
# Purpose: let an agent that opens a Claude Code CLOUD session run this
# repository's own gates (the `validation.local_commands` declared in its
# repository-governance manifest) without manual setup. The engine
# provisions exactly what .claude/session-bootstrap.json declares: a Python
# virtualenv, Node packages, pinned binaries, apt packages and session
# environment variables. The manifest is the only per-repository input; the
# engine stays byte-identical across the fleet so a diff against any sibling
# repository reviews it.
#
# Rules this engine enforces:
#   1. Cloud-only. It exits at once unless CLAUDE_CODE_REMOTE=true, so the
#      owner's Mac, Pop!_OS, devbox and the hub never install anything from a
#      hook (fleet rule: no suites, installs or background work on sister
#      devices).
#   2. Out of tree. Everything lands under $SESSION_BOOTSTRAP_ROOT
#      (default ~/.session-bootstrap): venv/<slot>, bin/<slot>, tools/, python/,
#      logs/, state/, where <slot> is the directory name plus a digest of the
#      checkout path. The only in-tree writes go to paths git already ignores: a Node
#      package install into node_modules/, and python.env_dir when a repository
#      names one. The engine verifies the ignore rule before writing.
#   3. Idempotent and fast on re-run. A state marker records a fingerprint of
#      the engine, the manifest and every dependency input it names (requirement
#      files, uv.lock, pyproject.toml, Node lockfiles, cache_inputs). A matching
#      marker plus passing probes ends the run in seconds; any change to those
#      inputs re-runs every declared installer.
#   4. Fail-open and honest. No step aborts the session. Each step reports
#      ok, cached, skipped or FAILED, and the last line names what is missing.
#      A malformed manifest is reported as missing, never cached as ready.
#      Verbose installer output goes to the log, not into session context.
#      A provisioning step that changes `git status` is reported, never cached.
#   5. Non-interactive. No prompts, no sudo, no credentials, nothing secret in
#      the env file. Downloaded binaries must carry a pinned version and sha256.
#
# The fleet contract is docs/session-bootstrap.md in the organization's .github
# repository.
#
# Manifest schema (JSON, schema_version 1), all other keys optional; any key
# not listed here is rejected:
#   python:   { "version": "3.12", "system_site_packages": false,
#               "env_dir": "<gitignored relative dir; default is out of tree>",
#               "uv_sync": {"frozen": true, "extras": [..],
#               "all_extras": false, "groups": [..]},
#               "requirements": ["requirements.txt", ..], "packages": [..],
#               "install": ["-e .[dev]", "? <optional entry>", ..],
#               "probe": ["yaml", "pytest"] }
#   node:     { "manager": "npm" | "pnpm" | "bun", "dirs": [".", "frontend"],
#               "args": ["--ignore-scripts"], "post": ["npm run --prefix x build"] }
#   apt:      ["package", ..]
#   binaries: [{ "name": "terraform", "version": "1.11.4",
#                "url": "https://..", "sha256": "..", "archive": "zip|tar.gz|none",
#                "member": "terraform" }]
#   env:      { "NAME": "value", .. }  ({root}, {bin}, {venv} and {repo} expand)
#   post:     ["command run from the repository root after provisioning",
#              "? optional command whose failure is reported, not missing", ..]
#   cache_inputs: ["path/or/glob", ..]  (extra files whose change re-provisions)
#   outputs:  ["{bin}/tool", ..]  (paths a post step creates; a cached run
#                                 re-provisions when one is missing)
#   timeout_seconds: 900   (per step; default 900)
#
# Validation: run `CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR=<repo> \
#   CLAUDE_ENV_FILE=/tmp/env.sh bash .claude/hooks/session-start.sh` twice; the
# second run must report "ready (cached)".
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi
# Fleet hook kill switch (platform convention, symmetric with its session hooks).
if [ "${HARNESS_HOOKS_DISABLED:-0}" = "1" ]; then
    exit 0
fi

ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if ! cd "$PROJECT_DIR" 2>/dev/null; then
    echo "session-start: FAILED cannot cd to PROJECT_DIR=$PROJECT_DIR (set CLAUDE_PROJECT_DIR)" >&2
    exit 0
fi
PROJECT_DIR="$(pwd -P)"

MANIFEST="$PROJECT_DIR/.claude/session-bootstrap.json"
REPO="$(basename "$PROJECT_DIR")"
# Two checkouts with the same directory name (a worktree, a second clone) must
# not share a virtualenv or a state marker, so per-checkout paths carry a short
# digest of the canonical project path.
SLOT="$REPO-$(printf '%s' "$PROJECT_DIR" | sha256sum | cut -c1-8)"
ROOT="${SESSION_BOOTSTRAP_ROOT:-$HOME/.session-bootstrap}"
# Every cache, log and tool lands under the root, so it must sit outside the
# checkout: a relative root would resolve inside it after the cd above.
case "$ROOT" in
    /*) ;;
    *) echo "session-start: SESSION_BOOTSTRAP_ROOT must be an absolute path, not $ROOT; nothing provisioned"; exit 0 ;;
esac
case "$ROOT/" in
    "$PROJECT_DIR"/*) echo "session-start: SESSION_BOOTSTRAP_ROOT must lie outside the checkout; nothing provisioned"; exit 0 ;;
esac
VENV="$ROOT/venv/$SLOT"
BIN="$ROOT/bin/$SLOT"
TOOLS_DIR="$ROOT/tools"
LOG="$ROOT/logs/$SLOT.log"
STATE="$ROOT/state/$SLOT.fingerprint"
ENV_NAMES="$ROOT/state/$SLOT.env-names"
PY_STATE="$ROOT/state/$SLOT.python"
OUTPUTS_STATE="$ROOT/state/$SLOT.outputs"
OWNER_MARK=".session-bootstrap-owned"
LOCK="$ROOT/state/$SLOT.lock"
CACHE_DIR="$ROOT/cache"
# strip_path PATH PREFIX: PATH without the entries equal to or under PREFIX. A
# resumed or cleared session inherits the PATH an earlier run published, so its
# bin and virtualenv entries are removed before this run publishes its own.
strip_path() {
    local entry out="" IFS=:
    for entry in $1; do
        case "$entry" in "$2"|"$2"/*) continue ;; esac
        out="${out:+$out:}$entry"
    done
    printf '%s' "$out"
}
BASE_PATH="$(strip_path "$PATH" "$ROOT")"
# An in-tree virtualenv an earlier run published lies outside $ROOT, and the
# manifest may since have moved env_dir; strip it by the VIRTUAL_ENV it set.
# Only a virtualenv this engine published is stripped: one under the root, one
# carrying its ownership marker, or any while the state records a Python
# install. A virtualenv the user activated stays on PATH and in VIRTUAL_ENV.
INHERITED_VENV_OURS=0
if [ -n "${VIRTUAL_ENV:-}" ]; then
    case "$VIRTUAL_ENV" in "$ROOT"/*) INHERITED_VENV_OURS=1 ;; esac
    [ -f "$VIRTUAL_ENV/.session-bootstrap-owned" ] && INHERITED_VENV_OURS=1
    [ -f "$ROOT/state/$SLOT.python" ] || [ -f "$ROOT/state/$SLOT.python.probe-failed" ] && INHERITED_VENV_OURS=1
fi
if [ "$INHERITED_VENV_OURS" = 1 ]; then
    BASE_PATH="$(strip_path "$BASE_PATH" "$VIRTUAL_ENV/bin")"
fi

# A resumed or cleared session still carries every name an earlier manifest
# published. Stop exporting them before any helper runs, so a retired
# PYTHONPATH or PIP_* value cannot reach the engine's own python3 or pip.
# Only the export attribute goes: a manifest name may coincide with one of
# this script's own variables, and steps get the current values through
# STEP_ENV. What the engine exports itself is exported again further down.
if [ -f "$ENV_NAMES" ]; then
    while IFS= read -r name; do
        case "$name" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*|PATH|HOME|SHELL|USER) continue ;; esac
        # shellcheck disable=SC2163 # the variable that $name names, by design
        export -n "$name" 2>/dev/null || true
    done <"$ENV_NAMES"
fi

# clear_published: a checkout whose manifest was removed, or no longer
# parses, still carries in a resumed or cleared session what the last valid
# manifest published. Clear it: the PATH entries, the virtualenv variables
# and every name the state recorded. Without state files only a VIRTUAL_ENV
# under $ROOT is this engine's; any other belongs to the user and is left
# alone. The recorded names stay behind as tombstones, so every other session
# of the checkout that still carries them can clear them too. Returns 1 when
# there was nothing to clear and 2 when CLAUDE_ENV_FILE could not be written.
clear_published() {
    local published=0 name
    if [ -f "$ENV_NAMES" ] || [ -f "$STATE" ] || [ "$INHERITED_VENV_OURS" = 1 ]; then
        published=1
    fi
    [ -n "${CLAUDE_ENV_FILE:-}" ] && [ "$published" = 1 ] || return 1
    {
        printf 'export PATH=%q\n' "$BASE_PATH"
        printf 'unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT\n'
        if [ -f "$ENV_NAMES" ]; then
            while IFS= read -r name; do
                [ -n "$name" ] && printf 'unset %s\n' "$name"
            done <"$ENV_NAMES"
        fi
    } >>"$CLAUDE_ENV_FILE" 2>/dev/null || return 2
    rm -f "$STATE" "$PY_STATE"
}
if [ ! -f "$MANIFEST" ]; then
    clear_published
    case $? in
        0) echo "session-start: no manifest at .claude/session-bootstrap.json; cleared what an earlier manifest published" ;;
        2) echo "session-start: FAILED no manifest at .claude/session-bootstrap.json, and could not write CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE to clear what an earlier manifest published" ;;
        *) echo "session-start: no manifest at .claude/session-bootstrap.json; nothing to provision" ;;
    esac
    exit 0
fi
mkdir -p "$BIN" "$TOOLS_DIR" "$ROOT/venv" "$ROOT/logs" "$ROOT/state" "$CACHE_DIR"
export PATH="$BIN:$BASE_PATH"
# The manifest's env entries reach the session and every step this engine
# runs, never this shell: a name such as VENV or WANT_PYTHON must not be able
# to change what the engine itself does.
STEP_ENV=()
# Names an earlier manifest published and this one dropped: a resumed session
# still carries them, so every step runs with them removed (`env -u`).
STEP_UNSET=()
# Set when a virtualenv this engine did not create needed a rebuild: it is
# used as it is, but a run over it is never cached as an exact match.
FOREIGN_STALE=0
ENGINE_EXPORTS="DEBIAN_FRONTEND CI npm_config_yes PIP_DISABLE_PIP_VERSION_CHECK UV_NO_PROGRESS \
PIP_PROGRESS_BAR UV_CACHE_DIR PIP_CACHE_DIR npm_config_cache UV_PYTHON_INSTALL_DIR \
npm_config_store_dir BUN_INSTALL_CACHE_DIR"
export DEBIAN_FRONTEND=noninteractive CI=1 npm_config_yes=true PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_PROGRESS=1 PIP_PROGRESS_BAR=off \
    UV_CACHE_DIR="$CACHE_DIR/uv" PIP_CACHE_DIR="$CACHE_DIR/pip" npm_config_cache="$CACHE_DIR/npm" \
    UV_PYTHON_INSTALL_DIR="$ROOT/python" \
    npm_config_store_dir="$CACHE_DIR/pnpm-store" BUN_INSTALL_CACHE_DIR="$CACHE_DIR/bun"
# One overall budget below the 3600 s hook timeout in settings.json, so the
# engine always reaches its summary before Claude Code would cancel it.
DEADLINE=$(( $(date +%s) + ${SESSION_BOOTSTRAP_BUDGET_SECONDS:-3300} ))
MISSING=()
TOOLS=()

# Keep one previous log and start a new one past 5 MiB, so repeated failing
# sessions cannot fill the disk with installer output.
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 5242880 ]; then
    mv -f "$LOG" "$LOG.1"
fi
# SessionStart stdout is added to the model's context, so it carries only
# failures, skips and the final summary. Each line is capped at 300 bytes and
# the lines before the summary at 1200 bytes in all, so a run that fails
# everywhere still costs the session well under 2 KB of context. Everything
# goes to the log in full.
SAID_BYTES=0
SAID_CAPPED=0
# blen TEXT: TEXT's length in bytes, in BLEN. In a UTF-8 locale ${#x} counts
# characters, and multibyte text would pass the caps several times over.
blen() { local LC_ALL=C; BLEN=${#1}; }
say() {
    printf '%s session-start: %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"
    case "$*" in
        ready*|FAILED*|skipped*|ignored*|optional*) ;;
        *) return 0 ;;
    esac
    # ${x:0:300} cuts whole characters (printf's %.300s would cut bytes and
    # can split one); the loop then trims whole characters until the line
    # fits 315 bytes, so the text that reaches the context stays valid UTF-8.
    local msg="$*" line
    line="session-start: ${msg:0:300}"
    blen "$line"
    while [ "$BLEN" -gt 315 ]; do line="${line%?}"; blen "$line"; done
    if [ "${1#ready}" != "$1" ]; then
        printf '%s\n' "$line"
    elif [ $(( SAID_BYTES + BLEN + 1 )) -le 1200 ]; then
        printf '%s\n' "$line"
        SAID_BYTES=$(( SAID_BYTES + BLEN + 1 ))
    elif [ "$SAID_CAPPED" = 0 ]; then
        printf 'session-start: further messages omitted; see %s\n' "$LOG"
        SAID_CAPPED=1
    fi
}

echo "----- session-start: $(date -u +%FT%TZ) repo=$REPO -----" >>"$LOG"

# One provisioning run per repository at a time. SessionStart fires again on
# /clear and on resume while a first run may still be installing; the second
# run waits here instead of writing into the same virtualenv concurrently.
# The lock descriptor is allocated, never fixed: a launcher may already use
# fd 9 for its own control pipe.
# The wait lasts as long as the holder may legally run, the whole budget,
# and a run that had to wait keeps at least 240 s for its probes:
# with the lock wait inside the budget that still ends before the 3600 s
# hook timeout.
exec {LOCK_FD}>"$LOCK"
if command -v flock >/dev/null 2>&1 && ! flock -n "$LOCK_FD"; then
    lock_wait=$(( DEADLINE - $(date +%s) ))
    [ "$lock_wait" -gt 0 ] || lock_wait=1
    if ! flock -w "$lock_wait" "$LOCK_FD"; then
        say "FAILED another bootstrap for $REPO still holds $LOCK after ${lock_wait}s; nothing provisioned"
        say "ready repo=$REPO missing=lock log=$LOG"
        exit 0
    fi
    lock_floor=$(( $(date +%s) + 240 ))
    [ "$DEADLINE" -ge "$lock_floor" ] || DEADLINE=$lock_floor
fi

# A manifest that does not parse, or names a schema this engine does not know,
# is reported and never cached: every later lookup would otherwise read as
# "absent" and the run would look complete.
if ! manifest_error="$(python3 -I - "$MANIFEST" <<'PY' 2>&1
import json, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:  # noqa: BLE001 - the message is the report
    sys.exit(f"unreadable JSON: {exc}")
if not isinstance(doc, dict):
    sys.exit("top level is not an object")
if doc.get("schema_version") != 1:
    sys.exit(f"schema_version {doc.get('schema_version')!r} is not 1")
for key in ("python", "node"):
    if key in doc and not isinstance(doc[key], dict):
        sys.exit(f"{key} is not an object")
for key in ("apt", "binaries", "post", "cache_inputs"):
    if key in doc and not isinstance(doc[key], list):
        sys.exit(f"{key} is not a list")
if "env" in doc and not isinstance(doc["env"], dict):
    sys.exit("env is not an object")
import re
def strings(value, where):
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        sys.exit(f"{where} must be a list of non-empty strings")
    # The engine reads each list back one entry per line.
    for v in value:
        if any(c in v for c in "\n\r\0"):
            sys.exit(f"{where} entry {v!r} must be a single line")
py = doc.get("python", {})
for key in ("requirements", "packages", "install", "probe"):
    if key in py:
        strings(py[key], f"python.{key}")
for key in ("version", "env_dir"):
    if key in py and not (isinstance(py[key], str) and py[key].strip()):
        sys.exit(f"python.{key} must be a non-empty string")
# The engine compares major.minor with the virtualenv's interpreter, so a
# patch pin such as 3.12.3 could never match and would never cache.
if "version" in py and not re.fullmatch(r"[0-9]+\.[0-9]+", py["version"]):
    sys.exit(f"python.version {py['version']!r} must be major.minor, such as 3.12")
# Without a version the venv would be built with whatever interpreter the
# image happens to provide, which a cloud-image update can change silently.
if "python" in doc and "version" not in py:
    sys.exit("python.version is required (major.minor, matching CI)")
# A probe is pasted into `python -c "import ..."`, so each entry must be a
# dotted module name; anything else is a manifest mistake, reported here.
for mod in py.get("probe") or []:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*", mod):
        sys.exit(f"python.probe entry {mod!r} is not a dotted module name")
if "system_site_packages" in py and not isinstance(py["system_site_packages"], bool):
    sys.exit("python.system_site_packages must be true or false")
if "uv_sync" in py:
    sync = py["uv_sync"]
    if not isinstance(sync, dict):
        sys.exit("python.uv_sync must be an object")
    for key in ("extras", "groups"):
        if key in sync:
            strings(sync[key], f"python.uv_sync.{key}")
    for key in ("frozen", "all_extras"):
        if key in sync and not isinstance(sync[key], bool):
            sys.exit(f"python.uv_sync.{key} must be true or false")
node = doc.get("node", {})
if node:
    if node.get("manager") not in ("npm", "pnpm", "bun"):
        sys.exit("node.manager must be npm, pnpm or bun")
    if "dirs" in node:
        strings(node["dirs"], "node.dirs")
    for key in ("args", "post"):
        if key in node:
            strings(node[key], f"node.{key}")
    # The install is frozen by design and the engine passes the frozen flag
    # itself, so an argument may not name a lockfile option in any form: a
    # separate value (`--frozen-lockfile false`) or an abbreviation that the
    # manager expands would undo it as surely as `=false`.
    LOCK_OPTS = ("--frozen-lockfile", "--no-frozen-lockfile", "--prefer-frozen-lockfile",
                 "--package-lock", "--no-package-lock", "--lockfile", "--no-lockfile", "--frozen")
    for arg in node.get("args") or []:
        opt = arg.split("=", 1)[0]
        if opt.startswith("--") and len(opt) > 4 and any(o.startswith(opt) for o in LOCK_OPTS):
            sys.exit(f"node.args entry {arg!r} names a lockfile option; the engine keeps the install frozen")
for key in ("apt", "post", "cache_inputs", "outputs"):
    if key in doc:
        strings(doc[key], key)
# The probe asks dpkg about each entry, so it must be a package name with an
# optional architecture and an optional exact version (`bash=5.2.21-2`);
# apt-get's release (`pkg/noble`) and glob forms have no dpkg answer.
for pkg in doc.get("apt") or []:
    if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?(=[A-Za-z0-9.+~:-]+)?", pkg):
        sys.exit(f"apt entry {pkg!r} must be a package name, optionally :arch and =version")
# Names the engine itself publishes, or that would change who the session is,
# cannot come from a manifest.
reserved = {"PATH", "HOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "SHELL", "USER", "PYTHONHOME"}
# Bash ignores an assignment to these (readonly or recomputed on every read),
# so the session would silently keep the shell's value.
reserved |= {"EUID", "UID", "PPID", "SHELLOPTS", "GROUPS", "FUNCNAME", "RANDOM", "SRANDOM",
             "SECONDS", "LINENO", "HISTCMD", "EPOCHSECONDS", "EPOCHREALTIME", "DIRSTACK",
             "PIPESTATUS", "IFS", "PWD", "OLDPWD"}
for name, value in doc.get("env", {}).items():
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        sys.exit(f"env name {name!r} is not a valid variable name")
    if name in reserved or name.startswith(("SESSION_BOOTSTRAP_", "CLAUDE_", "BASH")):
        sys.exit(f"env name {name} is reserved")
    if not isinstance(value, str):
        sys.exit(f"env.{name} must be a string")
    if "{venv}" in value and "python" not in doc:
        sys.exit(f"env.{name} names {{venv}}, but the manifest declares no python section")
for spec in doc.get("binaries", []):
    if not isinstance(spec, dict):
        sys.exit("a binaries entry is not an object")
    for field in ("name", "version", "url", "sha256"):
        if not (isinstance(spec.get(field), str) and spec[field].strip()):
            sys.exit(f"binaries entry {spec.get('name', '?')!r} has no {field}")
    if not re.fullmatch(r"[0-9a-f]{64}", spec["sha256"]):
        sys.exit(f"binaries entry {spec['name']!r} sha256 is not 64 lowercase hex digits")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", spec["name"]) or not re.fullmatch(r"[A-Za-z0-9._+-]+", spec["version"]):
        sys.exit(f"binaries entry {spec['name']!r} has an unsafe name or version")
    if spec.get("archive", "none") not in ("zip", "tar.gz", "tgz", "none"):
        sys.exit(f"binaries entry {spec['name']!r} archive must be zip, tar.gz, tgz or none")
    # member names a file inside the download; it is extracted under a fresh
    # temporary directory, so it must stay a relative path inside it.
    if "member" in spec:
        member = spec["member"]
        if not (isinstance(member, str) and member.strip()) or member.startswith("/") \
                or ".." in member.split("/"):
            sys.exit(f"binaries entry {spec['name']!r} member must be a relative path inside the archive")
if "timeout_seconds" in doc and (isinstance(doc["timeout_seconds"], bool)
                                or not (isinstance(doc["timeout_seconds"], int) and doc["timeout_seconds"] > 0)):
    sys.exit("timeout_seconds must be a positive integer")
# A misspelt key would otherwise be ignored and the run would still look
# complete, so every object accepts only the keys this engine reads.
ALLOWED = {
    "top level": {"schema_version", "python", "node", "apt", "binaries", "post",
                  "cache_inputs", "outputs", "env", "timeout_seconds"},
    "python": {"version", "system_site_packages", "env_dir", "uv_sync",
               "requirements", "packages", "install", "probe"},
    "python.uv_sync": {"frozen", "extras", "all_extras", "groups"},
    "node": {"manager", "dirs", "args", "post"},
    "binaries entry": {"name", "version", "url", "sha256", "archive", "member"},
}
def known(obj, where):
    extra = sorted(set(obj) - ALLOWED[where])
    if extra:
        sys.exit(f"{where} has unknown key(s): {', '.join(extra)}")
known(doc, "top level")
known(py, "python")
known(py.get("uv_sync") or {}, "python.uv_sync")
known(node, "node")
# bin/<slot> comes first on PATH for the session and for this engine, so a
# pinned binary may not take the name of a command the engine runs, and two
# entries may not share one link.
ENGINE_COMMANDS = {"apt-get", "awk", "basename", "bash", "cat", "comm", "curl", "cut", "date",
                   "dirname", "dpkg-query", "env", "flock", "git", "grep", "head",
                   "id", "install", "ln", "mkdir", "mktemp", "mv", "printf", "readlink",
                   "rm", "sed", "sh", "sha256sum", "sort", "tar", "timeout", "tr", "wc"}
names = set()
for spec in doc.get("binaries", []):
    known(spec, "binaries entry")
    if spec["name"] in ENGINE_COMMANDS or re.fullmatch(r"python[0-9.]*", spec["name"]):
        sys.exit(f"binaries entry {spec['name']!r} would shadow a command the engine runs")
    if spec["name"] in names:
        sys.exit(f"binaries entry {spec['name']!r} is declared twice")
    names.add(spec["name"])
# A post step's output in bin/ is on PATH ahead of the base PATH too, so it
# may not take an engine command's name either.
# It must be one plain file name: "{bin}/./git" would dodge this check and
# "{bin}/../x" would let the cleanup of retired outputs delete outside bin/.
for out in doc.get("outputs") or []:
    if out.startswith("{bin}"):
        name = out[len("{bin}/"):]
        if not out.startswith("{bin}/") or not re.fullmatch(r"[A-Za-z0-9_+-][A-Za-z0-9._+-]*", name):
            sys.exit(f"output {out!r} must name one file directly in {{bin}}")
        if name in ENGINE_COMMANDS or re.fullmatch(r"python[0-9.]*", name):
            sys.exit(f"output {out!r} would shadow a command the engine runs")
        # A binary's {bin} entry is a link into the shared tools/ store; a
        # post step writing through it would corrupt the verified artifact.
        if name in names:
            sys.exit(f"output {out!r} has the name of a declared binary")
# A local project installed without -e is a copy that the next source change
# leaves stale while the cache still reads as current. Local files (a wheel)
# are fingerprinted instead.
import os, shlex
root = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1])))
VALUE_OPTS = {"-r", "--requirement", "-c", "--constraint", "-i", "--index-url",
              "--extra-index-url", "-f", "--find-links", "--index-strategy", "-p",
              "--python", "--only-binary", "--no-binary", "--target", "--prefix",
              "--config-settings", "-C", "--trusted-host", "--upgrade-strategy"}
LOCATION_OPTS = ("--target", "--prefix", "--root", "--user", "--system", "--python")
def direct_target(spec):
    """The target of a PEP 508 direct reference ("pkg @ file:///x.whl"),
    or the spec itself when it is not one."""
    m = re.fullmatch(r"\s*[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*@\s*(\S[^;]*?)\s*(;.*)?", spec)
    return m.group(2) if m else spec


for where, entries in (("python.packages", py.get("packages") or []),
                       ("python.install", py.get("install") or [])):
    for entry in entries:
        try:
            tokens = shlex.split(entry.lstrip("?")) if where == "python.install" else [entry]
        except ValueError as exc:
            sys.exit(f"{where} entry {entry!r} does not parse: {exc}")
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            # Every install lands in the session virtualenv, never beside it.
            # Short options also take an attached value (`-t/tmp`, `-p3.11`),
            # and pip expands an unambiguous abbreviation (`--targ`), so both
            # forms are refused too; `--pre` is its own pip option.
            opt = tok.split("=", 1)[0]
            if (not opt.startswith("--") and opt[:2] in ("-t", "-p")) \
                    or (opt.startswith("--") and len(opt) > 3 and opt != "--pre"
                        and any(o.startswith(opt) for o in LOCATION_OPTS)):
                sys.exit(f"{where} entry {entry!r} may not choose its own install location ({opt})")
            if tok in ("-e", "--editable") or (tok in VALUE_OPTS and "=" not in tok):
                i += 2
                continue
            i += 1
            # "pkg @ target" splits into three words: skip the name and the @.
            if tok.startswith("-") or tok == "@" or (i < len(tokens) and tokens[i] == "@"):
                continue
            target = direct_target(tok)
            target = target.split("[", 1)[0] if target == tok else target
            target = target[len("file:"):] if target.startswith("file:") else target
            if "://" not in target and os.path.isdir(os.path.join(root, target)):
                sys.exit(f"{where} entry {entry!r} installs the local project {target!r} without -e")
PY
)"; then
    clear_published
    case $? in
        0) say "cleared what an earlier manifest published, because this one is invalid" ;;
        2) say "FAILED could not write CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE to clear what an earlier manifest published" ;;
    esac
    rm -f "$STATE"
    say "FAILED manifest .claude/session-bootstrap.json: $manifest_error"
    say "ready repo=$REPO missing=manifest log=$LOG"
    exit 0
fi
STEP_TIMEOUT="$(python3 -I -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("timeout_seconds", 900)))' "$MANIFEST" 2>/dev/null || echo 900)"
run() {
    local left=$(( DEADLINE - $(date +%s) ))
    if [ "$left" -le 0 ]; then
        printf 'session-start: budget exhausted before: %s\n' "$*" >>"$LOG"
        return 124
    fi
    [ "$left" -lt "$STEP_TIMEOUT" ] || left="$STEP_TIMEOUT"
    # No step reads the manifest loops' input, and none keeps the lock: a
    # background process a step leaves behind must not hold the lock after exit.
    # -k: a step that ignores SIGTERM is killed 10 s later, so it cannot
    # outlive the overall budget the hook timeout depends on.
    timeout -k 10 "$left" env "${STEP_UNSET[@]}" "${STEP_ENV[@]}" "$@" </dev/null >>"$LOG" 2>&1 {LOCK_FD}>&-
}

# mf KEY [SUBKEY]: print one manifest value per line (arrays expand; scalars
# print once; objects print nothing). Absent keys print nothing.
mf() {
    python3 -I - "$MANIFEST" "$@" <<'PY'
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    node = node.get(key) if isinstance(node, dict) else None
def render(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return str(value)
    return json.dumps(value)
if isinstance(node, list):
    for item in node:
        print(render(item))
elif isinstance(node, dict):
    pass
elif node is not None:
    print(render(node))
PY
}
# mf_has KEY [SUBKEY]: succeed when the key path exists in the manifest.
mf_has() {
    python3 -I - "$MANIFEST" "$@" <<'PY'
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    if not isinstance(node, dict) or key not in node:
        sys.exit(1)
    node = node[key]
sys.exit(0)
PY
}
# jf JSON FIELD [DEFAULT]: one field of a JSON object passed as text.
jf() { python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], sys.argv[3]))' "$1" "$2" "${3:-}"; }

# fingerprint: sha256 over the engine, the manifest and every dependency input
# the manifest names, so a pulled lockfile or requirements change re-provisions
# even when the manifest itself is unchanged.
# `fingerprint python` covers only the Python section and its inputs; the
# engine keys its virtualenv on it.
fingerprint() {
    # Bounded by the overall deadline: a broad cache_inputs glob over a large
    # ignored tree must not consume the time the summary needs.
    local left=$(( DEADLINE - $(date +%s) ))
    [ "$left" -gt 0 ] || return 1
    timeout -k 10 "$left" python3 -I - "$ENGINE" "$MANIFEST" "$PROJECT_DIR" "${1:-all}" <<'PY'
import glob, hashlib, json, os, re, shlex, subprocess, sys
engine, manifest, root, scope = sys.argv[1:5]
doc = json.load(open(manifest, encoding="utf-8"))
py = doc.get("python") or {}
node = doc.get("node") or {}
inputs = set()
for name in ("pyproject.toml", "setup.py", "setup.cfg"):
    if py:
        inputs.add(name)
if "uv_sync" in py:
    inputs.add("uv.lock")
    # uv sync installs every member of a uv workspace, so each member's
    # pyproject.toml is a dependency input too.
    try:
        import tomllib
        with open(os.path.join(root, "pyproject.toml"), "rb") as fh:
            workspace = (tomllib.load(fh).get("tool") or {}).get("uv", {}).get("workspace") or {}
    except (ImportError, OSError, ValueError):
        workspace = {}
    excluded = set()
    for pattern in workspace.get("exclude") or []:
        if isinstance(pattern, str):
            excluded.update(glob.glob(os.path.join(root, pattern)))
    for pattern in workspace.get("members") or []:
        if isinstance(pattern, str):
            for member in glob.glob(os.path.join(root, pattern)):
                if member not in excluded and os.path.isfile(os.path.join(member, "pyproject.toml")):
                    inputs.add(os.path.relpath(os.path.join(member, "pyproject.toml"), root))
INCLUDE_FLAGS = ("-r", "--requirement", "-c", "--constraint")
def pnpm_members(path):
    """The `packages` globs of a pnpm-workspace.yaml, read without a YAML
    library: a block list (`- 'apps/*'`) or a flow list (`[a, b]`)."""
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    found, inside = [], False
    for line in lines:
        text = line.split("#", 1)[0].rstrip()
        if not text.strip():
            continue
        if not line[:1].isspace():
            key, _, rest = text.partition(":")
            inside = key.strip() == "packages"
            rest = rest.strip()
            if inside and rest.startswith("["):
                found += [m.strip().strip("'\"") for m in rest.strip("[]").split(",")]
                inside = False
        elif inside and text.strip().startswith("-"):
            found.append(text.strip()[1:].strip().strip("'\""))
    return [m for m in found if m]


def direct_target(spec):
    """The target of a PEP 508 direct reference ("pkg @ file:///x.whl"),
    or the spec itself when it is not one."""
    m = re.fullmatch(r"\s*[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*@\s*(\S[^;]*?)\s*(;.*)?", spec)
    return m.group(2) if m else spec


def includes(tokens, base):
    def path(value):
        return os.path.normpath(os.path.join(base, value))
    for flag, value in zip(tokens, tokens[1:] + [""]):
        if flag in INCLUDE_FLAGS:
            if value:
                yield path(value)
        elif flag.startswith(("--requirement=", "--constraint=")):
            yield path(flag.split("=", 1)[1])
        elif flag[:2] in ("-r", "-c") and len(flag) > 2:
            # The compact form pip and uv both accept: -rFILE, -cFILE.
            yield path(flag[2:])
pending = list(py.get("requirements") or [])
# `install` entries are split with shell rules; each `packages` entry is one
# installer argument, exactly as the engine passes them.
local_files = []
VALUE_OPTS = {"-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i",
              "--index-url", "--extra-index-url", "-f", "--find-links"}
for tokens in [shlex.split(e.lstrip("?")) for e in py.get("install") or []] + \
              [[e] for e in py.get("packages") or []]:
    pending.extend(includes(tokens, ""))
    # A local wheel or sdist is part of what gets installed. Option values
    # (a requirements file after -r) are not targets: they are followed as
    # includes below.
    skip = False
    for n, tok in enumerate(tokens):
        if skip or tok.startswith("-"):
            skip = not skip and tok in VALUE_OPTS
            continue
        if tok == "@" or tokens[n + 1:n + 2] == ["@"]:
            continue
        target = direct_target(tok)
        target = target.split("[", 1)[0] if target == tok else target
        target = target[len("file:"):] if target.startswith("file:") else target
        if "://" not in target and os.path.isfile(os.path.join(root, target)):
            local_files.append(os.path.normpath(target))
    # An editable subproject's packaging metadata decides its dependencies
    # and entry points, like the root project's does.
    for flag, value in zip(tokens, tokens[1:] + [""]):
        if flag.startswith("--editable="):
            value = flag[len("--editable="):]
        elif flag.startswith("-e") and len(flag) > 2 and not flag.startswith("--"):
            value = flag[2:]  # the compact form pip accepts: -ePATH
        elif flag not in ("-e", "--editable"):
            continue
        value = value.split("[", 1)[0]
        value = value[len("file:"):] if value.startswith("file:") else value
        if value and "://" not in value and os.path.isdir(os.path.join(root, value)):
            for name in ("pyproject.toml", "setup.py", "setup.cfg"):
                local_files.append(os.path.normpath(os.path.join(value, name)))
# Requirement files may include others (-r/-c); follow them so a change to
# a nested lock invalidates the cache too.
while pending:
    rel = pending.pop()
    if rel in inputs:
        continue
    inputs.add(rel)
    full = os.path.join(root, rel)
    if os.path.isfile(full):
        # pip joins a line that ends in a backslash with the next one.
        text = re.sub(r"\\\r?\n", " ", open(full, encoding="utf-8", errors="replace").read())
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if line.startswith(("-r", "-c", "--requirement", "--constraint")):
                try:
                    pending.extend(includes(shlex.split(line), os.path.dirname(rel)))
                except ValueError:
                    # A dangling "-r \" at the end of the file: the installer
                    # rejects it too, and the file itself is already hashed.
                    pass
                continue
            # A local wheel, sdist or editable project named in the file is
            # part of what gets installed, like one named in the manifest.
            # pip resolves such paths against the working directory, and
            # some tools against the file's own directory; both are hashed.
            if re.match(r"-e[^\s-]", line):
                line = "-e " + line[2:]  # the compact form: -ePATH
            editable = line.startswith(("-e ", "--editable ", "--editable="))
            if line.startswith("-") and not editable:
                continue
            try:
                words = shlex.split(line.replace("--editable=", "--editable ", 1))
            except ValueError:
                continue
            if not words:
                continue
            if editable:
                target = words[1] if len(words) > 1 else ""
            elif len(words) >= 3 and words[1] == "@":
                target = words[2]  # a direct reference: pkg @ target
            else:
                target = direct_target(words[0])
            target = target.split(";", 1)[0].split("[", 1)[0]
            target = target[len("file:"):] if target.startswith("file:") else target
            if not target or "://" in target:
                continue
            for base in ("", os.path.dirname(rel)):
                cand = os.path.normpath(os.path.join(base, target))
                full_cand = os.path.join(root, cand)
                if os.path.isfile(full_cand):
                    local_files.append(cand)
                elif os.path.isdir(full_cand) and editable:
                    for name in ("pyproject.toml", "setup.py", "setup.cfg"):
                        local_files.append(os.path.normpath(os.path.join(cand, name)))
                elif os.path.isdir(full_cand):
                    # Without -e the installer copies the whole project, so
                    # every tracked file under it decides what is installed.
                    listed = subprocess.run(["git", "-C", root, "ls-files", "-z", "--", cand],
                                            capture_output=True, check=False).stdout
                    local_files.extend(os.path.normpath(f) for f in listed.decode().split("\0") if f)
inputs.update(local_files)
members = set()
for directory in (node.get("dirs") or ["."]) if node and scope in ("all", "members") else []:
    for name in ("package.json", "package-lock.json", "npm-shrinkwrap.json",
                 "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bun.lock",
                 "bun.lockb", "bunfig.toml", ".npmrc"):
        inputs.add(os.path.normpath(os.path.join(directory, name)))
    # npm and bun workspaces: each member's package.json is a dependency input.
    try:
        workspaces = json.load(open(os.path.join(root, directory, "package.json"))).get("workspaces") or []
    except (OSError, ValueError):
        workspaces = []
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages") or []
    workspaces = list(workspaces) if isinstance(workspaces, list) else []
    workspaces += pnpm_members(os.path.join(root, directory, "pnpm-workspace.yaml"))
    for member in workspaces:
        if isinstance(member, str) and not member.startswith("!"):
            for path in glob.glob(os.path.join(root, directory, member, "package.json"), recursive=True):
                inputs.add(os.path.relpath(path, root))
                members.add(os.path.relpath(os.path.dirname(path), root))
    for patch in glob.glob(os.path.join(root, directory, "patches", "**"), recursive=True):
        if os.path.isfile(patch):
            inputs.add(os.path.relpath(patch, root))
# `fingerprint members` prints the workspace member directories instead: the
# install may write a node_modules/ in each of them.
if scope == "members":
    for member in sorted(members):
        print(member)
    sys.exit(0)
# cache_inputs join the Python key too: a nested project's pyproject.toml
# listed there changes what the installers resolve.
for pattern in doc.get("cache_inputs") or []:
    matches = glob.glob(os.path.join(root, pattern), recursive=True)
    for m in matches:
        # A directory stands for every file beneath it.
        files = [m] if os.path.isfile(m) else [
            os.path.join(d, f) for d, _, fs in os.walk(m) for f in fs] if os.path.isdir(m) else []
        inputs.update(os.path.relpath(f, root) for f in files)
    if not matches:
        inputs.add(pattern)
digest = hashlib.sha256()
if scope == "python":
    # The manifest env reaches every installer (PIP_INDEX_URL, UV_INDEX), so
    # a change to it is a change to what gets installed.
    # apt joins it as well: a newly installed system library or header lets
    # pip build a package differently than in the old virtualenv.
    digest.update(json.dumps([py, doc.get("env") or {}, doc.get("apt") or []], sort_keys=True).encode())
else:
    for path in [engine, manifest]:
        digest.update(open(path, "rb").read())
for rel in sorted(inputs):
    full = os.path.join(root, rel)
    digest.update(rel.encode() + b"\0")
    digest.update(open(full, "rb").read() if os.path.isfile(full) else b"<absent>")
    digest.update(b"\0")
print(digest.hexdigest())
PY
}
# expand VALUE: the {root}, {bin}, {venv} and {repo} placeholders.
expand() {
    local value="$1"
    value="${value//'{root}'/"$ROOT"}"
    value="${value//'{bin}'/"$BIN"}"
    value="${value//'{venv}'/"$VENV"}"
    printf '%s' "${value//'{repo}'/"$PROJECT_DIR"}"
}
ENV_FILE_OK=1
# vpy ARGS: the virtualenv's interpreter, bounded. A .pth file or
# sitecustomize that blocks would otherwise hang the engine past its deadline.
vpy() { timeout -k 5 60 "$VENV/bin/python" "$@"; }
env_export() {
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        printf 'export %s=%q\n' "$1" "$2" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
    fi
    export "$1=$2"
}

if mf_has python; then WANT_PYTHON=1; else WANT_PYTHON=0; fi

# A repository whose own tooling only finds an in-tree virtualenv may name a
# relative directory in python.env_dir. The engine accepts it only when git
# already ignores that path, so the tree stays clean.
venv_rel="$(mf python env_dir)"
if [ -n "$venv_rel" ]; then
    case "$venv_rel" in
        /*|..|../*|*/..|*/../*|.|./) say "ignored python.env_dir=$venv_rel: it must be a relative path inside the repository"; venv_rel="" ;;
    esac
fi
if [ -n "$venv_rel" ]; then
    if git -C "$PROJECT_DIR" check-ignore -q "$venv_rel/" 2>/dev/null; then
        VENV="$PROJECT_DIR/$venv_rel"
    else
        say "ignored python.env_dir=$venv_rel because git does not ignore it; using $VENV"
    fi
fi
export SESSION_BOOTSTRAP_ROOT="$ROOT" SESSION_BOOTSTRAP_BIN="$BIN" SESSION_BOOTSTRAP_VENV="$VENV"
# An in-tree env_dir lies outside $ROOT, so strip its bin directory as well.
BASE_PATH="$(strip_path "$BASE_PATH" "$VENV/bin")"
export PATH="$BIN:$BASE_PATH"

VENV_ENV=()
# ---------------------------------------------------------------- environment
# Exported first so a cached run still re-publishes PATH into the new session.
# The virtualenv is published only once it exists and runs (publish_python),
# so neither the session nor this engine's own helpers ever run a broken or
# half-built venv's python3, and a venv left behind by an earlier manifest
# cannot shadow the base interpreter.
env_export PATH "$BIN:$BASE_PATH"
# unpublish_python: clear what an earlier session published for Python.
unpublish_python() {
    local pair
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        printf 'unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT\n' >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
        for pair in "${VENV_ENV[@]}"; do
            printf 'unset %s\n' "${pair%%=*}" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
        done
    fi
    unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT
}
# publish_python: put a working virtualenv on the session PATH, or clear it.
publish_python() {
    # WANT_PYTHON=0 was cleared at the start; a refused virtualenv (wrong
    # interpreter, not this engine's to rebuild) is never published.
    case "$WANT_PYTHON" in
        0) return 0 ;;
        1) ;;
        *) unpublish_python; return 0 ;;
    esac
    if [ -x "$VENV/bin/python" ] && vpy -c '' >/dev/null 2>&1; then
        env_export PATH "$BIN:$VENV/bin:$BASE_PATH"
        env_export VIRTUAL_ENV "$VENV"
        env_export UV_PROJECT_ENVIRONMENT "$VENV"
        local pair
        for pair in "${VENV_ENV[@]}"; do
            if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
                printf 'export %s=%q\n' "${pair%%=*}" "${pair#*=}" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
            fi
        done
    else
        unpublish_python
    fi
}
if [ "$WANT_PYTHON" != 1 ]; then
    # A previous manifest may have declared Python: clear what it published and
    # remove its out-of-tree environment. A virtualenv the user activated is
    # not the engine's and stays published.
    [ "$INHERITED_VENV_OURS" = 1 ] && unpublish_python
    [ -d "$ROOT/venv/$SLOT" ] && rm -rf "${ROOT:?}/venv/${SLOT:?}"
    rm -f "$PY_STATE"
fi
# A value that names the virtualenv ({venv}) reaches the session only with
# the virtualenv itself (publish_python), so a failed build never leaves the
# session pointing at a missing interpreter.
VENV_ENV=()
while IFS= read -r name; do
    [ -n "$name" ] || continue
    raw="$(mf env "$name")"
    value="$(expand "$raw")"
    case "$raw" in
        *'{venv}'*) VENV_ENV+=("$name=$value") ;;
        *)
            if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
                printf 'export %s=%q\n' "$name" "$value" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
            fi ;;
    esac
    STEP_ENV+=("$name=$value")
done < <(python3 -I -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1])).get("env",{})]' "$MANIFEST")
# A name an earlier manifest published and this one dropped is unset, so a
# resumed or cleared session does not keep the old value.
env_names="$(python3 -I -c 'import json,sys; [print(k) for k in sorted(json.load(open(sys.argv[1])).get("env",{}))]' "$MANIFEST")"
if [ -f "$ENV_NAMES" ]; then
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        printf '%s\n' "$env_names" | grep -qxF "$name" && continue
        # A name the engine exports itself (CI, a cache directory) keeps the
        # engine's value in steps; only the session loses the manifest's.
        case " $ENGINE_EXPORTS " in
            *" $name "*) ;;
            *) STEP_UNSET+=(-u "$name") ;;
        esac
        if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
            printf 'unset %s\n' "$name" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
        fi
    done <"$ENV_NAMES"
fi
# The state keeps every name any run published, not only this manifest's:
# another session of the same checkout may still carry a name an older
# manifest gave it, and unsetting a name that is not set is harmless.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ "$ENV_FILE_OK" = 1 ]; then
    { printf '%s\n' "$env_names"; if [ -f "$ENV_NAMES" ]; then cat "$ENV_NAMES"; fi; } \
        | { grep . || true; } | sort -u >"$ENV_NAMES.tmp" && mv -f "$ENV_NAMES.tmp" "$ENV_NAMES"
fi
# The session only sees PATH and the manifest's variables through
# CLAUDE_ENV_FILE; an install it cannot publish is not ready.
if [ "$ENV_FILE_OK" = 0 ]; then
    say "FAILED could not write the session environment to CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE"
    MISSING+=("env-file")
elif [ -z "${CLAUDE_ENV_FILE:-}" ]; then
    say "skipped publishing the environment: CLAUDE_ENV_FILE is not set (expected only in a manual run)"
fi

# --------------------------------------------------------------- cached run?
# apt_installed NAME: the package is installed, or an installed package
# provides it (Ubuntu 24.04 ships libgtk-3-0 as libgtk-3-0t64, which provides
# the old name, so `dpkg -s libgtk-3-0` alone fails on every run).
# An entry pinned to a version (`bash=5.2.21-2`) is installed only at exactly
# that version, and no other package's Provides can stand in for it.
apt_installed() {
    case "$1" in
        *=*) [ "$(dpkg-query -W -f='${db:Status-Abbrev}|${Version}' "${1%%=*}" 2>/dev/null | cut -c1-2,4-)" = "ii|${1#*=}" ]
             return ;;
    esac
    [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null | cut -c1-2)" = "ii" ] && return 0
    dpkg-query -W -f='${db:Status-Abbrev} ${Provides}\n' 2>/dev/null | awk -v want="$1" '
        $1 == "ii" { for (i = 2; i <= NF; i++) { name = $i; sub(/,$/, "", name); if (name == want) found = 1 } }
        END { exit !found }'
}
venv_matches() {
    [ -x "$VENV/bin/python" ] || return 1
    local want have want_site have_site
    want="$(mf python version)"
    if [ -n "$want" ]; then
        have="$(vpy -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)"
        [ "$have" = "$want" ] || return 1
    fi
    want_site="false"
    [ "$(mf python system_site_packages)" = "true" ] && want_site="true"
    have_site="$(sed -n 's/^include-system-site-packages *= *//p' "$VENV/pyvenv.cfg" 2>/dev/null | tr -d '[:space:]')"
    [ "$have_site" = "$want_site" ]
}
probe_python() {
    [ "$WANT_PYTHON" = 1 ] || return 0
    venv_matches || return 1
    local mods
    mods="$(mf python probe | tr '\n' ' ')"
    [ -n "$mods" ] || return 0
    # Through run: bounded by the step timeout and the overall deadline, and
    # with the manifest's env, which an import may need. It runs from the
    # virtualenv's own directory, never the checkout, so a stray yaml.py at
    # the repository root cannot stand in for the installed package; an
    # in-tree project is probed through its editable install.
    (cd "$VENV" && PYTHONDONTWRITEBYTECODE=1 run "$VENV/bin/python" -c "import $(echo "$mods" | sed 's/ *$//; s/ /, /g')")
}
# node_deps_declared DIR: package.json in DIR lists any dependency; a package
# with none never creates node_modules/ and is still provisioned.
node_deps_declared() {
    python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
meta=d.get("peerDependenciesMeta") or {}
peers=[p for p in (d.get("peerDependencies") or {}) if not (isinstance(meta.get(p),dict) and meta[p].get("optional"))]
sys.exit(0 if peers or any(d.get(k) for k in ("dependencies","devDependencies","optionalDependencies","workspaces")) else 1)' "$PROJECT_DIR/$1/package.json" 2>/dev/null \
        || [ -f "$PROJECT_DIR/$1/pnpm-workspace.yaml" ]
}
node_dirs() { mf node dirs | grep . || echo .; }
probe_node() {
    local manager dir
    manager="$(mf node manager)"
    [ -n "$manager" ] || return 0
    command -v "$manager" >/dev/null 2>&1 || return 1
    while IFS= read -r dir; do
        [ -d "$PROJECT_DIR/$dir/node_modules" ] || ! node_deps_declared "$dir" || return 1
    done < <(node_dirs)
    return 0
}
# The verified artifact for a binary lives at
# tools/<name>/<version>-<sha256 of the download>-<digest of archive+member>/<name>,
# and bin/<slot>/<name> links to it. A different version already on PATH, a
# sibling repository's pin, the same version with another checksum, another
# file taken from the same archive, or the same download read as another
# archive type never satisfies this manifest.
binary_target() {
    printf '%s/%s/%s-%s-%s/%s' "$TOOLS_DIR" "$1" "$2" "$3" \
        "$(printf '%s\0%s' "$5" "$4" | sha256sum | cut -c1-12)" "$1"
}
# binary_intact TARGET: the installed file still has the content recorded at
# install time. tools/ is shared by every checkout, so a file another session
# changed is reinstalled, never reused.
binary_intact() {
    [ -f "$1.sha256" ] && [ "$(sha256sum <"$1" | cut -d' ' -f1)" = "$(cat "$1.sha256")" ]
}
probe_binaries() {
    local spec name target
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        name="$(jf "$spec" name)"
        target="$(binary_target "$name" "$(jf "$spec" version)" "$(jf "$spec" sha256)" "$(jf "$spec" member "$name")" "$(jf "$spec" archive none)")"
        [ -x "$target" ] && [ "$(readlink "$BIN/$name" 2>/dev/null)" = "$target" ] && binary_intact "$target" || return 1
    done < <(mf binaries)
    return 0
}
probe_outputs() {
    local out path
    while IFS= read -r out; do
        [ -n "$out" ] || continue
        path="$(expand "$out")"
        [ -e "$path" ] || return 1
        # A {bin} output is a command on PATH, so it must run.
        case "$out" in '{bin}/'*) [ -f "$path" ] && [ -x "$path" ] || return 1 ;; esac
    done < <(mf outputs)
    return 0
}
probe_apt() {
    local pkg
    while IFS= read -r pkg; do
        [ -n "$pkg" ] || continue
        apt_installed "$pkg" || return 1
    done < <(mf apt)
    return 0
}
# A fingerprint that cannot be computed (an unreadable input, say) is a
# failure: it is reported and never written as a valid cache key.
if ! CURRENT_FINGERPRINT="$(fingerprint 2>>"$LOG")" || [ ${#CURRENT_FINGERPRINT} -ne 64 ]; then
    say "FAILED could not fingerprint the manifest inputs (see $LOG)"
    MISSING+=("fingerprint")
    CURRENT_FINGERPRINT=""
fi
if [ "${#MISSING[@]}" -eq 0 ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$CURRENT_FINGERPRINT" ] \
    && probe_apt && probe_python && probe_node && probe_binaries && probe_outputs; then
    publish_python
    if [ "$ENV_FILE_OK" = 1 ]; then
        say "ready (cached) repo=$REPO python=$([ "$WANT_PYTHON" = 1 ] && vpy --version 2>&1 | cut -d' ' -f2 || echo none) log=$LOG"
        exit 0
    fi
    say "FAILED could not write the session environment to CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE"
    MISSING+=("env-file")
fi
rm -f "$STATE"
# A file an earlier manifest declared as an output in the session bin/, and
# the current one no longer declares, is removed so it leaves PATH.
current_outputs="$(mf outputs | while IFS= read -r out; do [ -n "$out" ] && expand "$out" && echo; done)"
if [ -f "$OUTPUTS_STATE" ]; then
    while IFS= read -r old; do
        case "$old" in "$BIN"/*/*|"$BIN"/.*) continue ;; "$BIN"/*) ;; *) continue ;; esac
        printf '%s\n' "$current_outputs" | grep -qxF "$old" && continue
        rm -f "$old" && say "removed undeclared output $old"
    done <"$OUTPUTS_STATE"
fi
# Every write is meant to land out of tree or under a gitignored path. The
# status before and after shows any install or post step that broke that (a
# nested workspace whose install writes the root node_modules/, say).
# Each dirty path carries the hash of its content, so a step that rewrites a
# file that was already modified is caught, not only a change in its status.
# -z keeps a path with a space or a quote as written, where the display form
# would quote it and the hash would read "absent" on both sides.
tree_status() {
    git -C "$PROJECT_DIR" status --porcelain -z -uall 2>/dev/null | {
        local rec xy path
        while IFS= read -r -d '' rec; do
            xy="${rec:0:2}"
            path="${rec:3}"
            # A rename or copy is followed by its source path.
            case "$xy" in R*|C*) IFS= read -r -d '' _ || true ;; esac
            printf '%s %q\t%s\n' "$xy" "$path" "$(git -C "$PROJECT_DIR" hash-object -- "$path" 2>/dev/null || echo -)"
        done
    } | sort
}
TREE_BEFORE="$(tree_status)"

# ---------------------------------------------------------------------- apt
# System packages come first: a Python probe may import a distro module
# (PyGObject) that only exists once apt has run.
apt_pkgs=()
while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    apt_installed "$pkg" || apt_pkgs+=("$pkg")
done < <(mf apt)
if [ "${#apt_pkgs[@]}" -gt 0 ]; then
    if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
        # Wait for the dpkg lock instead of failing when another session's
        # hook (or the image's own updater) holds it.
        run apt-get -o DPkg::Lock::Timeout=300 update
        if run apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends "${apt_pkgs[@]}"; then
            say "apt ok ${apt_pkgs[*]}"
        else
            say "FAILED apt ${apt_pkgs[*]} (see $LOG)"
            MISSING+=("apt:${apt_pkgs[*]}")
        fi
    else
        say "skipped apt (${apt_pkgs[*]}): apt-get unavailable or not root"
        MISSING+=("apt:${apt_pkgs[*]}")
    fi
fi

# ----------------------------------------------------------------- binaries
# Pinned binaries come before Python and Node, so a manifest that pins uv
# gets that uv for the virtualenv and uv_sync on the same run.
while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    name="$(jf "$spec" name)"
    version="$(jf "$spec" version)"
    url="$(jf "$spec" url)"
    sha="$(jf "$spec" sha256)"
    archive="$(jf "$spec" archive none)"
    member="$(jf "$spec" member "$name")"
    target="$(binary_target "$name" "$version" "$sha" "$member" "$archive")"
    if [ ! -x "$target" ] || ! binary_intact "$target"; then
        # Drop a link to another version first, so a failed install leaves
        # nothing on PATH that looks like the pinned tool.
        rm -f "$BIN/$name"
        if ! tmp="$(mktemp -d)" || [ -z "$tmp" ]; then
            say "FAILED could not create a temporary directory for $name"
            MISSING+=("$name"); continue
        fi
        if ! run curl -fsSL --retry 3 -o "$tmp/download" "$url"; then
            say "FAILED download $name $version from $url"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        if [ "$(sha256sum "$tmp/download" | cut -d' ' -f1)" != "$sha" ]; then
            say "FAILED sha256 mismatch for $name $version; refusing to install"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        # A failed extraction can leave a partial member behind, so the exit
        # status decides, not the file's presence alone.
        extracted=1
        case "$archive" in
            zip) run python3 -I -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$tmp/download" "$member" "$tmp" || extracted=0 ;;
            tar.gz|tgz) run tar -xzf "$tmp/download" -C "$tmp" "$member" || extracted=0 ;;
            none) mv "$tmp/download" "$tmp/$member" || extracted=0 ;;
        esac
        if [ "$extracted" = 0 ] || [ ! -f "$tmp/$member" ]; then
            say "FAILED extract $name ($archive member=$member)"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        # tools/ is shared by every checkout, so each install writes its own
        # temporary file and publishes it with one atomic rename.
        # The content digest is published before the file, so a reader that
        # sees the new file also sees its digest.
        partial=""
        digest_partial=""
        if ! { mkdir -p "$(dirname "$target")" && partial="$(mktemp "$target.partial.XXXXXX")" \
                && digest_partial="$(mktemp "$target.sha256.partial.XXXXXX")" \
                && install -m 0755 "$tmp/$member" "$partial" \
                && sha256sum <"$partial" | cut -d' ' -f1 >"$digest_partial" \
                && mv -f "$digest_partial" "$target.sha256" && mv -f "$partial" "$target"; } >>"$LOG" 2>&1; then
            [ -n "$partial" ] && rm -f "$partial"
            [ -n "$digest_partial" ] && rm -f "$digest_partial"
            say "FAILED install $name $version into $target"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        rm -rf "$tmp"
    fi
    # -T: a directory already at $BIN/$name is an error, never a place to
    # put the link.
    if ln -sfnT "$target" "$BIN/$name" 2>>"$LOG"; then
        say "binary ok $name $version"
        TOOLS+=("$name")
    else
        say "FAILED link $BIN/$name -> $target"
        MISSING+=("$name")
    fi
done < <(mf binaries)
# Drop links to pinned tools the manifest no longer declares, so a removed
# binary does not stay on PATH. Links a post step made elsewhere are kept.
declared=" $(mf binaries | while IFS= read -r spec; do jf "$spec" name; done | tr '\n' ' ') "
for link in "$BIN"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in "$TOOLS_DIR"/*) ;; *) continue ;; esac
    case "$declared" in *" $(basename "$link") "*) ;; *) rm -f "$link"; say "removed undeclared tool link $(basename "$link")" ;; esac
done

# -------------------------------------------------------------------- python
# A miss on the fingerprint re-runs every declared installer; the probe only
# checks the result. Installers are idempotent, so an unchanged environment
# costs a resolve, while a changed pin or lockfile is always applied.
if [ "$WANT_PYTHON" = 1 ]; then
    want_ver="$(mf python version)"
    # pip and uv pip only add: a requirement the manifest drops would stay
    # installed and keep imports passing that CI would fail. So the venv is
    # keyed on the Python section and its inputs, and rebuilt when they change.
    python_fingerprint="$(fingerprint python 2>>"$LOG")"
    rebuild_reason=""
    if [ -e "$VENV" ]; then
        if ! venv_matches; then
            rebuild_reason="version or system_site_packages"
        elif [ "$(cat "$PY_STATE.probe-failed" 2>/dev/null)" = "$python_fingerprint" ]; then
            # This fingerprint was installed and its probe failed: rebuilding
            # again cannot help, so the run reinstalls and reports instead.
            :
        elif [ "$(cat "$PY_STATE" 2>/dev/null)" != "$python_fingerprint" ]; then
            rebuild_reason="its Python dependency inputs changed"
        elif ! probe_python; then
            # The inputs are those of the last good install, yet an import
            # fails: a deleted or corrupted package that pip would still call
            # satisfied. Rebuild once; a probe that fails again (an in-tree
            # module with an error, say) is reported, and the probe-failed
            # marker keeps the next run from rebuilding again.
            rebuild_reason="its probe failed although its inputs are unchanged"
        fi
    fi
    # The engine deletes only a virtualenv it created: one under the session
    # root, or an in-tree python.env_dir that carries its ownership marker. A
    # developer's own environment at env_dir is used as it is, or reported.
    venv_owned=0
    case "$VENV" in "$ROOT"/*) venv_owned=1 ;; esac
    [ -f "$VENV/$OWNER_MARK" ] && venv_owned=1
    if [ -n "$rebuild_reason" ] && [ "$venv_owned" = 0 ] && [ -f "$VENV/pyvenv.cfg" ] \
        && [ "$rebuild_reason" != "version or system_site_packages" ]; then
        say "skipped rebuilding $VENV ($rebuild_reason): this engine did not create it, so it is used as it is and this run is not cached"
        rebuild_reason=""
        FOREIGN_STALE=1
    fi
    if [ -n "$rebuild_reason" ]; then
        # Only a virtualenv (it has pyvenv.cfg) that this engine created is
        # removed; anything else at that path is reported, never deleted. The
        # default location under the session root is the engine's own, so a
        # directory there that an interrupted run left without pyvenv.cfg is
        # removed too, or every later run would refuse it.
        venv_default=0
        [ "$VENV" = "$ROOT/venv/$SLOT" ] && venv_default=1
        if [ "$VENV" = "/" ] || [ "$VENV" = "$PROJECT_DIR" ] || [ "$VENV" = "$HOME" ] \
            || { [ ! -f "$VENV/pyvenv.cfg" ] && [ "$venv_default" = 0 ]; } || [ "$venv_owned" = 0 ]; then
            say "FAILED refusing to rebuild $VENV ($rebuild_reason): it is not a virtualenv this engine created"
            MISSING+=("python-venv")
            WANT_PYTHON=refused
        else
            say "python venv at $VENV does not match the manifest ($rebuild_reason); rebuilding"
            rm -rf "$VENV"
            rm -f "$PY_STATE"
        fi
    fi
    if [ "$WANT_PYTHON" = 1 ] && [ ! -x "$VENV/bin/python" ]; then
        interpreter=""
        candidates=("python$want_ver" "/usr/bin/python$want_ver" "/usr/local/bin/python$want_ver")
        # Distro packages (python3-gi, say) live in the distro interpreter's
        # dist-packages, which only a venv built from that interpreter sees.
        [ "$(mf python system_site_packages)" = "true" ] \
            && candidates=("/usr/bin/python$want_ver" "python$want_ver" "/usr/local/bin/python$want_ver")
        for cand in "${candidates[@]}"; do
            if command -v "$cand" >/dev/null 2>&1; then interpreter="$cand"; break; fi
        done
        venv_new=0
        [ -e "$VENV" ] || venv_new=1
        venv_flags=()
        if [ "$(mf python system_site_packages)" = "true" ]; then
            venv_flags+=(--system-site-packages)
        fi
        venv_rc=1
        if command -v uv >/dev/null 2>&1; then
            if [ -n "$interpreter" ]; then
                run uv venv --seed "${venv_flags[@]}" --python "$interpreter" "$VENV" && venv_rc=0
            elif [ -n "$want_ver" ]; then
                run uv venv --seed "${venv_flags[@]}" --python "$want_ver" "$VENV" && venv_rc=0
            else
                run uv venv --seed "${venv_flags[@]}" "$VENV" && venv_rc=0
            fi
        elif [ -n "$interpreter" ] || [ -z "$want_ver" ]; then
            run "${interpreter:-python3}" -m venv "${venv_flags[@]}" "$VENV" && venv_rc=0
        else
            say "FAILED python $want_ver is not installed and uv is unavailable to provide it"
        fi
        # A creation step that failed part-way (a seed that never installed
        # pip, say) can still leave bin/python behind: the exit status
        # decides, and the partial environment this run created is removed so
        # the next run rebuilds it rather than trusting it.
        if [ "$venv_rc" = 0 ] && [ -x "$VENV/bin/python" ]; then
            : >"$VENV/$OWNER_MARK"
        fi
        if [ "$venv_rc" -ne 0 ] || [ ! -x "$VENV/bin/python" ]; then
            say "FAILED python venv at $VENV (see $LOG)"
            MISSING+=("python-venv")
            # A directory this run created is removed even without
            # pyvenv.cfg (creation died before writing it); one that existed
            # before is removed only when it is a virtualenv.
            if [ "$venv_new" = 1 ] || [ -f "$VENV/pyvenv.cfg" ]; then
                [ -n "$VENV" ] && [ "$VENV" != "/" ] && [ "$VENV" != "$PROJECT_DIR" ] && rm -rf "${VENV:?}"
            fi
        fi
    fi
    if [ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ]; then
        py_rc=0
        if mf_has python uv_sync; then
            if command -v uv >/dev/null 2>&1; then
                # --python pins the virtualenv's own interpreter, so an
                # inherited UV_PYTHON cannot make sync replace the venv.
                args=(sync --python "$VENV/bin/python")
                # Never let sync rewrite uv.lock: frozen installs the lock as is,
                # and frozen=false still refuses a lock that is out of date.
                if [ "$(mf python uv_sync frozen)" = "false" ]; then args+=(--locked); else args+=(--frozen); fi
                [ "$(mf python uv_sync all_extras)" = "true" ] && args+=(--all-extras)
                while IFS= read -r extra; do [ -n "$extra" ] && args+=(--extra "$extra"); done < <(mf python uv_sync extras)
                while IFS= read -r group; do [ -n "$group" ] && args+=(--group "$group"); done < <(mf python uv_sync groups)
                UV_PROJECT_ENVIRONMENT="$VENV" run uv "${args[@]}" || py_rc=$?
            else
                say "FAILED python.uv_sync needs uv, which is not on PATH"
                py_rc=1
            fi
        fi
        # CI installs with pip, which merges every index it is given. uv's
        # default picks the first index that carries a package, so an
        # entry that adds the PyTorch CPU index would resolve differently.
        # unsafe-best-match restores pip's semantics for these pinned sets.
        pip_install() {
            if command -v uv >/dev/null 2>&1; then
                run uv pip install --python "$VENV/bin/python" --index-strategy unsafe-best-match "$@"
            else
                run "$VENV/bin/python" -m pip install "$@"
            fi
        }
        pip_args=()
        while IFS= read -r req; do
            [ -n "$req" ] || continue
            if [ -f "$req" ]; then
                pip_args+=(-r "$req")
            else
                say "FAILED python.requirements names $req, which does not exist"
                py_rc=1
            fi
        done < <(mf python requirements)
        while IFS= read -r pkg; do [ -n "$pkg" ] && pip_args+=("$pkg"); done < <(mf python packages)
        if [ "${#pip_args[@]}" -gt 0 ]; then
            pip_install "${pip_args[@]}" || py_rc=$?
        fi
        # Each `install` entry is its own invocation, so an entry may carry
        # its own flags (`--no-deps -r lock.txt`, an alternate index). An
        # entry that starts with `?` is optional: its failure is logged and
        # the next entry still runs (a fallback source for the same wheel).
        while IFS= read -r spec; do
            [ -n "$spec" ] || continue
            optional=0
            case "$spec" in "?"*) optional=1; spec="${spec#\?}";; esac
            # Split with shell quoting rules (shlex) and no globbing, so a
            # quoted argument stays one argument and `-e .[dev]` reaches the
            # installer as written.
            entry=()
            while IFS= read -r -d '' arg; do entry+=("$arg"); done < <(
                python3 -I -c 'import shlex,sys; sys.stdout.write("".join(a+"\0" for a in shlex.split(sys.argv[1])))' "$spec")
            if ! pip_install "${entry[@]}"; then
                if [ "$optional" = 1 ]; then
                    say "optional install entry failed, continuing: $spec"
                else
                    py_rc=1
                fi
            fi
        done < <(mf python install)
        if probe_python && [ "$py_rc" = 0 ]; then
            say "python ok $(vpy --version 2>&1) venv=$VENV"
            [ -n "$python_fingerprint" ] && [ "$FOREIGN_STALE" = 0 ] && printf '%s\n' "$python_fingerprint" >"$PY_STATE"
            rm -f "$PY_STATE.probe-failed"
        else
            rm -f "$PY_STATE"
            if [ "$py_rc" = 0 ] && [ -n "$python_fingerprint" ]; then
                printf '%s\n' "$python_fingerprint" >"$PY_STATE.probe-failed"
            fi
            say "FAILED python deps (rc=$py_rc; probe=$(mf python probe | tr '\n' ' ')) see $LOG"
            MISSING+=("python-deps")
        fi
    fi
fi

# Node installs, node.post and post run with the PATH the session gets:
# bin/ first, then a virtualenv that exists and runs, then the base PATH.
# They also get the virtualenv variables the session gets, so a step that
# calls `uv` or reads VIRTUAL_ENV targets the same environment.
step_path="$BIN:$BASE_PATH"
if [ "$WANT_PYTHON" = 1 ] && vpy -c '' >/dev/null 2>&1; then
    step_path="$BIN:$VENV/bin:$BASE_PATH"
    STEP_ENV+=("VIRTUAL_ENV=$VENV" "UV_PROJECT_ENVIRONMENT=$VENV")
else
    unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT
fi

# --------------------------------------------------------------------- node
# Like Python, a fingerprint miss always re-runs the frozen install, so a
# changed manager, argument list or lockfile is applied to node_modules/.
manager="$(mf node manager)"
if [ -n "$manager" ]; then
    node_args=()
    while IFS= read -r a; do [ -n "$a" ] && node_args+=("$a"); done < <(mf node args)
    node_members="$(fingerprint members 2>>"$LOG")"
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        if ! git -C "$PROJECT_DIR" check-ignore -q "$dir/node_modules/" 2>/dev/null; then
            say "skipped node install in $dir: node_modules/ is not gitignored (would dirty the tree)"
            MISSING+=("node:$dir")
            continue
        fi
        # A workspace install writes node_modules/ into members too (pnpm
        # always does), so each member's must be ignored before it starts.
        unignored=""
        while IFS= read -r member; do
            [ -n "$member" ] || continue
            git -C "$PROJECT_DIR" check-ignore -q "$member/node_modules/" 2>/dev/null || unignored="$member"
        done <<<"$node_members"
        if [ -n "$unignored" ]; then
            say "skipped node install in $dir: workspace member $unignored/node_modules/ is not gitignored (would dirty the tree)"
            MISSING+=("node:$dir")
            continue
        fi
        rc=0
        case "$manager" in
            npm)  (cd "$PROJECT_DIR/$dir" && PATH="$step_path" run npm ci --no-audit --no-fund "${node_args[@]}") || rc=$? ;;
            pnpm) (cd "$PROJECT_DIR/$dir" && PATH="$step_path" run pnpm install --frozen-lockfile "${node_args[@]}") || rc=$? ;;
            bun)  (cd "$PROJECT_DIR/$dir" && PATH="$step_path" run bun install --frozen-lockfile "${node_args[@]}") || rc=$? ;;
            *)    say "skipped node: unknown manager $manager"; rc=1 ;;
        esac
        if [ "$rc" = 0 ]; then
            say "node ok $manager $dir"
        else
            say "FAILED node $manager in $dir (rc=$rc) see $LOG"
            MISSING+=("node:$dir")
        fi
    done < <(node_dirs)
    while IFS= read -r cmd; do
        [ -n "$cmd" ] || continue
        optional=0
        case "$cmd" in "?"*) optional=1; cmd="${cmd#\?}" ;; esac
        if PATH="$step_path" run bash -c "$cmd"; then
            say "node post ok: $cmd"
        elif [ "$optional" = 1 ]; then
            say "optional node post failed, continuing: $cmd (see $LOG)"
        else
            say "FAILED node post: $cmd (see $LOG)"; MISSING+=("node-post")
        fi
    done < <(mf node post)
fi

# --------------------------------------------------------------------- post
# A step that starts with `?` is optional, like an optional install entry:
# its failure is reported and does not hold the run back from being cached
# (a browser download the network policy may not allow, say).
while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    optional=0
    case "$cmd" in "?"*) optional=1; cmd="${cmd#\?}" ;; esac
    if PATH="$step_path" run bash -c "$cmd"; then
        say "post ok: $cmd"
    elif [ "$optional" = 1 ]; then
        say "optional post failed, continuing: $cmd (see $LOG)"
    else
        say "FAILED post: $cmd (see $LOG)"; MISSING+=("post")
    fi
done < <(mf post)

# ------------------------------------------------------------------ summary
# Symmetric: a step that adds, removes or restores a path all count.
dirtied="$(comm -3 <(printf '%s\n' "$TREE_BEFORE") <(tree_status) | sed 's/^\t//' | grep . | cut -c4- | cut -f1 | sort -u | head -5 | tr '\n' ' ')"
if [ -n "$dirtied" ]; then
    say "FAILED provisioning changed the working tree: $dirtied"
    MISSING+=("tree")
fi
if [ "${#MISSING[@]}" -eq 0 ] && ! probe_outputs; then
    say "FAILED a declared output is missing after provisioning: $(mf outputs | tr '\n' ' ')"
    MISSING+=("outputs")
fi
# Every probe a cached run would use must pass now too, so a post step that
# broke an earlier resource is caught before this run is cached.
if [ "${#MISSING[@]}" -eq 0 ] && ! { probe_apt && probe_python && probe_node && probe_binaries; }; then
    say "FAILED a provisioned resource no longer passes its probe after the post steps (see $LOG)"
    MISSING+=("probe")
fi
publish_python
if [ "$ENV_FILE_OK" = 0 ] && [[ " ${MISSING[*]} " != *" env-file "* ]]; then
    say "FAILED could not write the session environment to CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE"
    MISSING+=("env-file")
fi
if [ "${#MISSING[@]}" -eq 0 ] && [ -n "$CURRENT_FINGERPRINT" ] && [ "$FOREIGN_STALE" = 0 ]; then
    printf '%s\n' "$CURRENT_FINGERPRINT" >"$STATE"
fi
printf '%s\n' "$current_outputs" >"$OUTPUTS_STATE"
py_ver="none"
[ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ] && py_ver="$(vpy --version 2>&1 | cut -d' ' -f2)"
node_ver="$(command -v node >/dev/null 2>&1 && node --version || echo none)"
say "ready repo=$REPO python=$py_ver node=$node_ver tools=${TOOLS[*]:-none} missing=${MISSING[*]:-none} log=$LOG"
exit 0
