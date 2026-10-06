"""End-to-end: install the driver into a scratch repo and run real `git merge`s."""

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest

from git_merge_driver import cli, gitconfig

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_NOSYSTEM": "1",
}


class GitRepoTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self._env = dict(os.environ)
        os.environ.update(GIT_ENV)
        os.environ["HOME"] = self.repo  # isolate from the user's global config
        self._cwd = os.getcwd()
        os.chdir(self.repo)
        self.git("init", "-q", "-b", "main")

    def tearDown(self):
        os.chdir(self._cwd)
        os.environ.clear()
        os.environ.update(self._env)
        self._tmp.cleanup()

    def git(self, *args, check=True):
        return subprocess.run(["git", *args], cwd=self.repo, capture_output=True,
                              text=True, check=check)

    def write(self, path, content):
        with open(os.path.join(self.repo, path), "w", encoding="utf-8") as fh:
            fh.write(content)

    def read(self, path):
        with open(os.path.join(self.repo, path), encoding="utf-8") as fh:
            return fh.read()

    def commit_all(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def diverge(self, path, base, ours, theirs):
        self.write(path, base)
        self.commit_all("base")
        self.git("checkout", "-q", "-b", "feature")
        self.write(path, theirs)
        self.commit_all("theirs")
        self.git("checkout", "-q", "main")
        self.write(path, ours)
        self.commit_all("ours")
        return self.git("merge", "--no-edit", "feature", check=False)


class InstallTest(GitRepoTestCase):
    def test_install_writes_config_and_attributes(self):
        code, _ = self.cli("install", "--strategy", "json", "*.json", "package.json")
        self.assertEqual(code, 0)
        driver = self.git("config", "merge.json-merge.driver").stdout
        self.assertIn("merge --strategy json %O %A %B", driver)
        self.assertEqual(
            self.read(".gitattributes"),
            "*.json merge=json-merge\npackage.json merge=json-merge\n",
        )

    def test_install_is_idempotent(self):
        self.cli("install", "-s", "lines", ".gitignore")
        self.cli("install", "-s", "lines", ".gitignore")
        self.assertEqual(self.read(".gitattributes"), ".gitignore merge=lines-merge\n")

    def test_uninstall_removes_only_its_lines(self):
        self.write(".gitattributes", "*.png binary\n")
        self.cli("install", "-s", "json", "*.json")
        code, _ = self.cli("uninstall", "json-merge")
        self.assertEqual(code, 0)
        self.assertEqual(self.read(".gitattributes"), "*.png binary\n")
        self.assertNotEqual(self.git("config", "merge.json-merge.driver", check=False).returncode, 0)


class MergeTest(GitRepoTestCase):
    def setUp(self):
        super().setUp()
        command = gitconfig.default_command()
        self.cli("install", "-s", "json", "--command", command, "*.json")
        self.cli("install", "-s", "lines", "--command", command, ".gitignore")

    def test_json_merge_resolves_what_text_merge_cannot(self):
        base = {"name": "app", "deps": {"a": "1"}}
        # Adjacent-line edits: git's text merge would conflict here.
        ours = {"name": "app", "deps": {"a": "1", "b": "1"}}
        theirs = {"name": "app", "deps": {"a": "1", "c": "1"}}
        proc = self.diverge("package.json", json.dumps(base, indent=2) + "\n",
                            json.dumps(ours, indent=2) + "\n",
                            json.dumps(theirs, indent=2) + "\n")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(self.read("package.json")),
                         {"name": "app", "deps": {"a": "1", "b": "1", "c": "1"}})

    def test_json_conflict_leaves_markers(self):
        proc = self.diverge("config.json", '{\n  "v": 1\n}\n', '{\n  "v": 2\n}\n', '{\n  "v": 3\n}\n')
        self.assertNotEqual(proc.returncode, 0)
        content = self.read("config.json")
        self.assertIn("<<<<<<<", content)
        self.assertIn('$["v"]', proc.stderr)

    def test_lines_merge(self):
        proc = self.diverge(".gitignore", "*.log\n", "*.log\nbuild/\n", "*.log\ndist/\n")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.read(".gitignore"), "*.log\nbuild/\ndist/\n")


if __name__ == "__main__":
    unittest.main()
