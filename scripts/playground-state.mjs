// Dev-server endpoint that keeps the playground's saved state (chart layout, drawings,
// indicators, positions, watchlist, alerts) in a JSON file, so it outlives the server, the
// port and the browser. Read by playground/saved.ts and by the Android app (android/).
//   GET  /__state              every value
//   PUT  /__state {key, value} set one (value null removes it)
//   POST /__sync  {key: value} the Android app's sync: merges what it sends, answers every shared value
// A shared value ({"$items": …}, see saved.ts) is MERGED into the stored one, item by item (the
// newer change wins), never overwritten: edits made apart on the PC and the tablet all survive.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 5_000_000; // a value is a chart document, not a dump
const TOMBSTONE_MS = 30 * 86_400_000; // as in saved.ts

/** The items of a shared value, or null when the value is not one. */
function itemsOf(raw) {
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && v.$items && typeof v.$items === 'object' ? v.$items : null;
    } catch {
        return null;
    }
}

/** Same rule as saved.ts mergeItems: per item, the newer change wins. */
export function mergeItems(a, b, now = Date.now()) {
    const out = {};
    for (const [id, item] of [...Object.entries(a), ...Object.entries(b)]) {
        if (!item || typeof item.t !== 'number') continue;
        if (item.d && item.t < now - TOMBSTONE_MS) continue;
        const cur = out[id];
        if (!cur || item.t > cur.t || (item.t === cur.t && JSON.stringify(item) > JSON.stringify(cur))) out[id] = item;
    }
    return out;
}

/** The value to store: a shared value merges into the stored one; anything else replaces it. */
function combine(stored, incoming) {
    const theirs = itemsOf(incoming);
    const ours = stored === undefined ? null : itemsOf(stored);
    return theirs && ours ? JSON.stringify({ $items: mergeItems(ours, theirs) }) : incoming;
}

/** @param {URL} url the JSON file to keep the state in */
export function playgroundState(url) {
    const file = fileURLToPath(url);
    const read = () => {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        } catch {
            return {};
        }
    };
    const write = (state) => {
        writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
        renameSync(`${file}.tmp`, file); // a crash mid-write leaves the old file whole
    };
    const body = (req, res, then) => {
        let text = '';
        req.on('data', (chunk) => {
            text += chunk;
            if (text.length > MAX_BODY) req.destroy();
        });
        req.on('end', () => {
            try {
                then(JSON.parse(text));
            } catch {
                res.statusCode = 400;
                res.end();
            }
        });
    };
    return {
        name: 'playground-state',
        /** @param {import('vite').ViteDevServer} server */
        configureServer(server) {
            server.middlewares.use('/__state', (req, res) => {
                if (req.method === 'GET') {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(read()));
                    return;
                }
                if (req.method !== 'PUT') {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                body(req, res, ({ key, value }) => {
                    if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) throw new Error('bad body');
                    const state = read();
                    if (value === null) delete state[key];
                    else state[key] = combine(state[key], value);
                    write(state);
                    res.statusCode = 204;
                    res.end();
                });
            });
            server.middlewares.use('/__sync', (req, res) => {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                body(req, res, (sent) => {
                    if (!sent || typeof sent !== 'object') throw new Error('bad body');
                    const state = read();
                    let changed = false;
                    for (const [key, value] of Object.entries(sent)) {
                        if (typeof value !== 'string' || !itemsOf(value)) continue; // only shared values travel
                        const next = combine(state[key], value);
                        if (next !== state[key]) [state[key], changed] = [next, true];
                    }
                    if (changed) write(state);
                    res.setHeader('content-type', 'application/json');
                    res.setHeader('x-vela-playground', '1'); // how the app knows it found the playground, not some other server
                    res.end(JSON.stringify(Object.fromEntries(Object.entries(state).filter(([, v]) => itemsOf(v)))));
                });
            });
        },
    };
}
