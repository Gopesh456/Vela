import { defineConfig } from 'vite';
import { velaUiSource } from './scripts/vela-ui-source.mjs';
import { playgroundState } from './scripts/playground-state.mjs';

/**
 * Playground server: `npm run playground` serves playground/ with Vela imported STRAIGHT
 * from src/ (no build step, hot reload), and the kit from packages/vela-ui/src. Nothing else
 * to configure — Vela ships no scripting engine, so the page carries its own tiny demo engine
 * (playground/demo-engine.ts) and needs no bundler plumbing for it.
 */
/** Relay `prefix/*` to `target/*` — for sources that refuse direct browser calls (no CORS headers). */
const relay = (prefix: string, target: string) => ({ [prefix]: { target, changeOrigin: true, rewrite: (path: string) => path.slice(prefix.length) } });

export default defineConfig({
    root: 'playground',
    server: {
        port: 5190,
        strictPort: true,
        // The playground's stock data (playground/stocks.ts).
        proxy: {
            ...relay('/proxy/yahoo', 'https://query1.finance.yahoo.com'),
            ...relay('/proxy/nse', 'https://nsearchives.nseindia.com'),
            ...relay('/proxy/nasdaq', 'https://www.nasdaqtrader.com'),
        },
    },
    // `vite build`: the pages, bundled for the Android app (scripts/build-android.ps1). es2022 for saved.ts's top-level await.
    build: {
        outDir: '../android/assets/www',
        emptyOutDir: true,
        target: 'es2022',
        rollupOptions: { input: ['playground/index.html', 'playground/widget.html', 'playground/workspace.html'] },
    },
    // playgroundState: what the playground saves, kept in a file (outside `root`, so writing it reloads nothing).
    plugins: [velaUiSource(), playgroundState(new URL('.playground-state.json', import.meta.url))],
});
