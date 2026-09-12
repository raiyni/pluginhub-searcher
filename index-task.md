# Implement the Pluginhub Search Index (binary format)

## Objective

Implement, in this repository, the build + load + search pipeline for a
pre-computed search index of RuneLite plugin source, per the binary format
specified in `index-format.md`. The search itself must remain fully
client-side (static GitHub Pages, no backend/database); the index is generated
offline (Node/CI) and served as a static file.

Do **not** change `deprecate.js` or `index.html` in this task — those are
integrated in a separate task. Produce the index generator, the browser
reader/validator, the search core, and tests.

## Context and constraints

- The site searches every line of every RuneLite plugin for a literal string
  and reports back the plugin, file, and line number, deep-linking to the
  source on GitHub.
- The index must be self-contained: after generation, the client must not need
  the raw `.json.gz` archives, and must not fetch per-plugin metadata on click.
- No trigrams in this version — the spec's trigram section has been removed.
  Search is a literal (`String.prototype.includes`) scan over the unique-lines
  table.
- No external services. Node is available (v24). Use only Node built-ins
  (`node:fs`, `node:zlib`, `node:buffer`, `node:test`) and browser built-ins
  (`fetch`, `DataView`, `Uint32Array`). No npm dependencies, no bundler.

## Source data

- `json/plugins_0.json` … `json/plugins_12.json` — decompressed archives. Each
  is a JSON array of plugin records:

```json
[{
  "commit": "592bc0eeb3d9b0c19d45ff47884011850511d106",
  "repository": "https://github.com/UserD40/Runelite07Flip.git",
  "internalName": "07flip",
  "files": [
    { "fileName": "O7FlipPlugin.java", "content": "/* ... */\npackage ..." }
  ]
}]
```

- `plugins/plugins_splits.json` — maps each split archive to its plugin commit
  hashes (not needed by the generator if it indexes `json/*.json` directly).
- `plugins/*.json.gz` — the gzipped source archives (not needed by the
  generator; they remain for the legacy path only).

Robustness note: `deprecate.js` historically also accepted a top-level
`content` string (aggregate) and string entries in `files`. Handle both
`fileName` and `filePath`, string files, and a top-level `content` even though
the current `json/` data uses `files: [{fileName, content}]`.

## Output location

The generated binary index is **not** stored in `plugins/` (that directory
holds the raw source archives). It is written to a new, dedicated directory:

- `index/index.pbi` (uncompressed)
- `index/index.pbi.gz` (gzip-compressed)

The reader fetches `index/index.pbi.gz`. The builder creates the `index/`
directory if it does not exist and never writes into `plugins/`.

## Authoritative document

`index-format.md` is the spec. Follow it exactly. Apply these two required
extensions first (edit the spec as you go so it stays the single source of
truth):

1. **Per-plugin repository/commit** — needed for deep links. Add two new
   required string-table sections, each of length `pluginCount`:
   - section id `9`: `pluginRepos` (repository URL string per plugin; empty
     `str` = unknown)
   - section id `10`: `pluginCommits` (commit hash per plugin; empty `str` =
     unknown)
   Update the layout diagram, the required-sections rule, and the validation
   checklist (string-table length must equal `pluginCount`).

2. The `meta` section (`id 8`) must include `datasetVersion` (e.g. the newest
   commit hash across all plugins, or a monotonic build id), `generatedAt`
   (ISO-8601), and `indexFormatVersion` matching the header `version` (`1`).

## Deliverables (new files)

| File | Role |
| --- | --- |
| `build-index.mjs` | Node CLI: read `json/plugins_*.json`, build the index, write `index/index.pbi` and `index/index.pbi.gz`. |
| `index-reader.mjs` | Browser/worker module: `parseIndex(arrayBuffer)` → validated `Index`; `search(index, query, opts)`; occurrence resolution. |
| `tests/index-format.test.mjs` | Node built-in tests for the builder + reader + search round-trip (synthetic data only). |
| `tests/index-format.browser.test.html` | Optional manual browser harness that fetches a small synthetic `.pbi.gz` and exercises `parseIndex` + `search` (no production data). |

## Generator requirements (`build-index.mjs`)

- CLI usage: `node build-index.mjs` (no args). Read `json/` files in numeric
  order (`plugins_0.json` … `plugins_12.json`); deterministically build the
  tables.
- **Line splitting**: split each file `content` on `\n`, preserving a trailing
  `\r` (do not strip it). Lines are 1-based. Empty lines are never stored or
  indexed.
- **Dedup**: build a `Map<string, textId>` for unique non-empty lines. Preserve
  insertion order = first appearance in scan order. All matching lines map to
  the same `textId`.
- **Occurrences**: for every (file, line) that maps to a `textId`, append an
  occurrence. Do not dedupe identical lines within the same file — each
  physical line is a distinct occurrence (this preserves the current tool's
  behavior and line numbers).
- **Tables** (see spec §7):
  - `plugins[]` — internal names, in first-seen order.
  - `filePaths[]` — file path strings; aggregate `content` records get an empty
    string (interpreted as "no path").
  - `filePlugin[]` — plugin id per file.
  - `texts[]`, `textOffsets[]` (`textCount+1`), `occFile[]`, `occLine[]`
    (`occCount` each), with `textOffsets[0]=0`, `textOffsets[textCount]=occCount`,
    monotonic.
  - `pluginRepos[]`, `pluginCommits[]` — per plugin, in the same order as
    `plugins`.
- **Duplicate plugin names** (defensive): if `internalName` repeats across
  parts, the later record replaces the earlier plugin entirely (last-wins),
  mirroring `deprecate.js`; drop the orphaned file/text entries on finalization.
  (Not expected in the real data, where each plugin is in one split, but behave
  deterministically.)
- **Serialization**: write `index/index.pbi` per spec — 48-byte header, 24-byte
  section directory entries, 4-byte alignment for all numeric sections
  (`3,5,6,7`), string tables length-prefixed UTF-8, `totalBytes` = uncompressed
  size, `flags=0`, `reserved=0`. Then gzip to `index/index.pbi.gz` using
  `node:zlib`.
- **Overflow safety**: reject any count that would exceed a `u32`
  (`>= 2^32`) with a clear error rather than wrapping.
- **Meta**: emit `datasetVersion`, `generatedAt` (now, ISO-8601 UTC),
  `indexFormatVersion: 1`.
- **Progress logging**: print plugin/file/unique-line/occurrence counts and
  total wall time to stdout. Keep memory bounded by processing one `json/` file
  at a time and not retaining raw `content` strings after they are split and
  deduped (retaining only the unique `texts` and tables).

## Reader requirements (`index-reader.mjs`)

Export:

```js
export function parseIndex(arrayBuffer)   // throws on any validation failure
export function search(index, query, { activePlugins } = {})  // returns result below
export function occurrencesForText(index, textId)             // [{plugin, file, line}]
```

- **parseIndex**:
  - Detect and handle gzip magic `0x1f 0x8b` (decompress first, e.g.
    `DecompressionStream`).
  - Validate `magic`, `version`, `reserved`, `flags`, `sectionCount`, section
    presence/overlap/alignment, `totalBytes`, and all table constraints exactly
    as `index-format.md` §11 requires. Throw a descriptive `Error` on any
    failure — never return a partial index.
  - Parse string tables into JS strings; expose numeric tables as **zero-copy**
    `Uint32Array` views over the input buffer (do not copy). Return an `index`
    object carrying these views plus counts and the meta.
  - Ignore unknown optional section ids (forward compatibility) unless their
    required bit is set.
- **search** (literal only):
  - Scan `texts[]` for `text.includes(query)`. An empty query matches nothing.
  - For each matching `textId`, expand its occurrence run
    (`textOffsets[i]..textOffsets[i+1]`) to `(plugin, file, line)`.
  - If `activePlugins` (a `Set` of internal names) is provided, filter out
    occurrences whose plugin is not active; still count matches against the full
    index but only return/filter per spec semantics — document the exact
    behavior in a comment.
  - Deduplicate plugins; return
    `{ plugins: [...], rows: [{plugin, file, line, text}], occurrenceCount,
    matchedTextCount }` where `rows` are the occurrence details and `plugin` is
    the internal name.
  - Preserve scan order; no sorting required beyond grouping deterministically.
- **occurrencesForText**: slice the run for `textId` and return
  `[{plugin, file, line}]` resolving `filePlugin`/`filePaths`/`plugins`.

## Search correctness (must match the legacy behavior in spirit)

- Case-sensitive literal matching; regex metacharacters have no special meaning.
- Blank lines excluded (already not in `texts`).
- 1-based line numbers, `\r` retained, exact file path strings, empty path =
  `null`/"no path" when resolving.
- One result per physical source line (duplicates within a file remain distinct
  rows).

## Tests (`tests/index-format.test.mjs`)

Use `node --test`. Generate small **synthetic** plugin arrays (never read real
plugin content) covering:

- Round-trip: build → serialize → gzip → parse → search, asserting byte-level
  structure (magic, version, section directory offsets/alignment, `totalBytes`).
- Dedup: identical lines across files/plugins collapse to one `textId` but yield
  multiple occurrences with correct per-file line numbers.
- CRLF retention, trailing newline line numbering, empty lines skipped, Unicode
  (including a multi-byte line) round-trip through UTF-8.
- `filePath` vs `fileName` vs string-file vs aggregate `content` normalization.
- Duplicate `internalName` last-wins.
- Validation: corrupted magic, wrong `version`, misaligned numeric section,
  `textOffsets` non-monotonic, `occFile`/`filePlugin` out-of-range, wrong
  `totalBytes`, truncated buffer — each must throw.
- Search: empty query → no matches; metacharacters literal; `activePlugins`
  filtering; occurrence counts.
- A **performance smoke test** using an in-memory synthetic corpus (e.g. ~100k
  generated lines): record build ms and search ms, assert search completes (no
  wall-clock guarantee, just a correctness + no-pathological-hang assertion).

## Definition of done

- `node --test tests/index-format.test.mjs` passes.
- `node build-index.mjs` runs against the real `json/` files and writes
  `index/index.pbi` + `index/index.pbi.gz`, printing counts.
- A small script can parse `index/index.pbi.gz` and run a known query (e.g. a
  distinctive literal) against a known plugin without error.
- `index-format.md` is updated to reflect the two required extensions
  (§ repository/commit sections, meta keys) and remains consistent with the
  code.
- The binary index is written only to `index/`, never to `plugins/`.
- No npm dependencies, no changes to `deprecate.js`/`index.html`, no production
  data in tests.

## Out of scope

Web Worker plumbing, Vue UI integration, IndexedDB caching, trigrams, regex
search, and deployment workflows. Those are separate follow-up tasks.
