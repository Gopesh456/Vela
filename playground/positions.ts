// Buy / Sell: record a trade made in another app and follow it on the chart — a dashed line
// at the entry price, labelled with the live unrealised profit/loss (amount and percent).
// Positions are saved per symbol (saved.ts: a file the dev server keeps).
//
// Imported BEFORE the workspace is built: the renderer picks up layers when it mounts.
import { registerRendererLayer, registerWidgetAction, type WidgetContext } from '../src/plugin';
import { Dialog, createButton, createInput } from '../src/ui';
import { toast } from '@luxalgo/vela-ui/toast';
import { getSaved, setSaved } from './saved';
import type { VelaWorkspace } from '../src/workspace';

type Side = 'buy' | 'sell';
interface Position {
    id: string;
    symbol: string;
    side: Side;
    /** Price per share at entry. */
    price: number;
    /** Money put in; quantity = amount / price. */
    amount: number;
}

const KEY = 'vela-play:positions';
let positions: Position[] = load();
const lastPrices = new Map<string, number>(); // symbol → its latest close, from the layer's last frame
let symbolOf = (_canvas: HTMLCanvasElement): string | undefined => undefined;

function load(): Position[] {
    try {
        const raw: unknown = JSON.parse(getSaved(KEY) ?? '[]');
        if (!Array.isArray(raw)) return [];
        return raw.filter(
            (p: Partial<Position>) =>
                typeof p.id === 'string' && typeof p.symbol === 'string' && (p.side === 'buy' || p.side === 'sell') && Number(p.price) > 0 && Number(p.amount) > 0,
        ) as Position[];
    } catch {
        return [];
    }
}
const save = (): void => setSaved(KEY, JSON.stringify(positions));

/** Unrealised profit/loss at `price`: the amount, and the percent of the money put in. */
export function pnl(p: Pick<Position, 'side' | 'price' | 'amount'>, price: number): { value: number; pct: number } {
    const value = (p.amount / p.price) * (price - p.price) * (p.side === 'buy' ? 1 : -1);
    return { value, pct: (value / p.amount) * 100 };
}
console.assert(pnl({ side: 'buy', price: 100, amount: 1000 }, 110).value === 100 && pnl({ side: 'buy', price: 100, amount: 1000 }, 110).pct === 10, 'pnl buy');
console.assert(pnl({ side: 'sell', price: 100, amount: 1000 }, 110).value === -100, 'pnl sell');

/** Call once the workspace exists: each chart cell's layer paints the positions of that cell's symbol. */
export function bindPositions(ws: VelaWorkspace): void {
    symbolOf = (canvas) => ws.cells().find((c) => c.host.contains(canvas))?.chart.market.symbol;
}

const fmt = (n: number, digits = 2): string => n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPrice = (n: number): string => fmt(n, n < 1 ? 6 : 2);
const signed = (n: number): string => (n >= 0 ? '+' : '') + fmt(n);
const title = (p: Position): string => `${p.side.toUpperCase()} ${fmt(p.amount / p.price, 4)} @ ${fmtPrice(p.price)}`;

/** Delete a position, with an Undo on the notice. */
function removePosition(id: string): void {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    positions = positions.filter((x) => x.id !== id);
    save();
    toast('Position removed', {
        description: `${title(p)} · ${p.symbol}`,
        duration: 8000, // time to reach Undo
        action: {
            label: 'Undo',
            onClick: () => {
                positions.push(p);
                save();
            },
        },
    });
}

const CLOSE_W = 20;

registerRendererLayer({
    id: 'dev.positions',
    placement: 'above-data',
    repaintOnCursor: true, // a new or removed position shows on the next pointer move, even with no live ticks
    create: () => {
        let canvas: HTMLCanvasElement | null = null;
        let clicks: HTMLElement | null = null;
        /** The × on each label, in plot coordinates (CSS px), from the last frame. */
        let closeBoxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
        // A press on a label's × deletes that position. Caught on the way down, before the chart
        // reads it as a pan or a drawing click (this canvas itself lets pointer events through).
        const onPress = (e: PointerEvent): void => {
            if (e.button !== 0 || !canvas) return;
            const r = canvas.getBoundingClientRect();
            const [x, y] = [e.clientX - r.left, e.clientY - r.top];
            const hit = closeBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
            if (!hit) return;
            e.stopPropagation();
            e.preventDefault();
            removePosition(hit.id);
        };
        return {
            mount: (c) => {
                canvas = c;
            },
            destroy: () => clicks?.removeEventListener('pointerdown', onPress, true),
            render: ({ bars, coords, scale, bounds, theme, cursor }) => {
                const g = canvas?.getContext('2d');
                if (!canvas || !g) return;
                if (!clicks && canvas.parentElement) {
                    clicks = canvas.parentElement;
                    clicks.addEventListener('pointerdown', onPress, true);
                }
                const dpr = coords.dpr;
                g.setTransform(dpr, 0, 0, dpr, 0, 0);
                g.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
                closeBoxes = [];
                const symbol = symbolOf(canvas);
                const lastPrice = bars[bars.length - 1]?.close;
                if (lastPrice === undefined || !symbol) return;
                lastPrices.set(symbol, lastPrice);
                g.font = `600 11px ${theme.fontFamily}`;
                g.textBaseline = 'middle';
                for (const p of positions) {
                    if (p.symbol !== symbol) continue;
                    const y = Math.round(coords.priceToY(p.price, scale, bounds)) + 0.5;
                    g.strokeStyle = p.side === 'buy' ? theme.upColor : theme.downColor;
                    g.lineWidth = 1;
                    g.setLineDash([6, 4]);
                    g.beginPath();
                    g.moveTo(0, y);
                    g.lineTo(coords.width, y);
                    g.stroke();
                    g.setLineDash([]);
                    const r = pnl(p, lastPrice);
                    const text = `${title(p)}   P&L ${signed(r.value)} (${signed(r.pct)}%)`;
                    const ly = Math.min(Math.max(y, 11), coords.height - 11); // keep the label on screen when the entry is scrolled off
                    const w = g.measureText(text).width + 14;
                    g.fillStyle = r.value >= 0 ? theme.upColor : theme.downColor;
                    g.fillRect(8, ly - 10, w + CLOSE_W, 20);
                    g.fillStyle = '#fff';
                    g.fillText(text, 15, ly);
                    // The delete button: a darker cell at the label's end, darker still under the pointer.
                    const box = { id: p.id, x: 8 + w, y: ly - 10, w: CLOSE_W, h: 20 };
                    closeBoxes.push(box);
                    const hover = cursor && cursor.x >= box.x && cursor.x <= box.x + box.w && cursor.y >= box.y && cursor.y <= box.y + box.h;
                    g.fillStyle = hover ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.2)';
                    g.fillRect(box.x, box.y, box.w, box.h);
                    g.strokeStyle = '#fff';
                    g.lineWidth = 1.5;
                    g.beginPath();
                    g.moveTo(box.x + 6.5, ly - 3.5);
                    g.lineTo(box.x + 13.5, ly + 3.5);
                    g.moveTo(box.x + 13.5, ly - 3.5);
                    g.lineTo(box.x + 6.5, ly + 3.5);
                    g.stroke();
                }
            },
        };
    },
});

let dialog: Dialog | null = null;

function openTrade(ctx: WidgetContext, side: Side): void {
    const symbol = ctx.chart.market.symbol;
    if (!symbol) return;
    const lastPrice = lastPrices.get(symbol);
    const word = side === 'buy' ? 'Buy' : 'Sell';
    const priceIn = createInput({ id: 'dev-trade-price', placeholder: 'e.g. 60000' });
    const amountIn = createInput({ id: 'dev-trade-amount', placeholder: 'e.g. 1000' });
    if (lastPrice !== undefined) priceIn.setValue(String(lastPrice));
    const error = document.createElement('div');
    error.style.cssText = 'min-height:1.3em;color:var(--vela-danger);font-size:var(--vela-font-size-md);';
    const label = (forId: string, text: string): HTMLLabelElement => {
        const l = document.createElement('label');
        l.htmlFor = forId;
        l.textContent = text;
        l.style.cssText = 'font-size:var(--vela-font-size-md);color:var(--vela-fg-muted);';
        return l;
    };
    const num = (s: string): number => Number(s.replace(/,/g, '').trim());

    const submit = createButton({
        text: `${word} ${symbol}`,
        variant: side === 'buy' ? 'up' : 'down',
        onClick: () => {
            const price = num(priceIn.input.value);
            const amount = num(amountIn.input.value);
            if (!(price > 0) || !(amount > 0)) {
                error.textContent = 'Enter a price and an amount greater than 0.';
                return;
            }
            positions.push({ id: crypto.randomUUID(), symbol, side, price, amount });
            save();
            dialog?.hide();
            ctx.toast(`${word} ${fmt(amount / price, 4)} ${symbol} @ ${fmtPrice(price)} added to the chart`, 'success');
        },
    });

    // Existing positions on this symbol, each with a remove button.
    const list = document.createElement('div');
    list.style.cssText = 'display:grid;gap:4px;margin-top:12px;font-size:var(--vela-font-size-md);';
    const renderList = (): void => {
        list.replaceChildren();
        const mine = positions.filter((p) => p.symbol === symbol);
        if (mine.length === 0) return;
        const head = document.createElement('div');
        head.textContent = `Your positions on ${symbol}`;
        head.style.cssText = 'color:var(--vela-fg-muted);';
        list.append(head);
        for (const p of mine) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
            const r = lastPrice === undefined ? null : pnl(p, lastPrice);
            row.textContent = `${title(p)} · invested ${fmt(p.amount)}${r ? ` · P&L ${signed(r.value)} (${signed(r.pct)}%)` : ''}`;
            const remove = createButton({
                icon: 'trash',
                label: 'Remove this position',
                variant: 'ghost',
                size: 'icon-xs',
                onClick: () => {
                    removePosition(p.id);
                    renderList();
                },
            });
            row.append(remove.el);
            list.append(row);
        }
    };
    renderList();

    dialog?.destroy();
    dialog = new Dialog({
        title: `${word} ${symbol}`,
        host: ctx.host,
        closeOnInteractOutside: true,
        content: (body) => {
            const form = document.createElement('div');
            form.style.cssText = 'display:grid;grid-template-columns:auto 200px;align-items:center;gap:8px 12px;min-width:340px;';
            form.append(label('dev-trade-price', 'Price per share'), priceIn.el, label('dev-trade-amount', 'Amount invested'), amountIn.el);
            body.append(form, error, submit.el, list);
        },
    });
    dialog.show();
    setTimeout(() => amountIn.input.focus(), 0);
}

for (const side of ['buy', 'sell'] as const) {
    registerWidgetAction({
        id: `dev.${side}`,
        target: 'topbar',
        label: side === 'buy' ? 'Buy' : 'Sell',
        icon: side === 'buy' ? 'arrow-up' : 'arrow-down',
        run: (ctx) => openTrade(ctx, side),
    });
}
