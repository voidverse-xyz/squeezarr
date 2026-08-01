"use client";

import { useState } from "react";
import { X, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import Input from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { FILTER_IDS, OUTPUT_MODE_KEYS } from "@/lib/constants";
import { OUTPUT_MODE } from "shared/domain.js";
import { useI18n } from "@/context/i18n";

// Label (+ optional hint) above a field — the repeated wrapper every form field below uses.
function FormField({ label, hint, children }) {
    return (
        <div>
            <div className="text-xs text-muted-foreground mb-1">
                {label} {hint && <span className="opacity-60">{hint}</span>}
            </div>
            {children}
        </div>
    );
}

export default function SettingForm({ initial, onSave, onCancel, busy = false }) {
    const { t } = useI18n();
    const [form, setForm] = useState(() => ({
        ...initial,
        filters: Array.isArray(initial.filters) ? initial.filters : [],
        matchPattern: typeof initial.matchPattern === "object" ? "" : initial.matchPattern || "",
        fileExtensions: Array.isArray(initial.fileExtensions)
            ? initial.fileExtensions.join(", ")
            : initial.fileExtensions || "",
    }));
    const [patternError, setPatternError] = useState("");

    function set(key, val) {
        setForm((f) => ({ ...f, [key]: val }));
    }

    function toggleFilter(filterId) {
        setForm((f) => {
            const filters = Array.isArray(f.filters) ? f.filters : [];
            return {
                ...f,
                filters: filters.includes(filterId) ? filters.filter((x) => x !== filterId) : [...filters, filterId],
            };
        });
    }

    function handleSave() {
        const matchPattern = form.matchPattern || "";
        if (matchPattern) {
            try {
                new RegExp(matchPattern);
                setPatternError("");
            } catch {
                setPatternError(t.settings.fieldPathFilterError);
                return;
            }
        } else {
            setPatternError("");
        }
        const fileExtensions = form.fileExtensions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        onSave({
            ...form,
            matchPattern,
            fileExtensions,
            filters: Array.isArray(form.filters) ? form.filters : [],
            deleteOnReject: !!form.deleteOnReject,
            priority: form.priority === "" || form.priority == null ? null : Number(form.priority),
        });
    }

    return (
        <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{initial.id ? t.settings.editTitle : t.settings.newTitle}</h3>
                <button
                    type="button"
                    onClick={() => set("enabled", form.enabled === false ? true : false)}
                    disabled={busy}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${
                        form.enabled === false
                            ? "border-muted-foreground/20 text-muted-foreground/50 hover:bg-muted/20"
                            : "border-green-500/30 text-green-400 hover:bg-green-500/10"
                    }`}
                >
                    {form.enabled === false ? t.settings.disabled : t.settings.enabled}
                </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <FormField label={t.settings.fieldName}>
                    <Input
                        value={form.name}
                        onChange={(e) => set("name", e.target.value)}
                        placeholder={t.settings.fieldNamePlaceholder}
                        autoFocus
                    />
                </FormField>
                <FormField label={t.settings.fieldPriority} hint={t.settings.fieldPriorityHint}>
                    <Input
                        value={form.priority}
                        onChange={(e) => set("priority", e.target.value)}
                        type="number"
                        placeholder={t.settings.fieldPriorityPlaceholder}
                    />
                </FormField>
            </div>

            <FormField label={t.settings.fieldExtensions} hint={t.settings.fieldExtensionsHint}>
                <Input
                    value={form.fileExtensions}
                    onChange={(e) => set("fileExtensions", e.target.value)}
                    placeholder={t.settings.fieldExtensionsPlaceholder}
                />
            </FormField>

            <FormField label={t.settings.fieldPathFilter} hint={t.settings.fieldPathFilterHint}>
                <Input
                    value={form.matchPattern}
                    onChange={(e) => set("matchPattern", e.target.value)}
                    placeholder={t.settings.fieldPathFilterPlaceholder}
                    className={patternError ? "border-red-500" : ""}
                />
                {patternError && <p className="text-xs text-red-400 mt-1">{patternError}</p>}
            </FormField>

            <FormField label={t.settings.fieldFlags} hint={t.settings.fieldFlagsHint}>
                <textarea
                    value={form.flags}
                    onChange={(e) => set("flags", e.target.value)}
                    rows={2}
                    className="w-full bg-input border border-border rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                    placeholder={t.settings.fieldFlagsPlaceholder}
                />
            </FormField>

            <FormField label={t.settings.fieldOutputMode}>
                <div className="flex gap-4">
                    {OUTPUT_MODE_KEYS.map((val) => (
                        <label key={val} className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input
                                type="radio"
                                value={val}
                                checked={form.outputMode === val}
                                onChange={() => set("outputMode", val)}
                                className="accent-primary"
                            />
                            {t.outputModes[val]}
                        </label>
                    ))}
                </div>
            </FormField>

            {form.outputMode === OUTPUT_MODE.adjacent && (
                <div className="grid grid-cols-3 gap-3 pl-4 border-l border-border">
                    <FormField label={t.settings.fieldPrefix}>
                        <Input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="" />
                    </FormField>
                    <FormField label={t.settings.fieldSuffix}>
                        <Input
                            value={form.suffix}
                            onChange={(e) => set("suffix", e.target.value)}
                            placeholder={t.settings.fieldSuffixPlaceholder}
                        />
                    </FormField>
                    <FormField label={t.settings.fieldExtension}>
                        <Input
                            value={form.outputExtension}
                            onChange={(e) => set("outputExtension", e.target.value)}
                            placeholder={t.settings.fieldExtensionPlaceholder}
                        />
                    </FormField>
                </div>
            )}

            <FormField label={t.settings.fieldFilters} hint={t.settings.fieldFiltersHint}>
                <div className="space-y-2">
                    {FILTER_IDS.map((id) => (
                        <label key={id} className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={(form.filters || []).includes(id)}
                                onChange={() => toggleFilter(id)}
                                className="mt-0.5 accent-primary"
                            />
                            <div>
                                <div className="text-sm">{t.filters[id].name}</div>
                                <div className="text-xs text-muted-foreground">{t.filters[id].description}</div>
                            </div>
                        </label>
                    ))}
                </div>
            </FormField>

            <FormField label={t.settings.fieldOnRejection}>
                <label className="flex items-start gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={!!form.deleteOnReject}
                        onChange={() => set("deleteOnReject", !form.deleteOnReject)}
                        className="mt-0.5 accent-primary"
                    />
                    <div>
                        <div className="text-sm">{t.settings.fieldDeleteOnReject}</div>
                        <div className="text-xs text-muted-foreground">{t.settings.fieldDeleteOnRejectDesc}</div>
                    </div>
                </label>
            </FormField>

            <div className="flex gap-2 justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                    <X size={13} /> {t.actions.cancel}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={busy || !form.name.trim()}>
                    <Save size={13} /> {initial.id ? t.actions.update : t.actions.add}
                </Button>
            </div>
        </Card>
    );
}
