// Stock prices for the playground: NSE (India) and US-listed stocks. Prices come from Yahoo
// Finance's public chart API; the symbol lists from NSE and Nasdaq Trader. None of these
// hosts lets a browser page call them directly, so the dev server relays every request
// (`server.proxy` in vite.config.ts) — this only works under `npm run playground`.
// Free, unofficial sources: prices can be delayed, and the API can change without notice.
import type { BarRange, DataProvider, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../src';
import type { OHLCV } from '../src/core/model/ohlcv';
import { timeframeToMs } from '../src/data/timeframe';
import { DataUnavailableError } from '../src/plugin';

const DAY = 86_400_000;

/** Vela timeframe → Yahoo interval, and how far back Yahoo serves it. */
const INTERVALS: Record<string, { interval: string; maxAgeMs: number }> = {
    '1': { interval: '1m', maxAgeMs: 29 * DAY },
    '2': { interval: '2m', maxAgeMs: 59 * DAY },
    '5': { interval: '5m', maxAgeMs: 59 * DAY },
    '15': { interval: '15m', maxAgeMs: 59 * DAY },
    '30': { interval: '30m', maxAgeMs: 59 * DAY },
    '60': { interval: '60m', maxAgeMs: 729 * DAY },
    D: { interval: '1d', maxAgeMs: Infinity },
    W: { interval: '1wk', maxAgeMs: Infinity },
    M: { interval: '1mo', maxAgeMs: Infinity },
};
const TIMEFRAMES = Object.keys(INTERVALS);

interface Market {
    name: string;
    displayName: string;
    timezone: string;
    session: string;
    yahooTicker: (ticker: string) => string;
    list: () => Promise<SymbolDescriptor[]>;
}

/** GET with one retry on a network error or a server error. */
async function get(url: string): Promise<Response> {
    try {
        const res = await fetch(url);
        if (res.status < 500) return res;
    } catch {
        /* retried below */
    }
    await new Promise((r) => setTimeout(r, 1000));
    return fetch(url);
}

async function getText(url: string): Promise<string> {
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
}

/** A symbol list, kept in the browser for a day: the list sites refuse callers that download
 *  them on every page load. A failed download falls back to the last copy kept. */
async function getList(url: string): Promise<string> {
    const cache = await caches.open('vela-play-symbol-lists');
    const kept = await cache.match(url);
    if (kept && Date.now() - Number(kept.headers.get('x-saved-at')) < DAY) return kept.text();
    try {
        const text = await getText(url);
        await cache.put(url, new Response(text, { headers: { 'x-saved-at': String(Date.now()) } }));
        return text;
    } catch (e) {
        if (kept) return kept.text();
        throw e;
    }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** Days since 1970-01-01 on the market's own calendar. */
function marketDay(t: number, timezone: string): number {
    let f = dayFormats.get(timezone);
    if (!f) dayFormats.set(timezone, (f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }))); // en-CA formats as YYYY-MM-DD
    return Date.parse(f.format(t)) / DAY;
}

/** The period a bar time falls in: same key = same candle. */
function periodKey(t: number, tf: string, timezone: string): number {
    const day = marketDay(t, timezone);
    if (tf === 'D') return day;
    if (tf === 'W') return Math.floor((day + 3) / 7); // weeks start on Monday (1970-01-01 was a Thursday)
    const d = new Date(day * DAY);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Yahoo rows → sorted bars. Yahoo appends the live price as an extra, off-grid point; it is folded
 *  into the candle it belongs to (high/low/close only: that candle's volume already counts it). */
export function toBars(ts: readonly number[], q: YahooQuote, tf: string, timezone: string): OHLCV[] {
    const barMs = timeframeToMs(tf);
    const bars: OHLCV[] = [];
    ts.forEach((s, i) => {
        const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
        if (o == null || h == null || l == null || c == null) return;
        let time = s * 1000;
        const prev = bars[bars.length - 1];
        if (prev) {
            if (time <= prev.time) return;
            const same = barMs < DAY ? time < prev.time + barMs : periodKey(time, tf, timezone) === periodKey(prev.time, tf, timezone);
            if (same) {
                prev.high = Math.max(prev.high, h);
                prev.low = Math.min(prev.low, l);
                prev.close = c;
                return;
            }
            if (barMs < DAY) time = prev.time + Math.floor((time - prev.time) / barMs) * barMs; // onto the bar grid
        }
        bars.push({ time, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
    });
    return bars;
}

interface YahooQuote {
    open: (number | null)[];
    high: (number | null)[];
    low: (number | null)[];
    close: (number | null)[];
    volume: (number | null)[];
}
interface YahooChart {
    chart: { result: { timestamp?: number[]; indicators: { quote: YahooQuote[] } }[] | null };
}

class YahooStocks implements DataProvider {
    private readonly names = new Map<string, string>();

    constructor(private readonly m: Market) {}

    info(): ProviderInfo {
        return {
            name: this.m.name,
            displayName: this.m.displayName,
            requiresApiKey: false,
            supportedTimeframes: TIMEFRAMES,
            capabilities: { enumerate: true, stream: false, symbolInfo: true },
        };
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        const list = await this.m.list();
        for (const s of list) this.names.set(s.ticker, s.description ?? s.ticker);
        return list;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo> {
        return {
            ticker,
            description: this.names.get(ticker) ?? ticker,
            timezone: this.m.timezone,
            session: this.m.session,
            timeframes: { finest: '1', default: 'D', list: TIMEFRAMES },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const tf = timeframe.replace(/^1(?=[DWM]$)/, '');
        const spec = INTERVALS[tf];
        if (!spec) throw new DataUnavailableError({ reason: 'timeframe', symbol: ticker, timeframe, finest: '1', default: 'D' });
        const now = Date.now();
        const to = Math.min(range.to ?? now, now);
        const barMs = timeframeToMs(tf);
        // shortcut: markets shut nights and weekends, so N intraday bars span ~5x their length; raise it if the first screen comes up short.
        let from = range.from ?? to - (range.limit ?? 500) * barMs * (barMs < DAY ? 5 : 1.5);
        from = Math.max(from, now - spec.maxAgeMs, tf === '1' ? to - 7 * DAY : -Infinity); // Yahoo's lookback; 1m also caps one request at 7 days
        if (from >= to) return [];

        const url =
            `/proxy/yahoo/v8/finance/chart/${encodeURIComponent(this.m.yahooTicker(ticker))}` +
            `?interval=${spec.interval}&period1=${Math.floor(from / 1000)}&period2=${Math.ceil(to / 1000)}`;
        const res = await get(url);
        if (res.status === 404 || res.status === 422) return []; // unknown symbol, or a window Yahoo has no data for
        if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
        const result = ((await res.json()) as YahooChart).chart.result?.[0];
        const quote = result?.indicators.quote[0];
        if (!result?.timestamp || !quote) return [];
        const bars = toBars(result.timestamp, quote, tf, this.m.timezone);
        return range.from === undefined && range.limit ? bars.slice(-range.limit) : bars;
    }
}

/** One data line per row of a `|`/`,`-separated list, header and footer dropped. */
const rows = (text: string, sep: string): string[][] =>
    text
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(sep))
        .filter((c) => c.length > 2 && !c[0]!.startsWith('File Creation Time'));

export const nseStocks = (): DataProvider =>
    new YahooStocks({
        name: 'nse',
        displayName: 'NSE',
        timezone: 'Asia/Kolkata',
        session: '0915-1530',
        yahooTicker: (t) => `${t}.NS`,
        list: async () => rows(await getList('/proxy/nse/content/equities/EQUITY_L.csv'), ',').map(([t, name]) => ({ ticker: t!, description: name, type: 'stock' })),
    });

const US_EXCHANGES: Record<string, string> = { N: 'NYSE', A: 'AMEX', P: 'NYSEARCA', Z: 'BATS', V: 'IEXG' };

export const usStocks = (): DataProvider =>
    new YahooStocks({
        name: 'us',
        displayName: 'US stocks',
        timezone: 'America/New_York',
        session: '0930-1600',
        yahooTicker: (t) => t.replace(/\./g, '-'), // BRK.B is BRK-B on Yahoo
        list: async () => {
            const [nasdaq, other] = await Promise.all([getList('/proxy/nasdaq/dynamic/SymDir/nasdaqlisted.txt'), getList('/proxy/nasdaq/dynamic/SymDir/otherlisted.txt')]);
            const ok = (t: string | undefined, test: string | undefined): t is string => !!t && test !== 'Y' && !/[$ ]/.test(t); // no test issues or preferred shares
            return [
                ...rows(nasdaq, '|').flatMap(([t, name, , test, , , etf]) => (ok(t, test) ? [{ ticker: t, description: name, type: etf === 'Y' ? 'fund' : 'stock', prefix: 'NASDAQ' }] : [])),
                ...rows(other, '|').flatMap(([t, name, ex, , etf, , test]) =>
                    ok(t, test) ? [{ ticker: t, description: name, type: etf === 'Y' ? 'fund' : 'stock', prefix: US_EXCHANGES[ex ?? ''] ?? 'US' }] : [],
                ),
            ];
        },
    });
