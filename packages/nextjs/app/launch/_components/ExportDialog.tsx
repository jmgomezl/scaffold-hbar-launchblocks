"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../_lib/api";
import { exportHarnessRecipe, generateScript } from "../_lib/api";
import type { FlowInput, HarnessRecipe } from "@sh/launchblocks/editor";
import { strToU8, zipSync } from "fflate";
import { notification } from "~~/utils/scaffold-hbar";

type Tab = "json" | "script" | "harness";

const DESCRIPTION: Record<Tab, string> = {
  json: "The flow document: open it again here, run it with the core:run script, or commit it next to your app.",
  script:
    "A standalone script that performs the same steps with the Hedera SDK, calling the same functions the runner uses.",
  harness:
    "A Hedera Harness recipe: a coding agent adds this launch to your app's examples, unchanged, and the harness grades the work itself, up to running the launch on testnet with its own funded account.",
};

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Every recipe file at its path from the project root, so the zip unpacks in place. */
function recipeZip(recipe: HarnessRecipe): Blob {
  const entries = Object.fromEntries(recipe.files.map(file => [file.path, strToU8(file.content)]));
  return new Blob([zipSync(entries)], { type: "application/zip" });
}

/**
 * Export the flow as JSON (re-importable, runnable with core:run), as a
 * standalone launch.ts, or as a Hedera Harness recipe.
 */
export function ExportDialog({ flow, open, onClose }: { flow: FlowInput; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>("json");
  const [script, setScript] = useState<{ source?: string; error?: ApiError }>({});
  const [recipe, setRecipe] = useState<{ value?: HarnessRecipe; error?: ApiError }>({});
  const [recipeFile, setRecipeFile] = useState(0);
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

  useEffect(() => {
    if (!open || tab !== "harness") return;
    setRecipe({});
    setRecipeFile(0);
    exportHarnessRecipe(flow).then(
      value => setRecipe({ value }),
      (error: ApiError) => setRecipe({ error }),
    );
  }, [open, tab, flow]);

  const shownRecipeFile = recipe.value?.files[recipeFile];
  const text = tab === "json" ? json : tab === "script" ? (script.source ?? "") : (shownRecipeFile?.content ?? "");
  const error = tab === "script" ? script.error : tab === "harness" ? recipe.error : undefined;
  const downloadLabel =
    tab === "json"
      ? `${flow.id}.json`
      : tab === "script"
        ? "launch.ts"
        : `${recipe.value?.flowId ?? flow.id}-harness-recipe.zip`;

  const onDownload = () => {
    if (tab === "json") download(`${flow.id}.json`, new Blob([json], { type: "application/json" }));
    else if (tab === "script") download("launch.ts", new Blob([text], { type: "text/typescript" }));
    else if (recipe.value) download(downloadLabel, recipeZip(recipe.value));
  };

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
          <button
            role="tab"
            className={`tab ${tab === "harness" ? "tab-active" : ""}`}
            onClick={() => setTab("harness")}
          >
            Harness recipe
          </button>
        </div>
        <p className="mb-2 text-xs opacity-70">{DESCRIPTION[tab]}</p>
        {tab === "harness" && recipe.value && (
          <RecipeSummary recipe={recipe.value} selected={recipeFile} onSelect={setRecipeFile} />
        )}
        {error ? (
          <div className="alert alert-error text-xs">
            <div>
              <p>{error.message}</p>
              {error.hint && <p className="mt-1 opacity-80">{error.hint}</p>}
            </div>
          </div>
        ) : (
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-base-200 p-3 text-xs">
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
            {tab === "harness" ? "Copy this file" : "Copy"}
          </button>
          <button className="btn btn-sm btn-primary" disabled={!text} onClick={onDownload}>
            Download {downloadLabel}
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

function RecipeSummary({
  recipe,
  selected,
  onSelect,
}: {
  recipe: HarnessRecipe;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const shortPath = (file: string) => file.replace(`.harness/${recipe.flowId}/`, "").replace(".harness/", "");
  return (
    <div className="mb-3 space-y-2 text-xs">
      {recipe.copiedFrom && (
        <div role="note" className="rounded-lg bg-info/15 px-3 py-2">
          “{recipe.copiedFrom.name}” is one of the built-in examples, so the recipe adds it as a copy, “
          {recipe.copiedFrom.name} (copy)”, with the id <code>{recipe.flowId}</code>. Rename the launch to choose your
          own name.
        </div>
      )}
      <p>
        One run costs about <strong>{recipe.estimate.perRunHbar} ℏ</strong>.{" "}
        {recipe.fundingHbar !== undefined
          ? `The harness funds its own throwaway account with ${recipe.fundingHbar} ℏ from your operator and sweeps back the rest.`
          : "The launch is not on testnet, so the recipe stops before the on-chain tier."}
      </p>
      <p>
        Unzip at your project root, commit, then run{" "}
        <code className="rounded bg-base-200 px-1 py-0.5">{recipe.commands.run}</code>. The recipe&apos;s README covers
        the operator and prerequisites.
      </p>
      <div role="tablist" aria-label="Recipe files" className="flex flex-wrap gap-1">
        {recipe.files.map((file, index) => (
          <button
            key={file.path}
            role="tab"
            aria-selected={index === selected}
            className={`btn btn-xs font-mono ${index === selected ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onSelect(index)}
          >
            {shortPath(file.path)}
          </button>
        ))}
      </div>
    </div>
  );
}
