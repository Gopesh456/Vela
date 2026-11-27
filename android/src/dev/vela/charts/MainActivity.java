package dev.vela.charts;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The chart pages (the playground, built into assets/www by scripts/build-android.ps1), served
 * under https://vela.local/. The pages save through {@link Bridge} into the app's own store
 * ({@link Store}), which syncs with the PC ({@link Sync}); stock data goes through the same
 * relays the PC's dev server provides (/proxy/…).
 */
public class MainActivity extends Activity {
    static final String HOST = "vela.local";
    static final String DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    /** The relays of vite.config.ts: path prefix → the site it forwards to. */
    private static final Map<String, String> RELAYS = new HashMap<>();

    static {
        RELAYS.put("/proxy/yahoo", "https://query1.finance.yahoo.com");
        RELAYS.put("/proxy/nse", "https://nsearchives.nseindia.com");
        RELAYS.put("/proxy/nasdaq", "https://www.nasdaqtrader.com");
    }

    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private final Runnable syncTask = this::syncNow;
    private WebView web;
    private boolean resumed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "VelaNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String raw = u.getEncodedPath() == null ? "/" : u.getEncodedPath();
                String query = u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery();
                for (Map.Entry<String, String> r : RELAYS.entrySet()) {
                    if (raw.startsWith(r.getKey() + "/")) return relay(r.getValue() + raw.substring(r.getKey().length()) + query, 10_000);
                }
                // Alpaca (US stocks) needs the keys only the PC holds: ask the PC's server, when it is
                // on this Wi-Fi. Away from it the answer fails fast and the pages fall back to Yahoo.
                if (raw.startsWith("/proxy/alpaca-")) {
                    String pc = getSharedPreferences("sync", MODE_PRIVATE).getString("server", null);
                    return pc == null ? new WebResourceResponse("text/plain", "utf-8", 503, "No PC", null, null) : relay("http://" + pc + raw + query, 1500);
                }
                return asset(u.getPath() == null ? "/" : u.getPath());
            }
        });
        setContentView(web);
        if (saved == null) web.loadUrl("https://" + HOST + "/workspace.html");
        else web.restoreState(saved);
        AlertService.start(this);
        if (!askForNewerWebView()) askToRunInBackground();
    }

    /** The charts' styles need a recent browser engine (nested CSS: Chrome 112). An older system
     *  WebView shows a broken page: say so, and offer its store page. True when it asked. */
    private boolean askForNewerWebView() {
        Matcher m = Pattern.compile("Chrome/(\\d+)").matcher(WebSettings.getDefaultUserAgent(this));
        if (!m.find() || Integer.parseInt(m.group(1)) >= 112) return false;
        PackageInfo engine = WebView.getCurrentWebViewPackage();
        String pkg = engine == null ? "com.google.android.webview" : engine.packageName;
        new AlertDialog.Builder(this)
                .setTitle("Update the system WebView")
                .setMessage("Vela needs a newer Android System WebView than this device has (Chrome " + m.group(1) + "; it needs 112 or later). Update it from the app store, then open Vela again.")
                .setPositiveButton("Open the store", (d, w) -> {
                    Uri store = Uri.parse((pkg.startsWith("com.huawei") ? "appmarket://details?id=" : "market://details?id=") + pkg);
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, store));
                    } catch (RuntimeException e) {
                        // no store app: the message says what to update
                    }
                })
                .setNegativeButton("Later", null)
                .show();
        return true;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        ui.post(syncTask);
    }

    @Override
    protected void onPause() {
        resumed = isInPictureInPictureMode(); // a picture-in-picture chart keeps syncing
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        resumed = false;
        background.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Sync now in the background, then again in 5 s while the app is on screen. */
    private void syncNow() {
        ui.removeCallbacks(syncTask);
        background.execute(() -> {
            if (Sync.run(this)) pageChanged();
        });
        if (resumed) ui.postDelayed(syncTask, 5000);
    }

    /** The store changed under the page (a sync, a fired alert): it re-reads it (saved.ts). */
    static void pageChanged() {
        MainActivity a = current.get();
        if (a == null) return;
        a.ui.post(() -> a.web.evaluateJavascript("dispatchEvent(new Event('vela-synced'))", null));
    }

    private WebResourceResponse asset(String path) {
        if (path.endsWith("/")) path += "index.html";
        try {
            InputStream in = getAssets().open("www" + path);
            return new WebResourceResponse(mime(path), "utf-8", in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    /** Fetch from the site a relay forwards to (no CORS there: the page asks its own origin). */
    private static WebResourceResponse relay(String url, int connectTimeoutMs) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(connectTimeoutMs);
            c.setReadTimeout(20_000);
            c.setRequestProperty("User-Agent", DESKTOP_UA);
            int status = c.getResponseCode();
            InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String type = c.getContentType() == null ? "application/octet-stream" : c.getContentType().split(";")[0].trim();
            String reason = c.getResponseMessage() == null || c.getResponseMessage().isEmpty() ? "OK" : c.getResponseMessage();
            return new WebResourceResponse(type, "utf-8", status, reason, null, body);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", null, null);
        }
    }

    static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    /** Price alerts have to be checked while the screen is off: ask once to be left running. */
    private void askToRunInBackground() {
        SharedPreferences prefs = getSharedPreferences("app", MODE_PRIVATE);
        PowerManager pm = getSystemService(PowerManager.class);
        if (prefs.getBoolean("asked-battery", false) || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        prefs.edit().putBoolean("asked-battery", true).apply();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            // some devices have no such screen: alerts then pause while the system sleeps
        }
    }

    /** What the pages call (window.VelaNative). */
    final class Bridge {
        @JavascriptInterface
        public String getState() {
            return Store.get(MainActivity.this).all();
        }

        @JavascriptInterface
        public void put(String key, String value) {
            Store.get(MainActivity.this).put(key, value);
            if (Store.items(value) != null) ui.postDelayed(syncTask, 300); // a shared change: tell the PC soon
        }

        @JavascriptInterface
        public void pip() {
            ui.post(() -> enterPictureInPictureMode(new PictureInPictureParams.Builder().build()));
        }
    }
}
