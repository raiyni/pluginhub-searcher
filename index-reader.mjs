// index-reader.mjs
//
// Browser/worker reader + search core for the pre-computed Pluginhub search
// index (see index-format.md). Uses only browser built-ins (DataView,
// Uint32Array, TextDecoder, fetch/Response/DecompressionStream) so it can be
// imported from a Worker or a module script without a bundler. It also runs
// under Node (v18+) because the same web platform globals are present.

export const MAGIC = "PLHINDEX";
export const FORMAT_VERSION = 1;

const HEADER_SIZE = 48;
const DIR_ENTRY_SIZE = 24;
const MAX_U32 = 0x100000000; // 2^32 (exclusive)

// Section ids defined by the spec. Ids 1-7, 9 and 10 are always required;
// id 8 (meta) is optional.
const REQUIRED_SECTION_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10]);
const KNOWN_SECTION_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const NUMERIC_SECTION_IDS = new Set([3, 5, 6, 7]);

// Parse a (possibly gzip-compressed) index file into a validated Index.
//
// Accepts an ArrayBuffer. If the buffer begins with the gzip magic bytes
// (0x1f 0x8b) it is decompressed first via DecompressionStream; otherwise it
// is parsed directly. Throws a descriptive Error on any validation failure and
// never returns a partial index.
export async function parseIndex(arrayBuffer) {
    let buf = toArrayBuffer(arrayBuffer);

    const probe = new Uint8Array(buf);
    if (probe.length >= 2 && probe[0] === 0x1f && probe[1] === 0x8b) {
        buf = await decompressGzip(buf);
    }

    return parseIndexUncompressed(buf);
}

// Synchronous core: parse an already-decompressed ArrayBuffer. Exposed so
// tests (and callers that manage decompression themselves) can validate byte
// layout directly.
export function parseIndexUncompressed(arrayBuffer) {
    const buf = toArrayBuffer(arrayBuffer);
    const view = new DataView(buf);
    const byteLength = buf.byteLength;

    if (byteLength < HEADER_SIZE) {
        throw new Error(`index too small: ${byteLength} bytes (need >= ${HEADER_SIZE})`);
    }

    // 8-byte ASCII magic "PLHINDEX".
    const magicBytes = new Uint8Array(buf, 0, 8);
    if (new TextDecoder("ascii").decode(magicBytes) !== MAGIC) {
        throw new Error(`bad magic: expected ${MAGIC}`);
    }

    const version = view.getUint32(8, true);
    const flags = view.getUint32(12, true);
    const sectionCount = view.getUint32(16, true);
    const pluginCount = view.getUint32(20, true);
    const fileCount = view.getUint32(24, true);
    const textCount = view.getUint32(28, true);
    const occCount = view.getUint32(32, true);
    const totalBytes = view.getBigUint64(36, true);
    const reserved = view.getUint32(44, true);

    if (version !== FORMAT_VERSION) {
        throw new Error(`unsupported version ${version} (expected ${FORMAT_VERSION})`);
    }
    if (flags !== 0) {
        throw new Error(`reserved flag bits set: ${flags}`);
    }
    if (reserved !== 0) {
        throw new Error(`reserved field nonzero: ${reserved}`);
    }
    if (sectionCount === 0) {
        throw new Error("sectionCount is zero");
    }
    if (totalBytes !== BigInt(byteLength)) {
        throw new Error(`totalBytes ${totalBytes} != actual size ${byteLength}`);
    }

    // The directory must fit entirely inside the file.
    const directoryEnd = HEADER_SIZE + sectionCount * DIR_ENTRY_SIZE;
    if (directoryEnd > byteLength) {
        throw new Error("section directory overruns file");
    }

    // Read section directory entries.
    const entries = [];
    let dir = HEADER_SIZE;
    for (let i = 0; i < sectionCount; i++, dir += DIR_ENTRY_SIZE) {
        const id = view.getUint32(dir, true);
        const sflags = view.getUint32(dir + 4, true);
        const offset = Number(view.getBigUint64(dir + 8, true));
        const length = Number(view.getBigUint64(dir + 16, true));

        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
            throw new Error(`section ${id}: offset/length not representable`);
        }
        if (offset < directoryEnd || offset + length > byteLength) {
            throw new Error(`section ${id}: out of bounds`);
        }
        if (KNOWN_SECTION_IDS.has(id)) {
            if (NUMERIC_SECTION_IDS.has(id) && (offset % 4 !== 0)) {
                throw new Error(`section ${id}: numeric section not 4-byte aligned`);
            }
        } else if (sflags & 1) {
            // Unknown section with the required bit set: reject (forward compat).
            throw new Error(`unknown required section ${id}`);
        }

        entries.push({ id, flags: sflags, offset, length });
    }

    // No two sections may overlap.
    const sorted = entries.slice().sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].length) {
            throw new Error(`sections ${sorted[i - 1].id} and ${sorted[i].id} overlap`);
        }
    }

    const byId = new Map(entries.map((e) => [e.id, e]));

    for (const id of REQUIRED_SECTION_IDS) {
        if (!byId.has(id)) {
            throw new Error(`missing required section ${id}`);
        }
    }

    const req = (id) => byId.get(id);

    const plugins = decodeStringTable(buf, req(1).offset, req(1).length, pluginCount);
    const filePaths = decodeStringTable(buf, req(2).offset, req(2).length, fileCount);
    const texts = decodeStringTable(buf, req(4).offset, req(4).length, textCount);
    const pluginRepos = decodeStringTable(buf, req(9).offset, req(9).length, pluginCount);
    const pluginCommits = decodeStringTable(buf, req(10).offset, req(10).length, pluginCount);

    const filePlugin = decodeU32Array(buf, req(3), fileCount, "filePlugin");
    const textOffsets = decodeU32Array(buf, req(5), textCount + 1, "textOffsets");
    const occFile = decodeU32Array(buf, req(6), occCount, "occFile");
    const occLine = decodeU32Array(buf, req(7), occCount, "occLine");

    // textOffsets invariants (§7.2 / §11 item 5).
    if (textOffsets[0] !== 0) {
        throw new Error("textOffsets[0] != 0");
    }
    if (textOffsets[textCount] !== occCount) {
        throw new Error("textOffsets[textCount] != occCount");
    }
    for (let i = 1; i <= textCount; i++) {
        if (textOffsets[i] < textOffsets[i - 1]) {
            throw new Error(`textOffsets not monotonic at ${i}`);
        }
    }

    // filePlugin[i] < pluginCount (§7.1 / §11 item 6).
    for (let i = 0; i < fileCount; i++) {
        if (filePlugin[i] >= pluginCount) {
            throw new Error(`filePlugin[${i}] = ${filePlugin[i]} >= pluginCount ${pluginCount}`);
        }
    }

    // occFile[i] < fileCount and occLine[i] >= 1 (§7.3/7.4 / §11 item 7).
    for (let i = 0; i < occCount; i++) {
        if (occFile[i] >= fileCount) {
            throw new Error(`occFile[${i}] = ${occFile[i]} >= fileCount ${fileCount}`);
        }
        if (occLine[i] < 1) {
            throw new Error(`occLine[${i}] = ${occLine[i]} < 1`);
        }
    }

    // Optional meta section (id 8): a single length-prefixed UTF-8 JSON string.
    let meta = null;
    if (byId.has(8)) {
        const m = req(8);
        const [json] = decodeStringTable(buf, m.offset, m.length, 1);
        meta = JSON.parse(json);
        if (meta && typeof meta === "object" &&
            typeof meta.indexFormatVersion === "number" &&
            meta.indexFormatVersion !== version) {
            throw new Error(`meta.indexFormatVersion ${meta.indexFormatVersion} != header version ${version}`);
        }
    }

    return {
        magic: MAGIC,
        version,
        flags,
        sectionCount,
        pluginCount,
        fileCount,
        textCount,
        occCount,
        totalBytes: Number(totalBytes),
        plugins,
        filePaths,
        texts,
        pluginRepos,
        pluginCommits,
        meta,
        // Zero-copy numeric views over the input buffer.
        filePlugin,
        textOffsets,
        occFile,
        occLine,
    };
}

// Literal (String.prototype.includes) search over the unique-lines table.
//
// Semantics:
//   - Case-sensitive; regex metacharacters have no special meaning.
//   - An empty (or non-string) query matches nothing.
//   - matchedTextCount is the number of unique lines containing the query.
//   - occurrenceCount is the total number of (file, line) occurrences across
//     all matched lines, counted against the FULL index.
//   - activePlugins, when provided (a Set of internal names), only filters
//     which occurrences are returned in `rows` (and hence which plugins appear
//     in `plugins`). matchedTextCount and occurrenceCount are NOT filtered, so
//     a caller can still see the full-match totals while showing only active
//     plugins. rows are returned grouped by text in first-appearance order,
//     preserving occurrence scan order within each text.
export function search(index, query, { activePlugins } = {}) {
    if (typeof query !== "string" || query === "") {
        return { plugins: [], rows: [], occurrenceCount: 0, matchedTextCount: 0 };
    }

    const texts = index.texts;
    const matchedTextIds = [];
    for (let i = 0; i < texts.length; i++) {
        if (texts[i].includes(query)) {
            matchedTextIds.push(i);
        }
    }
    if (matchedTextIds.length === 0) {
        return { plugins: [], rows: [], occurrenceCount: 0, matchedTextCount: 0 };
    }

    return expandMatches(index, matchedTextIds, activePlugins, (i) => texts[i], Infinity);
}

// Regex search over the unique-lines table. Matches legacy semantics
// (case-sensitive, per-line `^`/`$` anchors) but scans a single concatenated
// haystack with one compiled `RegExp` instead of N per-line `.test()` calls.
//
//   - `pattern` is a RegExp source string; an invalid pattern throws SyntaxError
//     (callers surface it as an error). `""` and `"^"` match nothing.
//   - Uses the `g` + `m` flags: `g` for iteration, `m` so `^`/`$` anchor per
//     line. `m` is a semantic match for the per-line behavior of the legacy
//     tool (lines are separated by exactly one `\n`).
//   - `limit` caps the number of returned rows (a broad query can expand to
//     millions); when hit, `truncated` is `true` in the result. Counts are
//     still full-index counts.
//   - Documented caveat: a pattern containing a literal `\n` (or a construct
//     such as `[\s\S]`) can match across the `\n` separator, which per-line
//     testing would not. Per-line exact parity remains available via `search`
//     (literal) or by iterating `texts` directly.
export function searchRegex(index, pattern, { activePlugins, limit } = {}) {
    if (typeof pattern !== "string" || pattern === "" || pattern === "^") {
        return { plugins: [], rows: [], occurrenceCount: 0, matchedTextCount: 0 };
    }

    const re = new RegExp(pattern, "gm"); // throws SyntaxError on invalid pattern
    const s = index._search || buildHaystack(index.texts);
    const textCount = index.textCount;
    const matched = new Uint8Array(textCount);
    const matchedTextIds = [];
    const { haystack, lineStart } = s;

    re.lastIndex = 0;
    let m;
    while ((m = re.exec(haystack)) !== null) {
        const lineIdx = lineAt(lineStart, m.index, textCount);
        if (lineIdx >= 0 && lineIdx < textCount && matched[lineIdx] === 0) {
            matched[lineIdx] = 1;
            matchedTextIds.push(lineIdx);
        }
        if (re.lastIndex === m.index) {
            re.lastIndex = m.index + 1; // avoid infinite loop on zero-length matches
        }
    }

    if (matchedTextIds.length === 0) {
        return { plugins: [], rows: [], occurrenceCount: 0, matchedTextCount: 0 };
    }

    const textAt = (i) => haystack.slice(lineStart[i], lineStart[i + 1] - 1);
    return expandMatches(index, matchedTextIds, activePlugins, textAt, limit);
}

// Build the concatenated haystack + per-line char-offset table used by
// `searchRegex`. Every line is followed by exactly one `\n`, so
// `lineStart[i]..lineStart[i+1]` spans line `i` plus its trailing `\n` (the
// line's own text is `haystack.slice(lineStart[i], lineStart[i+1] - 1)`).
// The result is cached on `index._search`; callers may then drop `index.texts`
// to free the per-line string array (as the worker does).
export function buildSearchIndex(index) {
    const s = buildHaystack(index.texts);
    index._search = s;
    return s;
}

function buildHaystack(texts) {
    const n = texts.length;
    const lineStart = new Uint32Array(n + 1);
    let pos = 0;
    for (let i = 0; i < n; i++) {
        lineStart[i] = pos;
        pos += texts[i].length + 1;
    }
    lineStart[n] = pos;
    const haystack = n === 0 ? "" : texts.join("\n") + "\n";
    return { haystack, lineStart };
}

// Largest i in [0, textCount) with lineStart[i] <= pos (or -1 if none).
function lineAt(lineStart, pos, textCount) {
    let lo = 0;
    let hi = textCount;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lineStart[mid] <= pos) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo - 1;
}

// Expand a list of matched text ids into occurrences, resolving plugin/file/line.
// `textAt(i)` returns the display text for a matched line (or undefined).
// `limit` caps the returned rows (set `truncated` when hit); counts are always
// full-index counts.
function expandMatches(index, matchedTextIds, activePlugins, textAt, limit) {
    const filter = activePlugins ? new Set(activePlugins) : null;

    let occurrenceCount = 0;
    for (const tid of matchedTextIds) {
        occurrenceCount += index.textOffsets[tid + 1] - index.textOffsets[tid];
    }

    const rows = [];
    const pluginSet = new Set();
    let truncated = false;

    outer: for (const tid of matchedTextIds) {
        const start = index.textOffsets[tid];
        const end = index.textOffsets[tid + 1];
        const text = textAt ? textAt(tid) : undefined;
        for (let o = start; o < end; o++) {
            const fileId = index.occFile[o];
            const pluginId = index.filePlugin[fileId];
            const plugin = index.plugins[pluginId];
            if (filter && !filter.has(plugin)) {
                continue;
            }
            if (rows.length >= limit) {
                truncated = true;
                break outer;
            }
            rows.push({
                plugin,
                file: resolvePath(index, fileId),
                line: index.occLine[o],
                text,
            });
            pluginSet.add(plugin);
        }
    }

    const result = {
        plugins: [...pluginSet],
        rows,
        occurrenceCount,
        matchedTextCount: matchedTextIds.length,
    };
    if (truncated) {
        result.truncated = true;
    }
    return result;
}

// Expand the occurrence run for a single textId into resolved records.
// Returns [{plugin, file, line}]. file is null when the file path is the
// empty string (aggregate "no path" records).
export function occurrencesForText(index, textId) {
    if (!Number.isInteger(textId) || textId < 0 || textId >= index.textCount) {
        throw new Error(`textId ${textId} out of range [0, ${index.textCount})`);
    }
    const start = index.textOffsets[textId];
    const end = index.textOffsets[textId + 1];
    const out = [];
    for (let o = start; o < end; o++) {
        const fileId = index.occFile[o];
        const pluginId = index.filePlugin[fileId];
        out.push({
            plugin: index.plugins[pluginId],
            file: resolvePath(index, fileId),
            line: index.occLine[o],
        });
    }
    return out;
}

// An empty file-path string encodes "no path" (aggregate content records).
function resolvePath(index, fileId) {
    const p = index.filePaths[fileId];
    return p === "" ? null : p;
}

function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
        return input;
    }
    if (ArrayBuffer.isView(input)) {
        // Normalize TypedArray/DataView/Buffer to a byteOffset-0 ArrayBuffer so
        // zero-copy Uint32Array views below are always well-aligned.
        return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    throw new Error("parseIndex expects an ArrayBuffer or TypedArray");
}

async function decompressGzip(buf) {
    const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
}

function decodeStringTable(buf, offset, length, count) {
    const view = new DataView(buf);
    const end = offset + length;
    let pos = offset;
    const out = new Array(count);
    const decoder = new TextDecoder("utf-8");
    for (let i = 0; i < count; i++) {
        if (pos + 4 > end) {
            throw new Error("string table truncated");
        }
        const len = view.getUint32(pos, true);
        pos += 4;
        if (pos + len > end) {
            throw new Error("string table truncated");
        }
        out[i] = decoder.decode(new Uint8Array(buf, pos, len));
        pos += len;
    }
    if (pos !== end) {
        throw new Error(`string table length mismatch (consumed ${pos - offset}, length ${length})`);
    }
    return out;
}

function decodeU32Array(buf, section, count, name) {
    const { offset, length } = section;
    if (length !== count * 4) {
        throw new Error(`${name}: length ${length} != ${count} * 4`);
    }
    if (offset % 4 !== 0) {
        throw new Error(`${name}: not 4-byte aligned`);
    }
    return new Uint32Array(buf, offset, count);
}
