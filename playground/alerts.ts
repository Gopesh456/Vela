// Price alerts: the bell on a horizontal line arms an alert at the line's price. When the price
// crosses it: a notice on the chart, an alarm sound and a desktop notification. Alerts are saved
// (saved.ts) and shared by every page and device: the PC's pages and the Android app all check
// them in the background, on screen or not, and an alert that fires on one device notifies on
// all of them (the app notifies through Android itself, even while it is closed). Moving the line
// moves its alert; deleting the line deletes it. A fired alert stays listed until you remove it.
import { registerDrawingAction, registerSidePanel } from '../src/plugin';
import { createButton } from '../src/ui';
import type { VelaWorkspace } from '../src/workspace';
import { toast } from '@luxalgo/vela-ui/toast';
import { getSaved, onSavedChange, setSaved } from './saved';
import { symbolKey } from './symbol-charts';
import { CSS, fmtPrice } from './watchlist';

/** An alert on the horizontal line `id` among `symbol`'s lines (symbol-charts.ts). `price` is the
 *  line's last known price, the level wherever the line itself isn't on screen; `provider` and
 *  `ticker` name the price source, for the Android app's own checks. */
interface Alert {
    uid: string;
    id: string;
    symbol: string;
    price?: number;
    provider?: string;
    ticker?: string;
    triggered?: { at: number; price: number; level: number; by: string };
}

const KEY = 'vela-play:alerts';
const NOTIFIED = 'vela-play:notified-alerts'; // this device's own list: the fired alerts it has already announced
// shortcut: prices are checked every 5 s, so a spike that crosses and returns within 5 s is missed; follow live bars to catch those.
const CHECK_MS = 5000;
/** In the Android app, Android checks the alerts and notifies, also while the app is closed. */
const inApp = 'VelaNative' in globalThis;
const DEVICE = inApp ? 'Android' : 'PC';

let alerts = load();
// Another page or device changed the alerts: take the merged list, keeping each kept alert's last checked price.
onSavedChange(KEY, () => {
    const before = new Map(alerts.map((a) => [a.uid, lastPrice.get(a)]));
    alerts = load();
    lastPrice.clear();
    for (const a of alerts) {
        const p = before.get(a.uid);
        if (p !== undefined) lastPrice.set(a, p);
    }
    announceFired();
    notify();
});
function load(): Alert[] {
    try {
        const v: unknown = JSON.parse(getSaved(KEY) ?? '[]');
        if (!Array.isArray(v)) return [];
        return (v.filter((a: Partial<Alert>) => typeof a?.id === 'string' && typeof a.symbol === 'string') as Alert[]).map((a) => ({
            ...a,
            uid: a.uid ?? `${a.symbol}|${a.id}`, // alerts saved before uids: the id saved.ts gives them too
        }));
    } catch {
        return [];
    }
}

const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());
function changed(): void {
    setSaved(KEY, JSON.stringify(alerts));
    notify();
}

let ws: VelaWorkspace | null = null;
const lastPrice = new Map<Alert, number>(); // the price at the previous check
/** The alert's symbol as symbol-charts.ts names it: the key its lines are saved under. */
const keyOf = (a: Alert): string | undefined => (a.provider && a.ticker ? `${a.provider}:${a.ticker}` : undefined);
/** The alert's line, on whichever chart on screen shows its symbol. */
const lineOf = (a: Alert) => {
    for (const cell of ws?.cells() ?? []) {
        if (keyOf(a) !== symbolKey(cell.chart, cell.chart.market.symbol ?? '')) continue;
        const d = cell.chart.drawings.all().find((x) => x.id === a.id);
        if (d) return d;
    }
    return undefined;
};
const levelOf = (a: Alert): number | undefined => lineOf(a)?.anchors[0]?.price ?? a.price;

function cancel(a: Alert): void {
    alerts = alerts.filter((x) => x !== a);
    lastPrice.delete(a);
    changed();
}

// ── Sound ──
let audio: AudioContext | undefined;
// Browsers keep sound off until the page is clicked: after a reload, the first click anywhere turns it on.
// They also ask for desktop notifications only on a click, and alerts set on another device never
// pass through this page's bell: the first click asks, so those alerts notify here too.
addEventListener(
    'pointerdown',
    () => {
        audio ??= new AudioContext();
        void audio.resume();
        if (!inApp && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission().then(notify);
    },
    { capture: true },
);

/** A harsh two-tone siren for about 2.5 s: hard to mistake for an ordinary notification sound. */
function alarm(): void {
    if (!audio) return;
    for (let i = 0; i < 14; i++) {
        const t = audio.currentTime + i * 0.18;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'square';
        osc.frequency.value = i % 2 ? 740 : 988;
        gain.gain.setValueAtTime(0.12, t); // square waves are loud: keep the level modest
        gain.gain.setValueAtTime(0, t + 0.15); // a short gap between tones makes it pulse
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.17);
    }
}

// ── Checking ──
async function priceOf(symbol: string): Promise<number | undefined> {
    const chart = ws?.chart;
    const r = chart?.data.resolve(symbol);
    const provider = r && chart?.data.providerInstance(r.provider);
    if (!r || !provider) return undefined;
    const bars = await provider.getBars(r.ticker, 'D', { limit: 2 });
    return bars[bars.length - 1]?.close;
}

let checking = false;
async function check(): Promise<void> {
    if (checking || alerts.length === 0) return;
    checking = true;
    try {
        const prices = new Map<string, Promise<number | undefined>>(); // one fetch per symbol
        let moved = false;
        for (const a of [...alerts]) {
            if (!a.provider && ws) {
                const r = ws.chart.data.resolve(a.symbol);
                if (r) [a.provider, a.ticker, moved] = [r.provider, r.ticker, true]; // older alerts: name the price source
            }
            if (a.triggered) continue;
            if (!prices.has(a.symbol)) prices.set(a.symbol, priceOf(a.symbol).catch(() => undefined));
            const [level, now] = [levelOf(a), await prices.get(a.symbol)];
            if (level !== a.price) [a.price, moved] = [level, true]; // the line moved: keep the level for the other devices
            if (level === undefined || now === undefined) continue;
            const before = lastPrice.get(a);
            lastPrice.set(a, now);
            // In the app, Android itself fires the alerts (android/), so they come once.
            if (!inApp && before !== undefined && before < level !== now < level) {
                a.triggered = { at: Date.now(), price: now, level, by: DEVICE };
                moved = true;
            }
        }
        if (moved) changed();
        else notify();
        announceFired();
    } finally {
        checking = false;
    }
}

/** Announce the fired alerts this device hasn't announced yet, wherever they fired. */
function announceFired(): void {
    if (inApp) return; // the app's notifications come from Android
    const done = new Set<string>(JSON.parse(localStorage.getItem(NOTIFIED) ?? '[]') as string[]);
    const fresh = alerts.filter((a) => a.triggered && !done.has(a.uid));
    if (fresh.length === 0) return;
    for (const a of fresh) {
        done.add(a.uid);
        const t = a.triggered!;
        if (Date.now() - t.at > 86_400_000) continue; // a day late: listed as fired, without the alarm
        const where = t.by === DEVICE ? '' : ` (on ${t.by} at ${new Date(t.at).toLocaleTimeString()})`;
        const text = `${a.symbol} crossed ${t.price > t.level ? 'above' : 'below'} ${fmtPrice(t.level)} (now ${fmtPrice(t.price)})${where}`;
        ws?.toast(text, 'success', 15_000);
        alarm();
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Vela price alert', { body: text });
    }
    localStorage.setItem(NOTIFIED, JSON.stringify([...done].slice(-500)));
}

/** Call once the workspace exists: re-arms the saved alerts and starts checking. */
export function startAlerts(workspace: VelaWorkspace): void {
    ws = workspace;
    // Every chart cell, and the ones a later layout switch adds: deleting a line deletes its alert.
    const watch = (cell: { id: string; chart: VelaWorkspace['chart'] }): void => {
        cell.chart.on('drawing:removed', ({ id }) => {
            const key = symbolKey(cell.chart, cell.chart.market.symbol ?? '');
            const a = alerts.find((x) => x.id === id && keyOf(x) === key);
            if (a) cancel(a);
        });
    };
    workspace.cells().forEach(watch);
    workspace.on('cell:created', ({ id }) => {
        const cell = workspace.cell(id);
        if (cell) watch(cell);
    });
    void workspace.chart.ready().then(() => {
        void check();
        setInterval(() => void check(), CHECK_MS);
    });
}

// ── The bell on horizontal lines ──
registerDrawingAction({
    id: 'dev.price-alert',
    icon: 'bell',
    label: 'Price alert (click again to cancel)',
    when: (d) => d.type === 'hline',
    run: (ctx, d) => {
        const r = ctx.chart.data.resolve(ctx.symbol);
        if (!r) return;
        const armed = alerts.find((a) => a.id === d.id && keyOf(a) === `${r.provider}:${r.ticker}`);
        if (armed && !armed.triggered) {
            cancel(armed);
            ctx.toast('Price alert cancelled', 'info');
            return;
        }
        const at = d.anchors[0]?.price;
        if (at === undefined) return;
        // Asked on this click: browsers refuse the request from a price tick.
        const permission: Promise<NotificationPermission> = !('Notification' in window)
            ? Promise.resolve(inApp ? 'granted' : 'denied') // the app notifies through Android
            : Notification.permission === 'default'
              ? Notification.requestPermission()
              : Promise.resolve(Notification.permission);
        if (armed) cancel(armed); // a fired alert on this line: arm it again
        alerts.push({ uid: crypto.randomUUID(), id: d.id, symbol: ctx.symbol, price: at, provider: r.provider, ticker: r.ticker });
        changed();
        void check(); // record the starting price now
        // Say so when the desktop notification can't come: the browser blocks it without telling anyone.
        void permission.then((p) =>
            p === 'granted'
                ? ctx.toast(`Price alert set at ${fmtPrice(at)}`, 'success')
                : toast.info(`Price alert set at ${fmtPrice(at)}`, {
                      description: 'Desktop notifications are blocked in this browser, so the alert will only sound and show on the chart.',
                      duration: 8000,
                  }),
        );
    },
});

// ── The Price alerts panel: the topbar bell (the pages leave out the built-in one, see topbar.ts) ──
registerSidePanel({
    id: 'dev.alerts',
    title: 'Price alerts',
    icon: 'bell',
    order: 4, // first of the panel buttons: where the built-in bell was
    width: 290,
    resizable: true,
    mount: (ctx, body) => {
        const style = document.createElement('style');
        style.textContent = CSS;
        const list = document.createElement('div');
        list.className = 'wl-list';
        body.append(style, list);
        const span = (cls: string, text: string, color?: string): HTMLSpanElement => {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            if (color) s.style.color = color;
            return s;
        };

        const render = (): void => {
            list.replaceChildren();
            const allowed = inApp || ('Notification' in window && Notification.permission === 'granted');
            if (!allowed) {
                list.append(
                    span(
                        'wl-empty',
                        'Desktop notifications are off for this page, so alerts only ring while it is open. Allow notifications for this site in the browser to get them.',
                        'var(--vela-warning, #f0b90b)',
                    ),
                );
            }
            if (alerts.length === 0) {
                const empty = span('wl-empty', 'No price alerts. Draw a horizontal line, select it, and press its bell.');
                list.append(empty);
                return;
            }
            for (const a of alerts) {
                const level = levelOf(a);
                const now = lastPrice.get(a);
                const row = document.createElement('div');
                row.className = 'wl-row';
                const open = document.createElement('button');
                open.className = 'wl-open';
                open.title = `Open ${a.symbol} on the chart`;
                const away = level !== undefined && now !== undefined ? ((level / now - 1) * 100).toFixed(2) : null;
                const fired = a.triggered;
                open.append(
                    span('wl-sym', a.symbol),
                    span('wl-num', level === undefined ? '—' : fmtPrice(level)),
                    span(
                        'wl-desc',
                        fired
                            ? `Fired ${new Date(fired.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} on ${fired.by}`
                            : level === undefined
                              ? 'Level not synced yet'
                              : now === undefined
                                ? 'Waiting for the price…'
                                : `Now ${fmtPrice(now)}`,
                    ),
                    fired
                        ? span('wl-chg', `at ${fmtPrice(fired.price)}`, 'var(--vela-accent)')
                        : span('wl-chg', away === null ? '' : `${Number(away) >= 0 ? '+' : ''}${away}% away`),
                );
                open.addEventListener('click', () => ctx.setSymbol(a.symbol));
                const remove = createButton({
                    icon: 'close',
                    label: a.triggered ? `Remove the fired ${a.symbol} alert` : `Cancel the ${a.symbol} alert`,
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'wl-remove',
                    onClick: () => cancel(a),
                });
                row.append(open, remove.el);
                list.append(row);
            }
        };
        listeners.add(render);
        return { onChart: render, onOpen: render, destroy: () => listeners.delete(render) };
    },
});
