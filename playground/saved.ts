// Where the playground keeps what you save: chart layout, drawings, indicators, positions,
// watchlist and alerts. On the PC the dev server writes it to .playground-state.json at the repo
// root (scripts/playground-state.mjs), so it outlives server restarts, port changes and browsers;
// in the Android app (android/) the app keeps it, and syncs it with the PC whenever both are on
// the same Wi-Fi. Every value is mirrored in this browser's localStorage too: that copy is read
// when the store has none yet (state saved before the file existed).
//
// Trades, alerts, the watchlist and each symbol's lines and indicators are SHARED by every page
// and device. They are stored as items stamped with the time they last changed, and two copies
// merge item by item (the newer stamp wins, deletions included), so edits made on two devices
// apart from each other all survive the next sync. Each page's layout and symbols stay its own.

interface NativeStore {
    /** Every saved value, as JSON: { key: value }. */
    getState(): string;
    /** Save one value (null removes it); a value of shared items is merged into the stored one. */
    put(key: string, value: string | null): void;
}
/** The Android app's own store, present only inside the app. */
const native = (globalThis as { VelaNative?: NativeStore }).VelaNative;

/** One shared item: `t` when it last changed, `c` when it was created (list order), `d` deleted. */
interface Item {
    t: number;
    c?: number;
    v?: unknown;
    d?: 1;
}
type Items = Record<string, Item>;

/** How a shared value splits into named items and joins back. */
interface Shape {
    split(value: unknown): [string, unknown][];
    join(items: [string, unknown][]): unknown;
}
const list = (id: (x: unknown) => string): Shape => ({
    split: (v) => (Array.isArray(v) ? v.map((x): [string, unknown] => [id(x), x]) : []),
    join: (items) => items.map(([, v]) => v),
});
const SHARED: Record<string, Shape> = {
    'vela-play:positions': list((p) => (p as { id: string }).id),
    'vela-play:alerts': list((a) => (a as { uid?: string }).uid ?? `${(a as { symbol: string }).symbol}|${(a as { id: string }).id}`), // alerts.ts gives older alerts this same uid
    'vela-play:watchlist': list((s) => s as string),
    'vela-play:charts': { split: (v) => (v && typeof v === 'object' ? Object.entries(v) : []), join: (items) => Object.fromEntries(items) },
};

const TOMBSTONE_MS = 30 * 86_400_000; // shortcut: a device offline longer than this can bring a deleted item back

/** Merge two copies of shared items: per item, the newer change wins. */
export function mergeItems(a: Items, b: Items, now = Date.now()): Items {
    const out: Items = {};
    for (const [id, item] of [...Object.entries(a), ...Object.entries(b)]) {
        if (item.d && item.t < now - TOMBSTONE_MS) continue;
        const cur = out[id];
        if (!cur || item.t > cur.t || (item.t === cur.t && JSON.stringify(item) > JSON.stringify(cur))) out[id] = item;
    }
    return out;
}
console.assert(
    JSON.stringify(mergeItems({ a: { t: 2, v: 1 }, b: { t: 5, v: 1 } }, { a: { t: 3, d: 1 }, b: { t: 4, v: 2 }, c: { t: 1, v: 3 } }, 10)) ===
        JSON.stringify({ a: { t: 3, d: 1 }, b: { t: 5, v: 1 }, c: { t: 1, v: 3 } }),
    'mergeItems',
);

/** Shared items from a stored value: the stamped form, or a plain value saved before sharing existed
 *  (its items get the oldest stamp, so any real change made elsewhere wins over them). */
function readItems(key: string, raw: string | null | undefined): Items | null {
    if (raw == null) return null;
    try {
        const v: unknown = JSON.parse(raw);
        if (v && typeof v === 'object' && '$items' in v) return (v as { $items: Items }).$items;
        return Object.fromEntries(SHARED[key]!.split(v).map(([id, x], i): [string, Item] => [id, { t: 1, c: i, v: x }]));
    } catch {
        return null;
    }
}
const writeItems = (items: Items): string => JSON.stringify({ $items: items });
/** The plain value the page works with: live items, in the order they were created. */
function joinItems(key: string, items: Items | null): string | null {
    if (!items) return null;
    const live = Object.entries(items)
        .filter(([, it]) => !it.d)
        .sort(([a, x], [b, y]) => (x.c ?? 0) - (y.c ?? 0) || (a < b ? -1 : 1));
    return JSON.stringify(SHARED[key]!.join(live.map(([id, it]) => [id, it.v])));
}

// ── The store ──
async function readAll(): Promise<Record<string, string> | null> {
    if (native) return JSON.parse(native.getState()) as Record<string, string>;
    return fetch('/__state')
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : null))
        .catch(() => null);
}
async function write(key: string, value: string | null): Promise<boolean> {
    if (native) {
        native.put(key, value);
        return true;
    }
    const body = JSON.stringify({ key, value });
    // keepalive: the save a page makes as you leave it still lands. shortcut: browsers cap keepalive bodies at 64 KB, so a bigger one can still be lost on leaving.
    return fetch('/__state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 }).then(
        (r) => r.ok,
        () => false,
    );
}

const state: Record<string, string> = (await readAll()) ?? {};
const items: Record<string, Items> = {};
const plain: Record<string, string | null> = {}; // shared values, joined
for (const key of Object.keys(SHARED)) {
    const found = readItems(key, state[key] ?? localStorage.getItem(key));
    if (found) items[key] = found;
    plain[key] = joinItems(key, found);
}

export function getSaved(key: string): string | null {
    if (key in SHARED) return plain[key] ?? null;
    return state[key] ?? localStorage.getItem(key);
}

let clock = 0;
export function setSaved(key: string, value: string | null): void {
    if (key in SHARED) {
        // Stamp what changed: new and edited items, and the ones this value no longer has.
        const now = (clock = Math.max(Date.now(), clock + 1));
        const cur = { ...(items[key] ?? {}) };
        const next = value === null ? [] : SHARED[key]!.split(JSON.parse(value));
        const keep = new Set<string>();
        let changed = !items[key];
        next.forEach(([id, v], i) => {
            keep.add(id);
            const old = cur[id];
            if (old && !old.d && JSON.stringify(old.v) === JSON.stringify(v)) return;
            cur[id] = { t: now, c: old && !old.d ? old.c : now + i, v };
            changed = true;
        });
        for (const [id, old] of Object.entries(cur)) {
            if (keep.has(id) || old.d) continue;
            cur[id] = { t: now, d: 1 };
            changed = true;
        }
        if (!changed) return;
        items[key] = cur;
        plain[key] = joinItems(key, cur);
        value = writeItems(cur);
    }
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

// Other pages and devices save to the same store: pick up their changes when this window gets
// focus, every few seconds, and right after the Android app synced with the PC.
const listeners = new Map<string, Set<() => void>>();
export function onSavedChange(key: string, cb: () => void): void {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(cb);
}
async function pull(): Promise<void> {
    const fresh = await readAll();
    if (!fresh) return;
    for (const key of new Set([...Object.keys(fresh), ...Object.keys(state)])) {
        if (key in SHARED) {
            const theirs = readItems(key, fresh[key]);
            if (!theirs) continue;
            const merged = mergeItems(items[key] ?? {}, theirs);
            items[key] = merged;
            state[key] = writeItems(merged);
            const joined = joinItems(key, merged);
            if (joined === plain[key]) continue;
            plain[key] = joined;
        } else {
            if (pending.has(key) || fresh[key] === state[key]) continue; // our own unsent write wins
            if (fresh[key] === undefined) delete state[key];
            else state[key] = fresh[key];
        }
        listeners.get(key)?.forEach((cb) => cb());
    }
}
addEventListener('focus', () => void pull());
addEventListener('vela-synced', () => void pull());
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
            if (!(await write(key, value))) {
                setTimeout(() => void flush(), 3000);
                return;
            }
            if (pending.get(key) === value) pending.delete(key); // a newer value for this key waits its turn
        }
    } finally {
        flushing = false;
    }
}
