# Changelog

## 0.2.0

**Arrays merge properly.** Arrays of scalars (`tsconfig.include`,
`package.json.files`, `eslint.extends`) merge as a set, so both branches
appending an entry is no longer a conflict. Arrays of records are matched by an
identifying field — `id`, `name`, `key`, `uses`, `path`, `files`, `url` — and
merged field by field, so a workflow where each branch adds a step and one edits
an existing one leaves only the genuinely contested field to decide. Arrays
whose shape makes that unsafe (repeated entries, mixed kinds, no identifying
field) stay whole, with the reason shown.

**Recommendations on version conflicts.** When both branches bump the same
dependency, the newer version is marked Recommended, saying whether it is a
major bump, with an accept-all action. A recommendation never applies itself.

**A warning before overwriting hand edits.** If the file was edited since the
merge stopped, both a banner and a confirmation appear before Apply replaces it.

**New formats:** `.env`, TOML (`pyproject.toml`, `Cargo.toml`) and XML
(`pom.xml`, `.csproj`, `.props`). All three edit only the values that changed,
so comments, indentation and layout survive.

**A deeper resolver.** Filter the tree by key or value; resolve just the
conflicts under one subtree; and see a real side-by-side diff for a conflict
whose value is an object or array, rather than a `{3 items}` summary.

**Integration tests** now cover activation, the sidebar, the custom editor and
the apply-and-stage round trip inside a real VS Code.

## 0.1.0

First release.

- Structural resolver for conflicted files: a tree of decisions with per-key
  Ours / Theirs / Base choices, an inline editor for a value neither branch has,
  a conflicts-only filter, keyboard navigation and a live preview.
- Conflicted-files sidebar grouped by repository, with structural conflict
  counts and a bulk action for files that merge with no decisions.
- Formats: JSON/JSONC, YAML, line sets (`.gitignore`, `CODEOWNERS`) and
  lockfiles, which are offered as a whole-file choice plus regeneration rather
  than merged entry by entry.
- Applying writes through the editor's own edit system, so undo works, then
  stages the file to mark the conflict resolved.
