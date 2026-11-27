// Price alerts: the bell on a horizontal line arms an alert at the line's price. When the price
// crosses it: a notice on the chart, an alarm sound and a desktop notification. Alerts are saved
// (saved.ts) and shared by the playground pages; each page checks all of them in the background,
// on screen or not, and its Price alerts panel lists them. Moving the line moves its alert;
// deleting the line deletes it.
import { registerDrawingAction, registerSidePanel } from '../src/plugin';
import { createButton } from '../src/ui';
import type { VelaWorkspace } from '../src/workspace';
import { toast } from '@luxalgo/vela-ui/toast';
import { getSaved, onSavedChange, setSaved } from './saved';
import { CSS, fmtPrice } from './watchlist';

/** `id` is the horizontal line's drawing id in chart cell `cell` of page `page` (each chart
 *  numbers its own drawings). `price` is the line's last known price: the level wherever the
 *  line itself isn't (another page, a cell the layout put away). */
interface Alert {
    id: string;
    symbol: string;
    page: string;
    cell: string;
    price?: number;
}
const PAGE = location.pathname;

const KEY = 'vela-play:alerts';
// shortcut: prices are checked every 5 s, so a spike that crosses and returns within 5 s is missed; follow live bars to catch those.
const CHECK_MS = 5000;

let alerts = load();
// Another page changed the alerts: take its list, keeping each kept alert's last checked price.
onSavedChange(KEY, () => {
    const id = (a: Alert): string => `${a.page}|${a.cell}|${a.id}`;
    const before = new Map(alerts.map((a) => [id(a), lastPrice.get(a)]));
    alerts = load();
    lastPrice.clear();
    for (const a of alerts) {
        const p = before.get(id(a));
        if (p !== undefined) lastPrice.set(a, p);
    }
    notify();
});
function load(): Alert[] {
    try {
        const v: unknown = JSON.parse(getSaved(KEY) ?? '[]');
        if (!Array.isArray(v)) return [];
        return (v.filter((a: Partial<Alert>) => typeof a?.id === 'string' && typeof a.symbol === 'string') as Partial<Alert>[]).map((a) => ({
            ...(a as Alert),
            page: a.page ?? '/widget.html', // alerts saved before they had a page all came from the one-chart page
            cell: a.cell ?? 'c1',
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
const find = (cell: string, id: string): Alert | undefined => alerts.find((a) => a.page === PAGE && a.cell === cell && a.id === id);
const levelOf = (a: Alert): number | undefined =>
    (a.page === PAGE ? ws?.cell(a.cell)?.chart.drawings.all().find((d) => d.id === a.id)?.anchors[0]?.price : undefined) ?? a.price;

function cancel(a: Alert): void {
    alerts = alerts.filter((x) => x !== a);
    lastPrice.delete(a);
    changed();
}

// ── Sound ──
let audio: AudioContext | undefined;
// Browsers keep sound off until the page is clicked: after a reload, the first click anywhere turns it on.
addEventListener(
    'pointerdown',
    () => {
        audio ??= new AudioContext();
        void audio.resume();
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
            if (!prices.has(a.symbol)) prices.set(a.symbol, priceOf(a.symbol).catch(() => undefined));
            const [level, now] = [levelOf(a), await prices.get(a.symbol)];
            if (level !== a.price) [a.price, moved] = [level, true]; // the line moved: keep the level for the other pages
            if (level === undefined || now === undefined) continue;
            const before = lastPrice.get(a);
            lastPrice.set(a, now);
            if (before !== undefined && before < level !== now < level) trigger(a, level, now);
        }
        if (moved) changed();
        else notify();
    } finally {
        checking = false;
    }
}

function trigger(a: Alert, level: number, now: number): void {
    const text = `${a.symbol} crossed ${now > level ? 'above' : 'below'} ${fmtPrice(level)} (now ${fmtPrice(now)})`;
    ws?.toast(text, 'success', 15_000);
    alarm();
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Vela price alert', { body: text });
    cancel(a);
}

/** Call once the workspace exists: re-arms the saved alerts and starts checking. */
export function startAlerts(workspace: VelaWorkspace): void {
    ws = workspace;
    // Every chart cell, and the ones a later layout switch adds.
    const watch = (cell: { id: string; chart: VelaWorkspace['chart'] }): void => {
        cell.chart.on('drawing:removed', ({ id }) => {
            const a = find(cell.id, id);
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
        const cell = ws?.cells().find((c) => c.chart === ctx.chart)?.id;
        if (!cell) return;
        const armed = find(cell, d.id);
        if (armed) {
            cancel(armed);
            ctx.toast('Price alert cancelled', 'info');
            return;
        }
        const at = d.anchors[0]?.price;
        if (at === undefined) return;
        // Asked on this click: browsers refuse the request from a price tick.
        const permission: Promise<NotificationPermission> = !('Notification' in window)
            ? Promise.resolve('denied')
            : Notification.permission === 'default'
              ? Notification.requestPermission()
              : Promise.resolve(Notification.permission);
        alerts.push({ id: d.id, symbol: ctx.symbol, page: PAGE, cell, price: at });
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
                open.append(
                    span('wl-sym', a.symbol),
                    span('wl-num', level === undefined ? '—' : fmtPrice(level)),
                    span('wl-desc', level === undefined ? `Open ${a.page} once to load its level` : now === undefined ? 'Waiting for the price…' : `Now ${fmtPrice(now)}`),
                    span('wl-chg', away === null ? '' : `${Number(away) >= 0 ? '+' : ''}${away}% away`),
                );
                open.addEventListener('click', () => ctx.setSymbol(a.symbol));
                const remove = createButton({
                    icon: 'close',
                    label: `Cancel the ${a.symbol} alert`,
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
