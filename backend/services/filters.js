import { stat } from "fs/promises";
import { createReadStream } from "fs";
import crypto from "crypto";
import * as logging from "./logging.js";
import { FILTER_ID } from "shared/domain.js";

async function acceptMinimalSize(inputPath, outputPath) {
    const [inputStat, outputStat] = await Promise.all([stat(inputPath), stat(outputPath)]);
    return outputStat.size >= inputStat.size; // true = reject
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

async function sameFile(inputPath, outputPath) {
    const [inputStat, outputStat] = await Promise.all([stat(inputPath), stat(outputPath)]);
    if (inputStat.size !== outputStat.size) {
        return false;
    }

    const [inputHash, outputHash] = await Promise.all([hashFile(inputPath), hashFile(outputPath)]);
    return inputHash === outputHash; // true = reject
}

const FILTER_FUNCTIONS = {
    [FILTER_ID.acceptMinimalSize]: acceptMinimalSize,
    [FILTER_ID.sameFile]: sameFile,
};

/** Returns the ID of the first rejecting filter, or null if all pass. */
export async function runFilters(filterIds, inputPath, outputPath) {
    for (const id of filterIds) {
        const filterFn = FILTER_FUNCTIONS[id];
        if (!filterFn) {
            continue;
        }

        try {
            const rejected = await filterFn(inputPath, outputPath);
            if (rejected) {
                return id;
            }
        } catch (error) {
            logging.error("filters", `Filter "${id}" encountered an error: ${error.message}`);
            throw new Error(`Filter "${id}" failed: ${error.message}`, { cause: error });
        }
    }
    return null;
}
