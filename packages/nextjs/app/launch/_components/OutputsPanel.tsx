"use client";

import type { StepOutputRef } from "@sh/launchblocks/editor";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { notification } from "~~/utils/scaffold-hbar";

/**
 * Every output a step exposes, as the reference string to type into a text
 * field (memos, JSON messages). Id-type outputs can also be dragged from the
 * Outputs drawer onto an id socket.
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
  return (
    <div className="space-y-2 text-xs">
      <p className="opacity-70">
        Use these inside any text field; they are replaced with real values when the flow runs.
      </p>
      <ul className="space-y-1">
        {outputs.map(output => (
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
    </div>
  );
}
