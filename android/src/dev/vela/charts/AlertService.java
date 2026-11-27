package dev.vela.charts;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Price alerts while the app is open or closed: syncs with the PC (Sync) and checks the saved
 * alerts' prices (alerts.ts saves them, with their price source), the same way the PC's pages
 * do. A crossing marks the alert fired — the PC announces it too once it syncs — and rings an
 * alarm-style notification. Alerts that fired on the PC ring here as well.
 */
public class AlertService extends Service {
    static final String KEY = "vela-play:alerts";
    private static final long CHECK_MS = 15_000; // shortcut: a spike that crosses and returns within 15 s is missed
    private static final long SYNC_MS = 30_000;
    private static final int WATCHING = 1;

    private Handler handler;
    private PowerManager.WakeLock wake;
    private final Map<String, Double> lastPrice = new HashMap<>(); // alert uid → the price at the previous check
    private long lastSync;
    private final Runnable tickTask = this::tick;

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, AlertService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel watching = new NotificationChannel("watching", "Watching prices", NotificationManager.IMPORTANCE_MIN);
        watching.setShowBadge(false);
        NotificationChannel fired = new NotificationChannel("alerts", "Price alerts", NotificationManager.IMPORTANCE_HIGH);
        fired.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        fired.enableVibration(true);
        fired.setVibrationPattern(new long[] {0, 400, 200, 400, 200, 800});
        nm.createNotificationChannel(watching);
        nm.createNotificationChannel(fired);
        startForeground(WATCHING, watchingNotice(0));
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vela:alerts");
        wake.setReferenceCounted(false);
        HandlerThread thread = new HandlerThread("vela-alerts");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(tickTask);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (handler != null && intent != null && intent.getBooleanExtra("now", false)) {
            handler.removeCallbacks(tickTask);
            handler.post(tickTask);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.getLooper().quitSafely();
        if (wake.isHeld()) wake.release();
        super.onDestroy();
    }

    private void tick() {
        try {
            if (System.currentTimeMillis() - lastSync > SYNC_MS) {
                lastSync = System.currentTimeMillis();
                if (Sync.run(this)) MainActivity.pageChanged();
            }
            check();
        } catch (RuntimeException e) {
            // a bad value or a failed fetch: try again on the next tick
        } finally {
            handler.postDelayed(tickTask, CHECK_MS);
        }
    }

    private void check() {
        Store store = Store.get(this);
        JSONObject items = Store.items(store.value(KEY));
        int armed = 0;
        Map<String, Double> prices = new HashMap<>();
        Set<String> announced = announced();
        if (items != null) {
            for (Iterator<String> it = items.keys(); it.hasNext(); ) {
                String uid = it.next();
                JSONObject item = items.optJSONObject(uid);
                JSONObject a = item == null || item.optInt("d") == 1 ? null : item.optJSONObject("v");
                if (a == null) continue;
                JSONObject fired = a.optJSONObject("triggered");
                if (fired != null) {
                    if (announced.add(uid) && System.currentTimeMillis() - fired.optLong("at") < 86_400_000L) ring(a, fired);
                    continue;
                }
                if (!a.has("price") || !a.has("provider")) continue;
                armed++;
                String source = a.optString("provider") + ":" + a.optString("ticker");
                if (!prices.containsKey(source)) prices.put(source, price(a.optString("provider"), a.optString("ticker")));
                Double now = prices.get(source);
                if (now == null) continue;
                double level = a.optDouble("price");
                Double before = lastPrice.put(uid, now);
                if (before == null || (before < level) == (now < level)) continue;
                // Crossed: mark it fired, for the PC and the page.
                JSONObject mark = new JSONObject();
                Store.putQuietly(mark, "at", System.currentTimeMillis());
                Store.putQuietly(mark, "price", now);
                Store.putQuietly(mark, "level", level);
                Store.putQuietly(mark, "by", "Android");
                Store.putQuietly(a, "triggered", mark);
                JSONObject next = new JSONObject();
                Store.putQuietly(next, "t", System.currentTimeMillis());
                if (item.has("c")) Store.putQuietly(next, "c", item.opt("c"));
                Store.putQuietly(next, "v", a);
                JSONObject one = new JSONObject();
                Store.putQuietly(one, uid, next);
                JSONObject value = new JSONObject();
                Store.putQuietly(value, "$items", one);
                store.merge(KEY, value.toString());
                announced.add(uid);
                armed--;
                ring(a, mark);
                MainActivity.pageChanged();
                lastSync = 0; // tell the PC soon
            }
        }
        remember(announced);
        // Stay awake between checks only while some alert is armed.
        if (armed > 0 && !wake.isHeld()) wake.acquire();
        if (armed == 0 && wake.isHeld()) wake.release();
        getSystemService(NotificationManager.class).notify(WATCHING, watchingNotice(armed));
    }

    /** The alert's symbol's last price, from the same sources the pages use; null when unavailable. */
    static Double price(String provider, String ticker) {
        try {
            String enc = URLEncoder.encode(ticker, "UTF-8");
            switch (provider) {
                case "binance":
                    return Double.parseDouble(new JSONObject(get("https://api.binance.com/api/v3/ticker/price?symbol=" + enc)).getString("price"));
                case "nse":
                    return yahoo(ticker + ".NS");
                case "us":
                    return yahoo(ticker.replace('.', '-')); // BRK.B is BRK-B there
                default:
                    return null;
            }
        } catch (IOException | JSONException | NumberFormatException e) {
            return null;
        }
    }

    private static Double yahoo(String symbol) throws IOException, JSONException {
        JSONObject meta = new JSONObject(get("https://query1.finance.yahoo.com/v8/finance/chart/" + URLEncoder.encode(symbol, "UTF-8") + "?range=1d&interval=1d"))
                .getJSONObject("chart").getJSONArray("result").getJSONObject(0).getJSONObject("meta");
        return meta.getDouble("regularMarketPrice");
    }

    static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", MainActivity.DESKTOP_UA);
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            return new String(Store.readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    private void ring(JSONObject a, JSONObject fired) {
        double level = fired.optDouble("level");
        double price = fired.optDouble("price");
        String by = fired.optString("by");
        String where = "Android".equals(by) ? "" : " (on " + by + " at " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(fired.optLong("at"))) + ")";
        String text = a.optString("symbol") + " crossed " + (price > level ? "above " : "below ") + fmt(level) + " (now " + fmt(price) + ")" + where;
        Notification n = new Notification.Builder(this, "alerts")
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Vela price alert")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
        getSystemService(NotificationManager.class).notify(a.optString("uid").hashCode(), n);
    }

    private Notification watchingNotice(int armed) {
        String text = armed == 0 ? "Syncing with your PC" : "Watching " + armed + (armed == 1 ? " price alert" : " price alerts");
        return new Notification.Builder(this, "watching")
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Vela")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(openApp())
                .build();
    }

    private PendingIntent openApp() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static String fmt(double n) {
        return String.format(Locale.getDefault(), n < 1 ? "%,.6f" : "%,.2f", n);
    }

    /** The fired alerts this device has already rung for (its own list, never synced). */
    private Set<String> announced() {
        Set<String> out = new HashSet<>();
        JSONArray list;
        try {
            list = new JSONArray(prefs().getString("announced", "[]"));
        } catch (JSONException e) {
            return out;
        }
        for (int i = 0; i < list.length(); i++) out.add(list.optString(i));
        return out;
    }

    private void remember(Set<String> announced) {
        JSONArray list = new JSONArray();
        for (String uid : announced) list.put(uid);
        prefs().edit().putString("announced", list.toString()).apply();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("alerts", Context.MODE_PRIVATE);
    }
}
