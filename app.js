// app.js — Pluginhub search client (performance-first, plain DOM, no deprecate.js).
//
// Bootstraps the live manifest/installs, loads + caches the precomputed index
// (index/index.pbi.gz), hands it to a module Web Worker, and renders regex
// search results with active-plugin filtering, install-count ordering, and
// index-based deep links.

import { FORMAT_VERSION } from "./index-reader.mjs";

const INDEX_URL = "index/index.pbi.gz";
const VERSION_URL = "https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version";
const MANIFEST_ROOT = "https://repo.runelite.net/plugins/";
const INSTALLS_ROOT = "https://api.runelite.net/runelite-";

const ROW_LIMIT = 5000;
const DEBOUNCE_MS = 350;

const DB_NAME = "pluginhub-index";
const DB_VERSION = 1;
const STORE = "index";
const CACHE_KEY = "current";

// --- state ------------------------------------------------------------------

let worker = null;
let ready = false;
let activePlugins = null;          // Set of internal names (from manifest)
let installMap = {};               // internalName -> install count
let pluginMeta = new Map();        // internalName -> { repo, commit }
let lastUpdated = "Loading...";
let searchSeq = 0;
let pending = new Map();           // id -> { entry, seq }
let queued = new Set();            // entries awaiting the worker
let entries = [];                  // search entry objects

// --- bootstrap data ---------------------------------------------------------

async function fetchVersion() {
    const res = await fetch(VERSION_URL);
    if (!res.ok) throw new Error(`runelite.version ${res.status}`);
    return (await res.text()).trim();
}

async function fetchManifest(version) {
    const res = await fetch(`${MANIFEST_ROOT}manifest/${version}_full.js`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const buf = await res.arrayBuffer();
    const view = new DataView(buf);
    const skip = 4 + view.getUint32(0, true);
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf, skip));
    return JSON.parse(text);
}

async function fetchInstalls(version) {
    const res = await fetch(`${INSTALLS_ROOT}${version}/pluginhub`);
    if (!res.ok) throw new Error(`installs ${res.status}`);
    return res.json();
}

// --- IndexedDB cache --------------------------------------------------------

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Fetch the raw .pbi.gz buffer, revalidating a cached copy with If-None-Match
// and falling back to the cache when the network fails.
async function loadIndexBuffer() {
    let db = null;
    let cached = null;
    try {
        db = await openDb();
        cached = await idbGet(db, CACHE_KEY);
    } catch (e) {
        db = null;
    }

    const headers = {};
    if (cached && cached.formatVersion === FORMAT_VERSION) {
        if (cached.etag) headers["If-None-Match"] = cached.etag;
        if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
    }

    let res;
    try {
        res = await fetch(INDEX_URL, { headers });
    } catch (e) {
        if (cached && cached.buffer) return cached.buffer;
        throw e;
    }

    if (res.status === 304 && cached && cached.buffer) {
        return cached.buffer;
    }
    if (!res.ok) {
        if (cached && cached.buffer) return cached.buffer;
        throw new Error(`index fetch failed: ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    if (db) {
        try {
            await idbPut(db, CACHE_KEY, {
                formatVersion: FORMAT_VERSION,
                etag: res.headers.get("ETag") || null,
                lastModified: res.headers.get("Last-Modified") || null,
                buffer,
            });
        } catch (e) {
            // cache write is best-effort
        }
    }
    return buffer;
}

// --- worker -----------------------------------------------------------------

function onWorkerMessage(e) {
    const msg = e.data;
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "ready") {
        ready = true;
        const { plugins, pluginRepos, pluginCommits, generatedAt, datasetVersion } = msg;
        pluginMeta = new Map();
        for (let i = 0; i < plugins.length; i++) {
            pluginMeta.set(plugins[i], { repo: pluginRepos[i] || "", commit: pluginCommits[i] || "" });
        }
        if (generatedAt) lastUpdated = generatedAt;
        else if (datasetVersion) lastUpdated = datasetVersion;
        renderFooter();
        syncActivePlugins();
        for (const entry of queued) runSearch(entry);
        queued.clear();
        return;
    }

    if (msg.type === "result") {
        const p = pending.get(msg.id);
        if (p) {
            pending.delete(msg.id);
            if (p.seq === p.entry.seq) renderResult(p.entry, msg.result, null);
        }
        return;
    }

    if (msg.type === "error") {
        if (msg.id != null) {
            const p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                if (p.seq === p.entry.seq) renderResult(p.entry, null, msg.message);
            }
        } else {
            showError(msg.message || "index load failed");
        }
    }
}

function initWorkerAndIndex() {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => showError(`worker error: ${e.message || e}`);

    (async () => {
        const buffer = await loadIndexBuffer();
        worker.postMessage({ type: "init", buffer }, [buffer]);
    })().catch((err) => showError(String((err && err.message) || err)));
}

function syncActivePlugins() {
    if (worker && ready && activePlugins) {
        worker.postMessage({ type: "setActivePlugins", activePlugins: [...activePlugins] });
    }
}

// --- search -----------------------------------------------------------------

const EMPTY_RESULT = { plugins: [], rows: [], occurrenceCount: 0, matchedTextCount: 0 };

function runSearch(entry) {
    const pattern = entry.pattern;
    if (pattern === "" || pattern === "^") {
        entry.seq++;
        renderResult(entry, EMPTY_RESULT, null);
        return;
    }
    if (!ready) {
        queued.add(entry);
        return;
    }
    const seq = ++entry.seq;
    const id = ++searchSeq;
    pending.set(id, { entry, seq });
    worker.postMessage({ type: "search", id, pattern, limit: ROW_LIMIT });
}

// --- deep links -------------------------------------------------------------

function openLine(plugin, file, line) {
    const meta = pluginMeta.get(plugin);
    if (!meta || !meta.repo) return;
    const repo = meta.repo.replace(/\.git$/, "");
    const commit = meta.commit || "";
    const url = file
        ? `${repo}/tree/${commit}/${file.replace(/^\/+/, "")}#L${line}`
        : `${repo}/tree/${commit}`;
    window.open(url, "_blank", "noopener");
}

// --- rendering --------------------------------------------------------------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function renderResult(entry, result, error) {
    if (error) {
        entry.errorEl.textContent = error;
        entry.resultsEl.innerHTML = "";
        return;
    }
    entry.errorEl.textContent = "";

    const parts = [];

    const plugins = result.plugins
        ? result.plugins.slice().sort((a, b) => (installMap[b] || 0) - (installMap[a] || 0))
        : [];
    if (plugins.length) {
        parts.push(
            `<div class="plugins">` +
            plugins.map((p) =>
                `<span class="plugin" data-name="${escapeHtml(p)}">${escapeHtml(p)}` +
                ` <span class="noselect">(${(installMap[p] || 0).toLocaleString()})</span></span>`
            ).join("") +
            `</div>`
        );
    }

    if (result.rows && result.rows.length) {
        parts.push(
            `<div class="lines">` +
            result.rows.map((r) =>
                `<div class="line" data-plugin="${escapeHtml(r.plugin)}" ` +
                `data-file="${escapeHtml(r.file || "")}" data-line="${r.line}">` +
                `<a href="#"><code>${escapeHtml(r.text)}</code></a>` +
                `<span class="muted">${escapeHtml(r.file ? `${r.file}:${r.line}` : "")}</span>` +
                ` <span class="plugin">${escapeHtml(r.plugin)}</span></div>`
            ).join("") +
            `</div>`
        );
    }

    if (result.matchedTextCount) {
        const occ = result.occurrenceCount;
        let note = `${result.matchedTextCount} line${result.matchedTextCount === 1 ? "" : "s"} · ` +
            `${occ} occurrence${occ === 1 ? "" : "s"}`;
        if (result.truncated) note += ` · showing ${result.rows.length} of ${occ}`;
        parts.push(`<div class="note">${escapeHtml(note)}</div>`);
    }

    entry.resultsEl.innerHTML = parts.join("");
}

function renderFooter() {
    const el = document.getElementById("last-updated");
    if (!el) return;
    let label = lastUpdated;
    const d = new Date(lastUpdated);
    if (!isNaN(d)) label = d.toLocaleString();
    el.textContent = `Last updated: ${label}`;
}

function showError(message) {
    const app = document.getElementById("app");
    const el = document.getElementById("fatal-error");
    if (el) {
        el.textContent = message;
    } else {
        const div = document.createElement("div");
        div.id = "fatal-error";
        div.className = "error";
        div.textContent = message;
        app.appendChild(div);
    }
}

// --- search entry lifecycle -------------------------------------------------

function buildEntry(pattern) {
    const root = document.createElement("div");
    root.className = "search";

    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = "regex search (e.g. class \\w+Plugin)";
    input.value = pattern;

    const errorEl = document.createElement("div");
    errorEl.className = "error";
    const resultsEl = document.createElement("div");
    resultsEl.className = "results";

    root.append(input, errorEl, resultsEl);

    const entry = { pattern, input, errorEl, resultsEl, seq: 0, timer: null };

    input.addEventListener("input", () => {
        entry.pattern = input.value;
        // Auto-append a new empty entry when the last one becomes non-empty.
        if (entry === entries[entries.length - 1] && entry.pattern !== "") {
            addEntry("");
        }
        // Drop emptied non-last entries.
        if (entry.pattern === "" && entry !== entries[entries.length - 1]) {
            removeEntry(entry);
        }
        writeHash();
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => runSearch(entry), DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
            clearTimeout(entry.timer);
            runSearch(entry);
        }
    });

    return entry;
}

function addEntry(pattern) {
    const entry = buildEntry(pattern);
    entries.push(entry);
    document.getElementById("searches").appendChild(entry.input.parentElement);
    // Kick an immediate (empty) result.
    renderResult(entry, EMPTY_RESULT, null);
    return entry;
}

function removeEntry(entry) {
    const idx = entries.indexOf(entry);
    if (idx < 0) return;
    entries.splice(idx, 1);
    entry.input.parentElement.remove();
}

// --- URL hash ---------------------------------------------------------------

function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function b64decode(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function readHash() {
    const hash = window.location.hash;
    if (!hash || hash === "#") return [""];
    try {
        const raw = hash.slice(1);
        if (raw.startsWith("search?str=")) {
            return [raw.slice("search?str=".length)];
        }
        const arr = JSON.parse(b64decode(raw));
        if (Array.isArray(arr)) {
            const pats = arr.filter((p) => typeof p === "string");
            if (pats.length) return pats;
        }
        return [""];
    } catch (e) {
        return [""];
    }
}

function writeHash() {
    let pats = entries.map((e) => e.pattern);
    while (pats.length > 1 && pats[pats.length - 1] === "") pats.pop();
    if (pats.length === 0 || (pats.length === 1 && pats[0] === "")) {
        history.replaceState(undefined, undefined, "#");
        return;
    }
    history.replaceState(undefined, undefined, "#" + b64encode(JSON.stringify(pats)));
}

// --- main -------------------------------------------------------------------

async function main() {
    const app = document.getElementById("app");
    app.innerHTML = `
        <div class="content">
            <div id="searches"></div>
        </div>
        <footer class="footer"><span id="last-updated">Last updated: Loading...</span></footer>
    `;

    const searchesEl = document.getElementById("searches");
    searchesEl.addEventListener("click", (e) => {
        const line = e.target.closest(".line");
        if (!line) return;
        e.preventDefault();
        openLine(
            line.dataset.plugin,
            line.dataset.file || null,
            parseInt(line.dataset.line, 10) || 1
        );
    });

    initWorkerAndIndex();

    // Bootstrap live data in parallel with the index load.
    (async () => {
        try {
            const version = await fetchVersion();
            const [mf, installs] = await Promise.all([fetchManifest(version), fetchInstalls(version)]);
            activePlugins = new Set((mf.jars || []).map((j) => j.internalName));
            installMap = installs || {};
            if (!lastUpdated || lastUpdated === "Loading...") lastUpdated = (mf.display && mf.display.version) || version;
            renderFooter();
            syncActivePlugins();
            for (const entry of entries) runSearch(entry);
        } catch (e) {
            console.error("bootstrap data failed:", e);
        }
    })();

    for (const pattern of readHash()) addEntry(pattern);
    if (entries.length === 0) addEntry("");
}

main().catch((err) => showError(String((err && err.stack) || err)));
