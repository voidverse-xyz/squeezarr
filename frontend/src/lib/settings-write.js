import { settleMutation } from "./mutation-result.js";

function data(result) {
    return result?.data ?? null;
}

// Evaluate a functional settings edit once per authoritative, explicit attempt. Only a parsed
// settings_conflict proves the write did not apply and permits one rebase. Ambiguous transport,
// timeout, or parse outcomes are reconciled but never rebased/replayed.
export async function coordinateSettingsWrite({ current, update, save, read }) {
    const functional = typeof update === "function";
    let base = current;
    let candidate = functional ? update(base) : update;
    const saveOnce = (value) => settleMutation({ mutate: () => save(value), reconcile: read });
    let settlement = await saveOnce(candidate);

    if (!settlement.result?.success && settlement.result?.output === "settings_conflict" && functional) {
        base = data(settlement.result) || data(await read());
        if (base) {
            candidate = update(base);
            settlement = await saveOnce(candidate);
        }
    }

    return { candidate, settlement };
}
