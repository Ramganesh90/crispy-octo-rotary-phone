# Structural Merge Resolver

Resolve merge conflicts in JSON, YAML and list files **key by key** instead of
line by line.

When two branches each add a dependency to `package.json`, git sees two edits on
neighbouring lines and gives up. The keys never actually clashed. This extension
reads the three sides of the conflict out of the git index, works out which keys
genuinely differ, and asks you only about those.

![The resolver, showing two conflicting keys with ours/theirs choices and a live preview](https://raw.githubusercontent.com/Ramganesh90/crispy-octo-rotary-phone/main/docs/images/resolver-dark.png)

## What it does

- **A tree of decisions, not a wall of markers.** Keys that merged cleanly are
  marked as such and collapsed. Keys both branches changed are offered as a
  choice: Ours, Theirs, Base, or a value you type.
- **A live preview** of the exact file that will be written.
- **Apply is blocked** while any conflict is undecided, so a half-resolved file
  can never be written by accident.
- **Keyboard-first if you want it:** <kbd>j</kbd>/<kbd>k</kbd> between
  conflicts, <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> to pick a side,
  <kbd>e</kbd> to type a value. Everything is clickable too.
- **Resolve all cleanly mergeable files** in one action from the sidebar, for
  the files that need no decisions at all.

## Supported files

| Format | Files | Behavior |
|---|---|---|
| JSON / JSONC | `*.json`, `*.jsonc`, `.babelrc`, `.eslintrc`, … | Recursive key-by-key merge. Arrays and scalars are atomic. Comments, indentation and key order are preserved. |
| YAML | `*.yml`, `*.yaml` | Same semantics, with comments preserved. Multi-document streams and files using anchors/aliases are left to the text merge on purpose — editing them key by key can change what they mean. |
| Line sets | `.gitignore`, `CODEOWNERS`, `.dockerignore`, … | Additions from both sides kept, removals from either side applied. Never conflicts. |
| Lockfiles | `package-lock.json`, `npm-shrinkwrap.json` | Not merged entry by entry: independently merged entries can describe a tree that will not install. Keep one side, then regenerate. |

Anything else is left to git's own merge editor, and the sidebar says so rather
than pretending otherwise.

## Usage

Run a merge. Conflicted files appear in the **Merge Conflicts** view in the
activity bar:

- a file with structural conflicts shows the count — click it to resolve
- a file that merges cleanly can be applied without opening it
- a file needing a text merge opens in the normal editor

You can also use the CodeLens at the top of a conflicted file, the editor title
button, or **Structural Merge: Resolve Conflict Structurally** from the command
palette.

Applying writes the file through the editor's own edit system, so undo still
works, and then stages it to mark the conflict resolved.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `structuralMerge.showCodeLens` | `true` | Offer the resolver at the top of a conflicted file. |
| `structuralMerge.stageAfterApply` | `true` | Run `git add` after applying. |
| `structuralMerge.lockfileStrategy` | `ask` | `ask`, `regenerate` or `merge` for conflicted lockfiles. |

## Relationship to the CLI

This repository also contains [`git-merge-driver`](../README.md), a Python CLI
implementing the same merge semantics as an actual git merge driver. They serve
different moments:

- the **CLI** merges on the command line and in CI, with no editor involved
- the **extension** is for resolving interactively

The two share a fixture corpus (`tests/corpus/`) that both test suites run, so
they cannot drift apart.

## Development

```sh
npm install
npm run watch        # rebuild extension and webview on change
npm test             # typecheck, then the engine and git plumbing tests
npm run lint
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

The resolver UI can also be driven without launching an editor:

```sh
npm run build
node dev/shoot.mjs   # runs the real engine + webview in Chromium, asserts
                     # the interactions, and writes screenshots to docs/images
```
