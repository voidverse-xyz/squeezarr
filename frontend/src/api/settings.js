"use client";

import * as client from "./client.js";

export function get(options) {
    return client.get("settings", options);
}

export function save(settings, options) {
    return client.put(
        "settings",
        {
            videoExtensions: settings.videoExtensions,
            autoScanIntervalMinutes: settings.autoScanIntervalMinutes,
            transcodeSettings: settings.transcodeSettings,
            revision: settings.revision,
        },
        options,
    );
}
