"""Registering and removing the driver in git config and .gitattributes."""

import os
import shlex
import shutil
import subprocess
import sys

EXECUTABLE = "git-merge-driver"


class GitError(Exception):
    pass


def git(*args, cwd=None, check=True):
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise GitError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc


def repo_root(cwd=None):
    return git("rev-parse", "--show-toplevel", cwd=cwd).stdout.strip()


def default_command():
    """How git should invoke us: the installed script if on PATH, else this interpreter."""
    if shutil.which(EXECUTABLE):
        return EXECUTABLE
    package_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return (
        f"PYTHONPATH={shlex.quote(package_parent)} "
        f"{shlex.quote(sys.executable)} -m git_merge_driver"
    )


def driver_line(command, strategy):
    return f"{command} merge --strategy {strategy} %O %A %B --marker-size %L --path %P"


def _scope(global_):
    return ["--global"] if global_ else ["--local"]


def install(name, strategy, patterns, command, attributes_file, global_=False, cwd=None):
    scope = _scope(global_)
    git("config", *scope, f"merge.{name}.name", f"git-merge-driver ({strategy})", cwd=cwd)
    git("config", *scope, f"merge.{name}.driver", driver_line(command, strategy), cwd=cwd)

    existing = []
    if os.path.exists(attributes_file):
        with open(attributes_file, encoding="utf-8") as fh:
            existing = fh.read().splitlines()

    added = []
    for pattern in patterns:
        line = f"{pattern} merge={name}"
        if line not in existing:
            added.append(line)

    if added:
        prefix = ""
        if os.path.exists(attributes_file):
            with open(attributes_file, encoding="utf-8") as fh:
                content = fh.read()
            if content and not content.endswith("\n"):
                prefix = "\n"
        with open(attributes_file, "a", encoding="utf-8") as fh:
            fh.write(prefix + "\n".join(added) + "\n")
    return added


def uninstall(name, attributes_file, global_=False, cwd=None):
    proc = git("config", *_scope(global_), "--remove-section", f"merge.{name}", cwd=cwd, check=False)
    removed_config = proc.returncode == 0

    removed = []
    if os.path.exists(attributes_file):
        with open(attributes_file, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        kept = []
        for line in lines:
            if f"merge={name}" in line.split()[1:]:
                removed.append(line)
            else:
                kept.append(line)
        if removed:
            with open(attributes_file, "w", encoding="utf-8") as fh:
                fh.write("\n".join(kept) + ("\n" if kept else ""))
    return removed_config, removed
