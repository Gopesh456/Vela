package dev.vela.charts;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Price alerts keep working after a restart: start watching once the device has booted. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) AlertService.start(ctx);
    }
}
