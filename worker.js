// worker.js — module worker for the Pluginhub search client.
//
// Owns the parsed index and serves regex queries, keeping parsing and the
// regex scan off the main thread. Imports the shared search core from
// index-reader.mjs.

import { parseIndex, buildSearchIndex, searchRegex } from "./index-reader.mjs";

let index = null;
let activePlugins = null; // Set of active plugin internal names (from manifest)

self.onmessage = async (e) => {
    const msg = e.data;
    if (!msg || typeof msg.type !== "string") {
        return;
    }

    switch (msg.type) {
        case "init": {
            try {
                // `msg.buffer` is the raw .pbi.gz ArrayBuffer, transferred in
                // (zero-copy) by the main thread.
                index = await parseIndex(msg.buffer);

                // Build the concatenated haystack + line-offset table, then drop
                // the per-line string array to halve string memory.
                buildSearchIndex(index);
                index.texts = null;

                self.postMessage({
                    type: "ready",
                    pluginCount: index.pluginCount,
                    fileCount: index.fileCount,
                    textCount: index.textCount,
                    occCount: index.occCount,
                    datasetVersion: index.meta ? index.meta.datasetVersion : null,
                    generatedAt: index.meta ? index.meta.generatedAt : null,
                    plugins: index.plugins,
                    pluginRepos: index.pluginRepos,
                    pluginCommits: index.pluginCommits,
                });
            } catch (err) {
                self.postMessage({ type: "error", message: String((err && err.message) || err) });
            }
            break;
        }

        case "setActivePlugins": {
            activePlugins = Array.isArray(msg.activePlugins)
                ? new Set(msg.activePlugins)
                : null;
            break;
        }

        case "search": {
            if (!index) {
                self.postMessage({ type: "error", id: msg.id, message: "index not ready" });
                return;
            }
            try {
                const result = searchRegex(index, msg.pattern, {
                    activePlugins,
                    limit: typeof msg.limit === "number" ? msg.limit : undefined,
                });
                self.postMessage({ type: "result", id: msg.id, result });
            } catch (err) {
                // Includes SyntaxError for invalid patterns.
                self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
            }
            break;
        }

        default:
            break;
    }
};
