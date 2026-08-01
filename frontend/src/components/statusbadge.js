"use client";

import { STATUS_CLS, DEFAULT_STATUS_CLS } from "@/lib/constants";
import { useI18n } from "@/context/i18n";

export default function StatusBadge({ status }) {
    const { t } = useI18n();
    const cls = STATUS_CLS[status] || DEFAULT_STATUS_CLS;
    const label = t.statuses[status] || t.statuses._unknown;
    return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>;
}
