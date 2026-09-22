"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../_lib/api";
import { generateScript } from "../_lib/api";
import type { FlowInput } from "@sh/launchblocks/editor";
import { notification } from "~~/utils/scaffold-hbar";

type Tab = "json" | "script";

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Export the flow as JSON (re-importable, runnable with core:run) or as a standalone launch.ts. */
export function ExportDialog({ flow, open, onClose }: { flow: FlowInput; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>("json");
  const [script, setScript] = useState<{ source?: string; error?: ApiError }>({});
  const json = JSON.stringify(flow, null, 2);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "script") return;
    setScript({});
    generateScript(flow).then(
      source => setScript({ source }),
      (error: ApiError) => setScript({ error }),
    );
  }, [open, tab, flow]);

  const text = tab === "json" ? json : (script.source ?? "");
  const filename = tab === "json" ? `${flow.id}.json` : "launch.ts";

  return (
    <dialog ref={dialog} className="modal" onClose={onClose}>
      <div className="modal-box max-w-4xl">
        <h3 className="text-lg font-bold">Export {flow.name}</h3>
        <div role="tablist" className="tabs tabs-bordered my-3">
          <button role="tab" className={`tab ${tab === "json" ? "tab-active" : ""}`} onClick={() => setTab("json")}>
            flow.json
          </button>
          <button role="tab" className={`tab ${tab === "script" ? "tab-active" : ""}`} onClick={() => setTab("script")}>
            launch.ts
          </button>
        </div>
        <p className="mb-2 text-xs opacity-70">
          {tab === "json"
            ? "The flow document: open it again here, run it with the core:run script, or commit it next to your app."
            : "A standalone script that performs the same steps with the Hedera SDK, calling the same functions the runner uses."}
        </p>
        {script.error && tab === "script" ? (
          <div className="alert alert-error text-xs">{script.error.message}</div>
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-lg bg-base-200 p-3 text-xs">
            <code>{text || "Generating…"}</code>
          </pre>
        )}
        <div className="modal-action">
          <button
            className="btn btn-sm"
            disabled={!text}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                notification.success("Copied");
              } catch {
                notification.error("Could not copy to the clipboard");
              }
            }}
          >
            Copy
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!text}
            onClick={() => download(filename, text, tab === "json" ? "application/json" : "text/typescript")}
          >
            Download {filename}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
