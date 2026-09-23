"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ApiError, FlowIssue, GalleryEntry, StepRecord } from "../_lib/api";
import { fetchCatalog, fetchGallery, runFlowStream, validateFlow } from "../_lib/api";
import type { StepStatus, WorkspaceState } from "../_lib/blocks";
import type { LoadRequest } from "./BlockEditor";
import { ExportDialog } from "./ExportDialog";
import { OutputsPanel } from "./OutputsPanel";
import type { RunState } from "./RunPanel";
import { RunPanel } from "./RunPanel";
import type { Catalog, EditorDocument, FlowInput, StepCatalogEntry } from "@sh/launchblocks/editor";
import { editorToFlow, flowIdFromName, flowToEditor, indexCatalog, outputsOf } from "@sh/launchblocks/editor";
import { useTheme } from "next-themes";
import { notification } from "~~/utils/scaffold-hbar";

const BlockEditor = dynamic(() => import("./BlockEditor"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm opacity-60">Loading blocks…</div>,
});

const STORAGE_KEY = "launchblocks.flow.v1";
const TOKEN_KEY = "launchblocks.runToken";
const HERO_FLOW = "hts-launch-saucerswap";
const POOL_STEP = "saucerswap.createPool";

type Tab = "run" | "problems" | "outputs";

function readStorage(key: string, storage: () => Storage): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string, storage: () => Storage): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Private mode or blocked storage: the editor still works, it just forgets on reload.
  }
}

function issueText(issue: FlowIssue): string {
  const field = issue.path.replace(/^steps\[\d+\]\.?(params\.)?/, "");
  return field ? `${field}: ${issue.message}` : issue.message;
}

/**
 * Launch Studio: the block editor plus everything around it — loading the
 * step catalog and gallery, live validation, streaming runs, and export.
 * State flows one way: the workspace reports its content, the studio turns
 * it into flow JSON, and everything else (validation, run, export) works on
 * that JSON exactly as the CLI and API do.
 */
export function LaunchStudio() {
  const { resolvedTheme } = useTheme();
  const [entries, setEntries] = useState<StepCatalogEntry[] | null>(null);
  const [gallery, setGallery] = useState<GalleryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [load, setLoad] = useState<LoadRequest | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ name: "", steps: [], detachedIds: [] });
  const [description, setDescription] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<FlowIssue[]>([]);
  const [validating, setValidating] = useState(false);
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [tab, setTab] = useState<Tab>("run");
  const [exportOpen, setExportOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nonce = useRef(0);

  const catalog: Catalog | null = useMemo(() => (entries ? indexCatalog(entries) : null), [entries]);

  const document: EditorDocument = useMemo(
    () => ({
      id: flowIdFromName(workspace.name),
      name: workspace.name || "My token launch",
      ...(description ? { description } : {}),
      network: "testnet",
      steps: workspace.steps,
    }),
    [workspace, description],
  );
  const flow: FlowInput | null = useMemo(() => (catalog ? editorToFlow(document, catalog) : null), [document, catalog]);
  const flowJson = useMemo(() => (flow ? JSON.stringify(flow) : ""), [flow]);

  const openFlow = useCallback(
    (source: FlowInput, cat: Catalog) => {
      const { document: next, problems } = flowToEditor(source, cat);
      problems.forEach(problem => notification.error(`${problem.stepId}: ${problem.message}`));
      setDescription(next.description);
      setRun({ phase: "idle" });
      nonce.current += 1;
      setLoad({ document: next, nonce: nonce.current });
    },
    [setLoad],
  );

  // Catalog and gallery, then the saved flow or the hero example.
  useEffect(() => {
    Promise.all([fetchCatalog(), fetchGallery()]).then(
      ([steps, flows]) => {
        const cat = indexCatalog(steps);
        setEntries(steps);
        setGallery(flows);
        const saved = readStorage(STORAGE_KEY, () => window.localStorage);
        let initial: FlowInput | undefined;
        if (saved) {
          try {
            initial = JSON.parse(saved) as FlowInput;
          } catch {
            initial = undefined;
          }
        }
        initial ??= (flows.find(entry => entry.id === HERO_FLOW) ?? flows[0])?.flow;
        if (initial) openFlow(initial, cat);
      },
      (error: ApiError) => setLoadError(error.message ?? "Could not load the step catalog"),
    );
  }, [openFlow]);

  // Remember the flow across reloads.
  useEffect(() => {
    if (flowJson && workspace.steps.length) writeStorage(STORAGE_KEY, flowJson, () => window.localStorage);
  }, [flowJson, workspace.steps.length]);

  // Validate against the same registry the runner uses, shortly after edits settle.
  useEffect(() => {
    if (!flow) return;
    if (!flow.steps.length) {
      setIssues([]);
      return;
    }
    const controller = new AbortController();
    setValidating(true);
    const timer = setTimeout(() => {
      validateFlow(flow, controller.signal).then(
        result => {
          setIssues(result.issues);
          setValidating(false);
        },
        () => setValidating(false),
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // flowJson captures every change to `flow`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowJson]);

  const warnings = useMemo(() => {
    const byStep = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.stepId) continue;
      byStep.set(issue.stepId, [...(byStep.get(issue.stepId) ?? []), issueText(issue)]);
    }
    return byStep;
  }, [issues]);

  const statuses = useMemo(() => {
    const out: Record<string, StepStatus | undefined> = {};
    if (run.phase === "idle") return out;
    for (const [id, record] of Object.entries(run.records)) out[id] = record.status;
    return out;
  }, [run]);

  const outputs = useMemo(
    () => (catalog ? workspace.steps.flatMap(step => outputsOf(step, catalog)) : []),
    [workspace.steps, catalog],
  );

  const steps = useMemo(
    () =>
      workspace.steps.map(step => ({
        id: step.id,
        type: step.type,
        label: catalog?.get(step.type)?.ui.label ?? step.type,
      })),
    [workspace.steps, catalog],
  );

  const running = run.phase === "running";
  const canRun = !!flow && flow.steps.length > 0 && issues.length === 0 && !validating && !running;

  const startRun = async (runToken?: string) => {
    if (!flow) return;
    setTab("run");
    const records: Record<string, StepRecord> = Object.fromEntries(
      flow.steps.map(step => [step.id, { id: step.id, type: step.type, status: "pending" as const, links: [] }]),
    );
    setRun({ phase: "running", records: { ...records } });
    try {
      for await (const event of runFlowStream(flow, { runToken })) {
        if (event.type === "step:start" || event.type === "step:success" || event.type === "step:error") {
          records[event.step.id] = event.step;
          setRun({ phase: "running", records: { ...records } });
        } else if (event.type === "flow:end") {
          for (const record of event.result.steps) records[record.id] = record;
          setRun({ phase: "done", records: { ...records }, result: event.result });
          if (event.result.status === "succeeded") notification.success("Launch complete — every step is on-chain");
          else notification.error(`Stopped at ${event.result.error?.stepId}`);
        } else if (event.type === "error") {
          setRun({ phase: "error", records: { ...records }, error: event.error });
        }
      }
    } catch (raw) {
      const error = raw as ApiError;
      if (error.code === "RUN_TOKEN_REQUIRED" && !runToken) {
        const token = window.prompt("This deployment needs a run token to spend its testnet operator's HBAR:");
        if (token) {
          writeStorage(TOKEN_KEY, token, () => window.sessionStorage);
          return startRun(token);
        }
      }
      setRun({ phase: "error", records, error });
    }
  };

  const onFile = async (file: File) => {
    if (!catalog) return;
    try {
      openFlow(JSON.parse(await file.text()) as FlowInput, catalog);
    } catch {
      notification.error("That file is not a flow JSON document");
    }
  };

  const confirmReplace = () =>
    workspace.steps.length === 0 || window.confirm("Replace the current launch? Your changes will be lost.");

  if (loadError) {
    return (
      <div className="m-8 alert alert-error">
        <span>{loadError}</span>
      </div>
    );
  }

  return (
    // Stops 4rem short of the viewport bottom: the footer's faucet and theme
    // controls are fixed there and would otherwise sit on top of the blocks.
    <div className="flex h-[calc(100dvh-8rem)] min-h-[600px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-4 py-2">
        <span className="font-semibold">Launch Studio</span>
        <select
          className="select select-bordered select-sm max-w-xs"
          value=""
          aria-label="Load an example flow"
          onChange={event => {
            const entry = gallery.find(item => item.id === event.target.value);
            if (entry && catalog && confirmReplace()) openFlow(entry.flow, catalog);
          }}
        >
          <option value="" disabled>
            Load an example…
          </option>
          {gallery.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()}>
          Open JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = "";
          }}
        />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (!catalog || !confirmReplace()) return;
            openFlow(
              { schemaVersion: 1, id: "my-token-launch", name: "My token launch", network: "testnet", steps: [] },
              catalog,
            );
          }}
        >
          New
        </button>
        <div className="grow" />
        {validating ? (
          <span className="badge badge-ghost">checking…</span>
        ) : issues.length ? (
          <button className="badge badge-error cursor-pointer" onClick={() => setTab("problems")}>
            {issues.length} problem{issues.length === 1 ? "" : "s"}
          </button>
        ) : flow?.steps.length ? (
          <span className="badge badge-success">valid</span>
        ) : null}
        <button className="btn btn-sm" disabled={!flow?.steps.length} onClick={() => setExportOpen(true)}>
          Export
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!canRun}
          onClick={() => void startRun(readStorage(TOKEN_KEY, () => window.sessionStorage) ?? undefined)}
        >
          {running ? <span className="loading loading-spinner loading-xs" /> : null}
          {running ? "Running…" : "Run on testnet"}
        </button>
      </div>

      <div className="flex min-h-0 grow flex-col lg:flex-row">
        <div className="relative min-h-[420px] grow">
          {catalog ? (
            <BlockEditor
              catalog={catalog}
              load={load}
              onChange={setWorkspace}
              onLoadProblems={ids => notification.error(`Could not draw steps: ${ids.join(", ")}`)}
              statuses={statuses}
              warnings={warnings}
              dark={resolvedTheme === "dark"}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-sm opacity-60">Loading step catalog…</div>
          )}
        </div>

        <aside className="flex w-full flex-col border-t border-base-300 bg-base-100 lg:w-[380px] lg:border-l lg:border-t-0">
          <div role="tablist" className="tabs tabs-bordered px-2 pt-1">
            <button role="tab" className={`tab ${tab === "run" ? "tab-active" : ""}`} onClick={() => setTab("run")}>
              Run
            </button>
            <button
              role="tab"
              className={`tab ${tab === "problems" ? "tab-active" : ""}`}
              onClick={() => setTab("problems")}
            >
              Problems {issues.length ? `(${issues.length})` : ""}
            </button>
            <button
              role="tab"
              className={`tab ${tab === "outputs" ? "tab-active" : ""}`}
              onClick={() => setTab("outputs")}
            >
              Outputs
            </button>
          </div>
          <div className="min-h-0 grow overflow-y-auto p-4">
            {tab === "run" && (
              <RunPanel steps={steps} run={run} hasPool={workspace.steps.some(step => step.type === POOL_STEP)} />
            )}
            {tab === "problems" &&
              (issues.length || workspace.detachedIds.length ? (
                <ul className="space-y-2 text-sm">
                  {workspace.detachedIds.map(id => (
                    <li key={`detached-${id}`} className="rounded-lg border border-warning/40 p-2">
                      <span className="font-mono font-semibold">{id}</span> is outside the Launch block and will not
                      run.
                    </li>
                  ))}
                  {issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className="rounded-lg border border-error/40 p-2">
                      {issue.stepId && <span className="font-mono font-semibold">{issue.stepId} · </span>}
                      {issueText(issue)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm opacity-70">No problems. The flow is valid and ready to run.</p>
              ))}
            {tab === "outputs" && <OutputsPanel outputs={outputs} />}
          </div>
        </aside>
      </div>

      {flow && <ExportDialog flow={flow} open={exportOpen} onClose={() => setExportOpen(false)} />}
    </div>
  );
}
