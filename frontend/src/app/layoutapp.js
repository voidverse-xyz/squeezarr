"use client";

import { I18nProvider } from "@/context/i18n";
import { AuthProvider } from "@/context/auth";

// Project convention (not a Next.js file): a "use client" component whose only job is
// nesting Context providers in a fixed order, with zero markup of its own. As more providers
// are added (toast, network, etc.) they nest here.
export function AppLayout({ children }) {
    return (
        <I18nProvider>
            <AuthProvider>{children}</AuthProvider>
        </I18nProvider>
    );
}
