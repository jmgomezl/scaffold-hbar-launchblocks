"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { FlowIssue, GalleryEntry, StepRecord } from "../_lib/api";
import { fetchCatalog, fetchGallery, fetchOperator, runFlowStream, toApiError, validateFlow } from "../_lib/api";
import type { BlockWarning, StepStatus, WorkspaceState } from "../_lib/blocks";
import { clearSharedFlowFromUrl, shareLinkFor, sharedFlowInUrl } from "../_lib/share";
import { useHederaWallet } from "../_lib/wallet";
import { runFlowWithWallet } from "../_lib/walletRun";
import type { LoadRequest } from "./BlockEditor";
import { ExportDialog } from "./ExportDialog";
import { OutputsPanel } from "./OutputsPanel";
import type { RunState } from "./RunPanel";
import { RunPanel } from "./RunPanel";
import type { SignerMode } from "./SignerPicker";
import { SignerPicker, walletApprovals } from "./SignerPicker";
import type { PanelMode, RunSummary } from "./StudioPanel";
import { StudioPanel } from "./StudioPanel";
import type { Catalog, EditorDocument, FeeEstimate, FlowInput, StepCatalogEntry } from "@sh/launchblocks/editor";
import { editorToFlow, flowIdFromName, flowToEditor, indexCatalog, outputsOf } from "@sh/launchblocks/editor";
import { useTheme } from "next-themes";
import { EyeIcon, LinkIcon } from "@heroicons/react/24/outline";
import { notification } from "~~/utils/scaffold-hbar";

const BlockEditor = dynamic(() => import("./BlockEditor"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm opacity-60">Loading blocks…</div>,
});

const STORAGE_KEY = "launchblocks.flow.v1";

/**
 * Editor height when the panel stacks below it (under lg). Open leaves room
 * for the panel; collapsed and closed account for the header, a toolbar that
 * can wrap to two lines, the collapsed strip, and the footer's fixed controls.
 */
const EDITOR_HEIGHT: Record<PanelMode, string> = {
  open: "h-[65dvh]",
  collapsed: "h-[calc(100dvh-17rem)]",
  closed: "h-[calc(100dvh-14rem)]",
};
const TOKEN_KEY = "launchblocks.runToken";
const PANEL_KEY = "launchblocks.panel";
const SIGNER_KEY = "launchblocks.signer";
const HERO_FLOW = "hts-launch-saucerswap";

type Tab = "run" | "problems" | "outputs";

/** Earlier builds stored "shown" / "hidden"; read them as open / closed. */
function parsePanelMode(value: string | null): PanelMode {
  if (value === "collapsed" || value === "closed" || value === "open") return value;
  if (value === "hidden") return "closed";
  return "open";
}

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

/** The param a problem is about, relative to its step: `name`, `keys.admin`, `recipients[0].amount`. */
function issueField(issue: FlowIssue): string {
  return issue.path.replace(/^steps\[\d+\]\.?(params\.)?/, "");
}

/** The validator's wording, as a person filling in a block would put it. */
function plainMessage(message: string): string {
  if (/received undefined$/.test(message)) return "Required";
  const expected = /^Invalid input: expected (\w+), received \w+$/.exec(message);
  if (expected) return expected[1] === "int" ? "Must be a whole number" : `Must be a ${expected[1]}`;
  return message === "Invalid input" ? "Not a valid value" : message;
}

/** A problem under the field's own label on the block, e.g. "Decimals: Must be a whole number". */
function issueText(issue: FlowIssue, flow: FlowInput | null, catalog: Catalog | null): string {
  const field = issueField(issue);
  if (!field) return issue.message;
  const type = flow?.steps.find(step => step.id === issue.stepId)?.type;
  const label = (type && catalog?.get(type)?.ui.fields.find(spec => spec.key === field)?.label) || field;
  return `${label}: ${plainMessage(issue.message)}`;
}

/** Whether `flow` is an example exactly as the studio would save it, rather than someone's own work. */
function isUnchangedExample(flow: FlowInput, gallery: GalleryEntry[], cat: Catalog): boolean {
  const canonical = (source: FlowInput) => JSON.stringify(editorToFlow(flowToEditor(source, cat).document, cat));
  const json = JSON.stringify(flow);
  return gallery.some(entry => canonical(entry.flow) === json);
}

const linkErrorText = (error: unknown) => {
  const { message, hint } = toApiError(error);
  return hint ? `${message}. ${hint}` : message;
};

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
  // The loaded flow's id is kept until the user renames it, so an example
  // (and its export) stays "hts-launch-saucerswap" rather than a slug of its name.
  const [loaded, setLoaded] = useState<{ id: string; name: string } | null>(null);
  const [issues, setIssues] = useState<FlowIssue[]>([]);
  const [estimate, setEstimate] = useState<FeeEstimate | null>(null);
  const [validating, setValidating] = useState(false);
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [tab, setTab] = useState<Tab>("run");
  const [exportOpen, setExportOpen] = useState(false);
  // Remounts the run log per run so collapsed/expanded choices start fresh.
  const [runKey, setRunKey] = useState(0);
  // The Run / Problems / Outputs panel: open, collapsed to a slim bar, or closed.
  const [panelMode, setPanelMode] = useState<PanelMode>("open");
  // Who signs runs: the app's operator account unless the visitor picks their wallet.
  const [signerMode, setSignerMode] = useState<SignerMode>("operator");
  const [operatorAccountId, setOperatorAccountId] = useState<string | null>(null);
  const wallet = useHederaWallet(signerMode === "wallet");
  const fileInput = useRef<HTMLInputElement>(null);
  const nonce = useRef(0);

  const catalog: Catalog | null = useMemo(() => (entries ? indexCatalog(entries) : null), [entries]);

  const document: EditorDocument = useMemo(
    () => ({
      id: loaded && workspace.name === loaded.name ? loaded.id : flowIdFromName(workspace.name),
      name: workspace.name || "My token launch",
      ...(description ? { description } : {}),
      network: "testnet",
      steps: workspace.steps,
    }),
    [workspace, description, loaded],
  );
  const flow: FlowInput | null = useMemo(() => (catalog ? editorToFlow(document, catalog) : null), [document, catalog]);
  const flowJson = useMemo(() => (flow ? JSON.stringify(flow) : ""), [flow]);

  const openFlow = useCallback(
    (source: FlowInput, cat: Catalog) => {
      const { document: loaded } = flowToEditor(source, cat);
      // A step type this app has no block for cannot be drawn, so it is left out, and saying so once is enough.
      const unknown = loaded.steps.filter(step => !cat.get(step.type));
      const next = unknown.length ? { ...loaded, steps: loaded.steps.filter(step => cat.get(step.type)) } : loaded;
      if (unknown.length) {
        notification.error(
          `Left out ${unknown.map(step => `${step.id} (${step.type})`).join(", ")}: this app has no block for that step type.`,
        );
      }
      if (source.network && source.network !== "testnet") {
        notification.info(
          `This launch was for ${source.network}. The studio runs on testnet, so it opens as a testnet launch.`,
        );
      }
      setDescription(next.description);
      setLoaded({ id: next.id, name: next.name });
      setRun({ phase: "idle" });
      nonce.current += 1;
      setLoad({ document: next, nonce: nonce.current });
    },
    [setLoad],
  );

  // Catalog and gallery, then: a shared link's flow (#flow=…), else an example
  // requested with ?example=<id>, else the saved flow, else the hero example.
  useEffect(() => {
    // In development React runs this effect twice; only the second load may
    // open a flow, or it would replace the ?example= the first one consumed.
    let cancelled = false;
    Promise.all([fetchCatalog(), fetchGallery()]).then(
      ([steps, flows]) => {
        if (cancelled) return;
        const cat = indexCatalog(steps);
        setEntries(steps);
        setGallery(flows);

        let saved: FlowInput | undefined;
        try {
          const raw = readStorage(STORAGE_KEY, () => window.localStorage);
          saved = raw ? (JSON.parse(raw) as FlowInput) : undefined;
        } catch {
          saved = undefined;
        }

        // The saved flow is the user's own work unless it is exactly an example as
        // the studio would save it (same normalisation, same id).
        const savedIsOwnWork = !!saved?.steps?.length && !isUnchangedExample(saved, flows, cat);

        let shared: FlowInput | null = null;
        try {
          shared = sharedFlowInUrl();
        } catch (error) {
          notification.error(linkErrorText(error));
          clearSharedFlowFromUrl();
        }
        if (shared) {
          clearSharedFlowFromUrl();
          if (!savedIsOwnWork || window.confirm("Open the shared launch? It replaces your current launch.")) {
            openFlow(shared, cat);
            return;
          }
        }

        // Read the query directly rather than through useSearchParams, which
        // would force a Suspense boundary around the whole studio.
        const requested = new URLSearchParams(window.location.search).get("example");
        const example = requested ? flows.find(entry => entry.id === requested) : undefined;
        if (requested) window.history.replaceState(null, "", window.location.pathname);
        if (requested && !example)
          notification.error(`There is no example "${requested}". Opening your launch instead.`);
        if (
          example &&
          (!savedIsOwnWork || window.confirm(`Open the example "${example.title}"? It replaces your current launch.`))
        ) {
          openFlow(example.flow, cat);
          return;
        }

        const initial = saved ?? (flows.find(entry => entry.id === HERO_FLOW) ?? flows[0])?.flow;
        if (initial) openFlow(initial, cat);
      },
      error => !cancelled && setLoadError(toApiError(error).message || "Could not load the step catalog"),
    );
    return () => {
      cancelled = true;
    };
  }, [openFlow]);

  // Another shared link pasted into this tab changes only the fragment, which reloads nothing.
  useEffect(() => {
    if (!catalog) return;
    const onHashChange = () => {
      let shared: FlowInput | null;
      try {
        shared = sharedFlowInUrl();
      } catch (error) {
        notification.error(linkErrorText(error));
        clearSharedFlowFromUrl();
        return;
      }
      if (!shared) return;
      clearSharedFlowFromUrl();
      if (window.confirm("Open the shared launch? It replaces your current launch.")) openFlow(shared, catalog);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [catalog, openFlow]);

  const copyShareLink = async () => {
    if (!flow) return;
    const link = shareLinkFor(flow);
    try {
      await navigator.clipboard.writeText(link);
      notification.success("Link copied. It opens this launch, as blocks, in the studio.");
    } catch {
      window.prompt("Copy this link to share the launch:", link);
    }
  };

  useEffect(() => {
    setPanelMode(parsePanelMode(readStorage(PANEL_KEY, () => window.localStorage)));
    if (readStorage(SIGNER_KEY, () => window.localStorage) === "wallet") setSignerMode("wallet");
    fetchOperator().then(
      operator => setOperatorAccountId(operator.accountId),
      () => undefined,
    );
  }, []);

  const changeSignerMode = (mode: SignerMode) => {
    setSignerMode(mode);
    writeStorage(SIGNER_KEY, mode, () => window.localStorage);
  };

  const changePanelMode = (mode: PanelMode) => {
    setPanelMode(mode);
    writeStorage(PANEL_KEY, mode, () => window.localStorage);
  };

  const showTab = (next: Tab) => {
    setTab(next);
    if (panelMode !== "open") changePanelMode("open");
  };

  // Remember the flow across reloads, an empty one after New included.
  useEffect(() => {
    if (flowJson && catalog) writeStorage(STORAGE_KEY, flowJson, () => window.localStorage);
  }, [flowJson, catalog]);

  // Validate against the same registry the runner uses, shortly after edits settle.
  useEffect(() => {
    if (!flow) return;
    if (!flow.steps.length) {
      setIssues([]);
      setEstimate(null);
      setValidating(false);
      return;
    }
    const controller = new AbortController();
    setValidating(true);
    const timer = setTimeout(() => {
      // A superseded check must not clear `validating` for the one after it.
      validateFlow(flow, controller.signal).then(
        result => {
          if (controller.signal.aborted) return;
          setIssues(result.issues);
          setEstimate(result.estimate ?? null);
          setValidating(false);
        },
        () => !controller.signal.aborted && setValidating(false),
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
    const byStep = new Map<string, BlockWarning[]>();
    for (const issue of issues) {
      if (!issue.stepId) continue;
      const warning = { field: issueField(issue), text: issueText(issue, flow, catalog) };
      byStep.set(issue.stepId, [...(byStep.get(issue.stepId) ?? []), warning]);
    }
    return byStep;
    // issueText reads step types from the flow, which only matter when the issues change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, catalog]);

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

  const runSummary: RunSummary = useMemo(() => {
    if (run.phase === "idle") return null;
    const records = Object.values(run.records);
    const done = records.filter(record => record.status === "succeeded").length;
    if (run.phase === "running") return { tone: "info", text: `Running · ${done}/${records.length}` };
    if (run.phase === "error") return { tone: "error", text: "Run failed" };
    return run.result.status === "succeeded"
      ? { tone: "success", text: "Launch complete" }
      : { tone: "error", text: `Failed at ${run.result.error?.stepId}` };
  }, [run]);

  const running = run.phase === "running";
  const walletSigner = signerMode === "wallet" && wallet.state.status === "connected" ? wallet.signer() : null;
  const signerReady = signerMode === "operator" || !!walletSigner;
  // A block outside the Launch block counts as a problem: it looks like part of the launch but would not run.
  const problemCount = issues.length + workspace.detachedIds.length;
  const canRun = !!flow && flow.steps.length > 0 && problemCount === 0 && !validating && !running && signerReady;

  const startRun = async (runToken?: string) => {
    if (!flow) return;
    setTab("run");
    setRunKey(key => key + 1);
    const records: Record<string, StepRecord> = Object.fromEntries(
      flow.steps.map(step => [step.id, { id: step.id, type: step.type, status: "pending" as const, links: [] }]),
    );
    setRun({ phase: "running", records: { ...records } });
    let ended = false;
    try {
      const events = walletSigner ? runFlowWithWallet(flow, walletSigner) : runFlowStream(flow, { runToken });
      for await (const event of events) {
        if (event.type === "flow:end" || event.type === "error") ended = true;
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
      if (!ended) {
        setRun({
          phase: "error",
          records: { ...records },
          error: {
            code: "RUN_INTERRUPTED",
            message: "The run stopped before it finished: the connection closed.",
            hint: "Steps marked done are on-chain; open their HashScan links before running again.",
          },
        });
      }
    } catch (raw) {
      const error = toApiError(raw, "RUN_FAILED");
      if (error.code === "RUN_TOKEN_REQUIRED" && !runToken && !walletSigner) {
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
    !flow ||
    !catalog ||
    workspace.steps.length === 0 ||
    isUnchangedExample(flow, gallery, catalog) ||
    window.confirm("Replace the current launch? Your changes will be lost.");

  if (loadError) {
    return (
      <div className="m-8 alert alert-error">
        <span>{loadError}</span>
      </div>
    );
  }

  return (
    // Side by side (lg+), the studio fills the viewport but stops 4rem short
    // of the bottom, where the footer's faucet and theme controls are fixed.
    // Stacked, it flows with the page instead, so the footer (which reserves
    // room for those controls) lands below the run log rather than on it.
    <div className="flex flex-col lg:h-[calc(100dvh-8rem)] lg:min-h-[600px]">
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
        ) : problemCount ? (
          <button className="badge badge-error cursor-pointer" onClick={() => showTab("problems")}>
            {problemCount} problem{problemCount === 1 ? "" : "s"}
          </button>
        ) : flow?.steps.length ? (
          <span className="badge badge-success">valid</span>
        ) : null}
        {panelMode === "closed" && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => changePanelMode("open")}
            title="Show the Run, Problems and Outputs panel"
          >
            <EyeIcon className="h-4 w-4" />
            Show panel
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          disabled={!flow?.steps.length}
          onClick={() => void copyShareLink()}
          title="Copy a link that opens this launch in the studio"
        >
          <LinkIcon className="h-4 w-4" />
          Share
        </button>
        <button className="btn btn-sm" disabled={!flow?.steps.length} onClick={() => setExportOpen(true)}>
          Export
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!canRun}
          title={signerReady ? undefined : "Connect a wallet in the Run panel, or switch back to the default account"}
          onClick={() => void startRun(readStorage(TOKEN_KEY, () => window.sessionStorage) ?? undefined)}
        >
          {running ? <span className="loading loading-spinner loading-xs" /> : null}
          {running ? "Running…" : signerMode === "wallet" ? "Run with your wallet" : "Run on testnet"}
        </button>
      </div>

      <div className="flex flex-col lg:min-h-0 lg:grow lg:flex-row">
        <div className={`relative min-h-[420px] lg:h-auto lg:grow ${EDITOR_HEIGHT[panelMode]}`}>
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

        <StudioPanel
          mode={panelMode}
          onModeChange={changePanelMode}
          tab={tab}
          onTabChange={setTab}
          problemCount={problemCount}
          runSummary={runSummary}
        >
          {tab === "run" && (
            <>
              <SignerPicker
                mode={signerMode}
                onModeChange={changeSignerMode}
                operatorAccountId={operatorAccountId}
                wallet={wallet.state}
                onConnect={extensionId => void wallet.connect(extensionId)}
                onDisconnect={() => void wallet.disconnect()}
                approvals={walletApprovals(flow ?? undefined)}
                disabled={running}
              />
              <RunPanel
                key={runKey}
                steps={steps}
                run={run}
                estimate={issues.length ? null : estimate}
                problems={problemCount}
                payer={signerMode === "wallet" ? "your wallet" : "the default account"}
                signedBy={
                  signerMode === "wallet"
                    ? wallet.state.status === "connected"
                      ? `your wallet account ${wallet.state.accountId}, one approval per transaction`
                      : "your wallet, once it is connected"
                    : operatorAccountId
                      ? `the default account ${operatorAccountId}`
                      : "the app's operator account"
                }
              />
            </>
          )}
          {tab === "problems" &&
            (issues.length || workspace.detachedIds.length ? (
              <ul className="space-y-2 text-sm">
                {workspace.detachedIds.map(id => (
                  <li key={`detached-${id}`} className="rounded-lg border border-warning/40 p-2">
                    <span className="font-mono font-semibold">{id}</span> is outside the Launch block and will not run.
                  </li>
                ))}
                {issues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="rounded-lg border border-error/40 p-2">
                    {issue.stepId && <span className="font-mono font-semibold">{issue.stepId} · </span>}
                    {issueText(issue, flow, catalog)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm opacity-70">No problems. The flow is valid and ready to run.</p>
            ))}
          {tab === "outputs" && <OutputsPanel outputs={outputs} />}
        </StudioPanel>
      </div>

      {flow && (
        <ExportDialog
          flow={flow}
          problems={issues.map(
            issue => `${issue.stepId ? `${issue.stepId} · ` : ""}${issueText(issue, flow, catalog)}`,
          )}
          open={exportOpen}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
