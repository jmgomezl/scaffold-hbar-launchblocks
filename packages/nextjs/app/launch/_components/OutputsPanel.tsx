"use client";

import type { StepOutputRef } from "@sh/launchblocks/editor";
import { ChevronRightIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { notification } from "~~/utils/scaffold-hbar";

/**
 * Every output a step exposes, grouped by step, as the reference string to
 * type into a text field (memos, JSON messages). Id-type outputs can also be
 * dragged from the Outputs drawer onto an id socket. Groups start collapsed
 * so a long flow stays scannable.
 */
export function OutputsPanel({ outputs }: { outputs: StepOutputRef[] }) {
  if (!outputs.length) return <p className="text-sm opacity-70">Add steps to the Launch block to see their outputs.</p>;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notification.success(`Copied ${text}`);
    } catch {
      notification.error("Could not copy to the clipboard");
    }
  };

  const groups: { stepId: string; outputs: StepOutputRef[] }[] = [];
  for (const output of outputs) {
    const last = groups[groups.length - 1];
    if (last?.stepId === output.stepId) last.outputs.push(output);
    else groups.push({ stepId: output.stepId, outputs: [output] });
  }

  return (
    <div className="space-y-2 text-xs">
      <p className="opacity-70">
        Use these inside any text field; they are replaced with real values when the flow runs.
      </p>
      {groups.map(group => (
        <details key={group.stepId} className="group rounded-lg border border-base-300">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
            <span className="font-mono font-semibold">{group.stepId}</span>
            <span className="ml-auto opacity-60">
              {group.outputs.length} output{group.outputs.length === 1 ? "" : "s"}
            </span>
          </summary>
          <ul className="space-y-1 border-t border-base-300 px-2 py-1.5">
            {group.outputs.map(output => (
              <li key={output.reference} className="flex items-center gap-2">
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => copy(output.reference)}
                  aria-label={`Copy ${output.reference}`}
                >
                  <ClipboardDocumentIcon className="h-3.5 w-3.5" />
                </button>
                <code className="truncate">{output.reference}</code>
                <span className="ml-auto whitespace-nowrap opacity-60">{output.label}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
