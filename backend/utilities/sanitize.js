// Request-boundary sanitizers: raw input -> safe value. They coerce and never throw — routes run
// each field through one of these before handing it to a controller, which then validates business
// rules and returns the getResult envelope. (The deep settings-payload validation lives in
// services/settings-validation.js.)
const str = (raw) => (typeof raw === "string" ? raw.trim() : "");

export const sanitize = {
    text: (raw) => str(raw),
    bool: (raw) => raw === true || raw === "true",
    int: (raw, { min, max, fallback } = {}) => {
        let n = parseInt(raw, 10);
        if (Number.isNaN(n)) return fallback;
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        return n;
    },
    enum: (raw, allowed) => (allowed.includes(raw) ? raw : undefined),
    list: (raw) => (Array.isArray(raw) ? raw.map(str).filter(Boolean) : []),
};
