"""Runs the shared corpus in tests/corpus/ against the Python engines.

The same fixtures are run against the TypeScript extension engine by
extension/src/test/suite/corpus.unit.test.ts, so a semantic change to either
engine fails here or there. See tests/corpus/README.md for why the comparison
is on parsed values rather than text.
"""

import json
import os
import unittest

from git_merge_driver.strategies.json_merge import merge_json_text
from git_merge_driver.strategies.lines import merge_lines

CORPUS_DIR = os.path.join(os.path.dirname(__file__), "corpus")


def expected(case):
    """The case's shared expectation, unless this engine states its own."""
    return case.get("overrides", {}).get("python", case)


def load_cases(name):
    with open(os.path.join(CORPUS_DIR, name), encoding="utf-8") as fh:
        return json.load(fh)


class CorpusTest(unittest.TestCase):
    def test_json_cases(self):
        cases = load_cases("json-cases.json")
        self.assertTrue(cases, "corpus is empty")
        for case in cases:
            with self.subTest(case["name"]):
                want = expected(case)
                result = merge_json_text(case["base"], case["ours"], case["theirs"])
                self.assertEqual(result.conflicts, want["expectedConflicts"])
                self.assertEqual(json.loads(result.text), want["expectedValue"])

    def test_lines_cases(self):
        cases = load_cases("lines-cases.json")
        self.assertTrue(cases, "corpus is empty")
        for case in cases:
            with self.subTest(case["name"]):
                want = expected(case)
                result = merge_lines(case["base"], case["ours"], case["theirs"])
                self.assertEqual(result.conflicts, want["expectedConflicts"])
                self.assertEqual(result.text.splitlines(), want["expectedValue"])


if __name__ == "__main__":
    unittest.main()
