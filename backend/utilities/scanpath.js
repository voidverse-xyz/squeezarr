// Pure path-classification helpers for scanner output ownership.

export function collectFileOwnedOutputPaths(file) {
    return [
        ...(file.transcodeResults || []).map((result) => result.outputPath),
        file.currentOutputPath,
        file.reservedOutputPath,
        ...(file.retiredOutputPaths || []),
        file.adjacentJournal?.scratchPath,
        file.adjacentJournal?.finalPath,
        file.overwriteJournal?.tempPath,
        file.overwriteJournal?.backupPath,
    ].filter(Boolean);
}

// Every stable result, active reservation, generation-owned scratch, crash journal artifact, and
// retired stale-runner scratch remains excluded from source discovery. Journal paths matter when
// cleanup fails before currentOutputPath can represent every surviving artifact.
export function collectKnownOutputPaths(files) {
    return new Set(files.flatMap(collectFileOwnedOutputPaths));
}

// A document whose source path is owned as another file's output is a scanner race artifact.
// Never classify a file as stray solely from one of its own ownership records.
export function findStrayOutputDocs(files, knownOutputPaths) {
    return files.filter((file) => {
        if (!knownOutputPaths.has(file.path)) {
            return false;
        }
        return !collectFileOwnedOutputPaths(file).includes(file.path);
    });
}
