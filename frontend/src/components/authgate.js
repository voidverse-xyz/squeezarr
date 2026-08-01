"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/auth";
import { useI18n } from "@/context/i18n";
import { Button } from "@/components/ui/button";
import { authViewState } from "@/lib/operational-view";

export default function AuthGate({ children }) {
    const router = useRouter();
    const { t } = useI18n();
    const { ready, authenticated, unavailable, retry } = useAuth();

    useEffect(() => {
        if (ready && !authenticated && !unavailable) {
            router.replace("/");
        }
    }, [ready, authenticated, unavailable, router]);

    const viewState = authViewState({ ready, authenticated, unavailable });
    if (viewState === "checking") {
        return <div className="p-6 text-sm text-muted-foreground">{t.auth.checking}</div>;
    }
    if (viewState === "unavailable") {
        return (
            <div className="p-6 space-y-3 text-sm text-muted-foreground">
                <p>{t.auth.unavailable}</p>
                <Button size="sm" variant="outline" onClick={retry}>
                    {t.actions.retry}
                </Button>
            </div>
        );
    }
    if (viewState === "anonymous") return <div className="p-6 text-sm text-muted-foreground">{t.auth.checking}</div>;

    return children;
}
