"use client";

import { useState } from "react";
import type { ApiError, RunResult, StepRecord } from "../_lib/api";
import type { StepStatus } from "../_lib/blocks";
import { ArrowTopRightOnSquareIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

export type RunState =
  | { phase: "idle" }
  | { phase: "running"; records: Record<string, StepRecord> }
  | { phase: "done"; records: Record<string, StepRecord>; result: RunResult }
  | { phase: "error"; records: Record<string, StepRecord>; error: ApiError };

const STATUS_BADGE: Record<StepStatus, string> = {
  pending: "badge-ghost",
  running: "badge-info",
  succeeded: "badge-success",
  failed: "badge-error",
  skipped: "badge-ghost opacity-60",
};

type Props = {
  steps: { id: string; type: string; label: string }[];
  run: RunState;
  hasPool: boolean;
  /** Who signs, for the idle summary: the default account or the connected wallet. */
  signedBy: string;
};

/**
 * Live run log: one collapsible row per step. Collapsed rows show status,
 * id and timing; expanding one shows its explorer links and details. Failed
 * steps start expanded so an error is never hidden behind a click.
 */
export function RunPanel({ steps, run, hasPool, signedBy }: Props) {
  const records = run.phase === "idle" ? {} : run.records;
  // Explicit user choices per step; unset rows follow the default (open only when failed).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (id: string, status: StepStatus) => expanded[id] ?? status === "failed";
  const setAll = (open: boolean) => setExpanded(Object.fromEntries(steps.map(step => [step.id, open])));

  if (run.phase === "idle") {
    return (
      <div className="space-y-3 text-sm">
        <p>
          <strong>{steps.length}</strong> step{steps.length === 1 ? "" : "s"} will run in order on{" "}
          <strong>testnet</strong>, signed by {signedBy}.
        </p>
        {hasPool && (
          <div className="alert alert-info py-2 text-xs">
            Seeding a SaucerSwap pool costs about 33 ℏ on testnet (SaucerSwap&apos;s fee plus creating the pool&apos;s
            LP token), on top of the HBAR you deposit. A full launch is about 60 ℏ.
          </div>
        )}
        <p className="opacity-70">Press Run to watch each block light up as its transaction reaches consensus.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {run.phase === "error" && (
        <div className="alert alert-error flex-col items-start gap-1 py-2 text-xs">
          <span className="font-semibold">{run.error.code}</span>
          <span>{run.error.message}</span>
          {run.error.hint && <span className="opacity-80">{run.error.hint}</span>}
        </div>
      )}
      {run.phase === "done" && (
        <div className={`alert py-2 text-xs ${run.result.status === "succeeded" ? "alert-success" : "alert-warning"}`}>
          {run.result.status === "succeeded"
            ? "Launch complete. Every step is on-chain; expand a step for its HashScan links."
            : `Stopped at ${run.result.error?.stepId}. Earlier steps are on-chain; later ones were skipped.`}
        </div>
      )}
      <div className="flex items-center justify-end gap-1">
        <button className="btn btn-ghost btn-xs" onClick={() => setAll(true)}>
          Expand all
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => setAll(false)}>
          Collapse all
        </button>
      </div>
      <ol className="space-y-1.5">
        {steps.map(step => {
          const record = records[step.id];
          const status: StepStatus = record?.status ?? "pending";
          const open = isOpen(step.id, status);
          const hasDetails = !!(record?.links.length || record?.error || typeof record?.outputs?.poolUrl === "string");
          return (
            <li key={step.id} className="rounded-lg border border-base-300">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left disabled:cursor-default"
                onClick={() => setExpanded(current => ({ ...current, [step.id]: !open }))}
                disabled={!hasDetails}
                aria-expanded={hasDetails ? open : undefined}
              >
                <ChevronRightIcon
                  className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""} ${hasDetails ? "" : "opacity-0"}`}
                />
                <span className={`badge badge-sm ${STATUS_BADGE[status]}`}>{status}</span>
                <span className="font-mono font-semibold">{step.id}</span>
                <span className="truncate opacity-60">{step.label}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap opacity-60">
                  {!open && record?.links.length ? (
                    <span className="text-xs">
                      {record.links.length} link{record.links.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {record?.durationMs !== undefined && <span>{(record.durationMs / 1000).toFixed(1)} s</span>}
                </span>
              </button>
              {open && hasDetails && (
                <div className="border-t border-base-300 px-2 pb-2 pt-1.5 pl-7">
                  {record?.links.length ? (
                    <ul className="space-y-0.5">
                      {record.links.map(link => (
                        <li key={link.url}>
                          <a
                            className="link link-primary inline-flex items-center gap-1 text-xs"
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {link.label}: {link.url.split("/").pop()}
                            <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {typeof record?.outputs?.poolUrl === "string" && (
                    <a
                      className="btn btn-xs btn-outline mt-2"
                      href={record.outputs.poolUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open the pool on SaucerSwap
                    </a>
                  )}
                  {record?.error && (
                    <div className="mt-1 text-xs text-error">
                      {record.error.message}
                      {record.error.hint && <div className="mt-0.5 opacity-80">{record.error.hint}</div>}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
