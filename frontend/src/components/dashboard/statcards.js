"use client";

import { Clapperboard, HardDrive, Server, Layers, Clock, Loader2, CheckCircle2, Cpu, Moon } from "lucide-react";
import SectionHeader from "@/components/sectionheader";
import { Card } from "@/components/ui/card";
import { STAT_CARD_KEYS } from "@/lib/constants";
import { formatBytes } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

// Per-stat icon + chip color, mirroring the status badge palette (constants.STATUS_CLS).
const FILE_TONE = {
    total: { icon: Layers, chip: "bg-foreground/10 text-foreground" },
    queued: { icon: Clock, chip: "bg-blue-400/10 text-blue-400" },
    processing: { icon: Loader2, chip: "bg-purple-400/10 text-purple-400" },
    done: { icon: CheckCircle2, chip: "bg-emerald-400/10 text-emerald-400" },
};

const WORKER_TONE = {
    total: { icon: Server, chip: "bg-foreground/10 text-foreground" },
    busy: { icon: Cpu, chip: "bg-purple-400/10 text-purple-400" },
    idle: { icon: Moon, chip: "bg-emerald-400/10 text-emerald-400" },
};

// One clickable stat inside a combined widget: a colored icon chip beside the count, with an
// optional label below it (omitted for the cramped Workers tiles, which use `title` instead).
function StatTile({ tone, label, value, title, onClick }) {
    const Icon = tone.icon;
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            className="flex items-center gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/50"
        >
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tone.chip}`}>
                <Icon size={20} />
            </span>
            <span className="min-w-0">
                <span className="block text-2xl font-semibold leading-none tabular-nums">{value}</span>
                {label && <span className="mt-1.5 block truncate text-[11px] text-muted-foreground">{label}</span>}
            </span>
        </button>
    );
}

export default function StatCards({ stats, statsData, workers, onNavigate }) {
    const { t } = useI18n();
    const current = statsData?.currentLibrarySize || 0;
    const original = statsData?.originalLibrarySize || 0;
    const saved = original - current;
    const pct = original > 0 && saved > 0 ? ((saved / original) * 100).toFixed(1) : null;

    const totalWorkers = workers?.length || 0;
    const busyWorkers = workers?.filter((w) => w.status === "busy").length || 0;
    const idleWorkers = totalWorkers - busyWorkers;

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Files widget — the former per-status cards combined into one */}
            <Card className="p-3 sm:col-span-2 flex flex-col">
                <SectionHeader icon={Clapperboard} label={t.widgets.files} />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 flex-1 content-center">
                    {STAT_CARD_KEYS.map((key) => (
                        <StatTile
                            key={key}
                            tone={FILE_TONE[key]}
                            label={t.statCardLabels[key]}
                            value={stats[key] ?? 0}
                            onClick={() => onNavigate("files", key === "total" ? "all" : key)}
                        />
                    ))}
                </div>
            </Card>

            {/* Workers widget — sits in the middle; tiles are icon + count only (labels via title) */}
            <Card className="p-3 flex flex-col">
                <SectionHeader icon={Server} label={t.widgets.workers} />
                <div className="flex flex-1 items-center justify-around gap-1">
                    <StatTile
                        tone={WORKER_TONE.total}
                        title={t.statCardLabels.total}
                        value={totalWorkers}
                        onClick={() => onNavigate("workers")}
                    />
                    <StatTile
                        tone={WORKER_TONE.busy}
                        title={t.statuses.busy}
                        value={busyWorkers}
                        onClick={() => onNavigate("workers")}
                    />
                    <StatTile
                        tone={WORKER_TONE.idle}
                        title={t.statuses.idle}
                        value={idleWorkers}
                        onClick={() => onNavigate("workers")}
                    />
                </div>
            </Card>

            {/* Storage widget */}
            <Card
                className="p-3 cursor-pointer hover:border-border/80 flex flex-col"
                onClick={() => onNavigate("stats")}
            >
                <SectionHeader icon={HardDrive} label={t.storage.label} />
                <div className="flex-1 flex flex-col justify-center">
                    <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                        {t.storage.current}
                    </div>
                    <div className="text-xl font-semibold tabular-nums leading-tight">{formatBytes(current)}</div>
                    <div className="border-t border-border my-1.5" />
                    <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                        {t.storage.original}
                    </div>
                    <div className="flex items-baseline gap-1.5">
                        <span className="text-sm tabular-nums text-muted-foreground">{formatBytes(original)}</span>
                        {pct && <span className="text-[10px] text-green-400 font-medium">−{pct}%</span>}
                    </div>
                </div>
            </Card>
        </div>
    );
}
