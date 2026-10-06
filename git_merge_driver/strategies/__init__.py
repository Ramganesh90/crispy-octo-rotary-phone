"""Merge strategies.

Every strategy is a callable ``(base, ours, theirs) -> MergeResult`` operating
on decoded text. ``base`` is ``None`` when the file has no common ancestor
(e.g. both sides added it).
"""

from dataclasses import dataclass, field


@dataclass
class MergeResult:
    text: str
    conflicts: list = field(default_factory=list)

    @property
    def clean(self):
        return not self.conflicts


class UnsupportedInput(Exception):
    """Raised when a strategy cannot parse its input; the CLI falls back to a text merge."""


def _ours(base, ours, theirs):
    return MergeResult(ours)


def _theirs(base, ours, theirs):
    return MergeResult(theirs)


def get_strategies():
    from git_merge_driver.strategies.json_merge import merge_json_text
    from git_merge_driver.strategies.lines import merge_lines

    return {
        "json": (merge_json_text, "Structural 3-way merge of JSON objects, key by key"),
        "lines": (merge_lines, "Set-like merge of lines (.gitignore, CODEOWNERS, lists); never conflicts"),
        "ours": (_ours, "Always keep the current branch's version"),
        "theirs": (_theirs, "Always take the incoming branch's version"),
    }
