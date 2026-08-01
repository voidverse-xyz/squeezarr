import js from "@eslint/js";
import globals from "globals";

// Minimal flat config for the backend: plain Node ESM, no framework. ESLint's recommended rules
// plus Node globals (console/process/etc.) so `no-undef` doesn't fire on them.
export default [
    { ignores: ["node_modules/**"] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: "module",
            globals: { ...globals.node },
        },
        rules: {
            // Best-effort cleanup (e.g. `proc.kill()` in a `catch {}`) is an intentional pattern.
            "no-empty": ["error", { allowEmptyCatch: true }],
            // Allow the omit-by-rest idiom, e.g. `const { ws, cancelSent, ...rest } = runner`.
            "no-unused-vars": ["error", { ignoreRestSiblings: true, argsIgnorePattern: "^_" }],
        },
    },
];
