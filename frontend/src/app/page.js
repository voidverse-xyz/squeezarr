"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, LogIn } from "lucide-react";
import Logo from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Input from "@/components/ui/input";
import { useAuth } from "@/context/auth";
import { useI18n } from "@/context/i18n";
import { authViewState } from "@/lib/operational-view";

export default function LoginPage() {
    const router = useRouter();
    const { t } = useI18n();
    const { ready, authenticated, unavailable, retry, login } = useAuth();
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (ready && authenticated) {
            router.replace("/dashboard");
        }
    }, [ready, authenticated, router]);

    async function handleSubmit(event) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            const result = await login(password);
            if (result?.success) {
                router.replace("/dashboard");
                return;
            }
            setError(result?.output || "default");
        } finally {
            setBusy(false);
        }
    }

    const viewState = authViewState({ ready, authenticated, unavailable });
    if (viewState === "checking" || viewState === "authenticated") {
        return <div className="p-6 text-sm text-muted-foreground">{t.auth.checking}</div>;
    }
    if (viewState === "unavailable") {
        return (
            <main className="min-h-full flex items-center justify-center p-6">
                <Card className="w-full max-w-sm p-5 space-y-3">
                    <p className="text-sm text-muted-foreground">{t.auth.unavailable}</p>
                    <Button className="w-full" variant="outline" onClick={retry}>
                        {t.actions.retry}
                    </Button>
                </Card>
            </main>
        );
    }

    return (
        <main className="min-h-full flex items-center justify-center p-6">
            <Card className="w-full max-w-sm p-5 space-y-4">
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-lg font-semibold">
                        <Logo size={24} />
                        {t.app.title}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Lock size={15} />
                        {t.auth.signInTitle}
                    </div>
                </div>

                <form className="space-y-3" onSubmit={handleSubmit}>
                    <label className="block space-y-1.5">
                        <span className="text-xs text-muted-foreground">{t.auth.passwordLabel}</span>
                        <Input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoFocus
                        />
                    </label>

                    {error && <p className="text-xs text-red-400">{t.auth.errors[error] || t.auth.errors.default}</p>}

                    <Button type="submit" className="w-full" disabled={busy || !password}>
                        <LogIn size={14} />
                        {busy ? t.auth.signingIn : t.auth.signIn}
                    </Button>
                </form>
            </Card>
        </main>
    );
}
