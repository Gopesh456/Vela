// Dev-server relays to Alpaca, for the playground's US stock prices (playground/stocks.ts). The
// keys come from the ALPACA_API_KEY / ALPACA_SECRET_KEY environment variables and stay on the
// server, which adds them to what it relays; without them there are no relays and US stocks use
// Yahoo. The trading API shares a host with the asset list: that relay is pinned to the list,
// so nothing it relays can reach the account (the server also answers on the Wi-Fi network).

/** @returns {Record<string, import('vite').ProxyOptions>} */
export function alpacaRelays() {
    const key = process.env.ALPACA_API_KEY;
    const secret = process.env.ALPACA_SECRET_KEY;
    if (!key || !secret) return {};
    const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
    return {
        '/proxy/alpaca-data': {
            target: 'https://data.alpaca.markets', // market data only: nothing there trades
            changeOrigin: true,
            headers,
            rewrite: (path) => path.slice('/proxy/alpaca-data'.length),
        },
        '/proxy/alpaca-assets': {
            target: key.startsWith('PK') ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets', // PK… keys are paper-trading keys
            changeOrigin: true,
            headers,
            rewrite: (path) => `/v2/assets${path.includes('?') ? path.slice(path.indexOf('?')) : ''}`,
        },
    };
}
