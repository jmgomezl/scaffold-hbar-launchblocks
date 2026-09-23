"use client";

import { useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";

/** A shell command with a copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-base-300 py-2 pl-4 pr-2 font-mono text-sm">
      <span className="select-none opacity-50" aria-hidden>
        $
      </span>
      <code className="min-w-0 grow overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        className="btn btn-ghost btn-sm btn-square shrink-0"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard can be blocked; the command is still selectable.
          }
        }}
      >
        {copied ? <CheckIcon className="h-4 w-4 text-success" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
      </button>
    </div>
  );
}
