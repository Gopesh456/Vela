package dev.vela.charts;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Syncs the shared values (trades, alerts, watchlist, each symbol's lines and indicators) with
 * the playground server on the PC (scripts/playground-state.mjs, POST /__sync) whenever both are
 * on the same Wi-Fi. The PC is found at its last known address, else by asking every address of
 * this Wi-Fi network once a minute at most. Away from it, the app works on its own copy.
 */
final class Sync {
    static final int PORT = 5190; // the PC app's server (scripts/playground-app.ps1)
    private static long lastScan;

    /** Swap shared values with the PC; true when this device's values changed. */
    static synchronized boolean run(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE);
        Store store = Store.get(ctx);
        String host = prefs.getString("server", null);
        String reply = host == null ? null : exchange(host, store.shared().toString(), 2000);
        if (reply == null) {
            if (System.currentTimeMillis() - lastScan < 60_000) return false;
            lastScan = System.currentTimeMillis();
            host = scan(ctx);
            if (host == null) return false;
            reply = exchange(host, store.shared().toString(), 4000);
            if (reply == null) return false;
            prefs.edit().putString("server", host).apply();
        }
        prefs.edit().putLong("synced", System.currentTimeMillis()).apply();
        boolean changed = false;
        try {
            JSONObject theirs = new JSONObject(reply);
            for (Iterator<String> it = theirs.keys(); it.hasNext(); ) {
                String key = it.next();
                changed |= store.merge(key, theirs.getString(key));
            }
        } catch (JSONException e) {
            return false;
        }
        return changed;
    }

    /** POST our shared values; the merged values back, or null when no playground answered. */
    private static String exchange(String host, String body, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + "/__sync").openConnection();
            c.setConnectTimeout(Math.min(timeoutMs, 800));
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            if (c.getResponseCode() != 200 || !"1".equals(c.getHeaderField("x-vela-playground"))) return null;
            return new String(Store.readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Ask every address of this Wi-Fi network (a /24) for the playground; its host:port, or null. */
    @SuppressWarnings("deprecation") // getConnectionInfo is the plain way on the Android versions this targets
    private static String scan(Context ctx) {
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        int ip = wifi == null ? 0 : wifi.getConnectionInfo().getIpAddress();
        if (ip == 0) return null; // not on Wi-Fi
        String base = (ip & 0xff) + "." + (ip >> 8 & 0xff) + "." + (ip >> 16 & 0xff) + ".";
        int self = ip >>> 24;
        ExecutorService pool = Executors.newFixedThreadPool(48);
        CompletionService<String> done = new ExecutorCompletionService<>(pool);
        int asked = 0;
        for (int i = 1; i < 255; i++) {
            if (i == self) continue;
            final String host = base + i + ":" + PORT;
            done.submit(() -> exchange(host, "{}", 1500) != null ? host : null);
            asked++;
        }
        try {
            for (int i = 0; i < asked; i++) {
                Future<String> f = done.poll(5, TimeUnit.SECONDS);
                if (f == null) break;
                String found = f.get();
                if (found != null) return found;
            }
        } catch (Exception e) {
            return null;
        } finally {
            pool.shutdownNow();
        }
        return null;
    }
}
