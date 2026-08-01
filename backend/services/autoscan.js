// Auto-scan scheduler — owns the recurring SCAN_DIRECTORY enqueue driven by the
// `autoScanIntervalMinutes` setting. Applied once at boot and re-applied on every settings save
// (see controllers/settings.js), so an interval change takes effect immediately instead of only
// after a restart.
import * as event from "./event.js";
import * as logging from "./logging.js";
import { JOB_TYPE } from "shared/domain.js";

let timer = null;
let currentMinutes = null;
let stopped = false;
let shutdownPromise = null;
const pendingEnqueues = new Set();

// (Re)schedule the recurring scan. A no-op when the interval hasn't changed; 0 disables it.
export function apply(minutes) {
    if (stopped || minutes === currentMinutes) {
        return;
    }
    currentMinutes = minutes;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (minutes > 0) {
        timer = setInterval(
            () => {
                const enqueue = event
                    .enqueue(JOB_TYPE.SCAN_DIRECTORY, {})
                    .catch((error) => logging.error("autoscan", `enqueue failed: ${error.message}`))
                    .finally(() => pendingEnqueues.delete(enqueue));
                pendingEnqueues.add(enqueue);
            },
            minutes * 60 * 1000,
        );
        logging.log("autoscan", `auto-scan enabled: every ${minutes} min`);
    } else {
        logging.log("autoscan", "auto-scan disabled");
    }
}

export function shutdown() {
    if (shutdownPromise) {
        return shutdownPromise;
    }
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    currentMinutes = null;
    shutdownPromise = Promise.allSettled([...pendingEnqueues]);
    return shutdownPromise;
}
