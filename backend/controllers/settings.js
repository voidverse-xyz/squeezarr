// Settings controller — read + save the singleton settings document. The save path validates the
// (security-critical) payload via settingsValidationService and returns a clear envelope error
// rather than throwing; the route just sanitizes nothing here and hands the raw body over.
import { settingsService, settingsValidationService, autoscanService } from "../services/index.js";
import { getResult } from "shared/response.js";

export async function get() {
    const settings = await settingsService.get();
    return getResult(true, "settings_loaded", settings);
}

export async function save(rawSettings) {
    const { error, value } = settingsValidationService.validateSettings(rawSettings);
    if (error) {
        return getResult(false, error);
    }
    const saved = await settingsService.save(value);
    if (saved.error) return getResult(false, saved.error, saved.value);
    // Re-apply the auto-scan schedule so an interval change takes effect without a restart
    // (a no-op when the interval is unchanged).
    autoscanService.apply(saved.value.autoScanIntervalMinutes);
    return getResult(true, "settings_saved", saved.value);
}
