"use client";

import { Fragment } from "react";
import { XCircle, History, CheckCircle, Trash2, FileMinus, ChevronRight, ChevronDown } from "lucide-react";
import StatusBadge from "@/components/statusbadge";
import DetailTable from "@/components/detailtable";
import { Card } from "@/components/ui/card";
import { filesApi } from "@/api";
import { formatBytes, formatDuration, formatAge, formatDateTime, transcodeProgress, cn } from "@/lib/utils";
import { STATUS_FILTERS, FILTER_PILL_CLS } from "@/lib/constants";
import { FILE_STATUS, RESULT_STATUS, REQUEUEABLE_STATUSES, STOPPABLE_STATUSES } from "shared/domain.js";
import { useI18n } from "@/context/i18n";

function StatusFilterPills({ statusFilter, onNavigate, t }) {
    return (
        <div className="flex gap-1 flex-wrap">
            {STATUS_FILTERS.map((s) => {
                const pill = FILTER_PILL_CLS[s] || FILTER_PILL_CLS._default;
                const cls = statusFilter === s ? pill.active : pill.inactive;
                return (
                    <button
                        key={s}
                        onClick={() => onNavigate("files", s)}
                        className={`px-2 py-0.5 text-xs rounded border transition-colors ${cls}`}
                    >
                        {t.statuses[s] ?? s}
                    </button>
                );
            })}
        </div>
    );
}

// The done/stop/requeue/delete buttons in a file row's actions cell — what's shown depends
// on the file's current status.
function FileActions({ file, fileName, outputResults, busy, act, setConfirm, t }) {
    const requeueKey = `requeue-${file.fileId}`;
    return (
        <div className="flex gap-1 justify-end items-center">
            {outputResults
                .filter((r) => r.status === RESULT_STATUS.done)
                .map((r) => (
                    <button
                        key={r.settingId}
                        onClick={() =>
                            setConfirm({
                                type: "replace",
                                fileId: file.fileId,
                                settingId: r.settingId,
                                title: t.files.replaceConfirmTitle,
                                message: t.files.replaceConfirmMsg(fileName, r.settingName),
                            })
                        }
                        title={t.files.replaceTitle(r.settingName)}
                        className="p-1 text-green-400 hover:text-green-300"
                    >
                        <CheckCircle size={13} />
                    </button>
                ))}

            {STOPPABLE_STATUSES.includes(file.status) && (
                <button
                    onClick={() =>
                        setConfirm({
                            type: "stop",
                            fileId: file.fileId,
                            title: t.files.stopConfirmTitle,
                            message: t.files.stopConfirmMsg(fileName),
                        })
                    }
                    title={t.files.stopTitle}
                    className="p-1 text-yellow-400 hover:text-yellow-300"
                >
                    <XCircle size={13} />
                </button>
            )}

            {REQUEUEABLE_STATUSES.includes(file.status) && (
                <button
                    onClick={() => act(requeueKey, () => filesApi.requeue(file.fileId))}
                    disabled={busy[requeueKey]}
                    title={t.files.requeueTitle}
                    className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                    <History size={13} className={busy[requeueKey] ? "animate-spin" : ""} />
                </button>
            )}

            {file.status !== FILE_STATUS.processing && (
                <button
                    onClick={() =>
                        setConfirm({
                            type: "delete",
                            fileId: file.fileId,
                            title: t.files.deleteConfirmTitle,
                            message: t.files.deleteConfirmMsg(fileName),
                        })
                    }
                    title={t.files.deleteTitle}
                    className="p-1 text-muted-foreground hover:text-red-400"
                >
                    <Trash2 size={13} />
                </button>
            )}
        </div>
    );
}

// One transcode attempt's outcome in a file's expanded detail row: completion time, sizes,
// and (for kept outputs) a delete-output button.
function ResultDetail({ result, fileId, setConfirm, t }) {
    return (
        <div className="mt-2 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] font-medium">{result.settingName}</div>
                {result.outputPath && (
                    <button
                        onClick={() =>
                            setConfirm({
                                type: "deleteOutput",
                                fileId,
                                settingId: result.settingId,
                                title: t.files.deleteOutputConfirmTitle,
                                message: t.files.deleteOutputConfirmMsg(result.outputPath.split("/").pop()),
                            })
                        }
                        title={t.files.deleteOutputTitle}
                        className="p-1 text-orange-400 hover:text-orange-300"
                    >
                        <FileMinus size={13} />
                    </button>
                )}
            </div>
            <DetailTable
                rows={[
                    [
                        t.files.detailCompleted,
                        result.completedAt ? formatDateTime(result.completedAt) : t.files.detailNotStarted,
                    ],
                    [t.files.detailInputSize, formatBytes(result.inputSize)],
                    ...(result.outputPath
                        ? [
                              [t.files.detailOutputSize, formatBytes(result.outputSize)],
                              [
                                  t.files.detailOutputPath,
                                  <span key="path" className="break-all">
                                      {result.outputPath}
                                  </span>,
                              ],
                          ]
                        : [[t.files.detailOutputPath, t.files.detailNoOutput]]),
                ]}
            />
        </div>
    );
}

// The "Size" column: the source size, then `→ output size  ±%` once a transcode has produced one —
// green when it's a win awaiting replacement, red when the transcode was rejected. A replaced file
// has been swapped in place, so `file.size` IS the output size — show that single size in green,
// not a source→output comparison (both numbers would be identical, reading a meaningless "0%").
function sizeInfo(file) {
    const original = formatBytes(file.size);
    if (file.status === FILE_STATUS.replaced) {
        return { original, originalClassName: "text-green-400", current: null, percent: null, currentClassName: null };
    }
    const result = (file.transcodeResults || []).find(
        (r) =>
            [RESULT_STATUS.done, RESULT_STATUS.replaced, RESULT_STATUS.rejected].includes(r.status) &&
            r.outputSize != null,
    );
    if (!result) {
        return { original, originalClassName: null, current: null, percent: null, currentClassName: null };
    }
    const smaller = result.outputSize < file.size;
    const pct = file.size ? Math.round((result.outputSize / file.size - 1) * 100) : 0;
    let currentClassName = "text-muted-foreground";
    if (file.status === FILE_STATUS.rejected) {
        currentClassName = "text-red-400";
    } else if (smaller && file.status === FILE_STATUS.transcoded) {
        currentClassName = "text-green-400";
    }
    return {
        original,
        originalClassName: null,
        current: formatBytes(result.outputSize),
        percent: `${pct > 0 ? "+" : ""}${pct}%`,
        currentClassName,
    };
}

function FileRow({ file, isExpanded, onToggleExpand, busy, act, setConfirm, progress, t }) {
    // Output files sitting on disk: "done" (awaiting replace) or "rejected" kept by deleteOnReject: false.
    const outputResults = (file.transcodeResults || []).filter(
        (r) => (r.status === RESULT_STATUS.done || r.status === RESULT_STATUS.rejected) && r.outputPath,
    );
    const fileName = file.path.split("/").pop();
    const size = sizeInfo(file);

    // Transcode progress (Option 5): a thin purple line filled to pct% along the row's bottom edge,
    // no track. Painted as a bottom-anchored gradient on the row so it spans the full width.
    const showProgress = file.status === FILE_STATUS.processing && progress;
    const rowProgressStyle = showProgress
        ? {
              backgroundImage: `linear-gradient(to right, #c084fc ${progress.pct ?? 0}%, transparent ${progress.pct ?? 0}%)`,
              backgroundSize: "100% 2px",
              backgroundPosition: "bottom",
              backgroundRepeat: "no-repeat",
          }
        : undefined;

    return (
        <Fragment>
            <tr
                onClick={() => onToggleExpand(file.fileId)}
                style={rowProgressStyle}
                className="border-b border-border/50 last:border-0 hover:bg-muted/20 cursor-pointer"
            >
                <td className="px-2 py-2 text-muted-foreground">
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </td>
                <td className="px-3 py-2 max-w-64">
                    <div className="truncate font-medium" title={file.path}>
                        {fileName}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 truncate">{file.path}</div>
                    {file.errorMessage && (
                        <div className="text-[10px] text-red-400 truncate" title={file.errorMessage}>
                            {file.errorMessage}
                        </div>
                    )}
                </td>
                <td className="px-3 py-2">
                    <StatusBadge status={file.status} />
                </td>
                <td className="px-3 py-2 hidden sm:table-cell text-muted-foreground tabular-nums">
                    <div className={cn(size.originalClassName)}>{size.original}</div>
                    {size.current && (
                        <div className={cn("text-[10px]", size.currentClassName)}>
                            {size.current} <span className="opacity-70">{size.percent}</span>
                        </div>
                    )}
                </td>
                <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                    {file.status === FILE_STATUS.processing && file.processingStartedAt
                        ? `${formatDuration(file.processingStartedAt)}${progress ? ` · ${progress.label}` : ""}`
                        : formatAge(file.addedAt)}
                </td>
                <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <FileActions
                        file={file}
                        fileName={fileName}
                        outputResults={outputResults}
                        busy={busy}
                        act={act}
                        setConfirm={setConfirm}
                        t={t}
                    />
                </td>
            </tr>
            {isExpanded && <FileDetailRow file={file} setConfirm={setConfirm} t={t} />}
        </Fragment>
    );
}

function FileDetailRow({ file, setConfirm, t }) {
    return (
        <tr className="border-b border-border/50 last:border-0 bg-muted/10">
            <td colSpan={6} className="px-6 py-3">
                <DetailTable
                    rows={[
                        [t.files.detailAdded, formatDateTime(file.addedAt)],
                        [
                            t.files.detailStarted,
                            file.processingStartedAt
                                ? formatDateTime(file.processingStartedAt)
                                : t.files.detailNotStarted,
                        ],
                        [t.files.colSize, formatBytes(file.size)],
                    ]}
                />
                {(file.transcodeResults || []).map((result, idx) => (
                    <ResultDetail
                        key={result.settingId ?? idx}
                        result={result}
                        fileId={file.fileId}
                        setConfirm={setConfirm}
                        t={t}
                    />
                ))}
            </td>
        </tr>
    );
}

export default function FilesTab({
    filesData,
    statusFilter,
    expandedFiles,
    onToggleExpand,
    busy,
    act,
    setConfirm,
    onNavigate,
    workers,
}) {
    const { t } = useI18n();

    // Live transcode progress comes from the runner currently rendering each file (the worker pool,
    // polled with the rest of the dashboard) — keyed by fileId so a processing row can show its bar.
    const progressByFileId = {};
    for (const worker of workers || []) {
        if (worker.currentFileId) {
            progressByFileId[worker.currentFileId] = transcodeProgress(
                worker.progress,
                worker.currentFile?.media?.duration,
            );
        }
    }
    return (
        <section className="space-y-2">
            <StatusFilterPills statusFilter={statusFilter} onNavigate={onNavigate} t={t} />

            <Card className="overflow-hidden">
                {filesData.items.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">{t.dashboard.noFiles}</p>
                ) : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-border text-muted-foreground">
                                <th className="w-6 px-2 py-2" />
                                <th className="text-left px-3 py-2 font-medium">{t.files.colFile}</th>
                                <th className="text-left px-3 py-2 font-medium">{t.files.colStatus}</th>
                                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">
                                    {t.files.colSize}
                                </th>
                                <th className="text-left px-3 py-2 font-medium hidden md:table-cell">
                                    {statusFilter === FILE_STATUS.processing ? t.files.colDuration : t.files.colAdded}
                                </th>
                                <th className="text-right px-3 py-2 font-medium">{t.files.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filesData.items.map((file) => (
                                <FileRow
                                    key={file.fileId}
                                    file={file}
                                    isExpanded={expandedFiles.has(file.fileId)}
                                    onToggleExpand={onToggleExpand}
                                    busy={busy}
                                    act={act}
                                    setConfirm={setConfirm}
                                    progress={progressByFileId[file.fileId]}
                                    t={t}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
                {filesData.total > filesData.items.length && (
                    <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
                        {t.dashboard.showing(filesData.items.length, filesData.total)}
                    </div>
                )}
            </Card>
        </section>
    );
}
