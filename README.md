# crispy-octo-rotary-phone

`git-merge-driver` — a custom [git merge driver](https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver)
CLI with pluggable strategies. Pure Python standard library, no dependencies.

Git's default merge is line-based, so two branches that each add a key to the
same JSON object, or a line to the end of `.gitignore`, conflict even though
the changes are independent. A merge driver lets git hand those files to a
smarter merger.

## Strategies

| Strategy | Use for | Behavior |
|----------|---------|----------|
| `json`   | `package.json`, config files | Recursive key-by-key 3-way merge. Arrays and scalars are atomic. Real conflicts are reported by JSON path and left with standard conflict markers. Keeps the current branch's indentation and key order. Invalid JSON falls back to a normal text merge. |
| `lines`  | `.gitignore`, `CODEOWNERS`, word lists | Treats the file as a set of lines: additions from both sides are kept, removals from either side applied. Never conflicts. |
| `ours`   | generated files, lockfiles you regenerate | Always keeps the current branch's version. |
| `theirs` | vendored files | Always takes the incoming branch's version. |

## Install

```sh
pip install .            # puts `git-merge-driver` on PATH
```

Or run it without installing: `python3 -m git_merge_driver ...` from this directory.

## Usage

Register a driver in a repository (run inside that repo):

```sh
git-merge-driver install --strategy json '*.json'
git-merge-driver install --strategy lines .gitignore CODEOWNERS
git add .gitattributes && git commit -m "Use custom merge drivers"
```

This writes `merge.<strategy>-merge.driver` to `.git/config` and adds
`<pattern> merge=<strategy>-merge` lines to `.gitattributes`. Options:

- `--name NAME` — driver name (default `<strategy>-merge`)
- `--global` — put the driver definition in `~/.gitconfig` so every repo whose
  `.gitattributes` references it can use it
- `--command CMD` — command git should run (default: `git-merge-driver` if on
  PATH, otherwise this Python interpreter with `-m git_merge_driver`)
- `--attributes-file PATH` — e.g. `.git/info/attributes` to keep it unversioned

Note that `.gitattributes` is committed but `.git/config` is not: everyone who
clones the repo needs to run `install` (or `--global` once) for the driver to
take effect. Without it git silently falls back to its normal merge.

Other commands:

```sh
git-merge-driver strategies          # list strategies
git-merge-driver uninstall json-merge
git-merge-driver merge -s json BASE OURS THEIRS   # what git invokes (%O %A %B)
```

`merge` writes the result into `OURS` and exits `0` when clean, `1` on conflict.

## Tests

```sh
python3 -m unittest discover -s tests -t .
```

The integration tests create scratch repositories and run real `git merge`s
through the driver.
