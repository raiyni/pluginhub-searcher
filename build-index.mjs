// build-index.mjs
//
// Node CLI + library that builds the pre-computed Pluginhub search index
// (see index-format.md) from the decompressed `json/plugins_*.json` archives
// and writes `index/index.pbi` (uncompressed) and `index/index.pbi.gz`.
//
// Only Node built-ins are used (node:fs, node:zlib, node:path, node:url).
//
// Usage:
//   node build-index.mjs
//
// The build pipeline is also exported so tests can build + serialize synthetic
// data in memory without touching the real archives.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const MAGIC = "PLHINDEX";
export const FORMAT_VERSION = 1;

const HEADER_SIZE = 48;
const DIR_ENTRY_SIZE = 24;
const MAX_U32 = 0x100000000; // 2^32 (exclusive)

const NUMERIC_SECTION_IDS = new Set([3, 5, 6, 7]);
// bit 0 = required. Ids 1-7, 9, 10 are required; id 8 (meta) is optional.
const SECTION_LAYOUT = [
    { id: 1, required: true },  // plugins       (string table, pluginCount)
    { id: 2, required: true },  // filePaths     (string table, fileCount)
    { id: 3, required: true },  // filePlugin    (u32 array, fileCount)
    { id: 4, required: true },  // texts         (string table, textCount)
    { id: 5, required: true },  // textOffsets   (u32 array, textCount + 1)
    { id: 6, required: true },  // occFile       (u32 array, occCount)
    { id: 7, required: true },  // occLine       (u32 array, occCount)
    { id: 8, required: false }, // meta          (single str, UTF-8 JSON)
    { id: 9, required: true },  // pluginRepos   (string table, pluginCount)
    { id: 10, required: true }, // pluginCommits (string table, pluginCount)
];

// Accumulates the deduplicated tables that make up the index.
export class IndexBuilder {
    constructor() {
        this.plugins = [];       // internal names, first-seen order
        this.pluginRepos = [];   // repository URL per plugin
        this.pluginCommits = []; // commit hash per plugin
        this.filePaths = [];     // file path per file ("" = no path)
        this.filePlugin = [];    // plugin id per file
        this.texts = [];         // unique non-empty source lines
        this.textIdByText = new Map();
        this.occByText = [];     // per textId: [[fileId, line], ...]
        this.occCount = 0;
    }

    // Assign a new plugin id (first-seen order) and record its metadata.
    registerPlugin(name, repository, commit) {
        const pluginId = this.plugins.length;
        this.plugins.push(name);
        this.pluginRepos.push(repository || "");
        this.pluginCommits.push(commit || "");
        return pluginId;
    }

    // Overwrite metadata for an already-assigned plugin id.
    setPluginMeta(pluginId, repository, commit) {
        this.pluginRepos[pluginId] = repository || "";
        this.pluginCommits[pluginId] = commit || "";
    }

    // Index every line of every file of one plugin record (normalizing the
    // supported file shapes: {fileName|filePath, content}, string files, and a
    // top-level aggregate `content`).
    addPluginFiles(pluginId, record) {
        for (const entry of normalizeFileEntries(record)) {
            if (!entry.content) {
                continue;
            }
            const fileId = this.filePaths.length;
            this.filePaths.push(entry.filePath);
            this.filePlugin.push(pluginId);
            for (const [line, text] of splitLines(entry.content)) {
                this.addOccurrence(fileId, line, text);
            }
        }
    }

    addOccurrence(fileId, line, text) {
        let textId = this.textIdByText.get(text);
        if (textId === undefined) {
            textId = this.texts.length;
            this.textIdByText.set(text, textId);
            this.texts.push(text);
            this.occByText.push([]);
        }
        this.occByText[textId].push([fileId, line]);
        this.occCount++;
    }

    // Produce the final tables (incl. textOffsets/occFile/occLine) and counts.
    finalize() {
        const textCount = this.texts.length;
        const pluginCount = this.plugins.length;
        const fileCount = this.filePaths.length;

        checkU32(pluginCount, "pluginCount");
        checkU32(fileCount, "fileCount");
        checkU32(textCount, "textCount");
        checkU32(this.occCount, "occCount");

        const textOffsets = new Uint32Array(textCount + 1);
        const occFile = new Uint32Array(this.occCount);
        const occLine = new Uint32Array(this.occCount);

        let o = 0;
        for (let i = 0; i < textCount; i++) {
            textOffsets[i] = o;
            for (const [fileId, line] of this.occByText[i]) {
                occFile[o] = fileId;
                occLine[o] = line;
                o++;
            }
        }
        textOffsets[textCount] = o;

        return {
            plugins: this.plugins,
            pluginRepos: this.pluginRepos,
            pluginCommits: this.pluginCommits,
            filePaths: this.filePaths,
            filePlugin: this.filePlugin,
            texts: this.texts,
            textOffsets,
            occFile,
            occLine,
            counts: { pluginCount, fileCount, textCount, occCount: this.occCount },
        };
    }
}

// Build a complete index from an in-memory list of plugin records. Handles
// duplicate internal names with last-wins semantics (the last record seen
// replaces earlier ones entirely; plugin order is first-seen). Returns the
// uncompressed .pbi Buffer, the gzip .pbi.gz Buffer, the meta object, and the
// counts.
export function buildIndex(pluginRecords, opts = {}) {
    const winners = new Map();
    for (const rec of pluginRecords) {
        if (!rec || !rec.internalName) {
            continue;
        }
        winners.set(rec.internalName, rec);
    }

    const builder = new IndexBuilder();
    for (const rec of winners.values()) {
        const pluginId = builder.registerPlugin(rec.internalName, rec.repository, rec.commit);
        builder.addPluginFiles(pluginId, rec);
    }

    return finishBuild(builder, opts);
}

function finishBuild(builder, opts = {}) {
    const tables = builder.finalize();
    const generatedAt = opts.generatedAt || new Date().toISOString();
    const datasetVersion = opts.datasetVersion ||
        computeDatasetVersion(tables.pluginCommits, generatedAt);
    const meta = {
        datasetVersion,
        generatedAt,
        indexFormatVersion: FORMAT_VERSION,
    };

    const pbi = serialize(tables, meta);
    const gz = gzipSync(pbi);

    return {
        pbi,
        gz,
        meta,
        ...tables.counts,
    };
}

// datasetVersion defaults to the lexicographically largest commit hash present,
// falling back to the build timestamp when no plugin carries a commit.
function computeDatasetVersion(commits, generatedAt) {
    let max = null;
    for (const c of commits) {
        if (c && (max === null || c > max)) {
            max = c;
        }
    }
    return max || generatedAt;
}

// Serialize the tables + meta into the exact binary layout of index-format.md.
export function serialize(tables, meta) {
    const {
        plugins, pluginRepos, pluginCommits, filePaths, filePlugin, texts,
        textOffsets, occFile, occLine, counts,
    } = tables;
    const { pluginCount, fileCount, textCount, occCount } = counts;

    const datas = [
        { id: 1, required: true, data: encodeStringTable(plugins) },
        { id: 2, required: true, data: encodeStringTable(filePaths) },
        { id: 3, required: true, data: encodeU32Array(filePlugin) },
        { id: 4, required: true, data: encodeStringTable(texts) },
        { id: 5, required: true, data: encodeU32Array(textOffsets) },
        { id: 6, required: true, data: encodeU32Array(occFile) },
        { id: 7, required: true, data: encodeU32Array(occLine) },
        { id: 8, required: false, data: encodeStr(JSON.stringify(meta)) },
        { id: 9, required: true, data: encodeStringTable(pluginRepos) },
        { id: 10, required: true, data: encodeStringTable(pluginCommits) },
    ];

    const sectionCount = datas.length;
    const directorySize = sectionCount * DIR_ENTRY_SIZE;

    let offset = HEADER_SIZE + directorySize;
    const entries = [];
    for (const s of datas) {
        if (NUMERIC_SECTION_IDS.has(s.id)) {
            offset = align4(offset);
        }
        entries.push({ id: s.id, flags: s.required ? 1 : 0, offset, length: s.data.length });
        offset += s.data.length;
    }
    const totalBytes = offset;

    const buf = Buffer.alloc(totalBytes);

    // Header (48 bytes).
    Buffer.from(MAGIC, "ascii").copy(buf, 0);
    buf.writeUInt32LE(FORMAT_VERSION, 8);
    buf.writeUInt32LE(0, 12); // flags
    buf.writeUInt32LE(sectionCount, 16);
    buf.writeUInt32LE(pluginCount, 20);
    buf.writeUInt32LE(fileCount, 24);
    buf.writeUInt32LE(textCount, 28);
    buf.writeUInt32LE(occCount, 32);
    buf.writeBigUInt64LE(BigInt(totalBytes), 36);
    buf.writeUInt32LE(0, 44); // reserved

    // Section directory.
    let dir = HEADER_SIZE;
    for (const e of entries) {
        buf.writeUInt32LE(e.id, dir);
        buf.writeUInt32LE(e.flags, dir + 4);
        buf.writeBigUInt64LE(BigInt(e.offset), dir + 8);
        buf.writeBigUInt64LE(BigInt(e.length), dir + 16);
        dir += DIR_ENTRY_SIZE;
    }

    // Section payloads (gaps between sections stay zero-filled).
    datas.forEach((s, i) => {
        s.data.copy(buf, entries[i].offset);
    });

    return buf;
}

// --- encoding helpers -------------------------------------------------------

function align4(n) {
    return (n + 3) & ~3;
}

function encodeStr(s) {
    const b = Buffer.from(s, "utf8");
    checkU32(b.length, "string byte length");
    const out = Buffer.alloc(4 + b.length);
    out.writeUInt32LE(b.length, 0);
    b.copy(out, 4);
    return out;
}

function encodeStringTable(strings) {
    return Buffer.concat(strings.map(encodeStr));
}

function encodeU32Array(values) {
    const out = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) {
        out.writeUInt32LE(values[i] >>> 0, i * 4);
    }
    return out;
}

function checkU32(n, label) {
    if (n >= MAX_U32) {
        throw new Error(`${label} exceeds u32 limit (${n} >= ${MAX_U32})`);
    }
}

// --- record normalization ---------------------------------------------------

// Normalize the file entries of a plugin record into [{filePath, content}].
// Handles a top-level aggregate `content` (encoded as filePath "" = no path),
// object entries with `fileName`/`filePath`, and bare string entries (a path
// with no known content).
function normalizeFileEntries(record) {
    const entries = [];
    if (typeof record.content === "string") {
        entries.push({ filePath: "", content: record.content });
    }
    if (Array.isArray(record.files)) {
        for (const f of record.files) {
            if (f == null) {
                continue;
            }
            if (typeof f === "string") {
                entries.push({ filePath: f, content: "" });
            } else if (typeof f === "object") {
                const filePath = f.filePath ?? f.fileName ?? null;
                const content = typeof f.content === "string" ? f.content : "";
                entries.push({ filePath: filePath == null ? "" : filePath, content });
            }
        }
    }
    return entries;
}

// Yield [lineNumber, text] for each non-empty line, splitting on '\n' and
// retaining any trailing '\r'. Lines are 1-based; empty lines are skipped.
function* splitLines(content) {
    let lineNum = 1;
    let lineStart = 0;
    let idx;
    while ((idx = content.indexOf("\n", lineStart)) !== -1) {
        const line = content.substring(lineStart, idx);
        if (line !== "") {
            yield [lineNum, line];
        }
        lineStart = idx + 1;
        lineNum++;
    }
    const last = content.substring(lineStart);
    if (last !== "") {
        yield [lineNum, last];
    }
}

// --- CLI --------------------------------------------------------------------

function numericPartKey(name) {
    const m = /^plugins_(\d+)\.json$/.exec(name);
    return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

async function main() {
    const t0 = Date.now();
    const jsonDir = "json";

    const files = readdirSync(jsonDir)
        .filter((f) => /^plugins_\d+\.json$/.test(f))
        .sort((a, b) => numericPartKey(a) - numericPartKey(b));

    if (files.length === 0) {
        throw new Error(`no json/plugins_*.json files found in ${jsonDir}`);
    }

    // Pass 1: resolve duplicate internal names (last-wins) and capture the
    // final metadata + winning record location for each plugin, keeping
    // first-seen order. Only tiny metadata is retained here.
    const pluginNames = [];
    const pluginRepos = [];
    const pluginCommits = [];
    const pluginIdByName = new Map();
    const winningLoc = []; // per pluginId: { fileIdx, recIdx }

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const records = JSON.parse(readFileSync(join(jsonDir, files[fileIdx]), "utf8"));
        for (let recIdx = 0; recIdx < records.length; recIdx++) {
            const rec = records[recIdx];
            const name = rec && rec.internalName;
            if (!name) {
                continue;
            }
            let pid = pluginIdByName.get(name);
            if (pid === undefined) {
                pid = pluginNames.length;
                pluginIdByName.set(name, pid);
                pluginNames.push(name);
                pluginRepos.push("");
                pluginCommits.push("");
                winningLoc.push(null);
            }
            pluginRepos[pid] = rec.repository || "";
            pluginCommits[pid] = rec.commit || "";
            winningLoc[pid] = { fileIdx, recIdx };
        }
    }

    // Pass 2: index only the winning record for each plugin, one json file at
    // a time so raw source content is never retained after it is split/deduped.
    const builder = new IndexBuilder();
    builder.plugins = pluginNames;
    builder.pluginRepos = pluginRepos;
    builder.pluginCommits = pluginCommits;

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const records = JSON.parse(readFileSync(join(jsonDir, files[fileIdx]), "utf8"));
        for (let recIdx = 0; recIdx < records.length; recIdx++) {
            const rec = records[recIdx];
            const name = rec && rec.internalName;
            if (!name) {
                continue;
            }
            const pid = pluginIdByName.get(name);
            const wl = winningLoc[pid];
            if (wl.fileIdx !== fileIdx || wl.recIdx !== recIdx) {
                continue;
            }
            builder.addPluginFiles(pid, rec);
        }
    }

    const result = finishBuild(builder, {});

    mkdirSync("index", { recursive: true });
    writeFileSync(join("index", "index.pbi"), result.pbi);
    writeFileSync(join("index", "index.pbi.gz"), result.gz);

    const elapsed = Date.now() - t0;
    const mb = (n) => (n / (1024 * 1024)).toFixed(2);
    console.log(`Plugins:        ${result.pluginCount}`);
    console.log(`Files:          ${result.fileCount}`);
    console.log(`Unique lines:   ${result.textCount}`);
    console.log(`Occurrences:    ${result.occCount}`);
    console.log(`datasetVersion: ${result.meta.datasetVersion}`);
    console.log(`generatedAt:    ${result.meta.generatedAt}`);
    console.log(`index.pbi:      ${mb(result.pbi.length)} MiB (${result.pbi.length} bytes)`);
    console.log(`index.pbi.gz:   ${mb(result.gz.length)} MiB (${result.gz.length} bytes)`);
    console.log(`Elapsed:        ${elapsed} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
