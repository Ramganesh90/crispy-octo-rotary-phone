# Structural Merge Resolver

Resolve merge conflicts in JSON, YAML, TOML, XML, JavaScript and list files
**structurally** instead of line by line.

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
- **Recommendations where they are knowable.** When both branches bump the same
  dependency, the newer version is marked *Recommended* (and says when it is a
  major bump). It never applies itself — Apply stays blocked until you choose.
- **A filter, subtree actions and real diffs.** Narrow the tree by key, resolve
  just the conflicts under one subtree, and see both sides side by side when a
  conflicting value is an object or array.
- **A warning before overwriting hand edits.** If you already started fixing the
  conflict markers yourself, it says so before Apply replaces the file.

## Supported files

| Format | Files | Behavior |
|---|---|---|
| JSON / JSONC | `*.json`, `*.jsonc`, `.babelrc`, `.eslintrc`, … | Recursive key-by-key merge. Comments, indentation and key order preserved. |
| YAML | `*.yml`, `*.yaml` | Same semantics, with comments preserved. Multi-document streams and files using anchors/aliases are left to the text merge on purpose — editing them key by key can change what they mean. |
| TOML | `pyproject.toml`, `Cargo.toml` | Key-by-key, editing only the lines whose value changed. Arrays of tables and multi-line values fall back to a text merge rather than risk rewriting them wrongly. |
| XML | `pom.xml`, `*.csproj`, `*.props` | Replaces only the character spans that changed, so comments, the declaration, indentation and attribute order survive. Repeated siblings are matched by `artifactId`/`id`/`name`, so a dependency list merges by name rather than position. Mixed content falls back. |
| `.env` | `.env`, `.env.*` | Merged as `KEY=value` pairs rather than lines. |
| JavaScript / TypeScript | `*.js`, `*.jsx`, `*.mjs`, `*.cjs`, `*.ts`, `*.tsx` | Two levels — see below. |
| Line sets | `.gitignore`, `CODEOWNERS`, `.dockerignore`, … | Additions from both sides kept, removals from either side applied. Never conflicts. |
| Lockfiles | `package-lock.json`, `npm-shrinkwrap.json` | Not merged entry by entry: independently merged entries can describe a tree that will not install. Keep one side, then regenerate. |

### JavaScript, JSX and TypeScript

Source code does not decompose into named values, so this works at two levels:

1. **Top-level declarations** — imports, functions, classes, constants, exports
   and types — are matched **by name**. Each branch adding a function, or
   editing a different one, merges with nothing to decide. Imports from both
   branches end up together.
2. **Inside a declaration both branches touched**, a line-level three-way merge
   runs over just that declaration, so two people editing different parts of the
   same function still merge cleanly.

The second level is the point. Without it, declaration-level matching would
report a conflict for every shared function — making this *worse* than git for
the most common case in real code. Only when the lines genuinely overlap does a
decision reach you, and then the unit is one whole declaration shown as code,
side by side, rather than a wall of markers.

Edits on **adjacent lines** conflict, exactly as `git merge-file` conflicts on
them: with no unchanged line between two changes, they cannot be told apart.
Matching git is deliberate — this should never be worse than the merge you would
otherwise have got.

Nothing is reprinted: the output is your branch's text with individual
declaration spans spliced, so formatting elsewhere is untouched. A file that
does not parse falls back to a text merge.

### Arrays

Arrays of scalars (`tsconfig.include`, `package.json.files`) merge as a **set**,
so both branches appending an entry is not a conflict. Arrays of records merge
by an **identifying field** (`id`, `name`, `key`, `uses`, `path`, `files`,
`url`), so a workflow where each branch adds a step and one edits an existing
one leaves only the contested field to decide.

An array stays whole when merging its entries would be a guess — repeated
entries, mixed kinds, or no identifying field — and the UI says which it chose.
Any container can be overridden wholesale if the entry-by-entry result is not
what you wanted.

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
