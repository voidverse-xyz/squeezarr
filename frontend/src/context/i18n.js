"use client";

import { createContext, useContext } from "react";
import { useI18nState } from "@/hooks/i18n";

// Wiring only — never its own useState. The logic is in hooks/i18n.js.
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
    const value = useI18nState();
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
    const ctx = useContext(I18nContext);
    if (!ctx) {
        throw new Error("useI18n must be used inside <I18nProvider>");
    }
    return ctx;
}
