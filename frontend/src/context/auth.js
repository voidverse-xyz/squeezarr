"use client";

import { createContext, useContext } from "react";
import { useAuthState } from "@/hooks/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const value = useAuthState();
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error("useAuth must be used inside <AuthProvider>");
    }
    return ctx;
}
