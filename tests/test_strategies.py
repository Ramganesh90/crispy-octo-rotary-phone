import json
import unittest

from git_merge_driver.strategies import UnsupportedInput
from git_merge_driver.strategies.json_merge import merge_json_text
from git_merge_driver.strategies.lines import merge_lines


def dumps(value):
    return json.dumps(value, indent=2) + "\n"


class JsonMergeTest(unittest.TestCase):
    def merge(self, base, ours, theirs):
        result = merge_json_text(
            None if base is None else dumps(base), dumps(ours), dumps(theirs)
        )
        return json.loads(result.text), result.conflicts

    def test_disjoint_keys_merge_cleanly(self):
        merged, conflicts = self.merge(
            {"a": 1}, {"a": 1, "b": 2}, {"a": 1, "c": 3}
        )
        self.assertEqual(merged, {"a": 1, "b": 2, "c": 3})
        self.assertEqual(conflicts, [])

    def test_nested_objects_merge_recursively(self):
        base = {"deps": {"x": "1.0", "y": "1.0"}}
        ours = {"deps": {"x": "2.0", "y": "1.0"}}
        theirs = {"deps": {"x": "1.0", "y": "3.0", "z": "1.0"}}
        merged, conflicts = self.merge(base, ours, theirs)
        self.assertEqual(merged, {"deps": {"x": "2.0", "y": "3.0", "z": "1.0"}})
        self.assertEqual(conflicts, [])

    def test_deletion_on_one_side_is_applied(self):
        merged, conflicts = self.merge(
            {"a": 1, "b": 2}, {"a": 1}, {"a": 1, "b": 2, "c": 3}
        )
        self.assertEqual(merged, {"a": 1, "c": 3})
        self.assertEqual(conflicts, [])

    def test_conflicting_scalar_keeps_ours_and_reports_path(self):
        merged, conflicts = self.merge(
            {"v": {"n": 1}}, {"v": {"n": 2}}, {"v": {"n": 3}}
        )
        self.assertEqual(merged, {"v": {"n": 2}})
        self.assertEqual(conflicts, ['$["v"]["n"]'])

    def test_delete_vs_modify_conflicts(self):
        _, conflicts = self.merge({"a": 1}, {}, {"a": 2})
        self.assertEqual(conflicts, ['$["a"]'])

    def test_arrays_are_atomic(self):
        _, conflicts = self.merge({"l": [1]}, {"l": [1, 2]}, {"l": [1, 3]})
        self.assertEqual(conflicts, ['$["l"]'])

    def test_identical_changes_do_not_conflict(self):
        merged, conflicts = self.merge({"a": 1}, {"a": 2}, {"a": 2})
        self.assertEqual(merged, {"a": 2})
        self.assertEqual(conflicts, [])

    def test_type_sensitive_comparison(self):
        _, conflicts = self.merge({"a": 0}, {"a": 1}, {"a": True})
        self.assertEqual(conflicts, ['$["a"]'])

    def test_add_add_without_base(self):
        merged, conflicts = self.merge(None, {"a": 1}, {"b": 2})
        self.assertEqual(merged, {"a": 1, "b": 2})
        self.assertEqual(conflicts, [])

    def test_preserves_ours_formatting_and_key_order(self):
        ours = '{\n    "z": 1,\n    "a": 1\n}\n'
        result = merge_json_text('{"z": 1, "a": 1}', ours, '{"z": 1, "a": 1, "m": 2}')
        self.assertEqual(result.text, '{\n    "z": 1,\n    "a": 1,\n    "m": 2\n}\n')

    def test_invalid_json_raises_unsupported(self):
        with self.assertRaises(UnsupportedInput):
            merge_json_text("{}", "{not json", "{}")


class LinesMergeTest(unittest.TestCase):
    def test_additions_from_both_sides_are_kept(self):
        result = merge_lines("a\nb\n", "a\nb\nc\n", "a\nb\nd\n")
        self.assertEqual(result.text, "a\nb\nc\nd\n")
        self.assertTrue(result.clean)

    def test_removals_from_either_side_are_applied(self):
        result = merge_lines("a\nb\nc\n", "a\nc\n", "a\nb\n")
        self.assertEqual(result.text, "a\n")

    def test_same_addition_not_duplicated(self):
        result = merge_lines("a\n", "a\nx\n", "a\nx\n")
        self.assertEqual(result.text, "a\nx\n")

    def test_crlf_preserved(self):
        result = merge_lines("a\r\n", "a\r\nb\r\n", "a\r\nc\r\n")
        self.assertEqual(result.text, "a\r\nb\r\nc\r\n")


if __name__ == "__main__":
    unittest.main()
