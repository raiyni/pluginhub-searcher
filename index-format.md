# Pluginhub Search Index — Binary Format Specification

Version 1 (format version `1`)

This document specifies the binary encoding of the pre-computed search index
(the derived, deduplicated source-line index) described in the performance
plan. It is independent of the upstream archive format (`plugins_0.json.gz`,
`plugins.json`, `plugins_splits.json`); those are the *inputs* used to build
this index, and this format is the *output* that the client loads.

The format is designed so that the large numeric tables are consumed with
zero-copy `Uint32Array` views over the fetched buffer, avoiding `JSON.parse`,
base64, and per-element object allocation.

---

## 1. Scope

This format encodes:

- the plugin table (internal names),
- the per-plugin repository URL and commit hash (for deep links),
- the file table (source paths, grouped per plugin),
- the unique source-line table (deduplicated text),
- the occurrence tables (`textOffsets`, `occFile`, `occLine`),
- optional dataset metadata.

It does **not** encode live RuneLite manifest membership or install counts;
those remain runtime-fetched and applied at query time (see the plan).

---

## 2. Conventions

### 2.1 Endianness

All multi-byte integers are **little-endian**. This matches the native byte
order of all supported browser/worker platforms, so `Uint32Array` views are
interchangeable with `DataView.getUint32(..., true)`.

### 2.2 Primitive types

| Name | Size | Encoding |
|------|------|----------|
| `u8`  | 1 byte | unsigned integer |
| `u16` | 2 bytes | unsigned integer, little-endian |
| `u32` | 4 bytes | unsigned integer, little-endian |
| `u64` | 8 bytes | unsigned integer, little-endian |
| `str` | variable | `u32` byte length `N` followed by `N` UTF-8 bytes, no null terminator |

- A **string table** is a sequence of `str` values, back to back, with no
  separators; the count is given by the parent section.
- A **numeric array** is a sequence of `u32` values with no padding; the count
  is given by the parent section. Numeric sections are 4-byte aligned (see 4).

### 2.3 Alignment

Every **numeric array** section (ids `3`, `5`, `6`, `7`) starts at a byte
offset that is a multiple of 4. This is required
for `new Uint32Array(buffer, byteOffset, length)`, which mandates
`byteOffset % elementSize === 0`. String-table sections (`1`, `2`, `4`) do not
require alignment but SHOULD be padded to 4-byte boundaries when it costs
nothing.

---

## 3. File layout

```
┌──────────────────────────────────────────────────────────────┐
│ Header                          (48 bytes)                   │
├──────────────────────────────────────────────────────────────┤
│ Section directory               (sectionCount × 24 bytes)    │
├──────────────────────────────────────────────────────────────┤
│ Sections, in any order                                      │
│   id 1: plugins     (string table, pluginCount entries)      │
│   id 2: filePaths   (string table, fileCount entries)        │
│   id 3: filePlugin  (u32 array,  fileCount entries)          │
│   id 4: texts       (string table, textCount entries)        │
│   id 5: textOffsets (u32 array,  textCount + 1 entries)      │
│   id 6: occFile     (u32 array,  occCount entries)           │
│   id 7: occLine     (u32 array,  occCount entries)           │
│   id 8: meta        (optional; a single `str` UTF-8 JSON)    │
│   id 9: pluginRepos   (string table, pluginCount entries)    │
│   id 10: pluginCommits (string table, pluginCount entries)   │
└──────────────────────────────────────────────────────────────┘
```

Readers MUST locate every section through the directory, never by assuming a
fixed byte offset after the header.

---

## 4. Header (48 bytes)

| Offset | Type | Field | Meaning |
|-------:|------|-------|---------|
| 0 | 8 bytes | `magic` | ASCII bytes `PLHINDEX` (`50 4C 48 49 4E 44 45 58`) |
| 8 | `u32` | `version` | format version; this document is `1` |
| 12 | `u32` | `flags` | bit flags (see below) |
| 16 | `u32` | `sectionCount` | number of entries in the section directory |
| 20 | `u32` | `pluginCount` | length of the `plugins` table |
| 24 | `u32` | `fileCount` | length of the `filePaths` table |
| 28 | `u32` | `textCount` | length of the `texts` table |
| 32 | `u32` | `occCount` | total number of occurrences |
| 36 | `u64` | `totalBytes` | total file size in bytes (uncompressed), for sanity checking |
| 44 | `u32` | `reserved` | MUST be `0` |

### `flags`

| Bit | Name | Meaning |
|----:|------|---------|
| 0–31 | — | reserved, MUST be `0` |

Readers MUST reject a file with a nonzero reserved flag bit, a nonzero
`reserved` field, an unexpected `magic`, or an unsupported `version`.

---

## 5. Section directory

`sectionCount` entries, each 24 bytes, immediately following the header.

| Offset | Type | Field | Meaning |
|-------:|------|-------|---------|
| 0 | `u32` | `id` | section id (see 3) |
| 4 | `u32` | `flags` | bit 0 = required; bits 1–31 reserved (0) |
| 8 | `u64` | `offset` | byte offset of section start, from file start |
| 16 | `u64` | `length` | section length in bytes |

Validation requirements:

- `offset` and `offset + length` MUST fall within `[0, totalBytes]`.
- Sections MUST NOT overlap one another or the header/directory.
- Required sections (`flags` bit 0 set) MUST be present: ids `1`–`7`, `9`, and
  `10` are always required. Section `8` is optional.
- Numeric sections (`3`, `5`, `6`, `7`) MUST have 4-byte-aligned `offset`.
- Unknown section ids MUST be ignored (forward compatibility), unless their
  required bit is set, in which case the file MUST be rejected.

---

## 6. String-table sections

Ids `1` (`plugins`), `2` (`filePaths`), `4` (`texts`), `9` (`pluginRepos`),
`10` (`pluginCommits`).

Each is `count` consecutive `str` values, where `count` is `pluginCount`,
`fileCount`, or `textCount` respectively (sections `1`, `9`, and `10` each have
length `pluginCount`; section `2` has length `fileCount`; section `4` has
length `textCount`).

- `plugins[i]` is the plugin internal name (as used by `manifest.jars` and the
  plugin-hub repository).
- `filePaths[i]` is the source file path. A `null` path (aggregate `content`
  record) is encoded as an empty `str` (length 0). An empty string therefore
  MUST be interpreted as "no path", never as a real empty filename.
- `texts[i]` is one unique source line, byte-for-byte as produced by the
  source split on `\n` (a trailing `\r` is retained). Empty lines are never
  stored.
- `pluginRepos[i]` is the repository URL for `plugins[i]`, used for deep links.
  An empty `str` means unknown.
- `pluginCommits[i]` is the commit hash for `plugins[i]`, used for deep links.
  An empty `str` means unknown.

Strings are UTF-8 and MUST be valid UTF-8; the reader converts them to
JavaScript strings. This is the one part of the file that cannot be zero-copy
viewed (JS strings are UTF-16), which is acceptable because `texts` is small
relative to the occurrence tables.

---

## 7. Numeric-array sections

Ids `3`, `5`, `6`, `7`. Each is a flat sequence of little-endian `u32` values,
4-byte aligned, with the element count implied by the header.

### 7.1 `filePlugin` (id 3) — length `fileCount`

`filePlugin[i]` is the plugin id of `filePaths[i]`. Every value MUST be
`< pluginCount`. A plugin id is an index into `plugins`.

### 7.2 `textOffsets` (id 5) — length `textCount + 1`

Occurrence-run boundaries, as defined in the plan:

- `textOffsets[0]` MUST equal `0`.
- `textOffsets` MUST be monotonically non-decreasing.
- `textOffsets[textCount]` MUST equal `occCount`.

The occurrences belonging to `texts[i]` are
`occFile[textOffsets[i] .. textOffsets[i+1])` and the parallel
`occLine[textOffsets[i] .. textOffsets[i+1])`. An empty run is allowed.

### 7.3 `occFile` (id 6) — length `occCount`

For each occurrence, the file id. Every value MUST be `< fileCount`.

### 7.4 `occLine` (id 7) — length `occCount`

For each occurrence, the **1-based** line number within `filePaths[occFile[i]]`.
Every value MUST be `>= 1`.

> Future: `occLine` may be widened/narrowed (e.g. `u16`) via a flags bit or a
> new section id; version 1 always uses `u32`.

---

## 8. Metadata section (id 8) — optional

A single `str` whose bytes are UTF-8 JSON. Reserved keys:

| Key | Type | Meaning |
|-----|------|---------|
| `datasetVersion` | string | dataset generation identifier/timestamp |
| `generatedAt` | string | ISO-8601 build timestamp |
| `indexFormatVersion` | number | MUST equal the header `version` |

When present, `datasetVersion`, `generatedAt`, and `indexFormatVersion` MUST
all be present (the writer always emits them). Additional keys are allowed and
ignored. This section is informational only; correctness MUST NOT depend on
it.

---

## 10. Transport: gzip

The file MAY be stored and served gzip-compressed (recommended extension
`.pbi.gz`; uncompressed `.pbi`). Compression is a transport concern, not part
of this format: the reader MUST detect the gzip magic (`0x1f 0x8b`) and
decompress before parsing, exactly as `decodeJson` does for the source
archives. `totalBytes` refers to the **uncompressed** file size.

Serving the file with HTTP `Content-Encoding: gzip` and a correct `ETag` is
preferred so the browser decompresses transparently and the cache validator
works without a separate `HEAD` request.

The index is served from a dedicated directory (e.g. `index/`), separate from
`plugins/`, which holds the raw source archives. The two are never mixed: a
reader loads the index from `index/index.pbi.gz` and must not read `plugins/`.

---

## 11. Full validation checklist

A reader MUST reject the file (treat as corrupt) if any of the following hold:

1. `magic` != `PLHINDEX`, or `version` unsupported.
2. `reserved` != 0, or a reserved `flags` bit set.
3. `sectionCount` == 0, or required sections (`1`–`7`, `9`, `10`) missing or
   overlapping.
4. A numeric section (`3`,`5`,`6`,`7`) not 4-byte aligned.
5. `textOffsets[0] != 0`, `textOffsets[textCount] != occCount`, or
   `textOffsets` not monotonic.
6. Any `filePlugin[i] >= pluginCount`.
7. Any `occFile[i] >= fileCount`, or any `occLine[i] < 1`.
8. `totalBytes` != actual byte length (uncompressed).
9. `meta.indexFormatVersion` present but != header `version`.
10. A string table decoding to the wrong number of entries: sections `1`, `9`,
    and `10` must each decode to exactly `pluginCount` strings; section `2` to
    `fileCount`; section `4` to `textCount`.

On rejection, the runtime MUST NOT serve stale/partial search results and MUST
surface an initialization error (see the plan's cache-validation section).

---

## 12. Sizing limits

Version 1 imposes these hard limits, derived from the `u32` widths:

- `pluginCount`, `fileCount`, `textCount`, `occCount` each `< 2^32`.
- A single `str` length `< 2^32` bytes.

---

## 13. Example decode (JavaScript)

```js
const buf = await (await fetch("index/index.pbi.gz")).arrayBuffer();
const view = new DataView(buf);

if (view.getUint32(0, true) !== 0x58444849 /* "PLHINDEX" little-endian chunk */) {
    // caller must first check the full 8-byte magic; shown abbreviated
}

const version       = view.getUint32(8, true);
const sectionCount  = view.getUint32(16, true);
const pluginCount   = view.getUint32(20, true);
const fileCount     = view.getUint32(24, true);
const textCount     = view.getUint32(28, true);
const occCount      = view.getUint32(32, true);

const sections = new Map();
let dir = 48;
for (let i = 0; i < sectionCount; i++, dir += 24) {
    sections.set(view.getUint32(dir, true), {
        flags: view.getUint32(dir + 4, true),
        offset: Number(view.getBigUint64(dir + 8, true)),
        length: Number(view.getBigUint64(dir + 16, true)),
    });
}

// Zero-copy views into the fetched buffer:
const { offset: o5 } = sections.get(5);
const { offset: o6 } = sections.get(6);
const { offset: o7 } = sections.get(7);

const textOffsets = new Uint32Array(buf, o5, textCount + 1);
const occFile     = new Uint32Array(buf, o6, occCount);
const occLine     = new Uint32Array(buf, o7, occCount);
```

---

## 14. Versioning

- Bump `version` whenever stored semantics or layout change incompatibly.
- Additive changes (new optional sections) do not require a version bump as
  long as unknown-section rules (5) are honored.
- The runtime cache key MUST include `version` (the plan already includes
  `FORMAT_VERSION`) so an older cached index is never mistaken for a newer
  format.
