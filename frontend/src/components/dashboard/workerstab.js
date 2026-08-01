"use client";

import { Cpu, MemoryStick, Server, Film, Pause, Play } from "lucide-react";
import StatusBadge from "@/components/statusbadge";
import EmptyState from "@/components/emptystate";
import { Card } from "@/components/ui/card";
import { formatBytes, formatAge, transcodeProgress } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

// Seconds → compact "Xd Yh" / "Xh Ym" / "Xm". (utils.formatDuration works off a start timestamp;
// uptime arrives as a raw seconds count, so it gets its own tiny formatter.)
function formatUptime(seconds) {
    if (seconds == null) {
        return "—";
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) {
        return `${d}d ${h}h`;
    }
    if (h > 0) {
        return `${h}h ${m}m`;
    }
    return `${m}m`;
}

function toneFor(percent) {
    if (percent == null) {
        return "bg-muted-foreground/40";
    }
    if (percent >= 85) {
        return "bg-red-400";
    }
    if (percent >= 60) {
        return "bg-amber-400";
    }
    return "bg-emerald-400";
}

// { pct, label } for the render progress (see utils.transcodeProgress). Null when the worker
// has reported no progress yet.
function progressInfo(worker) {
    return transcodeProgress(worker.progress, worker.currentFile?.media?.duration);
}

function resolution(media) {
    return media?.width && media?.height ? `${media.width}×${media.height}` : null;
}

// "setting · codec · 1920×1080 · 1.2 GB" — whatever's known about what's rendering.
function renderMeta(currentFile) {
    return [
        currentFile.settingName,
        currentFile.media?.codec,
        resolution(currentFile.media),
        currentFile.size ? formatBytes(currentFile.size) : null,
    ]
        .filter(Boolean)
        .join(" · ");
}

function ramPercent(metrics) {
    return metrics?.memTotal ? (metrics.memUsed / metrics.memTotal) * 100 : null;
}

function MetricBar({ icon, label, percent, value }) {
    const pct = percent == null ? null : Math.max(0, Math.min(100, percent));
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 text-muted-foreground">
                    {icon}
                    {label}
                </span>
                <span className="tabular-nums">{value}</span>
            </div>
            <div className="h-1.5 rounded bg-muted overflow-hidden">
                {pct != null && <div className={`h-full ${toneFor(pct)}`} style={{ width: `${pct}%` }} />}
            </div>
        </div>
    );
}

function DetailRow({ label, value }) {
    return (
        <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums text-right truncate">{value ?? "—"}</span>
        </div>
    );
}

// Pause/resume toggle for a single worker — paused workers stop being handed new jobs (the job
// already running finishes). Lives in the worker card header.
function PauseButton({ worker, onTogglePause, busy }) {
    const { t } = useI18n();
    const paused = !!worker.paused;
    return (
        <button
            type="button"
            title={paused ? t.workers.resume : t.workers.pause}
            onClick={() => onTogglePause(worker.runnerId, !paused)}
            disabled={busy}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                paused
                    ? "border-amber-400/50 bg-amber-400/10 text-amber-400 hover:bg-amber-400/20"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
        >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? t.workers.resume : t.workers.pause}
        </button>
    );
}

function PausedPill() {
    const { t } = useI18n();
    return (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 font-medium whitespace-nowrap">
            {t.workers.paused}
        </span>
    );
}

// The "what's rendering" block — only shown for a busy worker that has a current-file summary.
function RenderingBlock({ worker }) {
    const { t } = useI18n();
    const file = worker.currentFile;
    if (!file) {
        return null;
    }
    const progress = progressInfo(worker);
    return (
        <div className="rounded bg-muted/30 p-2 space-y-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
                <Film size={12} className="shrink-0 text-purple-400" />
                <span className="truncate text-xs font-medium" title={file.path}>
                    {file.name}
                </span>
            </div>
            <div className="text-[10px] text-muted-foreground/70 truncate">{renderMeta(file)}</div>
            {progress && <MetricBar label={t.workers.progress} percent={progress.pct} value={progress.label} />}
        </div>
    );
}

function MetricsBlock({ metrics }) {
    const { t } = useI18n();
    if (!metrics) {
        return <p className="text-xs text-muted-foreground/60 italic">{t.workers.awaitingMetrics}</p>;
    }
    const gpu = metrics.gpu;
    return (
        <>
            <MetricBar
                icon={<Cpu size={11} />}
                label={t.workers.cpu}
                percent={metrics.cpuPercent}
                value={metrics.cpuPercent == null ? "—" : `${metrics.cpuPercent}%`}
            />
            <MetricBar
                icon={<MemoryStick size={11} />}
                label={t.workers.memory}
                percent={ramPercent(metrics)}
                value={`${formatBytes(metrics.memUsed)} / ${formatBytes(metrics.memTotal)}`}
            />
            {gpu && (
                <MetricBar
                    label={t.workers.gpu}
                    percent={gpu.util}
                    value={`${gpu.util}% · ${formatBytes(gpu.memUsed)} / ${formatBytes(gpu.memTotal)}`}
                />
            )}
        </>
    );
}

// Worker card (widget): always shows full detail, with the pause/resume control in its header.
function WorkerCard({ worker, onTogglePause, busy }) {
    const { t } = useI18n();
    const { info, metrics } = worker;
    const name = info?.hostname || worker.runnerId;

    return (
        <Card>
            <div className="flex items-center gap-2 p-3">
                <Server size={14} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="font-medium truncate" title={name}>
                            {name}
                        </span>
                        <StatusBadge status={worker.status} />
                        {worker.paused && <PausedPill />}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 truncate">{worker.host}</div>
                </div>
                <PauseButton worker={worker} onTogglePause={onTogglePause} busy={busy} />
            </div>

            <div className="px-3 pb-3 space-y-2">
                {worker.status === "busy" && <RenderingBlock worker={worker} />}
                <MetricsBlock metrics={metrics} />

                <div className="mt-1 pt-2 border-t border-border/50 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <DetailRow label={t.workers.cores} value={info?.cores} />
                    <DetailRow
                        label={t.workers.load}
                        value={metrics?.loadAvg1 != null ? metrics.loadAvg1.toFixed(2) : null}
                    />
                    <DetailRow label={t.workers.uptime} value={formatUptime(metrics?.uptime)} />
                    <DetailRow label={t.workers.platform} value={info ? `${info.platform}/${info.arch}` : null} />
                    <DetailRow label={t.workers.version} value={info?.version} />
                    <DetailRow label={t.workers.connected} value={formatAge(worker.connectedAt)} />
                </div>
            </div>
        </Card>
    );
}

export default function WorkersTab({ workers, onTogglePause, busy }) {
    const { t } = useI18n();

    if (!workers || workers.length === 0) {
        return <EmptyState icon={Server} title={t.workers.empty} hint={t.workers.emptyHint} />;
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {workers.map((worker) => (
                <WorkerCard
                    key={worker.runnerId}
                    worker={worker}
                    onTogglePause={onTogglePause}
                    busy={busy[`pause-${worker.runnerId}`]}
                />
            ))}
        </div>
    );
}
