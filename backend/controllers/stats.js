// Stats controller — aggregates storage savings across all files' replaced transcode
// results for the Statistics tab.
import * as db from "../database/index.js";
import { COLLECTION, RESULT_STATUS } from "shared/domain.js";
import { getResult } from "shared/response.js";

export async function get() {
    const allFiles = await db.getAll(COLLECTION.files);

    let currentLibrarySize = 0;
    let transcodedInputSize = 0;
    let transcodedOutputSize = 0;
    const convertedEntries = [];

    for (const file of allFiles) {
        currentLibrarySize += file.size || 0;

        const replacedResults = (file.transcodeResults || []).filter((r) => r.status === RESULT_STATUS.replaced);
        for (const result of replacedResults) {
            transcodedInputSize += result.inputSize || 0;
            transcodedOutputSize += result.outputSize || 0;
            convertedEntries.push({
                fileId: file.fileId,
                fileName: file.path.split("/").pop(),
                path: file.path,
                originalSize: result.inputSize || 0,
                outputSize: result.outputSize || 0,
                outputMode: result.outputMode,
                settingName: result.settingName,
                completedAt: result.completedAt || 0,
                fileStatus: file.status,
            });
        }
    }

    const savedSize = transcodedInputSize - transcodedOutputSize;
    // Original library size = current size + space that was freed by replacing files.
    const originalLibrarySize = currentLibrarySize + savedSize;

    convertedEntries.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    return getResult(true, "stats_loaded", {
        currentLibrarySize,
        originalLibrarySize,
        transcodedInputSize,
        transcodedOutputSize,
        savedSize,
        convertedCount: convertedEntries.length,
        fileCount: allFiles.length,
        converted: convertedEntries,
    });
}
