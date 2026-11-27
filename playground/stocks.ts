// Stock prices for the playground: NSE (India) and US-listed stocks. US prices come from Alpaca
// when the dev server has Alpaca keys (vite.config.ts), else — and for NSE — from Yahoo Finance's
// public chart API; the symbol lists from NSE, Nasdaq Trader and Alpaca. None of these hosts lets
// a browser page call them directly, so the dev server relays every request (`server.proxy` in
// vite.config.ts; the Android app relays them itself, Alpaca's through the PC).
// Yahoo is free and unofficial: prices can be delayed, and the API can change without notice.
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
    /** The pre- and after-market hours around `session`, when the source serves them. */
    sessionExtended?: string;
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
 *  them on every page load. A failed download falls back to the last copy kept. `valid` tells a
 *  real list from what a site sends while it refuses (an error page, served as a success):
 *  such a page is neither kept nor used. `download: false` takes only a copy already kept, however old. */
async function getList(url: string, valid: (text: string) => boolean, download = true): Promise<string> {
    const cache = await caches.open('vela-play-symbol-lists');
    const kept = await cache.match(url);
    const keptText = kept ? await kept.text() : undefined;
    const good = keptText !== undefined && valid(keptText) ? keptText : undefined;
    if (good && (!download || Date.now() - Number(kept!.headers.get('x-saved-at')) < DAY)) return good;
    if (!download) throw new Error(`${url}: no copy kept`);
    try {
        const text = await getText(url);
        if (!valid(text)) throw new Error(`${url}: not a symbol list`);
        await cache.put(url, new Response(text, { headers: { 'x-saved-at': String(Date.now()) } }));
        return text;
    } catch (e) {
        if (good) return good;
        throw e;
    }
}
const listOf = (header: RegExp, min: number) => (text: string) => header.test(text) && text.split('\n').length > min;

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
        // A list that fails to load leaves every symbol of this market unresolvable until the page
        // reloads: try a few times before giving up.
        for (let attempt = 1; ; attempt++) {
            try {
                const list = await this.m.list();
                for (const s of list) this.names.set(s.ticker, s.description ?? s.ticker);
                return list;
            } catch (e) {
                if (attempt === 3) throw e;
                await new Promise((r) => setTimeout(r, 5000 * attempt));
            }
        }
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo> {
        return {
            ticker,
            description: this.names.get(ticker) ?? ticker,
            timezone: this.m.timezone,
            session: this.m.session,
            ...(this.m.sessionExtended ? { session_extended: this.m.sessionExtended } : {}),
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
            `?interval=${spec.interval}&period1=${Math.floor(from / 1000)}&period2=${Math.ceil(to / 1000)}` +
            (range.session === 'extended' && barMs < DAY ? '&includePrePost=true' : '');
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
        list: async () =>
            rows(await getList('/proxy/nse/content/equities/EQUITY_L.csv', listOf(/^SYMBOL,NAME OF COMPANY/, 500)), ',').map(([t, name]) => ({ ticker: t!, description: name, type: 'stock' })),
    });

const US_EXCHANGES: Record<string, string> = { N: 'NYSE', A: 'AMEX', P: 'NYSEARCA', Z: 'BATS', V: 'IEXG' };
/** Alpaca's exchange codes → the prefixes the Nasdaq lists give the same exchanges. */
const ALPACA_EXCHANGES: Record<string, string> = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', ARCA: 'NYSEARCA', AMEX: 'AMEX', BATS: 'BATS', OTC: 'OTC' };

async function nasdaqList(download: boolean): Promise<SymbolDescriptor[]> {
    const [nasdaq, other] = await Promise.all([
        getList('/proxy/nasdaq/dynamic/SymDir/nasdaqlisted.txt', listOf(/^Symbol\|Security Name\|/, 1000), download),
        getList('/proxy/nasdaq/dynamic/SymDir/otherlisted.txt', listOf(/^ACT Symbol\|Security Name\|/, 1000), download),
    ]);
    const ok = (t: string | undefined, test: string | undefined): t is string => !!t && test !== 'Y' && !/[$ ]/.test(t); // no test issues or preferred shares
    return [
        ...rows(nasdaq, '|').flatMap(([t, name, , test, , , etf]) => (ok(t, test) ? [{ ticker: t, description: name, type: etf === 'Y' ? 'fund' : 'stock', prefix: 'NASDAQ' }] : [])),
        ...rows(other, '|').flatMap(([t, name, ex, , etf, , test]) =>
            ok(t, test) ? [{ ticker: t, description: name, type: etf === 'Y' ? 'fund' : 'stock', prefix: US_EXCHANGES[ex ?? ''] ?? 'US' }] : [],
        ),
    ];
}

/** Alpaca's list of US assets (it also has the over-the-counter ones the Nasdaq lists leave out). */
async function alpacaList(): Promise<SymbolDescriptor[]> {
    const valid = (text: string): boolean => text.startsWith('[') && text.length > 100_000;
    const assets = JSON.parse(await getList('/proxy/alpaca-assets?status=active&asset_class=us_equity', valid)) as { symbol: string; name: string; exchange: string }[];
    return assets.flatMap((a) =>
        ALPACA_EXCHANGES[a.exchange] && !/[/ ]/.test(a.symbol)
            ? [{ ticker: a.symbol, description: a.name, type: /\b(ETF|ETN)\b/.test(a.name) ? 'fund' : 'stock', prefix: ALPACA_EXCHANGES[a.exchange] }]
            : [],
    );
}

// ── Alpaca prices ──
const ALPACA_TF: Record<string, string> = { '1': '1Min', '2': '2Min', '5': '5Min', '15': '15Min', '30': '30Min', '60': '1Hour', D: '1Day', W: '1Week', M: '1Month' };
/** The free plan serves the consolidated tape (every exchange) up to 15 minutes ago; after that
 *  only the IEX exchange's own trades, live. A minute of margin. */
const SIP_DELAY_MS = 16 * 60_000;
// shortcut: a fixed 09:30–16:00 day, so on early-close days (13:00) the after-hours trades count as regular; use the market calendar to fix that.
const REGULAR = [570, 960]; // 09:30–16:00, minutes into the New York day

/** A failure that means "Alpaca is not reachable from here": no keys, away from the PC, rate-limited. */
class AlpacaDown extends Error {}

const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
/** Minutes into the New York day. */
function nyMinutes(t: number): number {
    const [h, m] = nyClock.format(t).split(':').map(Number);
    return (h! % 24) * 60 + m!;
}

interface AlpacaBar {
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
}

// Pages ask the same thing often (the chart's live polls, alerts, the watchlist): one answer serves them for a few seconds.
const recent = new Map<string, { at: number; answer: Promise<unknown> }>();
async function alpacaGet<T>(url: string): Promise<T> {
    const hit = recent.get(url);
    if (hit && Date.now() - hit.at < 4000) return hit.answer as Promise<T>;
    const answer = (async () => {
        let res: Response;
        try {
            res = await fetch(url);
        } catch (e) {
            throw new AlpacaDown(String(e));
        }
        if (res.status === 422) return null; // a symbol Alpaca has no data for
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new AlpacaDown(`HTTP ${res.status}`);
        return res.json();
    })();
    recent.set(url, { at: Date.now(), answer });
    if (recent.size > 200) recent.delete(recent.keys().next().value!);
    answer.catch(() => recent.delete(url));
    return answer as Promise<T>;
}

async function alpacaBars(ticker: string, tf: string, from: number, to: number, feed: 'sip' | 'iex'): Promise<OHLCV[]> {
    const out: OHLCV[] = [];
    let page: string | undefined;
    for (let i = 0; i < 10; i++) {
        const url =
            `/proxy/alpaca-data/v2/stocks/${encodeURIComponent(ticker)}/bars?timeframe=${ALPACA_TF[tf]}` +
            `&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}&limit=10000&adjustment=split&feed=${feed}` +
            (page ? `&page_token=${encodeURIComponent(page)}` : '');
        const answer = await alpacaGet<{ bars: AlpacaBar[] | null; next_page_token?: string | null } | null>(url);
        for (const b of answer?.bars ?? []) out.push({ time: Date.parse(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
        page = answer?.next_page_token ?? undefined;
        if (!page) break;
    }
    return out;
}

/** Fold the live price into the last daily (weekly, monthly) bar: those come from the delayed tape. */
async function withLastTrade(ticker: string, bars: OHLCV[]): Promise<OHLCV[]> {
    const last = bars[bars.length - 1];
    if (!last) return bars;
    const answer = await alpacaGet<{ trade?: { p: number; t: string } } | null>(`/proxy/alpaca-data/v2/stocks/${encodeURIComponent(ticker)}/trades/latest?feed=iex`);
    const trade = answer?.trade;
    if (!trade || Date.parse(trade.t) < last.time) return bars;
    return [...bars.slice(0, -1), { ...last, close: trade.p, high: Math.max(last.high, trade.p), low: Math.min(last.low, trade.p) }];
}

/** US stocks: Alpaca when the dev server has keys (and, in the Android app, the PC is on the
 *  same Wi-Fi), Yahoo otherwise or whenever Alpaca fails. */
class UsStocks extends YahooStocks {
    private downUntil = 0;

    override async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const tf = timeframe.replace(/^1(?=[DWM]$)/, '');
        if (ALPACA_TF[tf] && Date.now() >= this.downUntil) {
            try {
                const bars = await this.fromAlpaca(ticker, tf, range);
                if (bars) return bars;
            } catch (e) {
                if (!(e instanceof AlpacaDown)) throw e;
                this.downUntil = Date.now() + 60_000; // try Alpaca again in a minute
            }
        }
        return super.getBars(ticker, timeframe, range);
    }

    /** The bars, or null when Alpaca has none for a long window (a symbol it doesn't carry: Yahoo may). */
    private async fromAlpaca(ticker: string, tf: string, range: BarRange): Promise<OHLCV[] | null> {
        const now = Date.now();
        const to = Math.min(range.to ?? now, now);
        const barMs = timeframeToMs(tf);
        const intraday = barMs < DAY;
        const from = range.from ?? to - (range.limit ?? 500) * barMs * (intraday ? 5 : 1.5);
        if (from >= to) return [];
        const sipEnd = now - SIP_DELAY_MS;
        const extended = range.session === 'extended';
        // Regular-session hours open at 09:30: build them from half hours, not Alpaca's clock-hour bars.
        const fetchTf = tf === '60' && !extended ? '30' : tf;
        let bars = [
            ...(from < sipEnd ? await alpacaBars(ticker, fetchTf, from, Math.min(to, sipEnd), 'sip') : []),
            ...(intraday && to > sipEnd ? await alpacaBars(ticker, fetchTf, Math.max(from, sipEnd), to, 'iex') : []),
        ];
        if (bars.length === 0 && to - from > 3 * DAY) return null;
        if (intraday && !extended) bars = bars.filter((b) => nyMinutes(b.time) >= REGULAR[0]! && nyMinutes(b.time) < REGULAR[1]!);
        if (fetchTf !== tf) bars = toHours(bars);
        if (!intraday) bars = await withLastTrade(ticker, bars);
        return range.from === undefined && range.limit ? bars.slice(-range.limit) : bars;
    }
}

/** Half-hour bars → hour bars that start at 09:30, 10:30, … (the last one, 15:30, is half an hour). */
function toHours(bars: OHLCV[]): OHLCV[] {
    const out: OHLCV[] = [];
    for (const b of bars) {
        const slot = Math.floor((nyMinutes(b.time) - REGULAR[0]!) / 60);
        const prev = out[out.length - 1];
        if (prev && b.time - prev.time < 60 * 60_000 && Math.floor((nyMinutes(prev.time) - REGULAR[0]!) / 60) === slot) {
            prev.high = Math.max(prev.high, b.high);
            prev.low = Math.min(prev.low, b.low);
            prev.close = b.close;
            prev.volume = (prev.volume ?? 0) + (b.volume ?? 0);
        } else out.push({ ...b });
    }
    return out;
}

export const usStocks = (): DataProvider =>
    new UsStocks({
        name: 'us',
        displayName: 'US stocks',
        timezone: 'America/New_York',
        session: '0930-1600',
        sessionExtended: '0400-2000',
        yahooTicker: (t) => t.replace(/\./g, '-'), // BRK.B is BRK-B on Yahoo
        list: async () => {
            // Alpaca's list when there are keys; Nasdaq's adds its exact ETF flags from a copy already
            // kept, and is downloaded only without Alpaca: the Nasdaq site blocks frequent callers.
            const alpaca = await alpacaList().catch(() => []);
            const nasdaq = await nasdaqList(alpaca.length === 0).catch(() => []);
            if (nasdaq.length === 0 && alpaca.length === 0) throw new Error('No US symbol list could be loaded');
            const known = new Set(nasdaq.map((d) => d.ticker));
            return [...nasdaq, ...alpaca.filter((d) => !known.has(d.ticker))];
        },
    });
