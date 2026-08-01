"use client";

import { useState, useEffect, useCallback } from "react";
import { locales, DEFAULT_LANG } from "@/lib/strings";

// All the i18n state/effect logic lives here (no JSX, no context). The provider in
// context/i18n.js does nothing but wire this into a Context. Returns the active translation
// table plus the current language and a setter.
export function useI18nState() {
    const [lang, setLangState] = useState(DEFAULT_LANG);

    // Hydrate from localStorage after mount (avoids SSR mismatch). Setting state here is the whole
    // point — a one-shot, post-mount read of a client-only store — so the effect rule is moot.
    useEffect(() => {
        const stored = localStorage.getItem("lang");
        if (stored && locales[stored]) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only hydration
            setLangState(stored);
        }
    }, []);

    const setLang = useCallback((code) => {
        if (!locales[code]) {
            return;
        }
        setLangState(code);
        localStorage.setItem("lang", code);
    }, []);

    return { t: locales[lang], lang, setLang };
}
