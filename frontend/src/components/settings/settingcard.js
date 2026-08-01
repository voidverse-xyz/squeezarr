"use client";

import { Pencil, Trash2 } from "lucide-react";
import { OUTPUT_MODE } from "shared/domain.js";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

// Read-only summary card for one transcode setting. `formActive` disables its controls while
// any setting form (new or edit) is open, matching the original single-form-at-a-time UX.
export default function SettingCard({ setting, formActive, onToggleEnabled, onEdit, onDelete }) {
    const { t } = useI18n();
    // Built-in defaults are code-sourced and read-only: their enabled state can't be toggled and they
    // can't be deleted (editing one forks a copy). User settings keep the full controls.
    const isDefault = setting.isDefault;
    const enabledTitle = isDefault
        ? t.settings.defaultBadge
        : setting.enabled === false
          ? t.settings.enableTitle
          : t.settings.disableTitle;
    return (
        <Card
            className={cn("px-3 py-3 hover:bg-muted/5 transition-opacity", setting.enabled === false && "opacity-50")}
        >
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{setting.name}</span>
                        <button
                            onClick={() => !formActive && !isDefault && onToggleEnabled(setting.id)}
                            disabled={formActive || isDefault}
                            title={enabledTitle}
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors disabled:cursor-default ${
                                setting.enabled === false
                                    ? "border-muted-foreground/20 text-muted-foreground/50 hover:bg-muted/20"
                                    : "border-green-500/30 text-green-400 hover:bg-green-500/10"
                            }`}
                        >
                            {setting.enabled === false ? t.settings.disabledBadge : t.settings.enabledBadge}
                        </button>
                        {isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-500/30 text-blue-400">
                                {t.settings.defaultBadge}
                            </span>
                        )}
                        {setting.priority != null && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                                p{setting.priority}
                            </span>
                        )}
                        {setting.outputMode === OUTPUT_MODE.overwrite ? (
                            <span className="text-[10px] px-1.5 py-0.5 bg-orange-400/10 text-orange-400 rounded">
                                {t.settings.overwriteMode}
                            </span>
                        ) : (
                            <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                                {setting.prefix || ""}
                                <span className="opacity-50">name</span>
                                {setting.suffix || ""}.{setting.outputExtension || "mkv"}
                            </span>
                        )}
                        {setting.fileExtensions?.length > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                                {setting.fileExtensions.join(", ")}
                            </span>
                        )}
                        {setting.filters?.length > 0 && (
                            <span className="text-[10px] text-blue-400">
                                {t.settings.filterCount(setting.filters.length)}
                            </span>
                        )}
                    </div>
                    <p className="text-xs font-mono text-muted-foreground truncate" title={setting.flags}>
                        ffmpeg … {setting.flags}
                    </p>
                    {setting.matchPattern && (
                        <p className="text-[10px] text-muted-foreground/70 font-mono truncate">
                            /{setting.matchPattern}/
                        </p>
                    )}
                </div>
                <div className="flex gap-1 shrink-0">
                    <button
                        onClick={() => onEdit(setting.id)}
                        disabled={formActive}
                        className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t.actions.edit}
                    >
                        <Pencil size={13} />
                    </button>
                    {!isDefault && (
                        <button
                            onClick={() => onDelete(setting.id)}
                            disabled={formActive}
                            className="p-1 text-muted-foreground hover:text-red-400 disabled:opacity-30"
                            title={t.actions.delete}
                        >
                            <Trash2 size={13} />
                        </button>
                    )}
                </div>
            </div>
        </Card>
    );
}
