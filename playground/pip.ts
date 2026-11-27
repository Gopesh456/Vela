// Picture-in-picture: pop the whole chart out into a small always-on-top window that stays
// visible when you switch tabs or apps (the browser's Document Picture-in-Picture: Chrome
// and Edge). The chart's DOM moves into that window, and back when the window closes.
import { registerIcon, registerWidgetAction } from '../src/plugin';
import { createButton } from '../src/ui';

registerIcon(
    'pip',
    '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="8" y="8" width="5" height="3.5" rx=".5" fill="currentColor"/></svg>',
);

interface DocumentPictureInPicture {
    requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const docPip = (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
let pip: Window | null = null;

/** The page's styles, as text the pop-out window can take (the chart and the kit add theirs to <head>). */
function copyStyles(to: Document): void {
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
        try {
            const style = to.createElement('style');
            style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
            to.head.append(style);
        } catch {
            if (!sheet.href) continue; // a cross-origin sheet hides its rules: link it instead
            const link = to.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            to.head.append(link);
        }
    }
}

async function popOut(): Promise<void> {
    const chart = document.getElementById('chart');
    if (!docPip || !chart) return;
    const win = await docPip.requestWindow({ width: 560, height: 360 });
    pip = win;
    win.document.title = document.title;
    copyStyles(win.document);

    // What the page shows while the chart is away.
    const away = document.createElement('div');
    away.style.cssText =
        'position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:12px;color:#d1d4dc;font:14px system-ui,sans-serif;';
    away.textContent = 'The chart is in the picture-in-picture window.';
    away.append(createButton({ text: 'Bring it back', variant: 'outline', onClick: () => win.close() }).el);

    chart.replaceWith(away);
    win.document.body.append(chart);
    const restoreFrames = borrowFrames(win);
    win.addEventListener(
        'pagehide',
        () => {
            restoreFrames();
            away.replaceWith(chart);
            pip = null;
        },
        { once: true },
    );
}

/** The chart paints on this page's animation frames, which stop once the tab is hidden. While the
 *  pop-out is open, serve them from the pop-out window instead; give back what is still pending on close. */
function borrowFrames(win: Window): () => void {
    const ownRaf = window.requestAnimationFrame;
    const ownCancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    window.requestAnimationFrame = (cb) => {
        const id = win.requestAnimationFrame((t) => {
            pending.delete(id);
            cb(t);
        });
        pending.set(id, cb);
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        win.cancelAnimationFrame(id);
    };
    return () => {
        window.requestAnimationFrame = ownRaf;
        window.cancelAnimationFrame = ownCancel;
        for (const cb of pending.values()) ownRaf.call(window, cb); // a dropped frame would stall the chart for good
        pending.clear();
    };
}

registerWidgetAction({
    id: 'dev.pip',
    target: 'topbar',
    label: 'Picture in picture',
    icon: 'pip',
    iconOnly: true,
    run: (ctx) => {
        if (pip) pip.close();
        else if (!docPip) ctx.toast('Picture in picture needs Chrome or Edge', 'error');
        else void popOut();
    },
});
