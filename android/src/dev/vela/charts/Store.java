package dev.vela.charts;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * What the app saves: the same { key: value } store the PC's playground server keeps
 * (playground/saved.ts). A shared value ({"$items": …}) merges item by item — the newer change
 * wins, deletions included — exactly as the server merges it, so edits made on the PC and here
 * while apart all survive the next sync.
 */
final class Store {
    private static final long TOMBSTONE_MS = 30L * 86_400_000L; // as in saved.ts
    private static Store instance;

    static synchronized Store get(Context ctx) {
        if (instance == null) instance = new Store(new File(ctx.getFilesDir(), "state.json"));
        return instance;
    }

    private final File file;
    private JSONObject state;

    private Store(File file) {
        this.file = file;
        JSONObject s;
        try {
            s = new JSONObject(new String(readAll(new FileInputStream(file)), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            s = new JSONObject();
        }
        state = s;
    }

    synchronized String all() {
        return state.toString();
    }

    synchronized String value(String key) {
        return state.has(key) ? state.optString(key) : null;
    }

    /** Save one value (null removes it); a shared value merges into the stored one. */
    synchronized void put(String key, String value) {
        if (value == null) state.remove(key);
        else putQuietly(key, combine(value(key), value));
        save();
    }

    /** Merge a shared value in; true when it changed what is stored. */
    synchronized boolean merge(String key, String value) {
        String before = value(key);
        String next = combine(before, value);
        if (next.equals(before)) return false;
        putQuietly(key, next);
        save();
        return true;
    }

    /** Every shared value: what travels to the PC. */
    synchronized JSONObject shared() {
        JSONObject out = new JSONObject();
        for (Iterator<String> it = state.keys(); it.hasNext(); ) {
            String key = it.next();
            if (items(state.optString(key)) != null) putQuietly(out, key, state.optString(key));
        }
        return out;
    }

    /** The items of a shared value, or null when the value is not one. */
    static JSONObject items(String raw) {
        if (raw == null) return null;
        try {
            return new JSONObject(raw).optJSONObject("$items");
        } catch (JSONException e) {
            return null;
        }
    }

    static String combine(String stored, String incoming) {
        JSONObject theirs = items(incoming);
        JSONObject ours = items(stored);
        if (theirs == null || ours == null) return incoming;
        JSONObject out = new JSONObject();
        putQuietly(out, "$items", mergeItems(ours, theirs, System.currentTimeMillis()));
        return out.toString();
    }

    /** Per item, the newer change wins (saved.ts mergeItems). */
    static JSONObject mergeItems(JSONObject a, JSONObject b, long now) {
        JSONObject out = new JSONObject();
        for (JSONObject src : new JSONObject[] {a, b}) {
            for (Iterator<String> it = src.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONObject item = src.optJSONObject(id);
                if (item == null || !item.has("t")) continue;
                long t = item.optLong("t");
                if (item.optInt("d") == 1 && t < now - TOMBSTONE_MS) continue;
                JSONObject cur = out.optJSONObject(id);
                if (cur == null || t > cur.optLong("t") || (t == cur.optLong("t") && item.toString().compareTo(cur.toString()) > 0)) putQuietly(out, id, item);
            }
        }
        return out;
    }

    private void putQuietly(String key, String value) {
        putQuietly(state, key, value);
    }

    static void putQuietly(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (JSONException e) {
            throw new IllegalStateException(e); // only a null key throws, and keys are never null
        }
    }

    private void save() {
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(state.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            return; // the store stays in memory; the next save writes it
        }
        if (!tmp.renameTo(file)) tmp.delete(); // a crash mid-write leaves the old file whole
    }

    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = s.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
