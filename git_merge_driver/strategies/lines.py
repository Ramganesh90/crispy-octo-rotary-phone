"""Set-like merge for files that are unordered lists of lines.

Lines added on either side are kept, lines removed on either side are dropped.
Order follows the current branch, with the incoming branch's new lines
appended. This never conflicts.
"""

from git_merge_driver.strategies import MergeResult


def _split(text):
    return text.splitlines() if text else []


def merge_lines(base, ours, theirs):
    base_lines = set(_split(base))
    ours_lines = _split(ours)
    theirs_lines = _split(theirs)

    removed_by_theirs = base_lines - set(theirs_lines)
    merged = [line for line in ours_lines if line not in removed_by_theirs]

    seen = set(ours_lines)
    for line in theirs_lines:
        if line not in base_lines and line not in seen:
            merged.append(line)
            seen.add(line)

    newline = "\r\n" if "\r\n" in ours else "\n"
    text = newline.join(merged)
    if merged and (ours.endswith("\n") or not ours):
        text += newline
    return MergeResult(text)
