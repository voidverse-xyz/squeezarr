"use client";

import { RefreshCw, Pause, Play, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Logo from "@/components/logo";
import { useI18n } from "@/context/i18n";
import { useAuth } from "@/context/auth";

// Shared page header: app title, the processing pause/resume toggle, a scan button, and a
// page-specific nav button (passed in as `navButton`). Used by both the dashboard and the
// settings page so the two never drift.
export default function Header({
    onTitleClick,
    processingPaused,
    processingBusy = false,
    onToggleProcessing,
    onScan,
    scanning,
    scanDisabled = false,
    navButton,
}) {
    const router = useRouter();
    const { t } = useI18n();
    const { logout } = useAuth();

    async function handleLogout() {
        await logout();
        router.replace("/");
    }

    return (
        <div className="flex items-center justify-between">
            <h1
                className="flex items-center gap-2 text-lg font-semibold cursor-pointer hover:opacity-70 transition-opacity"
                onClick={onTitleClick}
            >
                <Logo size={22} />
                {t.app.title}
            </h1>
            <div className="flex items-center gap-2">
                <button
                    onClick={onToggleProcessing}
                    disabled={processingBusy}
                    title={processingPaused ? t.processing.resumeTitle : t.processing.pauseTitle}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border transition-colors ${
                        processingPaused
                            ? "border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                            : "border-green-500/50 bg-green-500/10 text-green-400 hover:bg-green-500/20"
                    }`}
                >
                    {processingPaused ? <Play size={12} /> : <Pause size={12} />}
                    {processingPaused ? t.processing.paused : t.processing.active}
                </button>
                <Button
                    onClick={onScan}
                    disabled={scanning || processingPaused || scanDisabled}
                    variant="outline"
                    size="sm"
                >
                    <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
                    {scanning ? t.actions.scanning : t.actions.scan}
                </Button>
                {navButton}
                <Button variant="outline" size="sm" title={t.auth.logout} onClick={handleLogout}>
                    <LogOut size={14} />
                </Button>
            </div>
        </div>
    );
}
