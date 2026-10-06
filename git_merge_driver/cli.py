"""Command-line interface.

Exit codes for ``merge`` follow git's merge-driver contract: 0 means the
result in %A is clean, non-zero means it has conflicts.
"""

import argparse
import os
import subprocess
import sys

from git_merge_driver import __version__, gitconfig
from git_merge_driver.strategies import UnsupportedInput, get_strategies

EXIT_CLEAN = 0
EXIT_CONFLICT = 1
EXIT_ERROR = 2


def _read(path):
    with open(path, "rb") as fh:
        data = fh.read()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UnsupportedInput(f"{path} is not UTF-8 text") from exc


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def text_merge(base, ours, theirs, marker_size, label):
    """Standard line-based merge with conflict markers, written into ``ours``.

    Returns the number of conflicts (0 when clean).
    """
    proc = subprocess.run(
        [
            "git", "merge-file",
            f"--marker-size={marker_size}",
            "-L", f"ours:{label}", "-L", f"base:{label}", "-L", f"theirs:{label}",
            ours, base, theirs,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode < 0:
        raise gitconfig.GitError(proc.stderr.strip() or "git merge-file failed")
    return proc.returncode


def cmd_merge(args):
    strategy, _ = get_strategies()[args.strategy]
    label = args.path or os.path.basename(args.ours)

    try:
        result = strategy(_read(args.base), _read(args.ours), _read(args.theirs))
    except UnsupportedInput as exc:
        print(f"git-merge-driver: {label}: {exc}; falling back to text merge", file=sys.stderr)
        conflicts = text_merge(args.base, args.ours, args.theirs, args.marker_size, label)
        return EXIT_CONFLICT if conflicts else EXIT_CLEAN

    if result.clean:
        _write(args.ours, result.text)
        return EXIT_CLEAN

    print(f"git-merge-driver: {label}: {len(result.conflicts)} conflict(s):", file=sys.stderr)
    for conflict in result.conflicts:
        print(f"  {conflict}", file=sys.stderr)

    # Leave familiar conflict markers for the user to resolve. If the text
    # merge happens to be clean, keep the structural result (ours wins on the
    # conflicting paths) instead, but still report the conflict.
    if text_merge(args.base, args.ours, args.theirs, args.marker_size, label) == 0:
        _write(args.ours, result.text)
    return EXIT_CONFLICT


def _attributes_file(args):
    if args.attributes_file:
        return args.attributes_file
    return os.path.join(gitconfig.repo_root(), ".gitattributes")


def cmd_install(args):
    name = args.name or f"{args.strategy}-merge"
    command = args.command or gitconfig.default_command()
    attributes = _attributes_file(args)
    added = gitconfig.install(name, args.strategy, args.patterns, command, attributes, args.global_)

    scope = "global" if args.global_ else "local"
    print(f"Registered merge driver '{name}' in {scope} git config")
    print(f"  driver = {gitconfig.driver_line(command, args.strategy)}")
    if added:
        print(f"Added to {attributes}:")
        for line in added:
            print(f"  {line}")
    else:
        print(f"{attributes} already up to date")
    return EXIT_CLEAN


def cmd_uninstall(args):
    attributes = _attributes_file(args)
    removed_config, removed_lines = gitconfig.uninstall(args.name, attributes, args.global_)
    if removed_config:
        print(f"Removed merge driver '{args.name}' from git config")
    else:
        print(f"No merge driver '{args.name}' in git config")
    for line in removed_lines:
        print(f"Removed from {attributes}: {line}")
    return EXIT_CLEAN


def cmd_strategies(args):
    strategies = get_strategies()
    width = max(len(name) for name in strategies)
    for name, (_, description) in strategies.items():
        print(f"{name.ljust(width)}  {description}")
    return EXIT_CLEAN


def build_parser():
    strategies = list(get_strategies())
    parser = argparse.ArgumentParser(
        prog="git-merge-driver",
        description="Custom merge driver for git with pluggable strategies.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    merge = sub.add_parser(
        "merge",
        help="perform a merge (invoked by git)",
        description="Merge OURS with THEIRS using BASE as ancestor; the result is written to OURS.",
    )
    merge.add_argument("--strategy", "-s", choices=strategies, required=True)
    merge.add_argument("base", help="common ancestor version (%%O)")
    merge.add_argument("ours", help="current branch version, overwritten with the result (%%A)")
    merge.add_argument("theirs", help="other branch version (%%B)")
    merge.add_argument("--marker-size", type=int, default=7, help="conflict marker length (%%L)")
    merge.add_argument("--path", help="path of the file being merged (%%P), used in messages")
    merge.set_defaults(func=cmd_merge)

    install = sub.add_parser("install", help="register the driver for file patterns")
    install.add_argument("--strategy", "-s", choices=strategies, required=True)
    install.add_argument("patterns", nargs="+", help="gitattributes patterns, e.g. '*.json'")
    install.add_argument("--name", help="driver name (default: <strategy>-merge)")
    install.add_argument("--command", help="command git runs (default: auto-detected)")
    install.add_argument("--global", dest="global_", action="store_true",
                         help="write the driver to global instead of repo git config")
    install.add_argument("--attributes-file", help="attributes file (default: <repo>/.gitattributes)")
    install.set_defaults(func=cmd_install)

    uninstall = sub.add_parser("uninstall", help="remove a registered driver")
    uninstall.add_argument("name", help="driver name, e.g. json-merge")
    uninstall.add_argument("--global", dest="global_", action="store_true")
    uninstall.add_argument("--attributes-file")
    uninstall.set_defaults(func=cmd_uninstall)

    lister = sub.add_parser("strategies", help="list available merge strategies")
    lister.set_defaults(func=cmd_strategies)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (gitconfig.GitError, OSError) as exc:
        print(f"git-merge-driver: error: {exc}", file=sys.stderr)
        return EXIT_ERROR
