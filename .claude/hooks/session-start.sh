#!/usr/bin/env bash
# Venturi fleet session bootstrap (vendored engine; identical in every repository).
#
# Purpose: let an agent that opens a Claude Code CLOUD session run this
# repository's own gates (the `validation.local_commands` declared in
# .venturi/repository-governance.json) without manual setup. The engine
# provisions exactly what .venturi/session-bootstrap.json declares: a Python
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
#   2. Out of tree. Everything lands under $VENTURI_SESSION_ROOT
#      (default ~/.venturi-session): venv/<repo>, bin/, logs/, state/. The only
#      in-tree write is a Node package install into a node_modules/ directory
#      that git already ignores; the engine verifies that before installing.
#   3. Idempotent and fast on re-run. A state marker records the manifest hash
#      of the last complete provision; a matching marker plus passing probes
#      ends the run in seconds (resume and compact sessions pay nothing).
#   4. Fail-open and honest. No step aborts the session. Each step reports
#      ok, cached, skipped or FAILED, and the last line names what is missing.
#      Verbose installer output goes to the log, not into session context.
#   5. Non-interactive. No prompts, no sudo, no credentials, nothing secret in
#      the env file.
#
# The fleet contract is docs/session-bootstrap.md in the organization's .github
# repository.
#
# Manifest schema (JSON, schema_version 1), all keys optional:
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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if ! cd "$PROJECT_DIR" 2>/dev/null; then
    echo "session-start: FAILED cannot cd to PROJECT_DIR=$PROJECT_DIR (set CLAUDE_PROJECT_DIR)" >&2
    exit 0
fi

MANIFEST="$PROJECT_DIR/.venturi/session-bootstrap.json"
if [ ! -f "$MANIFEST" ]; then
    echo "session-start: no manifest at .venturi/session-bootstrap.json; nothing to provision"
    exit 0
fi

REPO="$(basename "$PROJECT_DIR")"
ROOT="${VENTURI_SESSION_ROOT:-$HOME/.venturi-session}"
VENV="$ROOT/venv/$REPO"
BIN="$ROOT/bin"
LOG="$ROOT/logs/$REPO.log"
STATE="$ROOT/state/$REPO.manifest.sha256"
CACHE_DIR="$ROOT/cache"
mkdir -p "$BIN" "$ROOT/venv" "$ROOT/logs" "$ROOT/state" "$CACHE_DIR"
BASE_PATH="$PATH"
export PATH="$BIN:$BASE_PATH"
export DEBIAN_FRONTEND=noninteractive CI=1 npm_config_yes=true PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_PROGRESS=1 PIP_PROGRESS_BAR=off \
    UV_CACHE_DIR="$CACHE_DIR/uv" PIP_CACHE_DIR="$CACHE_DIR/pip" npm_config_cache="$CACHE_DIR/npm"
STEP_TIMEOUT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("timeout_seconds", 900))' "$MANIFEST" 2>/dev/null || echo 900)"
MISSING=()
TOOLS=()

say() { printf 'session-start: %s\n' "$*"; printf '%s session-start: %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"; }
run() { timeout "$STEP_TIMEOUT" "$@" >>"$LOG" 2>&1; }
# mf KEY [SUBKEY]: print one manifest value per line (arrays expand; scalars
# print once; objects print nothing). Absent keys print nothing.
mf() {
    python3 - "$MANIFEST" "$@" <<'PY' 2>/dev/null
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
    python3 - "$MANIFEST" "$@" <<'PY' 2>/dev/null
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    if not isinstance(node, dict) or key not in node:
        sys.exit(1)
    node = node[key]
sys.exit(0)
PY
}
manifest_hash() { sha256sum "$MANIFEST" | cut -d' ' -f1; }
env_export() {
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        printf 'export %s=%q\n' "$1" "$2" >>"$CLAUDE_ENV_FILE"
    fi
    export "$1=$2"
}

echo "----- session-start: $(date -u +%FT%TZ) repo=$REPO -----" >>"$LOG"

# A repository whose own tooling only finds an in-tree virtualenv may name a
# relative directory in python.env_dir. The engine accepts it only when git
# already ignores that path, so the tree stays clean.
venv_rel="$(mf python env_dir)"
if [ -n "$venv_rel" ]; then
    if git -C "$PROJECT_DIR" check-ignore -q "$venv_rel/" 2>/dev/null; then
        VENV="$PROJECT_DIR/$venv_rel"
    else
        say "ignored python.env_dir=$venv_rel because git does not ignore it; using $VENV"
    fi
fi
export VENTURI_SESSION_ROOT="$ROOT" VENTURI_SESSION_BIN="$BIN" VENTURI_SESSION_VENV="$VENV"

# ---------------------------------------------------------------- environment
# Exported first so a cached run still re-publishes PATH into the new session.
env_export PATH "$BIN:$VENV/bin:$BASE_PATH"
if mf_has python; then
    WANT_PYTHON=1
    env_export VIRTUAL_ENV "$VENV"
    env_export UV_PROJECT_ENVIRONMENT "$VENV"
else
    WANT_PYTHON=0
fi
while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(mf env "$name")"
    value="${value//'{root}'/"$ROOT"}"
    value="${value//'{bin}'/"$BIN"}"
    value="${value//'{venv}'/"$VENV"}"
    value="${value//'{repo}'/"$PROJECT_DIR"}"
    env_export "$name" "$value"
done < <(python3 -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1])).get("env",{})]' "$MANIFEST" 2>/dev/null)

# --------------------------------------------------------------- cached run?
probe_python() {
    [ "$WANT_PYTHON" = 1 ] || return 0
    [ -x "$VENV/bin/python" ] || return 1
    local want have
    want="$(mf python version)"
    if [ -n "$want" ]; then
        have="$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)"
        [ "$have" = "$want" ] || return 1
    fi
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
probe_binaries() {
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        local name
        name="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))')"
        [ -n "$name" ] || continue
        command -v "$name" >/dev/null 2>&1 || return 1
    done < <(mf binaries)
    return 0
}
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$(manifest_hash)" ] \
    && probe_python && probe_node && probe_binaries; then
    say "ready (cached) repo=$REPO python=$([ "$WANT_PYTHON" = 1 ] && "$VENV/bin/python" --version 2>&1 | cut -d' ' -f2 || echo none) log=$LOG"
    exit 0
fi

# -------------------------------------------------------------------- python
if [ "$WANT_PYTHON" = 1 ]; then
    want_ver="$(mf python version)"
    # A venv built for a different interpreter than the manifest now names is
    # rebuilt in place (--clear), so a version change in the manifest takes effect.
    clear_flag=()
    if [ -n "$want_ver" ] && [ -x "$VENV/bin/python" ]; then
        have_ver="$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)"
        if [ "$have_ver" != "$want_ver" ]; then
            say "python venv is $have_ver but the manifest names $want_ver; rebuilding"
            clear_flag=(--clear)
        fi
    fi
    if [ ! -x "$VENV/bin/python" ] || [ "${#clear_flag[@]}" -gt 0 ]; then
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
                run uv venv --seed "${clear_flag[@]}" "${venv_flags[@]}" --python "$interpreter" "$VENV"
            elif [ -n "$want_ver" ]; then
                run uv venv --seed "${clear_flag[@]}" "${venv_flags[@]}" --python "$want_ver" "$VENV"
            else
                run uv venv --seed "${clear_flag[@]}" "${venv_flags[@]}" "$VENV"
            fi
        else
            "${interpreter:-python3}" -m venv "${clear_flag[@]}" "${venv_flags[@]}" "$VENV" >>"$LOG" 2>&1
        fi
        if [ ! -x "$VENV/bin/python" ]; then
            say "FAILED python venv at $VENV (see $LOG)"
            MISSING+=("python-venv")
        fi
    fi
    if [ -x "$VENV/bin/python" ]; then
        if probe_python; then
            say "python ok (cached) $("$VENV/bin/python" --version 2>&1)"
        else
            py_rc=0
            if mf_has python uv_sync && command -v uv >/dev/null 2>&1; then
                args=(sync)
                [ "$(mf python uv_sync frozen)" != "false" ] && args+=(--frozen)
                [ "$(mf python uv_sync all_extras)" = "true" ] && args+=(--all-extras)
                while IFS= read -r extra; do [ -n "$extra" ] && args+=(--extra "$extra"); done < <(mf python uv_sync extras)
                while IFS= read -r group; do [ -n "$group" ] && args+=(--group "$group"); done < <(mf python uv_sync groups)
                UV_PROJECT_ENVIRONMENT="$VENV" run uv "${args[@]}" || py_rc=$?
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
            while IFS= read -r req; do [ -n "$req" ] && [ -f "$req" ] && pip_args+=(-r "$req"); done < <(mf python requirements)
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
                # shellcheck disable=SC2206
                entry=($spec)
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
fi

# ---------------------------------------------------------------------- apt
apt_pkgs=()
while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    dpkg -s "$pkg" >/dev/null 2>&1 || apt_pkgs+=("$pkg")
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
while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    name="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))')"
    url="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
    sha="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha256",""))')"
    archive="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("archive","none"))')"
    member="$(printf '%s' "$spec" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("member", d.get("name","")))')"
    [ -n "$name" ] && [ -n "$url" ] || continue
    if command -v "$name" >/dev/null 2>&1; then
        TOOLS+=("$name")
        continue
    fi
    tmp="$(mktemp -d)"
    if ! run curl -fsSL --retry 3 -o "$tmp/download" "$url"; then
        say "FAILED download $name from $url"
        MISSING+=("$name"); rm -rf "$tmp"; continue
    fi
    if [ -n "$sha" ] && [ "$(sha256sum "$tmp/download" | cut -d' ' -f1)" != "$sha" ]; then
        say "FAILED sha256 mismatch for $name; refusing to install"
        MISSING+=("$name"); rm -rf "$tmp"; continue
    fi
    case "$archive" in
        zip) python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$tmp/download" "$member" "$tmp" >>"$LOG" 2>&1 ;;
        tar.gz|tgz) tar -xzf "$tmp/download" -C "$tmp" "$member" >>"$LOG" 2>&1 ;;
        none) mv "$tmp/download" "$tmp/$member" ;;
    esac
    if [ -f "$tmp/$member" ]; then
        install -m 0755 "$tmp/$member" "$BIN/$name" && say "binary ok $name" && TOOLS+=("$name")
    else
        say "FAILED extract $name ($archive member=$member)"
        MISSING+=("$name")
    fi
    rm -rf "$tmp"
done < <(mf binaries)

# --------------------------------------------------------------------- node
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
        if [ -d "$PROJECT_DIR/$dir/node_modules" ]; then
            say "node ok (cached) $dir"
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
while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    if PATH="$VENV/bin:$PATH" run bash -c "$cmd"; then say "post ok: $cmd"; else say "FAILED post: $cmd (see $LOG)"; MISSING+=("post"); fi
done < <(mf post)

# ------------------------------------------------------------------ summary
if [ "${#MISSING[@]}" -eq 0 ]; then
    manifest_hash >"$STATE"
else
    rm -f "$STATE"
fi
py_ver="none"
[ "$WANT_PYTHON" = 1 ] && [ -x "$VENV/bin/python" ] && py_ver="$("$VENV/bin/python" --version 2>&1 | cut -d' ' -f2)"
node_ver="$(command -v node >/dev/null 2>&1 && node --version || echo none)"
say "ready repo=$REPO python=$py_ver node=$node_ver tools=${TOOLS[*]:-none} missing=${MISSING[*]:-none} log=$LOG"
exit 0
