// Where the playground keeps what you save: chart layout, drawings, indicators, positions,
// watchlist and alerts. The dev server writes it to .playground-state.json at the repo root
// (scripts/playground-state.mjs), so it outlives server restarts, port changes and browsers.
// Every value is mirrored in this browser's localStorage too: that copy is read when the file
// has none yet (state saved before the file existed), and it covers a write the server missed.

const state: Record<string, string> = await fetch('/__state')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
    .catch(() => ({}));

export function getSaved(key: string): string | null {
    return state[key] ?? localStorage.getItem(key);
}

export function setSaved(key: string, value: string | null): void {
    if (value === null) {
        delete state[key];
        localStorage.removeItem(key);
    } else {
        state[key] = value;
        localStorage.setItem(key, value);
    }
    pending.set(key, value);
    void flush();
}

// Writes go out one at a time, in order; while the server is down they wait and retry.
const pending = new Map<string, string | null>();
let flushing = false;
async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
        while (pending.size > 0) {
            const [key, value] = pending.entries().next().value as [string, string | null];
            const ok = await fetch('/__state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }) }).then(
                (r) => r.ok,
                () => false,
            );
            if (!ok) {
                setTimeout(() => void flush(), 3000);
                return;
            }
            if (pending.get(key) === value) pending.delete(key); // a newer value for this key waits its turn
        }
    } finally {
        flushing = false;
    }
}
