"""Structural three-way merge for JSON documents.

Objects are merged key by key, recursively. Any other value (scalars, arrays)
is treated atomically: if both sides changed it differently, that path is a
conflict.
"""

import json
import re

from git_merge_driver.strategies import MergeResult, UnsupportedInput

MISSING = object()


def _same(a, b):
    if a is MISSING or b is MISSING:
        return a is b
    # json.dumps keeps 1 / 1.0 / True distinct, which == does not.
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _format_path(path):
    if not path:
        return "$"
    return "$" + "".join(f"[{json.dumps(p)}]" for p in path)


def merge_values(base, ours, theirs, path=(), conflicts=None):
    """Merge three JSON values. Returns (merged, conflicts).

    MISSING marks an absent value (deleted key, or no common ancestor).
    On conflict the value from ``ours`` is kept and the path recorded.
    """
    if conflicts is None:
        conflicts = []

    if _same(ours, theirs):
        return ours, conflicts
    if _same(base, ours):
        return theirs, conflicts
    if _same(base, theirs):
        return ours, conflicts

    if isinstance(ours, dict) and isinstance(theirs, dict):
        base_dict = base if isinstance(base, dict) else {}
        merged = {}
        keys = list(ours) + [k for k in theirs if k not in ours]
        for key in keys:
            value, _ = merge_values(
                base_dict.get(key, MISSING),
                ours.get(key, MISSING),
                theirs.get(key, MISSING),
                path + (key,),
                conflicts,
            )
            if value is not MISSING:
                merged[key] = value
        return merged, conflicts

    conflicts.append(_format_path(path))
    return ours, conflicts


def _detect_indent(text):
    match = re.search(r"\n([ \t]+)\S", text)
    if not match:
        return None
    indent = match.group(1)
    return indent if "\t" in indent else len(indent)


def _load(text, label):
    if text is None or not text.strip():
        return MISSING
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise UnsupportedInput(f"{label} is not valid JSON: {exc}") from exc


def merge_json_text(base, ours, theirs):
    base_val = _load(base, "base")
    ours_val = _load(ours, "ours")
    theirs_val = _load(theirs, "theirs")

    merged, conflicts = merge_values(base_val, ours_val, theirs_val)
    if merged is MISSING:
        return MergeResult("", conflicts)

    text = json.dumps(merged, indent=_detect_indent(ours), ensure_ascii=False)
    if ours.endswith("\n"):
        text += "\n"
    return MergeResult(text, conflicts)
