"use client";

import { useState } from "react";
import type { ApiError, RunResult, StepRecord } from "../_lib/api";
import type { StepStatus } from "../_lib/blocks";
import type { FeeEstimate } from "@sh/launchblocks/editor";
import { ArrowTopRightOnSquareIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { notification } from "~~/utils/scaffold-hbar";

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
  /** What one run costs, once the flow is valid. */
  estimate: FeeEstimate | null;
  /** Who signs, for the idle summary: the default account or the connected wallet. */
  signedBy: string;
  /** Who pays, for the cost line: "the default account" or "your wallet". */
  payer: string;
};

const hbar = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ℏ`;

/** The run's cost, with a per-step breakdown one click away. */
function CostSummary({ estimate, steps, payer }: { estimate: FeeEstimate; steps: Props["steps"]; payer: string }) {
  const labels = new Map(steps.map(step => [step.id, step.label]));
  return (
    <details className="group rounded-lg border border-base-300 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <ChevronRightIcon className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="text-sm">
          Costs about <strong>{hbar(estimate.perRunHbar)}</strong>, paid by {payer}
        </span>
      </summary>
      <div className="border-t border-base-300 px-3 py-2">
        <table className="w-full">
          <thead className="opacity-60">
            <tr>
              <th className="text-left font-normal">Step</th>
              <th className="text-right font-normal">Fee</th>
              <th className="text-right font-normal">HBAR sent</th>
            </tr>
          </thead>
          <tbody>
            {estimate.lines.map(line => (
              <tr key={line.stepId}>
                <td className="truncate pr-2">
                  <span className="font-mono">{line.stepId}</span>{" "}
                  <span className="opacity-60">{labels.get(line.stepId)}</span>
                </td>
                <td className="text-right">{hbar(line.feeHbar)}</td>
                <td className="text-right">{line.spentHbar ? hbar(line.spentHbar) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {estimate.unknownAmounts.length > 0 && (
          <p className="mt-2 opacity-70">
            Not included: the HBAR that {estimate.unknownAmounts.join(", ")} sends, which comes from an earlier step.
          </p>
        )}
        <p className="mt-2 opacity-60">
          From fees measured on testnet. Hedera prices fees in US dollars, so the HBAR amount moves with its price.
        </p>
      </div>
    </details>
  );
}

/** The topic a run opened for its launch log: its public page is rebuilt from it. */
function launchLogTopic(records: Record<string, StepRecord>): string | null {
  const record = Object.values(records).find(
    candidate => candidate.type === "hcs.createTopic" && typeof candidate.outputs?.topicId === "string",
  );
  return (record?.outputs?.topicId as string | undefined) ?? null;
}

function LaunchPageCard({ topicId }: { topicId: string }) {
  const path = `/launches/${topicId}`;
  const copy = async () => {
    const link = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(link);
      notification.success("Link to the launch page copied");
    } catch {
      window.prompt("Copy the link to the launch page:", link);
    }
  };
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
      <p className="text-sm font-semibold">This launch has a public page</p>
      <p className="mt-0.5 opacity-70">
        Rebuilt from its HCS log, with the token, the pool&apos;s price and any locks and schedules as they are now.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a className="btn btn-primary btn-xs" href={path} target="_blank" rel="noreferrer">
          Open the launch page
          <ArrowTopRightOnSquareIcon className="h-3 w-3" />
        </a>
        <button type="button" className="btn btn-xs" onClick={() => void copy()}>
          Copy its link
        </button>
      </div>
    </div>
  );
}

/**
 * Live run log: one collapsible row per step. Collapsed rows show status,
 * id and timing; expanding one shows its explorer links and details. Failed
 * steps start expanded so an error is never hidden behind a click.
 */
export function RunPanel({ steps, run, estimate, signedBy, payer }: Props) {
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
        {estimate && <CostSummary estimate={estimate} steps={steps} payer={payer} />}
        <p className="opacity-70">Press Run to watch each block light up as its transaction reaches consensus.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {run.phase === "error" && (
        <div className="alert alert-error flex-col items-start gap-1 py-2 text-xs [overflow-wrap:anywhere]">
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
      {run.phase === "done" && launchLogTopic(run.records) && (
        <LaunchPageCard topicId={launchLogTopic(run.records) as string} />
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
