#!/usr/bin/env python3
"""Hold CodeQL's code-quality findings to a baseline that only shrinks.

WHY THIS EXISTS
---------------
GitHub Code Quality runs CodeQL's ``<language>-code-quality`` query suites on
GitHub-hosted runners, as a repository setting (``dynamic/github-code-quality``).
It was the largest hosted consumer in September 2026, about 53,400 hosted
minutes a month, and no file in this tree can route, scope or throttle it. The
owner decision (2026-09-29) is to disable it once every finding it reports is
resolved, and to run the same checks on infrastructure with a fixed cost.

The code-quality workflow runs those suites on the isolated ephemeral pool, a
capacity reservation paid for whether or not a job runs, and hands the SARIF
here. Nothing is uploaded to GitHub.

WHAT IT ENFORCES
----------------
A finding is identified by language, rule id, repository path and CodeQL's two
partial fingerprints: ``primaryLocationLineHash`` hashes the flagged line's
content, so moving code up or down a file does not turn an old finding into a
new one, and ``primaryLocationStartColumnFingerprint`` is the start column
relative to the line's indentation, so two findings of one rule on one line
(two unused imports in ``import os, sys``) stay distinct. The message is not
part of the identity: CodeQL phrases some messages from context outside the
flagged line (the share of statements with an explicit semicolon in the
enclosing function, for one), so an unrelated edit would otherwise re-flag an
old finding. A result the SARIF lists more than once is one finding. The
workflow keeps the SARIF complete on every event (diff-informed analysis is
off), so a baseline entry missing from the SARIF is a fixed finding, never one
the action filtered out. For every language whose SARIF is given:

  * a finding absent from config/code-quality-baseline.json FAILS, with a
    workflow annotation on the flagged line and escaped location in the job log;
  * a baseline entry that no longer reproduces FAILS as stale. Run with
    ``--prune`` to drop it: pruning only removes entries, so the baseline
    shrinks toward zero and never absorbs a new finding.

``--write-baseline`` rewrites the entries for the given languages from the
SARIF. It exists for the first baseline and for a reviewed re-baseline after a
CodeQL release changes its queries; a pull request that grows the baseline
shows every added entry in its diff.

WHAT IT REJECTS
---------------
Input the gate cannot read as described exits 2, never a pass:

  * a SARIF log or baseline that cannot be read or decoded as UTF-8 JSON,
    including JSON that Python's decoder refuses: nesting past its recursion
    limit, or an integer longer than its integer string conversion limit
    (4,300 digits by default);
  * a value of the wrong JSON type anywhere the gate reads, such as a string
    where SARIF has an object or a ``startLine`` that is not an integer;
  * a string the gate reads that is not UTF-8 text: JSON can escape a lone
    surrogate (a code point from U+D800 to U+DFFF), which UTF-8 cannot encode;
  * a result that lacks its rule id, its path or either fingerprint;
  * a baseline entry whose identity fields or message are not strings, or
    whose line is not an integer.

Paths, rule ids and messages come from the SARIF or the baseline. The runner
reads every output line for a workflow command, both ``::name::`` at the start
of a line and the legacy ``##[name]`` anywhere in it. Annotations escape those
values as GitHub's toolkit escapes command values, so no value can start a new
line or end a property. The runner finds the ``::`` that ends an annotation's
properties by a culture-sensitive search, which .NET on Linux runs through ICU
unless globalization-invariant mode is on. ICU rejects a match that would split
a grapheme cluster of the break iterator .NET passes it, so a combining mark
after that ``::`` or a prepended character before it would hide it. Each
annotation therefore writes its line number last and puts an ASCII space before
a message whose first character is not ASCII. The ``::`` then has an ASCII digit
before it and, after it, an ASCII character or the end of the line. The stale
and input-error lines use the toolkit's data escaping and also write ``#`` as
``%23``, so they stay on one line and never hold ``##[``. The comment above
_escape_data cites the runner, toolkit, .NET and ICU sources for these rules.

Run: python3 scripts/check_code_quality.py --sarif python=python.sarif [--sarif ...]
Exit 0 clean, 1 on a new or stale finding, 2 on unreadable or malformed input.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "config" / "code-quality-baseline.json"
SCHEMA_VERSION = 1
POLICY = (
    "Exact language, rule, path and CodeQL fingerprint (line hash and start column) matches only. A finding "
    "outside this list fails CI; an entry that no longer reproduces fails as stale until --prune removes it. "
    "The list only shrinks."
)
# The annotation cap keeps a large regression readable in the job log; the
# count line after it always states the full number.
MAX_ANNOTATIONS = 50
# JSON types as _json_type names them; _field takes one as the expected type.
OBJECT, ARRAY, STRING, INTEGER = "an object", "an array", "a string", "an integer"
IDENTITY_FIELDS = ("language", "rule", "path", "fingerprint", "column_fingerprint")


class InputError(ValueError):
    """The SARIF or the baseline could not be read as expected."""


def _json_type(value: Any) -> str:
    """The JSON type of a decoded value, as an error message names it."""
    if value is None:
        return "null"
    if isinstance(value, bool):  # tested before int, because bool is a subclass of int
        return "a boolean"
    if isinstance(value, int):
        return INTEGER
    if isinstance(value, float):
        return "a number"
    if isinstance(value, str):
        return STRING
    if isinstance(value, list):
        return ARRAY
    if isinstance(value, dict):
        return OBJECT
    return type(value).__name__


def _is_utf8(text: str) -> bool:
    """False for a string that UTF-8 cannot encode.

    A JSON string can escape a lone surrogate (``"\\ud800"`` with no low
    surrogate after it). Python decodes it into a str that holds the bare code
    point, and printing that str or writing it to the step summary raises
    UnicodeEncodeError.
    """
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _field(
    container: dict[str, Any] | None, key: str, expected: str, where: str
) -> Any:
    """``container[key]`` when its JSON type is ``expected``; None when the container or the key is absent.

    A present value of any other type, null included, raises InputError, and so
    does a string that is not UTF-8 text, so a malformed SARIF log or baseline
    exits 2 instead of crashing or passing.
    """
    if container is None or key not in container:
        return None
    value = container[key]
    if _json_type(value) != expected:
        raise InputError(f"{where}.{key} is {_json_type(value)}, expected {expected}")
    if expected == STRING and not _is_utf8(value):
        # The message names the value's JSON path and never quotes the value.
        raise InputError(
            f"{where}.{key} is a string with a lone surrogate, expected UTF-8 text"
        )
    return value


@dataclass(frozen=True, order=True)
class Finding:
    language: str
    rule: str
    path: str
    fingerprint: str
    column_fingerprint: str
    line: int = 0
    message: str = ""

    @property
    def key(self) -> tuple[str, str, str, str, str]:
        return (
            self.language,
            self.rule,
            self.path,
            self.fingerprint,
            self.column_fingerprint,
        )

    def as_entry(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "rule": self.rule,
            "path": self.path,
            "fingerprint": self.fingerprint,
            "column_fingerprint": self.column_fingerprint,
            "line": self.line,
            "message": self.message,
        }


def _finding_from_result(language: str, result: Any, where: str) -> Finding:
    """One SARIF result as a finding of ``language``, after type-checking every value the gate reads."""
    if not isinstance(result, dict):
        raise InputError(f"{where} is {_json_type(result)}, expected an object")
    # Both rule spellings are checked even when ruleId alone decides the rule.
    rule_id = _field(result, "ruleId", STRING, where)
    rule_reference_id = _field(
        _field(result, "rule", OBJECT, where), "id", STRING, f"{where}.rule"
    )
    rule = rule_id or rule_reference_id
    locations = _field(result, "locations", ARRAY, where)
    primary = locations[0] if locations else None
    if locations and not isinstance(primary, dict):
        raise InputError(
            f"{where}.locations[0] is {_json_type(primary)}, expected an object"
        )
    at = f"{where}.locations[0].physicalLocation"
    physical = _field(primary, "physicalLocation", OBJECT, f"{where}.locations[0]")
    path = _field(
        _field(physical, "artifactLocation", OBJECT, at),
        "uri",
        STRING,
        f"{at}.artifactLocation",
    )
    line = _field(
        _field(physical, "region", OBJECT, at), "startLine", INTEGER, f"{at}.region"
    )
    partial = _field(result, "partialFingerprints", OBJECT, where)
    fingerprint = _field(
        partial, "primaryLocationLineHash", STRING, f"{where}.partialFingerprints"
    )
    column = _field(
        partial,
        "primaryLocationStartColumnFingerprint",
        STRING,
        f"{where}.partialFingerprints",
    )
    text = _field(
        _field(result, "message", OBJECT, where), "text", STRING, f"{where}.message"
    )
    if rule is None or path is None:
        raise InputError(f"{where} has no rule id or file path")
    if not fingerprint or not column:
        # CodeQL always writes both; without them an entry would key on
        # the line number and break on every unrelated edit above it.
        raise InputError(
            f"{where} ({rule} {path}) has no primaryLocationLineHash or primaryLocationStartColumnFingerprint"
        )
    # An absent or empty message text has no lines; the finding then carries no message.
    lines = (text or "").splitlines()
    message = lines[0][:200] if lines else ""
    return Finding(language, rule, path, fingerprint, column, line or 0, message)


def findings_from_sarif(language: str, payload: Any) -> list[Finding]:
    """Every result in a CodeQL SARIF log, as findings of ``language``."""
    if not isinstance(payload, dict) or not isinstance(payload.get("runs"), list):
        raise InputError(f"{language}: SARIF has no runs list")
    findings: list[Finding] = []
    for run_index, run in enumerate(payload["runs"]):
        where = f"{language}: runs[{run_index}]"
        if not isinstance(run, dict):
            raise InputError(f"{where} is {_json_type(run)}, expected an object")
        results = _field(run, "results", ARRAY, where)
        if results is None:
            raise InputError(f"{where} has no results list")
        for index, result in enumerate(results):
            findings.append(
                _finding_from_result(language, result, f"{where}.results[{index}]")
            )
    return findings


def load_baseline(path: Path) -> list[Finding]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise InputError(f"{path}: not JSON ({exc})") from exc
    # ValueError covers UnicodeDecodeError and an integer past the conversion
    # limit; RecursionError is JSON nested past the decoder's recursion limit.
    except (OSError, ValueError, RecursionError) as exc:
        raise InputError(f"{path}: unreadable ({exc})") from exc
    if not isinstance(data, dict):
        raise InputError(f"{path}: expected a JSON object, got {_json_type(data)}")
    version = data.get("schema_version")
    # The type test keeps true and 1.0, which compare equal to 1, from passing.
    if (
        _json_type(version) != INTEGER
        or version != SCHEMA_VERSION
        or not isinstance(data.get("findings"), list)
    ):
        raise InputError(
            f"{path}: expected schema_version {SCHEMA_VERSION} and a findings list"
        )
    entries: list[Finding] = []
    for index, entry in enumerate(data["findings"]):
        where = f"{path}: findings[{index}]"
        if not isinstance(entry, dict):
            raise InputError(f"{where} is {_json_type(entry)}, expected an object")
        identity = {
            name: _field(entry, name, STRING, where) for name in IDENTITY_FIELDS
        }
        missing = [name for name, value in identity.items() if not value]
        if missing:
            raise InputError(f"{where} has no {', '.join(missing)}")
        line = _field(entry, "line", INTEGER, where)
        message = _field(entry, "message", STRING, where)
        entries.append(Finding(**identity, line=line or 0, message=message or ""))
    return entries


def _unique(findings: Iterable[Finding]) -> list[Finding]:
    """One finding per identity key, in first-seen order; a repeated key keeps its last line and message."""
    return list({finding.key: finding for finding in findings}.values())


def write_baseline(path: Path, findings: list[Finding]) -> None:
    ordered = sorted(_unique(findings))
    body = {
        "schema_version": SCHEMA_VERSION,
        "policy": POLICY,
        "findings": [finding.as_entry() for finding in ordered],
    }
    path.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")


# The runner reads every stdout and stderr line of a step for a workflow
# command in two forms. ActionCommandManager.TryProcessCommand tries
# ActionCommand.TryParseV2, which reads ``::name key=value,key=value::data``
# at the start of the line, and, when that fails, ActionCommand.TryParse, which
# reads the legacy ``##[name key=value;key=value]data`` wherever its ``##[``
# prefix occurs in the line:
# https://github.com/actions/runner/blob/main/src/Runner.Common/ActionCommand.cs
# https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommandManager.cs
#
# An annotation is a ``::`` command, so TryParseV2 reads it and decodes its
# escapes. _escape_data and _escape_property copy escapeData and escapeProperty
# from actions/toolkit packages/core/src/command.ts:
# https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
# Escaped, a property value (a SARIF path or rule id) holds no line break,
# comma or colon, and the message holds no line break. No value can then start
# a new line or end a property, and the ``::`` that ends the property list is
# the only one between the command's opening ``::`` and the message.
#
# Escaping alone does not fix where TryParseV2 sees that separator. It calls
# string.IndexOf(string, int), which compares by the current culture. On
# Linux, .NET runs that comparison as an ICU string search unless
# globalization-invariant mode is on. The runner targets .NET 8 (net8.0 in
# its src/Runner.Common/Runner.Common.csproj), whose pal_collation.c opens
# the search with usearch_openFromCollator and the break iterator that
# CreateCustomizedBreakIterator builds from BreakIteratorRuleNew:
# https://github.com/dotnet/runtime/blob/release/8.0/src/native/libs/System.Globalization.Native/pal_collation.c
# usearch_search rejects a match that would split a grapheme cluster of that
# iterator, through its combining-sequence and isBreakBoundary checks:
# https://github.com/unicode-org/icu/blob/main/icu4c/source/i18n/usearch.cpp
# .NET's iterator drops the CR x LF rule but keeps the rules that join an
# Extend, ZWJ or SpacingMark character to the character before it and a
# Prepend character to the character after it. A combining mark (U+0301) or
# spacing mark (U+0903) right after the separator, or a prepended character
# (U+0600) right before it, would therefore join the separator's colon to the
# value next to it. The runner would then take a later ``::`` in the message
# as the separator, or find none and read a ``##[`` in the message through
# TryParse. _annotation therefore writes the line property, an ASCII integer,
# last, and puts an ASCII space before a message whose first character is not
# ASCII. The separator then has an ASCII digit before it and an ASCII
# character or the end of the line after it, so a grapheme cluster boundary
# of that iterator falls at both of its ends.
#
# The stale and input-error lines are plain text, and the runner decodes no
# escape in them. _escape_plain gives them the data escaping, so a line break
# cannot start a ``::`` line, and writes every ``#`` as ``%23``, so the line
# never holds ``##[`` for TryParse to find. Escaping each ``#``, beyond each
# ``##[``, also holds if the match skips a character between the two ``#``:
# TryParse calls string.IndexOf(string), which compares by the current culture,
# and such a comparison does not consider ignorable characters such as the soft
# hyphen (U+00AD): https://learn.microsoft.com/dotnet/api/system.string.indexof
def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def _escape_plain(value: str) -> str:
    # % is already %25, so a %23 in the value reads %2523 and stays distinct.
    return _escape_data(value).replace("#", "%23")


def _annotation(finding: Finding) -> str:
    # The line property comes last, so an ASCII digit precedes the separator,
    # and a message whose first character is not ASCII gets an ASCII space
    # first, so the separator ends the line or an ASCII character follows it.
    properties = {
        "file": finding.path,
        "title": f"code quality: {finding.rule}",
        "line": str(finding.line),
    }
    rendered = ",".join(
        f"{name}={_escape_property(value)}" for name, value in properties.items()
    )
    data = _escape_data(finding.message)
    if not data[:1].isascii():
        data = " " + data
    return f"::error {rendered}::{data}"


def _summary(
    current: list[Finding],
    new: list[Finding],
    stale: list[Finding],
    languages: list[str],
) -> str:
    by_rule = Counter((finding.language, finding.rule) for finding in current)
    lines = [
        "## Code quality",
        "",
        (
            f"Languages: {', '.join(languages)}. Findings: {len(current)} "
            # Separate the baseline counts from the current finding total.
            f"({len(new)} new, {len(stale)} stale baseline entries)."
        ),
        "",
        "| language | rule | findings |",
        "|---|---|---|",
    ]
    lines += [
        f"| {language} | `{rule}` | {count} |"
        for (language, rule), count in by_rule.most_common()
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--sarif", action="append", default=[], metavar="LANGUAGE=PATH", required=True
    )
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--prune",
        action="store_true",
        help="drop baseline entries that no longer reproduce",
    )
    mode.add_argument(
        "--write-baseline",
        action="store_true",
        help="rewrite the given languages' entries",
    )
    args = parser.parse_args(argv)

    try:
        current: list[Finding] = []
        languages: list[str] = []
        for spec in args.sarif:
            language, sep, raw_path = spec.partition("=")
            if not sep or not language or not raw_path:
                raise InputError(f"--sarif takes LANGUAGE=PATH, got {spec!r}")
            try:
                payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
            # ValueError covers json.JSONDecodeError, UnicodeDecodeError and an
            # integer past the conversion limit; RecursionError is JSON nested
            # past the decoder's recursion limit.
            except (OSError, ValueError, RecursionError) as exc:
                raise InputError(f"{raw_path}: unreadable SARIF ({exc})") from exc
            current += findings_from_sarif(language, payload)
            languages.append(language)
        baseline = load_baseline(args.baseline)
    except InputError as exc:
        # The message can quote a SARIF or baseline path; escaped, it stays on
        # one line and holds no command.
        print(
            f"[FAIL] code_quality_readable: {_escape_plain(str(exc))}", file=sys.stderr
        )
        return 2

    # A result the SARIF repeats is one finding: one annotation, counted once.
    current = _unique(current)
    display_languages = _escape_plain(", ".join(languages))
    display_baseline = _escape_plain(str(args.baseline))
    scope = set(languages)
    kept = [entry for entry in baseline if entry.language not in scope]
    in_scope = [entry for entry in baseline if entry.language in scope]
    current_keys = {finding.key for finding in current}
    baseline_keys = {entry.key for entry in in_scope}

    if args.write_baseline:
        write_baseline(args.baseline, kept + current)
        print(
            f"[ok] code_quality: wrote {len(current_keys)} {display_languages} entries to {display_baseline}"
        )
        return 0

    new = sorted(finding for finding in current if finding.key not in baseline_keys)
    stale = sorted(entry for entry in in_scope if entry.key not in current_keys)

    if args.prune:
        write_baseline(
            args.baseline,
            kept + [entry for entry in in_scope if entry.key in current_keys],
        )
        print(
            f"[ok] code_quality: pruned {len(stale)} stale entr(ies) from {display_baseline}"
        )
        stale = []

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(_summary(current, new, stale, languages))

    for finding in new[:MAX_ANNOTATIONS]:
        print(_annotation(finding))
        # Downloaded logs may omit annotation properties. Keep the location
        # readable there, escaping untrusted values as for stale entries.
        print(
            _escape_plain(
                f"         new: {finding.language} {finding.rule} "
                f"{finding.path}:{finding.line}: {finding.message}"
            ),
            file=sys.stderr,
        )
    if len(new) > MAX_ANNOTATIONS:
        print(
            f"         and {len(new) - MAX_ANNOTATIONS} more new finding(s)",
            file=sys.stderr,
        )
    for entry in stale[:MAX_ANNOTATIONS]:
        # A plain line, but the runner scans it for commands too; escaped, a
        # baseline value can neither break the line nor hold a ##[ command.
        print(
            _escape_plain(
                f"         stale: {entry.language} {entry.rule} {entry.path}:{entry.line}"
            ),
            file=sys.stderr,
        )

    failed = False
    if new:
        failed = True
        print(
            f"[FAIL] code_quality: {len(new)} new finding(s) in {display_languages}, annotated above; "
            "fix them (the baseline never absorbs a new finding)",
            file=sys.stderr,
        )
    if stale:
        failed = True
        print(
            f"[FAIL] code_quality_baseline: {len(stale)} baseline entr(ies) no longer reproduce; run "
            "`python3 scripts/check_code_quality.py --prune --sarif ...` and commit config/code-quality-baseline.json",
            file=sys.stderr,
        )
    if failed:
        return 1
    print(
        f"[ok] code_quality: {len(current)} finding(s) in {display_languages}, all in the baseline, none stale"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
