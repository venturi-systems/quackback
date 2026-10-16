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
#   5. Non-interactive. No prompts, no sudo, no credentials, nothing secret in
#      the env file. Downloaded binaries must carry a pinned version and sha256.
#
# The fleet contract is docs/session-bootstrap.md in the organization's .github
# repository.
#
# Manifest schema (JSON, schema_version 1), all other keys optional:
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
#   post:     ["command run from the repository root after provisioning", ..]
#   cache_inputs: ["path/or/glob", ..]  (extra files whose change re-provisions)
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
LOCK="$ROOT/state/$SLOT.lock"
CACHE_DIR="$ROOT/cache"
mkdir -p "$BIN" "$TOOLS_DIR" "$ROOT/venv" "$ROOT/logs" "$ROOT/state" "$CACHE_DIR"
BASE_PATH="$PATH"
export PATH="$BIN:$BASE_PATH"
export DEBIAN_FRONTEND=noninteractive CI=1 npm_config_yes=true PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_PROGRESS=1 PIP_PROGRESS_BAR=off \
    UV_CACHE_DIR="$CACHE_DIR/uv" PIP_CACHE_DIR="$CACHE_DIR/pip" npm_config_cache="$CACHE_DIR/npm" \
    UV_PYTHON_INSTALL_DIR="$ROOT/python"
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
for spec in doc.get("binaries", []):
    if not isinstance(spec, dict):
        sys.exit("a binaries entry is not an object")
    for field in ("name", "version", "url", "sha256"):
        if not str(spec.get(field, "")).strip():
            sys.exit(f"binaries entry {spec.get('name', '?')!r} has no {field}")
PY
)"; then
    rm -f "$STATE"
    say "FAILED manifest .claude/session-bootstrap.json: $manifest_error"
    say "ready repo=$REPO missing=manifest log=$LOG"
    exit 0
fi
STEP_TIMEOUT="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("timeout_seconds", 900)))' "$MANIFEST" 2>/dev/null || echo 900)"
run() { timeout "$STEP_TIMEOUT" "$@" >>"$LOG" 2>&1; }

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
fingerprint() {
    python3 - "$ENGINE" "$MANIFEST" "$PROJECT_DIR" <<'PY'
import glob, hashlib, json, os, shlex, sys
engine, manifest, root = sys.argv[1:4]
doc = json.load(open(manifest, encoding="utf-8"))
py = doc.get("python") or {}
node = doc.get("node") or {}
inputs = set()
for name in ("pyproject.toml", "setup.py", "setup.cfg"):
    if py:
        inputs.add(name)
if "uv_sync" in py:
    inputs.add("uv.lock")
inputs.update(py.get("requirements") or [])
for entry in py.get("install") or []:
    tokens = shlex.split(entry.lstrip("?"))
    for flag, value in zip(tokens, tokens[1:] + [""]):
        if flag in ("-r", "--requirement", "-c", "--constraint") and value:
            inputs.add(value)
for directory in node.get("dirs") or []:
    for name in ("package.json", "package-lock.json", "npm-shrinkwrap.json",
                 "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb"):
        inputs.add(os.path.normpath(os.path.join(directory, name)))
for pattern in doc.get("cache_inputs") or []:
    matches = glob.glob(os.path.join(root, pattern), recursive=True)
    inputs.update(os.path.relpath(m, root) for m in matches if os.path.isfile(m))
    if not matches:
        inputs.add(pattern)
digest = hashlib.sha256()
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

# ---------------------------------------------------------------- environment
# Exported first so a cached run still re-publishes PATH into the new session.
# The virtualenv joins PATH only while the manifest declares Python, so a venv
# left behind by an earlier manifest cannot shadow the base interpreter.
if [ "$WANT_PYTHON" = 1 ]; then
    env_export PATH "$BIN:$VENV/bin:$BASE_PATH"
    env_export VIRTUAL_ENV "$VENV"
    env_export UV_PROJECT_ENVIRONMENT "$VENV"
else
    env_export PATH "$BIN:$BASE_PATH"
fi
while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(mf env "$name")"
    value="${value//'{root}'/"$ROOT"}"
    value="${value//'{bin}'/"$BIN"}"
    value="${value//'{venv}'/"$VENV"}"
    value="${value//'{repo}'/"$PROJECT_DIR"}"
    env_export "$name" "$value"
done < <(python3 -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1])).get("env",{})]' "$MANIFEST")
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
    dpkg -s "$1" >/dev/null 2>&1 && return 0
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
probe_node() {
    local manager dir
    manager="$(mf node manager)"
    [ -n "$manager" ] || return 0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        [ -d "$PROJECT_DIR/$dir/node_modules" ] || return 1
    done < <(mf node dirs)
    return 0
}
# The pinned artifact for a binary lives at tools/<name>/<version>/<name> and
# bin/<repo>/<name> links to it, so a different version already on PATH, or a
# sibling repository's pin, never satisfies this repository's manifest.
binary_target() { printf '%s/%s/%s/%s' "$TOOLS_DIR" "$1" "$2" "$1"; }
probe_binaries() {
    local spec name version
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        name="$(jf "$spec" name)"; version="$(jf "$spec" version)"
        [ -x "$(binary_target "$name" "$version")" ] || return 1
        [ "$(readlink "$BIN/$name" 2>/dev/null)" = "$(binary_target "$name" "$version")" ] || return 1
    done < <(mf binaries)
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
CURRENT_FINGERPRINT="$(fingerprint)"
if [ "${#MISSING[@]}" -eq 0 ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$CURRENT_FINGERPRINT" ] \
    && probe_apt && probe_python && probe_node && probe_binaries; then
    say "ready (cached) repo=$REPO python=$([ "$WANT_PYTHON" = 1 ] && "$VENV/bin/python" --version 2>&1 | cut -d' ' -f2 || echo none) log=$LOG"
    exit 0
fi
rm -f "$STATE"

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
    if [ -e "$VENV" ] && ! venv_matches; then
        if [ "$VENV" = "/" ] || [ "$VENV" = "$PROJECT_DIR" ] || [ "$VENV" = "$HOME" ]; then
            say "FAILED refusing to rebuild virtualenv at $VENV"
            MISSING+=("python-venv")
        else
            say "python venv at $VENV does not match the manifest (version or system_site_packages); rebuilding"
            rm -rf "$VENV"
        fi
    fi
    if [ ! -x "$VENV/bin/python" ]; then
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
        if command -v uv >/dev/null 2>&1; then
            if [ -n "$interpreter" ]; then
                run uv venv --seed "${venv_flags[@]}" --python "$interpreter" "$VENV"
            elif [ -n "$want_ver" ]; then
                run uv venv --seed "${venv_flags[@]}" --python "$want_ver" "$VENV"
            else
                run uv venv --seed "${venv_flags[@]}" "$VENV"
            fi
        else
            "${interpreter:-python3}" -m venv "${venv_flags[@]}" "$VENV" >>"$LOG" 2>&1
        fi
        if [ ! -x "$VENV/bin/python" ]; then
            say "FAILED python venv at $VENV (see $LOG)"
            MISSING+=("python-venv")
        fi
    fi
    if [ -x "$VENV/bin/python" ]; then
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
            # Split on whitespace with globbing off, so `-e .[dev]` reaches the
            # installer as written even when a file matches the bracket.
            set -f
            # shellcheck disable=SC2206
            entry=($spec)
            set +f
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
        else
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
    target="$(binary_target "$name" "$version")"
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
        case "$archive" in
            zip) python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$tmp/download" "$member" "$tmp" >>"$LOG" 2>&1 ;;
            tar.gz|tgz) tar -xzf "$tmp/download" -C "$tmp" "$member" >>"$LOG" 2>&1 ;;
            none) mv "$tmp/download" "$tmp/$member" ;;
            *) say "FAILED unknown archive type $archive for $name" ;;
        esac
        if [ ! -f "$tmp/$member" ]; then
            say "FAILED extract $name ($archive member=$member)"
            MISSING+=("$name"); rm -rf "$tmp"; continue
        fi
        if ! { mkdir -p "$(dirname "$target")" && install -m 0755 "$tmp/$member" "$target"; } >>"$LOG" 2>&1; then
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
    done < <(mf node dirs)
    while IFS= read -r cmd; do
        [ -n "$cmd" ] || continue
        if run bash -c "$cmd"; then say "node post ok: $cmd"; else say "FAILED node post: $cmd (see $LOG)"; MISSING+=("node-post"); fi
    done < <(mf node post)
fi

# --------------------------------------------------------------------- post
post_path="$PATH"
[ "$WANT_PYTHON" = 1 ] && post_path="$VENV/bin:$PATH"
while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    if PATH="$post_path" run bash -c "$cmd"; then say "post ok: $cmd"; else say "FAILED post: $cmd (see $LOG)"; MISSING+=("post"); fi
done < <(mf post)

# ------------------------------------------------------------------ summary
if [ "${#MISSING[@]}" -eq 0 ]; then
    printf '%s\n' "$CURRENT_FINGERPRINT" >"$STATE"
fi
py_ver="none"
[ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ] && py_ver="$("$VENV/bin/python" --version 2>&1 | cut -d' ' -f2)"
node_ver="$(command -v node >/dev/null 2>&1 && node --version || echo none)"
say "ready repo=$REPO python=$py_ver node=$node_ver tools=${TOOLS[*]:-none} missing=${MISSING[*]:-none} log=$LOG"
exit 0
