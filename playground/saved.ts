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

// Other open pages save to the same file: pick up their changes when this window gets focus
// and every few seconds, so a list edited here starts from theirs instead of overwriting it.
// shortcut: two pages editing the same list within the same few seconds can still lose one edit; a per-item server merge would close that.
const listeners = new Map<string, Set<() => void>>();
export function onSavedChange(key: string, cb: () => void): void {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(cb);
}
async function pull(): Promise<void> {
    const fresh = await fetch('/__state')
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : null))
        .catch(() => null);
    if (!fresh) return;
    for (const key of new Set([...Object.keys(fresh), ...Object.keys(state)])) {
        if (pending.has(key) || fresh[key] === state[key]) continue; // our own unsent write wins
        if (fresh[key] === undefined) delete state[key];
        else state[key] = fresh[key];
        listeners.get(key)?.forEach((cb) => cb());
    }
}
addEventListener('focus', () => void pull());
setInterval(() => void pull(), 5000);

// Writes go out one at a time, in order; while the server is down they wait and retry.
const pending = new Map<string, string | null>();
let flushing = false;
async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
        while (pending.size > 0) {
            const [key, value] = pending.entries().next().value as [string, string | null];
            const body = JSON.stringify({ key, value });
            // keepalive: the save a page makes as you leave it still lands. shortcut: browsers cap keepalive bodies at 64 KB, so a bigger one can still be lost on leaving.
            const ok = await fetch('/__state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 }).then(
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
