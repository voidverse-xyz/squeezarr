"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import Header from "@/components/header";
import AuthGate from "@/components/authgate";
import Input from "@/components/ui/input";
import Field from "@/components/ui/field";
import SettingForm from "@/components/settings/settingform";
import SettingCard from "@/components/settings/settingcard";
import { useSettings } from "@/hooks/settings";
import { OUTPUT_MODE } from "shared/domain.js";
import { isAmbiguousMutationResult } from "@/lib/mutation-result";
import { settingsViewState } from "@/lib/operational-view";
import { SUPPORTED_LANGUAGES } from "@/lib/strings";
import { useI18n } from "@/context/i18n";

function generateId() {
    return Math.random().toString(36).slice(2, 10);
}

const EMPTY_SETTING = {
    id: "",
    name: "",
    enabled: true,
    priority: "",
    fileExtensions: [],
    matchPattern: "",
    flags: "-c:v libx265 -crf 26 -preset slow -c:a copy",
    outputMode: OUTPUT_MODE.adjacent,
    prefix: "",
    suffix: ".hevc",
    outputExtension: "mkv",
    filters: [],
    deleteOnReject: false,
};

function SettingsContent() {
    const router = useRouter();
    const { t, lang, setLang } = useI18n();
    const {
        settings,
        setSettings,
        loading,
        loadError,
        retry,
        persist,
        saving,
        saved,
        saveError,
        saveAmbiguous,
        saveReconciled,
        pauseError,
        pausing,
        pauseBlocked,
        retryProcessingReconciliation,
        scanning,
        scan,
        scanError,
        scanBlocked,
        processingPaused,
        toggleProcessing,
    } = useSettings();
    const [formState, setFormState] = useState(null);

    async function handleSettingSave(formData) {
        const newId = generateId();
        const createdAt = Date.now();
        if (
            await persist((current) => {
                const list = current.transcodeSettings || [];
                const existing = formData.id ? list.find((s) => s.id === formData.id) : null;
                const fork = !existing || existing.isDefault;
                const entry = fork ? { ...formData, id: newId, isDefault: false, createdAt } : { ...formData };
                const updated = fork ? [...list, entry] : list.map((s) => (s.id === entry.id ? entry : s));
                return { ...current, transcodeSettings: updated };
            })
        ) {
            setFormState(null);
        }
    }

    function handleSettingDelete(id) {
        persist((current) => ({
            ...current,
            transcodeSettings: (current.transcodeSettings || []).filter((s) => s.id !== id),
        }));
    }

    function toggleEnabled(id) {
        persist((current) => ({
            ...current,
            transcodeSettings: (current.transcodeSettings || []).map((s) =>
                s.id === id ? { ...s, enabled: s.enabled === false ? true : false } : s,
            ),
        }));
    }

    const viewState = settingsViewState({ loading, loadError, settings });
    if (viewState === "loading") {
        return <div className="p-6 text-sm text-muted-foreground">{t.dashboard.loading}</div>;
    }
    if (viewState === "error") {
        return (
            <div className="p-6 space-y-3 text-sm text-muted-foreground">
                <p>{t.settings.loadError}</p>
                <Button size="sm" variant="outline" onClick={retry}>
                    {t.actions.retry}
                </Button>
            </div>
        );
    }

    // Order: enabled first, then built-in defaults, then user-made — ties broken by priority, then age.
    const sortedSettings = [...(settings.transcodeSettings || [])].sort((a, b) => {
        const enabledRank = (s) => (s.enabled === false ? 1 : 0);
        const defaultRank = (s) => (s.isDefault ? 0 : 1);
        return (
            enabledRank(a) - enabledRank(b) ||
            defaultRank(a) - defaultRank(b) ||
            (a.priority ?? 999) - (b.priority ?? 999) ||
            String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
        );
    });

    return (
        <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
            <Header
                onTitleClick={() => router.push("/dashboard")}
                processingPaused={processingPaused}
                processingBusy={pausing || pauseBlocked}
                onToggleProcessing={toggleProcessing}
                onScan={scan}
                scanning={scanning}
                scanDisabled={scanBlocked}
                navButton={
                    <Button
                        variant="outline"
                        size="sm"
                        title={t.nav.dashboard}
                        onClick={() => router.push("/dashboard")}
                    >
                        <Home size={14} />
                    </Button>
                }
            />

            {pauseError && (
                <div className="flex items-center justify-center gap-3 text-xs text-red-400">
                    <span>
                        {t.settings.pauseError}
                        {isAmbiguousMutationResult(pauseError)
                            ? ` ${
                                  pauseError.reconciled
                                      ? t.settings.ambiguousMutation
                                      : t.settings.pauseReconciliationRequired
                              }`
                            : ""}
                    </span>
                    {pauseBlocked && (
                        <Button size="sm" variant="outline" onClick={retryProcessingReconciliation}>
                            {t.actions.refresh}
                        </Button>
                    )}
                </div>
            )}

            {scanError && (
                <div className="flex items-center justify-center gap-3 text-xs text-red-400">
                    <span>
                        {t.settings.scanError}
                        {scanError.ambiguous ? ` ${t.settings.ambiguousScan}` : ""}
                    </span>
                    {!scanError.ambiguous && (
                        <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>
                            {t.actions.retry}
                        </Button>
                    )}
                </div>
            )}

            {/* General */}
            <section className="space-y-3 max-w-2xl mx-auto">
                <div className="border-b border-border pb-2 flex items-center justify-between">
                    <h2 className="text-sm font-medium">{t.settings.generalTitle}</h2>
                    <div className="flex items-center gap-2">
                        {saveError && (
                            <span className="text-xs text-red-400">
                                {t.settings.saveErrors[saveError] || t.settings.saveError}
                                {saveAmbiguous
                                    ? ` ${
                                          saveReconciled
                                              ? t.settings.ambiguousMutation
                                              : t.settings.ambiguousMutationRefreshFailed
                                      }`
                                    : ""}
                            </span>
                        )}
                        <Button onClick={() => persist(settings)} disabled={saving} size="sm">
                            <Save size={14} />
                            {saving ? t.actions.saving : saved ? t.actions.saved : t.actions.save}
                        </Button>
                    </div>
                </div>
                <Field label={t.settings.languageLabel}>
                    <select
                        value={lang}
                        onChange={(e) => setLang(e.target.value)}
                        className="bg-input border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                        {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                            <option key={code} value={code}>
                                {label}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label={t.settings.fieldVideoExtensions} description={t.settings.fieldVideoExtensionsDesc}>
                    <Input
                        value={(settings.videoExtensions || []).join(", ")}
                        onChange={(e) =>
                            setSettings((s) => ({
                                ...s,
                                videoExtensions: e.target.value
                                    .split(",")
                                    .map((x) => x.trim())
                                    .filter(Boolean),
                            }))
                        }
                        placeholder={t.settings.fieldVideoExtensionsPlaceholder}
                        disabled={saving}
                    />
                </Field>
                <Field label={t.settings.fieldAutoScan} description={t.settings.fieldAutoScanDesc}>
                    <Input
                        type="number"
                        min="0"
                        value={settings.autoScanIntervalMinutes ?? ""}
                        onChange={(e) =>
                            setSettings((s) => ({ ...s, autoScanIntervalMinutes: Number(e.target.value) }))
                        }
                        disabled={saving}
                    />
                </Field>
            </section>

            {/* Transcode Settings */}
            <section className="space-y-3 max-w-2xl mx-auto">
                <div className="border-b border-border pb-2 flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-medium">{t.settings.transcodeTitle}</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">{t.settings.transcodeDesc}</p>
                    </div>
                    <Button
                        onClick={() => setFormState({ editing: null })}
                        variant="outline"
                        size="sm"
                        disabled={!!formState || saving}
                    >
                        <Plus size={13} /> {t.actions.add}
                    </Button>
                </div>

                {formState && formState.editing === null && (
                    <SettingForm
                        initial={{ ...EMPTY_SETTING }}
                        onSave={handleSettingSave}
                        onCancel={() => setFormState(null)}
                        busy={saving}
                    />
                )}

                {sortedSettings.length === 0 && !formState && (
                    <p className="text-sm text-muted-foreground">{t.settings.noSettings}</p>
                )}

                <div className="space-y-2">
                    {sortedSettings.map((setting) => (
                        <div key={setting.id}>
                            {formState?.editing === setting.id ? (
                                <SettingForm
                                    initial={{
                                        ...setting,
                                        matchPattern:
                                            typeof setting.matchPattern === "object" ? "" : setting.matchPattern || "",
                                        fileExtensions: (setting.fileExtensions || []).join(", "),
                                    }}
                                    onSave={handleSettingSave}
                                    onCancel={() => setFormState(null)}
                                    busy={saving}
                                />
                            ) : (
                                <SettingCard
                                    setting={setting}
                                    formActive={!!formState || saving}
                                    onToggleEnabled={toggleEnabled}
                                    onEdit={(id) => setFormState({ editing: id })}
                                    onDelete={handleSettingDelete}
                                />
                            )}
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

export default function SettingsPage() {
    return (
        <AuthGate>
            <SettingsContent />
        </AuthGate>
    );
}
