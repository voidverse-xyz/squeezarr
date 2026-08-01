// Helpers shared by the two halves of a transcode (prepare + finalize).
import * as db from "../../database/index.js";
import { COLLECTION } from "shared/domain.js";

// Apply a shallow patch to a file doc. Keeps every status transition readable as "set these
// fields on the file". Thin files-scoped alias for db.patch.
export async function patchFile(fileId, patch) {
    await db.patch(COLLECTION.files, fileId, patch);
}

// Look up a transcode setting by id within the stored settings config.
export function resolveSetting(config, settingId) {
    return config.transcodeSettings?.find((s) => s.id === settingId);
}
