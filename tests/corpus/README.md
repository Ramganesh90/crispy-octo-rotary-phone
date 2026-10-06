# Shared merge corpus

Fixtures consumed by **both** engines:

- the Python CLI, via `tests/test_corpus.py`
- the TypeScript extension engine, via `extension/src/test/suite/corpus.unit.test.ts`

Each case gives `base` (null means no common ancestor), `ours` and `theirs` as
file text, and asserts:

- `expectedConflicts` — conflict paths, compared exactly and in order
- `expectedValue` — the merged document's *value* once parsed

Comparing parsed values rather than text is deliberate: the two engines
serialize differently on purpose. Python reprints the document, while the
extension applies edits to the current branch's text so that comments and
formatting survive. Text-level formatting guarantees are asserted separately,
in each engine's own tests.

Adding a case here automatically covers both engines, which is what keeps them
from drifting apart.
