#!/usr/bin/env python3
"""Zero-trust validator for bun.lock changes against origin/<base>.

Enforces:
- No symlinks or NUL bytes in base or candidate bun.lock files.
- No new external/local URL references (http(s), git+, git, ssh, file, github, bitbucket, gitlab).
- Deterministic JSONC parsing (trailing commas outside string literals, duplicate keys rejected).
- Fail-closed checks on shared keys (SemVer -> non-SemVer, package name swap, top-level bundled flip).
- 3-Layer Mathematical No-Downgrade Invariant on non-bundled SemVer 2.0.0 entries:
  1. Per-(pkg_name, compat_line) top-aligned multiset dominance.
  2. Per-shared-key strict 1-to-1 slot vacation + exact-hoist sha512 integrity verification.
  3. Cross-bucket disappearance guard for canonical package names.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

REF_RE = re.compile(
    r"(?i)(?:https?://|git\+|git://|ssh://|file:|github:|bitbucket:|gitlab:)[^\s\"'`<>()\[\]{},;]*"
)
SEMVER_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

SemVer = tuple[int, int, int, int, tuple[tuple[int, int | str], ...]]
CompatLine = tuple[int, ...]
Bucket = tuple[str, CompatLine]


@dataclass(frozen=True)
class PackageEntry:
    key: str
    spec: str
    pkg_name: str
    ver: str
    sv: SemVer | None
    is_bundled: bool
    integrity: str


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError(f"duplicate key in bun.lock JSON: {k!r}")
        obj[k] = v
    return obj


def strip_trailing_commas(text: str) -> str:
    """Remove JSONC trailing commas outside JSON string literals."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_str = False
    escaped = False

    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            i += 1
        elif ch == '"':
            in_str = True
            out.append(ch)
            i += 1
        elif ch == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                i += 1
            else:
                out.append(ch)
                i += 1
        else:
            out.append(ch)
            i += 1

    return "".join(out)


def parse_pkg_spec(spec: str) -> tuple[str, str]:
    """Split package spec into (pkg_name, version_spec).

    For scoped (@scope/name@ver) or unscoped (name@ver) specs, splits at the first '@'
    after index 0 (npm package names cannot contain '@' after index 0). If no '@'
    appears after index 0, returns (spec, "").
    """
    at = spec.find("@", 1)
    if at > 0:
        return spec[:at], spec[at + 1 :]
    return spec, ""


def parse_semver(ver: str) -> SemVer | None:
    m = SEMVER_RE.fullmatch(ver)
    if not m:
        return None
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
    pre = m.group(4)
    if pre is None:
        return (major, minor, patch, 1, ())
    pre_tuple = tuple(
        (0, int(part)) if part.isdigit() else (1, part) for part in pre.split(".")
    )
    return (major, minor, patch, 0, pre_tuple)


def format_semver(sv: SemVer) -> str:
    major, minor, patch, is_stable, pre_tuple = sv
    base = f"{major}.{minor}.{patch}"
    if is_stable:
        return base
    pre = ".".join(str(part[1]) for part in pre_tuple)
    return f"{base}-{pre}"


def compat_line(sv: SemVer) -> CompatLine:
    major, minor, patch = sv[0], sv[1], sv[2]
    if major > 0:
        return (major,)
    if minor > 0:
        return (0, minor)
    return (0, 0, patch)


def format_compat_line(cline: CompatLine) -> str:
    if len(cline) == 1:
        return f"{cline[0]}.x"
    if len(cline) == 2:
        return f"0.{cline[1]}.x"
    return f"0.0.{cline[2]}"


def is_top_level_key(key: str) -> bool:
    if "/" not in key:
        return True
    return key.startswith("@") and key.count("/") == 1


def parse_bun_lock(text: str) -> tuple[dict[str, PackageEntry], bool]:
    cleaned = strip_trailing_commas(text)
    try:
        data = json.loads(cleaned, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid bun.lock JSONC: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("bun.lock root must be a JSON object")

    if "packages" not in data:
        return {}, False

    raw_pkgs = data["packages"]
    if not isinstance(raw_pkgs, dict):
        raise ValueError('bun.lock "packages" must be a JSON object')

    pkgs: dict[str, PackageEntry] = {}
    for key, val in raw_pkgs.items():
        if not isinstance(val, list) or len(val) < 1 or not isinstance(val[0], str):
            raise ValueError(
                f"invalid package entry for {key!r}: expected non-empty array starting with string"
            )
        spec = val[0]
        pkg_name, ver = parse_pkg_spec(spec)
        sv = parse_semver(ver)
        is_bundled = (
            len(val) >= 3
            and isinstance(val[2], dict)
            and val[2].get("bundled") is True
        )
        integrity = val[3] if len(val) >= 4 and isinstance(val[3], str) else ""
        pkgs[key] = PackageEntry(
            key=key,
            spec=spec,
            pkg_name=pkg_name,
            ver=ver,
            sv=sv,
            is_bundled=is_bundled,
            integrity=integrity,
        )

    return pkgs, True


def check_new_refs(
    path: str,
    old_text: str | None,
    new_text: str,
    diff_text: str | None = None,
) -> list[str]:
    allowed_refs = (
        {m.group(0) for m in REF_RE.finditer(old_text)}
        if old_text is not None
        else set()
    )
    errors: list[str] = []
    seen_bad: set[str] = set()

    if diff_text is not None:
        for line in diff_text.splitlines():
            if not line.startswith("+") or line.startswith("+++"):
                continue
            for m in REF_RE.finditer(line[1:]):
                found = m.group(0)
                if found not in allowed_refs and found not in seen_bad:
                    seen_bad.add(found)
                    errors.append(
                        f"::error::{path}: new external/local URL reference forbidden in bun.lock: {found!r}"
                    )

    for m in REF_RE.finditer(new_text):
        found = m.group(0)
        if found not in allowed_refs and found not in seen_bad:
            seen_bad.add(found)
            errors.append(
                f"::error::{path}: new external/local URL reference forbidden in bun.lock: {found!r}"
            )

    return errors


def _is_eligible_hoist_source(
    old_t: PackageEntry,
    new_t: PackageEntry,
    src: PackageEntry,
    new_pkgs: dict[str, PackageEntry],
    pkg_name: str,
    cline: CompatLine,
) -> bool:
    if src.key == new_t.key:
        return False
    assert src.sv is not None and new_t.sv is not None and old_t.sv is not None
    if src.sv > new_t.sv:
        return False

    # Exact hoist integrity check when both integrities are present.
    if (
        src.sv == new_t.sv
        and src.integrity
        and new_t.integrity
        and src.integrity != new_t.integrity
    ):
        return False

    # Strict vacation check for src.key in new_pkgs.
    ns = new_pkgs.get(src.key)
    if ns is None:
        return True
    if ns.is_bundled or ns.sv is None:
        return True
    if ns.pkg_name != pkg_name or compat_line(ns.sv) != cline:
        return True
    # Swap inside same compat_line: vacated source must now hold >= old_t.sv.
    return ns.sv >= old_t.sv


def validate_packages(
    path: str,
    old_pkgs: dict[str, PackageEntry],
    new_pkgs: dict[str, PackageEntry],
) -> list[str]:
    errors: list[str] = []

    # Fail-closed checks on shared keys.
    for key in sorted(old_pkgs.keys() & new_pkgs.keys()):
        o = old_pkgs[key]
        n = new_pkgs[key]
        if o.sv is not None and n.sv is None:
            errors.append(
                f"::error::{path}: SemVer version replaced by non-SemVer for {key} ({o.spec} -> {n.spec})"
            )
        if o.sv is not None and o.pkg_name != n.pkg_name:
            errors.append(
                f"::error::{path}: package alias swap forbidden for {key} ({o.spec} -> {n.spec})"
            )
        if not o.is_bundled and n.is_bundled and is_top_level_key(key):
            errors.append(
                f"::error::{path}: top-level package cannot become bundled for {key} ({o.spec} -> {n.spec})"
            )

    old_nb = {
        k: e for k, e in old_pkgs.items() if not e.is_bundled and e.sv is not None
    }
    new_nb = {
        k: e for k, e in new_pkgs.items() if not e.is_bundled and e.sv is not None
    }

    # Layer 1: Per-(pkg_name, compat_line) top-aligned multiset dominance on changed entries.
    # Pure spectator keys (identical key, pkg_name, SemVer, and integrity in both old and new)
    # cannot participate in any downgrade, hoist, or swap; cancelling them prevents false
    # positives when a higher-version nested copy is deleted while an untouched lower-version
    # copy in the same compat line remains (e.g. root tslib@2.8.1 when nested */tslib@2.9.1
    # copies disappear with their parent packages).
    spectator_keys = {
        k
        for k in (old_nb.keys() & new_nb.keys())
        if old_nb[k].pkg_name == new_nb[k].pkg_name
        and old_nb[k].sv == new_nb[k].sv
        and old_nb[k].integrity == new_nb[k].integrity
    }

    old_buckets: dict[Bucket, list[SemVer]] = {}
    for k, entry in old_nb.items():
        if k in spectator_keys:
            continue
        assert entry.sv is not None
        old_buckets.setdefault((entry.pkg_name, compat_line(entry.sv)), []).append(
            entry.sv
        )

    new_buckets: dict[Bucket, list[SemVer]] = {}
    for k, entry in new_nb.items():
        if k in spectator_keys:
            continue
        assert entry.sv is not None
        new_buckets.setdefault((entry.pkg_name, compat_line(entry.sv)), []).append(
            entry.sv
        )

    for bucket in sorted(old_buckets.keys() & new_buckets.keys()):
        old_svs = sorted(old_buckets[bucket])
        new_svs = sorted(new_buckets[bucket])
        k = min(len(old_svs), len(new_svs))
        for i in range(k):
            if new_svs[-k + i] < old_svs[-k + i]:
                pkg_name, cline = bucket
                errors.append(
                    f"::error::{path}: Layer 1 downgrade forbidden for {pkg_name} "
                    f"(compat {format_compat_line(cline)}): "
                    f"{format_semver(old_svs[-k + i])} -> {format_semver(new_svs[-k + i])}"
                )
                break

    # Layer 2: Per-shared-key strict 1-to-1 slot vacation + exact-hoist sha512 check.
    downgrade_groups: dict[Bucket, list[tuple[PackageEntry, PackageEntry]]] = {}
    for key in sorted(old_nb.keys() & new_nb.keys()):
        o = old_nb[key]
        n = new_nb[key]
        if o.pkg_name != n.pkg_name:
            continue
        assert o.sv is not None and n.sv is not None
        if n.sv < o.sv:
            downgrade_groups.setdefault((n.pkg_name, compat_line(n.sv)), []).append(
                (o, n)
            )

    old_nb_by_bucket: dict[Bucket, list[PackageEntry]] = {}
    for entry in old_nb.values():
        assert entry.sv is not None
        old_nb_by_bucket.setdefault((entry.pkg_name, compat_line(entry.sv)), []).append(
            entry
        )

    for bucket in sorted(downgrade_groups.keys()):
        pkg_name, cline = bucket
        targets = sorted(
            downgrade_groups[bucket],
            key=lambda pair: (pair[1].sv, pair[0].key),
        )
        candidates = old_nb_by_bucket.get(bucket, [])

        # Build ordered adjacency list (prefer exact integrity match, then highest src.sv).
        adj: list[list[str]] = []
        for old_t, new_t in targets:
            eligible = [
                src
                for src in candidates
                if _is_eligible_hoist_source(old_t, new_t, src, new_pkgs, pkg_name, cline)
            ]
            eligible.sort(
                key=lambda src: (
                    1
                    if (
                        src.sv == new_t.sv
                        and bool(src.integrity)
                        and src.integrity == new_t.integrity
                    )
                    else 0,
                    src.sv,
                ),
                reverse=True,
            )
            adj.append([src.key for src in eligible])

        # Maximum bipartite matching guarantees strict 1-to-1 source consumption.
        matched_target_for_src: dict[str, int] = {}

        def try_match(target_idx: int, visited: set[str]) -> bool:
            for src_key in adj[target_idx]:
                if src_key in visited:
                    continue
                visited.add(src_key)
                prev_target = matched_target_for_src.get(src_key)
                if prev_target is None or try_match(prev_target, visited):
                    matched_target_for_src[src_key] = target_idx
                    return True
            return False

        for target_idx, (old_t, new_t) in enumerate(targets):
            if not try_match(target_idx, set()):
                errors.append(
                    f"::error::{path}: Layer 2 downgrade forbidden for {new_t.key} "
                    f"({old_t.ver} -> {new_t.ver}): no eligible vacated hoist source in "
                    f"{pkg_name} compat {format_compat_line(cline)}"
                )

    # Layer 3: Cross-bucket disappearance guard.
    old_by_pkg: dict[str, list[SemVer]] = {}
    for entry in old_nb.values():
        assert entry.sv is not None
        old_by_pkg.setdefault(entry.pkg_name, []).append(entry.sv)

    new_by_pkg: dict[str, list[SemVer]] = {}
    for entry in new_nb.values():
        assert entry.sv is not None
        new_by_pkg.setdefault(entry.pkg_name, []).append(entry.sv)

    for pkg_name in sorted(old_by_pkg.keys() & new_by_pkg.keys()):
        old_max = max(old_by_pkg[pkg_name])
        new_max = max(new_by_pkg[pkg_name])
        if new_max < old_max:
            old_lines = {compat_line(sv) for sv in old_by_pkg[pkg_name]}
            new_lines = {compat_line(sv) for sv in new_by_pkg[pkg_name]}
            unexpected = sorted(new_lines - old_lines)
            if unexpected:
                formatted = ", ".join(format_compat_line(c) for c in unexpected)
                errors.append(
                    f"::error::{path}: Layer 3 cross-bucket downgrade forbidden for {pkg_name}: "
                    f"max {format_semver(old_max)} -> {format_semver(new_max)} introduced "
                    f"new compat line(s) [{formatted}] not present in base"
                )

    return errors


def validate_lock_texts(
    path: str,
    old_text: str | None,
    new_text: str,
    diff_text: str | None = None,
) -> list[str]:
    errors = check_new_refs(path, old_text, new_text, diff_text=diff_text)

    try:
        new_pkgs, new_found = parse_bun_lock(new_text)
    except ValueError as exc:
        errors.append(f"::error::{path}: {exc}")
        return errors

    if old_text is None:
        return errors

    try:
        old_pkgs, _ = parse_bun_lock(old_text)
    except ValueError as exc:
        errors.append(f"::error::{path}: base lockfile parse error: {exc}")
        return errors

    if old_pkgs and not new_found:
        errors.append(f'::error::{path}: missing "packages" section in bun.lock')
        return errors

    errors.extend(validate_packages(path, old_pkgs, new_pkgs))
    return errors


def _read_regular_utf8(path: str, label: str, reject_symlink: bool = True) -> tuple[str | None, str | None]:
    if reject_symlink and os.path.islink(path):
        return None, f"::error::{label}: bun.lock must not be a symlink"
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return None, f"::error::{label}: failed to read file: {exc}"
    if b"\x00" in raw:
        return None, f"::error::{label}: contains NUL byte (\\x00)"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError as exc:
        return None, f"::error::{label}: invalid UTF-8: {exc}"


def validate_git_lock_file(base: str, path: str) -> list[str]:
    if not base or base.startswith("-"):
        return [f"::error::{path}: invalid base branch name: {base!r}"]

    new_text, err = _read_regular_utf8(path, path, reject_symlink=True)
    if err is not None:
        return [err]
    assert new_text is not None

    ref_check = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"origin/{base}^{{commit}}"],
        check=False,
        capture_output=True,
    )
    if ref_check.returncode != 0:
        return [f"::error::{path}: base commit origin/{base} not found"]

    exists_res = subprocess.run(
        ["git", "cat-file", "-e", f"origin/{base}:{path}"],
        check=False,
        capture_output=True,
    )
    old_text: str | None = None
    diff_text: str | None = None

    if exists_res.returncode == 0:
        old_res = subprocess.run(
            ["git", "show", f"origin/{base}:{path}"],
            check=False,
            capture_output=True,
        )
        if old_res.returncode != 0:
            stderr = old_res.stderr.decode("utf-8", "replace").strip()
            return [f"::error::{path}: git show origin/{base}:{path} failed: {stderr}"]
        if b"\x00" in old_res.stdout:
            return [f"::error::origin/{base}:{path}: contains NUL byte (\\x00)"]
        try:
            old_text = old_res.stdout.decode("utf-8")
        except UnicodeDecodeError as exc:
            return [f"::error::origin/{base}:{path}: invalid UTF-8: {exc}"]

        diff_res = subprocess.run(
            ["git", "diff", "-U0", "--no-color", f"origin/{base}", "--", path],
            check=False,
            capture_output=True,
        )
        if diff_res.returncode != 0:
            stderr = diff_res.stderr.decode("utf-8", "replace").strip()
            return [f"::error::{path}: git diff failed: {stderr}"]
        diff_text = diff_res.stdout.decode("utf-8", "replace")

    return validate_lock_texts(path, old_text, new_text, diff_text=diff_text)


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--old-file":
        if len(argv) != 5 or argv[3] != "--new-file":
            print(
                "::error::Usage: validate-bun-lock.py --old-file <old> --new-file <new>",
                file=sys.stderr,
            )
            return 1
        old_path, new_path = argv[2], argv[4]
        old_text, old_err = _read_regular_utf8(old_path, old_path, reject_symlink=False)
        if old_err is not None:
            print(old_err, file=sys.stderr)
            return 1
        new_text, new_err = _read_regular_utf8(new_path, new_path, reject_symlink=True)
        if new_err is not None:
            print(new_err, file=sys.stderr)
            return 1
        assert old_text is not None and new_text is not None
        errors = validate_lock_texts(new_path, old_text, new_text)
        if errors:
            for err in errors:
                print(err, file=sys.stderr)
            return 1
        return 0

    if len(argv) < 3:
        print(
            "::error::Usage: validate-bun-lock.py <base> <lock_file> [<lock_file> ...]",
            file=sys.stderr,
        )
        return 1

    base = argv[1]
    lock_files = argv[2:]
    all_errors: list[str] = []
    for lock_path in lock_files:
        all_errors.extend(validate_git_lock_file(base, lock_path))

    if all_errors:
        for err in all_errors:
            print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
