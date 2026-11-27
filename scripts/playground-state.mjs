// Dev-server endpoint that keeps the playground's saved state (chart layout, drawings,
// indicators, positions, watchlist, alerts) in a JSON file, so it outlives the server, the
// port and the browser. GET /__state returns every value; PUT /__state {key, value} sets one
// (value null removes it). Read by playground/saved.ts.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 5_000_000; // a value is a chart document, not a dump

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
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > MAX_BODY) req.destroy();
                });
                req.on('end', () => {
                    try {
                        const { key, value } = JSON.parse(body);
                        if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) throw new Error('bad body');
                        const state = read();
                        if (value === null) delete state[key];
                        else state[key] = value;
                        write(state);
                        res.statusCode = 204;
                    } catch {
                        res.statusCode = 400;
                    }
                    res.end();
                });
            });
        },
    };
}
