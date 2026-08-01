"use client";

import { Card } from "@/components/ui/card";
import { formatBytes, formatAge } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

export default function StatisticsTab({ statsData }) {
    const { t } = useI18n();
    if (!statsData) {
        return <p className="text-sm text-muted-foreground">{t.dashboard.loading}</p>;
    }

    const saved = statsData.savedSize;
    const input = statsData.transcodedInputSize;
    const output = statsData.transcodedOutputSize;
    const pct = input > 0 ? Math.abs((saved / input) * 100).toFixed(1) : null;
    const isGain = saved > 0;
    const isLoss = saved < 0;

    return (
        <section className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
                <Card className="p-4 space-y-3">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">
                        {t.stats.currentStorage}
                    </div>
                    <div className="text-3xl font-semibold tabular-nums">
                        {formatBytes(statsData.currentLibrarySize)}
                    </div>
                    <div className="text-xs text-muted-foreground">{t.dashboard.fileCount(statsData.fileCount)}</div>
                </Card>
                <Card className="p-4 space-y-3">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">
                        {t.stats.originalStorage}
                    </div>
                    <div className="text-3xl font-semibold tabular-nums">
                        {formatBytes(statsData.originalLibrarySize)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                        {t.dashboard.replacements(statsData.convertedCount)}
                    </div>
                </Card>
                <Card className="p-4 space-y-3">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">{t.stats.savedStorage}</div>
                    <div
                        className={`text-3xl font-semibold tabular-nums ${isGain ? "text-green-400" : isLoss ? "text-red-400" : ""}`}
                    >
                        {saved !== 0 ? formatBytes(Math.abs(saved)) : "—"}
                    </div>
                    <div className="space-y-1 text-xs">
                        {pct && (
                            <div className={`font-medium ${isGain ? "text-green-400/80" : "text-red-400/80"}`}>
                                {isGain ? t.dashboard.pctReduction(pct) : t.dashboard.pctIncrease(pct)}
                            </div>
                        )}
                        <div className="text-muted-foreground/70">
                            <span>{formatBytes(input)}</span>
                            <span className="mx-1">→</span>
                            <span>{formatBytes(output)}</span>
                        </div>
                        <div className="text-muted-foreground/50">
                            {t.dashboard.acrossFiles(statsData.convertedCount)}
                        </div>
                    </div>
                </Card>
            </div>

            <Card className="overflow-hidden">
                {statsData.converted.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">{t.dashboard.noTranscodes}</p>
                ) : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-border text-muted-foreground">
                                <th className="text-left px-3 py-2 font-medium">{t.stats.colFile}</th>
                                <th className="text-left px-3 py-2 font-medium">{t.stats.colSetting}</th>
                                <th className="text-right px-3 py-2 font-medium">{t.stats.colOriginal}</th>
                                <th className="text-right px-3 py-2 font-medium">{t.stats.colOutput}</th>
                                <th className="text-right px-3 py-2 font-medium">{t.stats.colSaved}</th>
                                <th className="text-left px-3 py-2 font-medium hidden md:table-cell">
                                    {t.stats.colCompleted}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {statsData.converted.map((r, i) => {
                                const rowSaved = r.originalSize - r.outputSize;
                                const rowPct = r.originalSize > 0 ? ((rowSaved / r.originalSize) * 100).toFixed(1) : 0;
                                return (
                                    <tr
                                        key={`${r.fileId}-${i}`}
                                        className="border-b border-border/50 last:border-0 hover:bg-muted/20"
                                    >
                                        <td className="px-3 py-2 max-w-48">
                                            <div className="truncate font-medium" title={r.path}>
                                                {r.fileName}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground/60">
                                                {r.outputMode === "overwrite"
                                                    ? t.settings.overwriteMode
                                                    : t.settings.adjacentMode}
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 text-muted-foreground">{r.settingName}</td>
                                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                            {formatBytes(r.originalSize)}
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums">
                                            {formatBytes(r.outputSize)}
                                        </td>
                                        <td
                                            className={`px-3 py-2 text-right tabular-nums ${rowSaved > 0 ? "text-green-400" : rowSaved < 0 ? "text-red-400" : "text-muted-foreground"}`}
                                        >
                                            {rowSaved > 0
                                                ? `−${formatBytes(rowSaved)}`
                                                : rowSaved < 0
                                                  ? `+${formatBytes(-rowSaved)}`
                                                  : "—"}
                                            {r.originalSize > 0 && (
                                                <span className="ml-1 text-muted-foreground/60">({rowPct}%)</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                                            {formatAge(r.completedAt)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </Card>
        </section>
    );
}
