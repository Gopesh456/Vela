// Each symbol keeps its own lines and indicators, shared by every page and device (saved.ts): a
// line drawn on BTCUSDT shows wherever BTCUSDT is open, on the PC and in the Android app, and
// switching a chart to another symbol puts that symbol's lines and indicators on it. A symbol
// opened for the first time starts with no lines and keeps the indicators the chart shows.
import type { Vela } from '../src';
import type { VelaWorkspace } from '../src/workspace';
import { getSaved, onSavedChange, setSaved } from './saved';

const KEY = 'vela-play:charts';

/** One symbol's lines and indicators, as a chart's saved state holds them. */
interface Entry {
    drawings: unknown;
    indicators: unknown;
}
interface CellDoc extends Entry {
    id: string;
    symbol: string;
}

let store: Record<string, Entry> = load();
function load(): Record<string, Entry> {
    try {
        const v: unknown = JSON.parse(getSaved(KEY) ?? '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Entry>) : {};
    } catch {
        return {};
    }
}

/** A symbol as every page and device names it: its source and ticker (binance:BTCUSDT, nse:RELIANCE). */
export function symbolKey(chart: Vela, symbol: string): string {
    const r = chart.data.resolve(symbol);
    return r ? `${r.provider}:${r.ticker}` : symbol;
}

export function bindSymbolCharts(ws: VelaWorkspace): void {
    const settled = new Map<string, string>(); // cell id → the symbol whose lines and indicators it shows
    const seen = new Map<string, string>(); // cell id → those lines and indicators, as last put or recorded
    const entryOf = (c: CellDoc): string => JSON.stringify({ drawings: c.drawings, indicators: c.indicators });
    const liveCells = (doc: { charts: unknown[] }): CellDoc[] => (doc.charts as CellDoc[]).filter((c) => ws.cell(c.id));
    const keyOf = (c: CellDoc): string => symbolKey(ws.cell(c.id)!.chart, c.symbol);

    // Put each chart's symbol's saved lines and indicators on it.
    const put = (): void => {
        const doc = ws.getState() as unknown as { charts: unknown[] };
        let changed = false;
        for (const c of liveCells(doc)) {
            const key = keyOf(c);
            const saved = store[key];
            if (saved && JSON.stringify(saved) !== entryOf(c)) {
                c.drawings = saved.drawings;
                c.indicators = saved.indicators;
                changed = true;
            }
            settled.set(c.id, key);
            seen.set(c.id, entryOf(c));
        }
        if (changed) ws.applyState(doc as unknown as Parameters<VelaWorkspace['applyState']>[0]);
        record(); // a symbol seen for the first time keeps what its chart shows
    };

    // Keep what changed on a chart under its symbol, then line up other charts on the same symbol.
    const record = (): void => {
        const doc = ws.getState() as unknown as { charts: unknown[] };
        let changed = false;
        for (const c of liveCells(doc)) {
            const key = keyOf(c);
            if (settled.get(c.id) !== key) continue; // mid-switch: these lines belong to no symbol yet
            const entry = entryOf(c);
            if (seen.get(c.id) === entry && store[key]) continue;
            seen.set(c.id, entry);
            if (JSON.stringify(store[key]) === entry) continue;
            store = { ...store, [key]: JSON.parse(entry) as Entry };
            changed = true;
        }
        if (!changed) return;
        setSaved(KEY, JSON.stringify(store));
        put();
    };

    const watch = (id: string): void => {
        const chart = ws.cell(id)?.chart;
        if (!chart) return;
        chart.drawings.setClearOnSymbolChange(true); // lines belong to the symbol they were drawn on
        chart.on('load:start', ({ symbol }) => {
            if (symbolKey(chart, symbol) !== settled.get(id)) settled.delete(id); // a timeframe change keeps the symbol
        });
        chart.on('market:changed', () => setTimeout(put, 0));
    };
    ws.cells().forEach((c) => watch(c.id));
    ws.on('cell:created', ({ id }) => {
        watch(id);
        setTimeout(put, 0);
    });
    ws.on('state:changed', record);
    onSavedChange(KEY, () => {
        store = load();
        put();
    });
    void ws.chart.ready().then(put);
}
