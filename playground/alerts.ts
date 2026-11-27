// Price alerts: the bell on a horizontal line arms an alert at the line's price. When the price
// crosses it: a notice on the chart, an alarm sound and a desktop notification. Alerts are saved
// (saved.ts) and checked in the background for every symbol, on screen or not; the Price alerts
// panel lists them. Moving the line moves its alert; deleting the line deletes it.
import { registerDrawingAction, registerIcon, registerSidePanel } from '../src/plugin';
import { createButton } from '../src/ui';
import type { VelaWorkspace } from '../src/workspace';
import { toast } from '@luxalgo/vela-ui/toast';
import { getSaved, setSaved } from './saved';
import { CSS, fmtPrice } from './watchlist';

/** `id` is the horizontal line's drawing id: the line holds the alert's price. */
interface Alert {
    id: string;
    symbol: string;
}

const KEY = 'vela-play:alerts';
// shortcut: prices are checked every 5 s, so a spike that crosses and returns within 5 s is missed; follow live bars to catch those.
const CHECK_MS = 5000;

let alerts = load();
function load(): Alert[] {
    try {
        const v: unknown = JSON.parse(getSaved(KEY) ?? '[]');
        return Array.isArray(v) ? (v.filter((a: Partial<Alert>) => typeof a?.id === 'string' && typeof a.symbol === 'string') as Alert[]) : [];
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
const lastPrice = new Map<string, number>(); // alert id → the price at the previous check
const levelOf = (id: string): number | undefined => ws?.chart.drawings.all().find((d) => d.id === id)?.anchors[0]?.price;

function cancel(id: string): void {
    alerts = alerts.filter((a) => a.id !== id);
    lastPrice.delete(id);
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
        for (const a of [...alerts]) {
            if (!prices.has(a.symbol)) prices.set(a.symbol, priceOf(a.symbol).catch(() => undefined));
            const [level, now] = [levelOf(a.id), await prices.get(a.symbol)];
            if (level === undefined || now === undefined) continue;
            const before = lastPrice.get(a.id);
            lastPrice.set(a.id, now);
            if (before !== undefined && before < level !== now < level) trigger(a, level, now);
        }
        notify();
    } finally {
        checking = false;
    }
}

function trigger(a: Alert, level: number, now: number): void {
    const text = `${a.symbol} crossed ${now > level ? 'above' : 'below'} ${fmtPrice(level)} (now ${fmtPrice(now)})`;
    ws?.toast(text, 'success', 15_000);
    alarm();
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Vela price alert', { body: text });
    cancel(a.id);
}

/** Call once the workspace exists: re-arms the saved alerts and starts checking. */
export function startAlerts(workspace: VelaWorkspace): void {
    ws = workspace;
    void workspace.chart.ready().then(() => {
        workspace.chart.on('drawing:removed', ({ id }) => {
            if (alerts.some((a) => a.id === id)) cancel(id);
        });
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
        if (alerts.some((a) => a.id === d.id)) {
            cancel(d.id);
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
        alerts.push({ id: d.id, symbol: ctx.symbol });
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

// ── The Price alerts panel ──
registerIcon(
    'price-alerts',
    '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.6 1.2M2.5 3.5l2-1.5M13.5 3.5l-2-1.5"/></svg>',
);

registerSidePanel({
    id: 'dev.alerts',
    title: 'Price alerts',
    icon: 'price-alerts',
    order: 6,
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
                const level = levelOf(a.id);
                const now = lastPrice.get(a.id);
                const row = document.createElement('div');
                row.className = 'wl-row';
                const open = document.createElement('button');
                open.className = 'wl-open';
                open.title = `Open ${a.symbol} on the chart`;
                const away = level !== undefined && now !== undefined ? ((level / now - 1) * 100).toFixed(2) : null;
                open.append(
                    span('wl-sym', a.symbol),
                    span('wl-num', level === undefined ? '—' : fmtPrice(level)),
                    span('wl-desc', now === undefined ? 'Waiting for the price…' : `Now ${fmtPrice(now)}`),
                    span('wl-chg', away === null ? '' : `${Number(away) >= 0 ? '+' : ''}${away}% away`),
                );
                open.addEventListener('click', () => ctx.setSymbol(a.symbol));
                const remove = createButton({
                    icon: 'close',
                    label: `Cancel the ${a.symbol} alert`,
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'wl-remove',
                    onClick: () => cancel(a.id),
                });
                row.append(open, remove.el);
                list.append(row);
            }
        };
        listeners.add(render);
        return { onChart: render, onOpen: render, destroy: () => listeners.delete(render) };
    },
});
