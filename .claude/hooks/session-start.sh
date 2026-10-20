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
if [ ! -f "$MANIFEST" ]; then
    echo "session-start: no manifest at .claude/session-bootstrap.json; nothing to provision"
    exit 0
fi

REPO="$(basename "$PROJECT_DIR")"
# Two checkouts with the same directory name (a worktree, a second clone) must
# not share a virtualenv or a state marker, so per-checkout paths carry a short
# digest of the canonical project path.
SLOT="$REPO-$(printf '%s' "$PROJECT_DIR" | sha256sum | cut -c1-8)"
ROOT="${SESSION_BOOTSTRAP_ROOT:-$HOME/.session-bootstrap}"
VENV="$ROOT/venv/$SLOT"
BIN="$ROOT/bin/$SLOT"
TOOLS_DIR="$ROOT/tools"
LOG="$ROOT/logs/$SLOT.log"
STATE="$ROOT/state/$SLOT.fingerprint"
ENV_NAMES="$ROOT/state/$SLOT.env-names"
PY_STATE="$ROOT/state/$SLOT.python"
LOCK="$ROOT/state/$SLOT.lock"
CACHE_DIR="$ROOT/cache"
mkdir -p "$BIN" "$TOOLS_DIR" "$ROOT/venv" "$ROOT/logs" "$ROOT/state" "$CACHE_DIR"
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
export PATH="$BIN:$BASE_PATH"
# The manifest's env entries reach the session and every step this engine
# runs, never this shell: a name such as VENV or WANT_PYTHON must not be able
# to change what the engine itself does.
STEP_ENV=()
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
# failures, skips and the final summary, each line capped, at most 20 lines.
# Everything goes to the log in full.
SAID=0
say() {
    printf '%s session-start: %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"
    case "$*" in
        ready*|FAILED*|skipped*|ignored*|optional*) ;;
        *) return 0 ;;
    esac
    if [ "$SAID" -lt 20 ] || [ "${1#ready}" != "$1" ]; then
        printf 'session-start: %.300s\n' "$*"
        SAID=$((SAID + 1))
    fi
}

echo "----- session-start: $(date -u +%FT%TZ) repo=$REPO -----" >>"$LOG"

# One provisioning run per repository at a time. SessionStart fires again on
# /clear and on resume while a first run may still be installing; the second
# run waits here instead of writing into the same virtualenv concurrently.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK"
    if ! flock -w 1800 9; then
        say "FAILED another bootstrap for $REPO still holds $LOCK after 1800s; nothing provisioned"
        say "ready repo=$REPO missing=lock log=$LOG"
        exit 0
    fi
fi

# A manifest that does not parse, or names a schema this engine does not know,
# is reported and never cached: every later lookup would otherwise read as
# "absent" and the run would look complete.
if ! manifest_error="$(python3 - "$MANIFEST" <<'PY' 2>&1
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
py = doc.get("python", {})
for key in ("requirements", "packages", "install", "probe"):
    if key in py:
        strings(py[key], f"python.{key}")
for key in ("version", "env_dir"):
    if key in py and not (isinstance(py[key], str) and py[key].strip()):
        sys.exit(f"python.{key} must be a non-empty string")
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
    strings(node.get("dirs", []) or ["."], "node.dirs")
    for key in ("args", "post"):
        if key in node:
            strings(node[key], f"node.{key}")
for key in ("apt", "post", "cache_inputs", "outputs"):
    if key in doc:
        strings(doc[key], key)
# Names the engine itself publishes, or that would change who the session is,
# cannot come from a manifest.
reserved = {"PATH", "HOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "SHELL", "USER"}
for name, value in doc.get("env", {}).items():
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        sys.exit(f"env name {name!r} is not a valid variable name")
    if name in reserved or name.startswith(("SESSION_BOOTSTRAP_", "CLAUDE_")):
        sys.exit(f"env name {name} is reserved")
    if not isinstance(value, str):
        sys.exit(f"env.{name} must be a string")
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
if "timeout_seconds" in doc and not (isinstance(doc["timeout_seconds"], int) and doc["timeout_seconds"] > 0):
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
# A local project installed without -e is a copy that the next source change
# leaves stale while the cache still reads as current. Local files (a wheel)
# are fingerprinted instead.
import os, shlex
root = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1])))
VALUE_OPTS = {"-r", "--requirement", "-c", "--constraint", "-i", "--index-url",
              "--extra-index-url", "-f", "--find-links", "--index-strategy", "-p",
              "--python", "--only-binary", "--no-binary", "--target", "--prefix",
              "--config-settings", "-C", "--trusted-host", "--upgrade-strategy"}
for where, entries in (("python.packages", py.get("packages") or []),
                       ("python.install", py.get("install") or [])):
    for entry in entries:
        tokens = shlex.split(entry.lstrip("?"))
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if tok in ("-e", "--editable") or (tok in VALUE_OPTS and "=" not in tok):
                i += 2
                continue
            i += 1
            if tok.startswith("-"):
                continue
            target = tok.split("[", 1)[0]
            target = target[len("file:"):] if target.startswith("file:") else target
            if "://" not in target and os.path.isdir(os.path.join(root, target)):
                sys.exit(f"{where} entry {entry!r} installs the local project {target!r} without -e")
PY
)"; then
    rm -f "$STATE"
    say "FAILED manifest .claude/session-bootstrap.json: $manifest_error"
    say "ready repo=$REPO missing=manifest log=$LOG"
    exit 0
fi
STEP_TIMEOUT="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("timeout_seconds", 900)))' "$MANIFEST" 2>/dev/null || echo 900)"
run() {
    local left=$(( DEADLINE - $(date +%s) ))
    if [ "$left" -le 0 ]; then
        printf 'session-start: budget exhausted before: %s\n' "$*" >>"$LOG"
        return 124
    fi
    [ "$left" -lt "$STEP_TIMEOUT" ] || left="$STEP_TIMEOUT"
    # No step reads the manifest loops' input, and none keeps the lock: a
    # background process a step leaves behind must not hold fd 9 after exit.
    timeout "$left" env "${STEP_ENV[@]}" "$@" </dev/null >>"$LOG" 2>&1 9>&-
}

# mf KEY [SUBKEY]: print one manifest value per line (arrays expand; scalars
# print once; objects print nothing). Absent keys print nothing.
mf() {
    python3 - "$MANIFEST" "$@" <<'PY'
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
    python3 - "$MANIFEST" "$@" <<'PY'
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
jf() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], sys.argv[3]))' "$1" "$2" "${3:-}"; }

# fingerprint: sha256 over the engine, the manifest and every dependency input
# the manifest names, so a pulled lockfile or requirements change re-provisions
# even when the manifest itself is unchanged.
# `fingerprint python` covers only the Python section and its inputs; the
# engine keys its virtualenv on it.
fingerprint() {
    python3 - "$ENGINE" "$MANIFEST" "$PROJECT_DIR" "${1:-all}" <<'PY'
import glob, hashlib, json, os, re, shlex, sys
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
INCLUDE_FLAGS = ("-r", "--requirement", "-c", "--constraint")
def includes(tokens, base):
    for flag, value in zip(tokens, tokens[1:] + [""]):
        if flag in INCLUDE_FLAGS and value:
            yield os.path.normpath(os.path.join(base, value))
        for prefix in ("--requirement=", "--constraint="):
            if flag.startswith(prefix):
                yield os.path.normpath(os.path.join(base, flag[len(prefix):]))
pending = list(py.get("requirements") or [])
for entry in (py.get("install") or []) + (py.get("packages") or []):
    tokens = shlex.split(entry.lstrip("?"))
    pending.extend(includes(tokens, ""))
    # A local wheel or sdist is part of what gets installed.
    for tok in tokens:
        target = tok.split("[", 1)[0]
        target = target[len("file:"):] if target.startswith("file:") else target
        if not tok.startswith("-") and "://" not in target and os.path.isfile(os.path.join(root, target)):
            inputs.add(os.path.normpath(target))
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
                pending.extend(includes(shlex.split(line), os.path.dirname(rel)))
for directory in (node.get("dirs") or ["."]) if node and scope == "all" else []:
    for name in ("package.json", "package-lock.json", "npm-shrinkwrap.json",
                 "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bun.lock",
                 "bun.lockb", "bunfig.toml", ".npmrc"):
        inputs.add(os.path.normpath(os.path.join(directory, name)))
    for patch in glob.glob(os.path.join(root, directory, "patches", "**"), recursive=True):
        if os.path.isfile(patch):
            inputs.add(os.path.relpath(patch, root))
for pattern in doc.get("cache_inputs") or [] if scope == "all" else []:
    matches = glob.glob(os.path.join(root, pattern), recursive=True)
    inputs.update(os.path.relpath(m, root) for m in matches if os.path.isfile(m))
    if not matches:
        inputs.add(pattern)
digest = hashlib.sha256()
if scope == "python":
    digest.update(json.dumps(py, sort_keys=True).encode())
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

# ---------------------------------------------------------------- environment
# Exported first so a cached run still re-publishes PATH into the new session.
# The virtualenv is published only once it exists and runs (publish_python),
# so neither the session nor this engine's own helpers ever run a broken or
# half-built venv's python3, and a venv left behind by an earlier manifest
# cannot shadow the base interpreter.
env_export PATH "$BIN:$BASE_PATH"
# unpublish_python: clear what an earlier session published for Python.
unpublish_python() {
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        printf 'unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT\n' >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
    fi
    unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT
}
# publish_python: put a working virtualenv on the session PATH, or clear it.
publish_python() {
    [ "$WANT_PYTHON" = 1 ] || return 0
    if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c '' >/dev/null 2>&1; then
        env_export PATH "$BIN:$VENV/bin:$BASE_PATH"
        env_export VIRTUAL_ENV "$VENV"
        env_export UV_PROJECT_ENVIRONMENT "$VENV"
    else
        unpublish_python
    fi
}
if [ "$WANT_PYTHON" != 1 ]; then
    # A previous manifest may have declared Python: clear what it published and
    # remove its out-of-tree environment.
    unpublish_python
    [ -d "$ROOT/venv/$SLOT" ] && rm -rf "${ROOT:?}/venv/${SLOT:?}"
    rm -f "$PY_STATE"
fi
while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(expand "$(mf env "$name")")"
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        printf 'export %s=%q\n' "$name" "$value" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
    fi
    STEP_ENV+=("$name=$value")
done < <(python3 -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1])).get("env",{})]' "$MANIFEST")
# A name an earlier manifest published and this one dropped is unset, so a
# resumed or cleared session does not keep the old value.
env_names="$(python3 -c 'import json,sys; [print(k) for k in sorted(json.load(open(sys.argv[1])).get("env",{}))]' "$MANIFEST")"
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f "$ENV_NAMES" ]; then
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        printf '%s\n' "$env_names" | grep -qxF "$name" && continue
        printf 'unset %s\n' "$name" >>"$CLAUDE_ENV_FILE" || ENV_FILE_OK=0
    done <"$ENV_NAMES"
fi
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ "$ENV_FILE_OK" = 1 ]; then
    printf '%s\n' "$env_names" >"$ENV_NAMES"
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
apt_installed() {
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
        have="$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)"
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
    "$VENV/bin/python" -c "import $(echo "$mods" | sed 's/ *$//; s/ /, /g')" >/dev/null 2>&1
}
# node_deps_declared DIR: package.json in DIR lists any dependency; a package
# with none never creates node_modules/ and is still provisioned.
node_deps_declared() {
    python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
sys.exit(0 if any(d.get(k) for k in ("dependencies","devDependencies","optionalDependencies")) else 1)' "$PROJECT_DIR/$1/package.json" 2>/dev/null
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
# tools/<name>/<version>-<sha256 of the download>/<name>, and bin/<slot>/<name>
# links to it. A different version already on PATH, a sibling repository's pin,
# or the same version with another checksum never satisfies this manifest.
binary_target() { printf '%s/%s/%s-%s/%s' "$TOOLS_DIR" "$1" "$2" "$3" "$1"; }
probe_binaries() {
    local spec name target
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        name="$(jf "$spec" name)"
        target="$(binary_target "$name" "$(jf "$spec" version)" "$(jf "$spec" sha256)")"
        [ -x "$target" ] && [ "$(readlink "$BIN/$name" 2>/dev/null)" = "$target" ] || return 1
    done < <(mf binaries)
    return 0
}
probe_outputs() {
    local out
    while IFS= read -r out; do
        [ -n "$out" ] || continue
        [ -e "$(expand "$out")" ] || return 1
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
        say "ready (cached) repo=$REPO python=$([ "$WANT_PYTHON" = 1 ] && "$VENV/bin/python" --version 2>&1 | cut -d' ' -f2 || echo none) log=$LOG"
        exit 0
    fi
    say "FAILED could not write the session environment to CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE"
    MISSING+=("env-file")
fi
rm -f "$STATE"
# Every write is meant to land out of tree or under a gitignored path. The
# status before and after shows any install or post step that broke that (a
# nested workspace whose install writes the root node_modules/, say).
tree_status() { git -C "$PROJECT_DIR" status --porcelain -uall 2>/dev/null | sort; }
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
        elif [ "$(cat "$PY_STATE" 2>/dev/null)" != "$python_fingerprint" ]; then
            rebuild_reason="its Python dependency inputs changed"
        fi
    fi
    if [ -n "$rebuild_reason" ]; then
        # Only a directory that is a virtualenv (it has pyvenv.cfg) is removed;
        # anything else at that path is reported, never deleted.
        if [ "$VENV" = "/" ] || [ "$VENV" = "$PROJECT_DIR" ] || [ "$VENV" = "$HOME" ] || [ ! -f "$VENV/pyvenv.cfg" ]; then
            say "FAILED refusing to rebuild $VENV: it is not a virtualenv this engine created"
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
        if [ -n "$want_ver" ]; then
            for cand in "python$want_ver" "/usr/bin/python$want_ver" "/usr/local/bin/python$want_ver"; do
                if command -v "$cand" >/dev/null 2>&1; then interpreter="$cand"; break; fi
            done
        fi
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
        if [ "$venv_rc" -ne 0 ] || [ ! -x "$VENV/bin/python" ]; then
            say "FAILED python venv at $VENV (see $LOG)"
            MISSING+=("python-venv")
            [ -f "$VENV/pyvenv.cfg" ] && rm -rf "${VENV:?}"
        fi
    fi
    if [ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ]; then
        py_rc=0
        if mf_has python uv_sync; then
            if command -v uv >/dev/null 2>&1; then
                args=(sync)
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
                python3 -c 'import shlex,sys; sys.stdout.write("".join(a+"\0" for a in shlex.split(sys.argv[1])))' "$spec")
            if ! pip_install "${entry[@]}"; then
                if [ "$optional" = 1 ]; then
                    say "optional install entry failed, continuing: $spec"
                else
                    py_rc=1
                fi
            fi
        done < <(mf python install)
        if probe_python && [ "$py_rc" = 0 ]; then
            say "python ok $("$VENV/bin/python" --version 2>&1) venv=$VENV"
            [ -n "$python_fingerprint" ] && printf '%s\n' "$python_fingerprint" >"$PY_STATE"
        else
            rm -f "$PY_STATE"
            say "FAILED python deps (rc=$py_rc; probe=$(mf python probe | tr '\n' ' ')) see $LOG"
            MISSING+=("python-deps")
        fi
    fi
fi

# ----------------------------------------------------------------- binaries
while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    name="$(jf "$spec" name)"
    version="$(jf "$spec" version)"
    url="$(jf "$spec" url)"
    sha="$(jf "$spec" sha256)"
    archive="$(jf "$spec" archive none)"
    member="$(jf "$spec" member "$name")"
    target="$(binary_target "$name" "$version" "$sha")"
    if [ ! -x "$target" ]; then
        # Drop a link to another version first, so a failed install leaves
        # nothing on PATH that looks like the pinned tool.
        rm -f "$BIN/$name"
        tmp="$(mktemp -d)"
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
            zip) run python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$tmp/download" "$member" "$tmp" || extracted=0 ;;
            tar.gz|tgz) run tar -xzf "$tmp/download" -C "$tmp" "$member" || extracted=0 ;;
            none) mv "$tmp/download" "$tmp/$member" || extracted=0 ;;
        esac
        if [ "$extracted" = 0 ] || [ ! -f "$tmp/$member" ]; then
            say "FAILED extract $name ($archive member=$member)"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        if ! { mkdir -p "$(dirname "$target")" && install -m 0755 "$tmp/$member" "$target.partial" && mv -f "$target.partial" "$target"; } >>"$LOG" 2>&1; then
            say "FAILED install $name $version into $target"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        rm -rf "$tmp"
    fi
    if ln -sfn "$target" "$BIN/$name" 2>>"$LOG"; then
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

# --------------------------------------------------------------------- node
# Like Python, a fingerprint miss always re-runs the frozen install, so a
# changed manager, argument list or lockfile is applied to node_modules/.
manager="$(mf node manager)"
if [ -n "$manager" ]; then
    node_args=()
    while IFS= read -r a; do [ -n "$a" ] && node_args+=("$a"); done < <(mf node args)
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        if ! git -C "$PROJECT_DIR" check-ignore -q "$dir/node_modules/" 2>/dev/null; then
            say "skipped node install in $dir: node_modules/ is not gitignored (would dirty the tree)"
            MISSING+=("node:$dir")
            continue
        fi
        rc=0
        case "$manager" in
            npm)  (cd "$PROJECT_DIR/$dir" && run npm ci --no-audit --no-fund "${node_args[@]}") || rc=$? ;;
            pnpm) (cd "$PROJECT_DIR/$dir" && run pnpm install --frozen-lockfile "${node_args[@]}") || rc=$? ;;
            bun)  (cd "$PROJECT_DIR/$dir" && run bun install --frozen-lockfile "${node_args[@]}") || rc=$? ;;
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
        if run bash -c "$cmd"; then
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
post_path="$PATH"
[ "$WANT_PYTHON" = 1 ] && post_path="$VENV/bin:$PATH"
while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    optional=0
    case "$cmd" in "?"*) optional=1; cmd="${cmd#\?}" ;; esac
    if PATH="$post_path" run bash -c "$cmd"; then
        say "post ok: $cmd"
    elif [ "$optional" = 1 ]; then
        say "optional post failed, continuing: $cmd (see $LOG)"
    else
        say "FAILED post: $cmd (see $LOG)"; MISSING+=("post")
    fi
done < <(mf post)

# ------------------------------------------------------------------ summary
dirtied="$(comm -13 <(printf '%s\n' "$TREE_BEFORE") <(tree_status) | grep . | cut -c4- | head -5 | tr '\n' ' ')"
if [ -n "$dirtied" ]; then
    say "FAILED provisioning changed the working tree: $dirtied"
    MISSING+=("tree")
fi
if [ "${#MISSING[@]}" -eq 0 ] && ! probe_outputs; then
    say "FAILED a declared output is missing after provisioning: $(mf outputs | tr '\n' ' ')"
    MISSING+=("outputs")
fi
publish_python
if [ "$ENV_FILE_OK" = 0 ] && [[ " ${MISSING[*]} " != *" env-file "* ]]; then
    say "FAILED could not write the session environment to CLAUDE_ENV_FILE=$CLAUDE_ENV_FILE"
    MISSING+=("env-file")
fi
if [ "${#MISSING[@]}" -eq 0 ] && [ -n "$CURRENT_FINGERPRINT" ]; then
    printf '%s\n' "$CURRENT_FINGERPRINT" >"$STATE"
fi
py_ver="none"
[ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ] && py_ver="$("$VENV/bin/python" --version 2>&1 | cut -d' ' -f2)"
node_ver="$(command -v node >/dev/null 2>&1 && node --version || echo none)"
say "ready repo=$REPO python=$py_ver node=$node_ver tools=${TOOLS[*]:-none} missing=${MISSING[*]:-none} log=$LOG"
exit 0
