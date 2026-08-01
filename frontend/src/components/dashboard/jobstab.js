"use client";

import { Fragment } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import StatusBadge from "@/components/statusbadge";
import DetailTable from "@/components/detailtable";
import { Card } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/utils";
import { useI18n } from "@/context/i18n";

function JobDetailRow({ job, t }) {
    return (
        <tr className="border-b border-border/50 last:border-0 bg-muted/10">
            <td colSpan={7} className="px-6 py-3">
                <DetailTable
                    rows={[
                        [
                            t.jobs.detailId,
                            <span key="id" className="font-mono">
                                {job.jobId}
                            </span>,
                        ],
                        [t.jobs.detailCreated, formatDateTime(job.createdAt)],
                        [
                            t.jobs.detailProgress,
                            <span key="progress" className="font-mono">
                                {job.progress || "—"}
                            </span>,
                        ],
                        ...(job.error
                            ? [
                                  [
                                      t.jobs.detailError,
                                      <span key="error" className="text-red-400">
                                          {job.error}
                                      </span>,
                                  ],
                              ]
                            : []),
                    ]}
                />
            </td>
        </tr>
    );
}

function JobRow({ job, isExpanded, onToggleExpand, t }) {
    return (
        <Fragment>
            <tr
                onClick={() => onToggleExpand(job.jobId)}
                className="border-b border-border/50 last:border-0 hover:bg-muted/20 cursor-pointer"
            >
                <td className="px-2 py-2 text-muted-foreground">
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </td>
                <td className="px-3 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                    {formatDateTime(job.createdAt)}
                </td>
                <td className="px-3 py-2 font-medium">{t.jobTypes[job.type] || job.type}</td>
                <td className="px-3 py-2">
                    <StatusBadge status={job.status} />
                </td>
                <td className="px-3 py-2 hidden sm:table-cell font-mono text-muted-foreground">
                    {job.progress || "—"}
                </td>
                <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">{formatAge(job.createdAt)}</td>
                <td className="px-3 py-2 hidden lg:table-cell text-red-400 max-w-40 truncate" title={job.error}>
                    {job.error || ""}
                </td>
            </tr>
            {isExpanded && <JobDetailRow job={job} t={t} />}
        </Fragment>
    );
}

export default function JobsTab({ jobs, expandedJobs, onToggleExpand }) {
    const { t } = useI18n();
    return (
        <section>
            <Card className="overflow-hidden">
                {jobs.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">{t.dashboard.noJobs}</p>
                ) : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-border text-muted-foreground">
                                <th className="w-6 px-2 py-2" />
                                <th className="text-left px-3 py-2 font-medium">{t.jobs.colDateTime}</th>
                                <th className="text-left px-3 py-2 font-medium">{t.jobs.colType}</th>
                                <th className="text-left px-3 py-2 font-medium">{t.jobs.colStatus}</th>
                                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">
                                    {t.jobs.colProgress}
                                </th>
                                <th className="text-left px-3 py-2 font-medium hidden md:table-cell">
                                    {t.jobs.colCreated}
                                </th>
                                <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">
                                    {t.jobs.colError}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((job) => (
                                <JobRow
                                    key={job.jobId}
                                    job={job}
                                    isExpanded={expandedJobs.has(job.jobId)}
                                    onToggleExpand={onToggleExpand}
                                    t={t}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </Card>
        </section>
    );
}
