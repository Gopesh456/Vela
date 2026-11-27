// Watchlist: a side panel of symbols with their last price and today's change, fetched through
// the chart's own data sources (crypto and stocks alike). Click a row to open that symbol;
// + adds the chart's symbol; × removes a row. Saved with the rest (saved.ts).
import { registerSidePanel, type WidgetContext } from '../src/plugin';
import { createButton } from '../src/ui';
import { getSaved, setSaved } from './saved';

const KEY = 'vela-play:watchlist';
const DEFAULTS = ['BTCUSDT', 'ETHUSDT', 'RELIANCE', 'NASDAQ:AAPL'];
const REFRESH_MS = 15_000;

let symbols = load();
function load(): string[] {
    try {
        const v: unknown = JSON.parse(getSaved(KEY) ?? 'null');
        return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [...DEFAULTS];
    } catch {
        return [...DEFAULTS];
    }
}
const save = (): void => setSaved(KEY, JSON.stringify(symbols));

/** The last price, and its change in percent from the previous daily close. */
interface Quote {
    last: number;
    change: number;
}

/** A quote; null when the source has none; undefined while no source knows the symbol yet
 *  (a provider's symbol list can still be loading). */
async function fetchQuote(ctx: WidgetContext, symbol: string): Promise<Quote | null | undefined> {
    const r = ctx.chart.data.resolve(symbol);
    const provider = r && ctx.chart.data.providerInstance(r.provider);
    if (!r || !provider) return undefined;
    const bars = await provider.getBars(r.ticker, 'D', { limit: 5 }); // a few days, so a weekend still leaves a previous close
    const [prev, last] = bars.slice(-2);
    if (!last) return null;
    return { last: last.close, change: prev ? (last.close / prev.close - 1) * 100 : 0 };
}

export const fmtPrice = (n: number): string => n.toLocaleString(undefined, { minimumFractionDigits: n < 1 ? 6 : 2, maximumFractionDigits: n < 1 ? 6 : 2 });

export const CSS = `
.wl-list { display: grid; font-size: var(--vela-font-size-md); }
.wl-empty { padding: 16px 12px; color: var(--vela-fg-muted); line-height: 1.5; }
.wl-row { display: grid; grid-template-columns: 1fr auto; align-items: center; border-bottom: 1px solid var(--vela-border-soft); }
.wl-row[data-current] { background: var(--vela-hover); }
.wl-open { all: unset; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 7px 4px 7px 12px; cursor: pointer; min-width: 0; }
.wl-open:hover { background: var(--vela-hover); }
.wl-open:focus-visible { outline: 2px solid var(--vela-accent); outline-offset: -2px; }
.wl-sym { color: var(--vela-fg-bright); font-weight: 600; }
.wl-desc { color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--vela-fg); }
.wl-chg { text-align: right; font-variant-numeric: tabular-nums; font-size: var(--vela-font-size-sm); }
.wl-row .wl-remove { margin-right: 6px; opacity: 0; }
.wl-row:hover .wl-remove, .wl-row .wl-remove:focus-visible { opacity: 1; }
`;

registerSidePanel({
    id: 'dev.watchlist',
    title: 'Watchlist',
    icon: 'star',
    order: 5,
    width: 290,
    resizable: true,
    mount: (ctx, body, header) => {
        const quotes = new Map<string, Quote | null | undefined>();
        const descriptions = new Map<string, string>();
        const key = (s: string): string => ctx.chart.data.canonicalSymbol(s) ?? s; // NASDAQ:AAPL and AAPL are one symbol

        const style = document.createElement('style');
        style.textContent = CSS;
        const list = document.createElement('div');
        list.className = 'wl-list';
        body.append(style, list);

        const addCurrent = createButton({
            icon: 'plus',
            label: 'Add the chart symbol to the watchlist',
            variant: 'ghost',
            size: 'icon-xs',
            onClick: () => {
                const s = ctx.symbol;
                if (symbols.some((x) => key(x) === key(s))) return ctx.toast(`${s} is already in the watchlist`, 'info');
                symbols.push(s);
                save();
                render();
                void refresh([s]);
            },
        });
        header.slot.append(addCurrent.el);

        const describe = (s: string): { ticker: string; venue: string; name: string } => {
            const r = ctx.chart.data.resolve(s);
            const ticker = r?.ticker ?? s;
            if (r && !descriptions.has(s)) descriptions.set(s, ctx.chart.data.symbols(r.provider).find((d) => d.ticker === r.ticker)?.description ?? '');
            return { ticker, venue: (ctx.chart.data.displayPrefix(s) ?? '').toUpperCase(), name: descriptions.get(s) ?? '' };
        };

        function render(): void {
            list.replaceChildren();
            if (symbols.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'wl-empty';
                empty.textContent = 'Your watchlist is empty. Open a symbol on the chart, then press + above to add it.';
                list.append(empty);
                return;
            }
            const current = key(ctx.symbol);
            for (const s of symbols) {
                const { ticker, venue, name } = describe(s);
                const q = quotes.get(s);
                const row = document.createElement('div');
                row.className = 'wl-row';
                if (key(s) === current) row.dataset.current = '';

                const open = document.createElement('button');
                open.className = 'wl-open';
                open.title = `Open ${s} on the chart`;
                const cell = (cls: string, text: string, color?: string): HTMLSpanElement => {
                    const span = document.createElement('span');
                    span.className = cls;
                    span.textContent = text;
                    if (color) span.style.color = color;
                    return span;
                };
                open.append(
                    cell('wl-sym', ticker),
                    cell('wl-num', q ? fmtPrice(q.last) : q === null ? '—' : '…'),
                    cell('wl-desc', [venue, name].filter(Boolean).join(' · ')),
                    q ? cell('wl-chg', `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`, q.change >= 0 ? 'var(--vela-up)' : 'var(--vela-down)') : cell('wl-chg', ''),
                );
                open.addEventListener('click', () => ctx.setSymbol(s));

                const remove = createButton({
                    icon: 'close',
                    label: `Remove ${ticker} from the watchlist`,
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'wl-remove',
                    onClick: () => {
                        symbols = symbols.filter((x) => x !== s);
                        quotes.delete(s);
                        save();
                        render();
                    },
                });
                row.append(open, remove.el);
                list.append(row);
            }
        }

        // Quotes refresh while the panel is on screen; a failed fetch shows a dash, never an error.
        let hasChart = false;
        async function refresh(only = symbols): Promise<void> {
            if (!hasChart || !body.isConnected || body.offsetParent === null) return;
            await ctx.chart.data.ready();
            await Promise.all(
                only.map(async (s) => {
                    quotes.set(s, await fetchQuote(ctx, s).catch(() => null));
                }),
            );
            render();
            if (only.some((s) => quotes.get(s) === undefined)) setTimeout(() => void refresh(only), 2000); // symbol lists still loading
        }
        const timer = setInterval(() => void refresh(), REFRESH_MS);
        let offMarket = (): void => {};

        // The panel mounts while the workspace is still being built: everything that reads the chart starts here.
        return {
            onChart: () => {
                hasChart = true;
                offMarket();
                offMarket = ctx.chart.on('market:changed', render);
                render();
                void refresh();
            },
            onOpen: () => void refresh(),
            destroy: () => {
                clearInterval(timer);
                offMarket();
            },
        };
    },
});
