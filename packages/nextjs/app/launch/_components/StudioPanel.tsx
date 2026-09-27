"use client";

import type { ReactNode } from "react";
import {
  ChevronDoubleDownIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronDoubleUpIcon,
  ExclamationTriangleIcon,
  ListBulletIcon,
  PlayIcon,
} from "@heroicons/react/24/outline";

export type PanelMode = "open" | "collapsed";
export type PanelTab = "run" | "problems" | "outputs";
export type RunSummary = { tone: "info" | "success" | "error"; text: string } | null;

type Props = {
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  problemCount: number;
  runSummary: RunSummary;
  children: ReactNode;
};

const TABS: { id: PanelTab; label: string; Icon: typeof PlayIcon }[] = [
  { id: "run", label: "Run", Icon: PlayIcon },
  { id: "problems", label: "Problems", Icon: ExclamationTriangleIcon },
  { id: "outputs", label: "Outputs", Icon: ListBulletIcon },
];

const TONE_TEXT = { info: "text-info", success: "text-success", error: "text-error" } as const;
const TONE_DOT = { info: "bg-info", success: "bg-success", error: "bg-error" } as const;

/**
 * The Run / Problems / Outputs panel, open or collapsed:
 *
 * - open: the full panel, with a control to collapse it
 * - collapsed: a slim rail (side by side) or strip (stacked) that stays put,
 *   shows run status and problem count, and reopens on any click
 *
 * It cannot be closed: the problems and the run log are where a person finds
 * out what is wrong, and a closed panel was easy to lose for good.
 */
export function StudioPanel({ mode, onModeChange, tab, onTabChange, problemCount, runSummary, children }: Props) {
  const openOn = (next: PanelTab) => {
    onTabChange(next);
    onModeChange("open");
  };

  if (mode === "collapsed") {
    return (
      <aside
        aria-label="Studio panel, collapsed"
        className="flex items-center gap-1 border-t border-base-300 bg-base-100 px-2 py-1 lg:w-11 lg:flex-col lg:border-l lg:border-t-0 lg:px-1 lg:py-2"
      >
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={() => onModeChange("open")}
          title="Expand panel"
          aria-label="Expand panel"
        >
          <ChevronDoubleLeftIcon className="hidden h-4 w-4 lg:block" />
          <ChevronDoubleUpIcon className="h-4 w-4 lg:hidden" />
        </button>
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className="btn btn-ghost btn-sm relative gap-1 lg:btn-square"
            onClick={() => openOn(id)}
            title={`Open ${label}`}
          >
            <Icon className="h-4 w-4" />
            <span className="lg:hidden">{label}</span>
            {id === "problems" && problemCount > 0 && (
              <span className="badge badge-error badge-xs absolute -right-0.5 -top-0.5 lg:static lg:hidden">
                {problemCount}
              </span>
            )}
            {id === "problems" && problemCount > 0 && (
              <span className="absolute right-1 top-1 hidden h-2 w-2 rounded-full bg-error lg:block" />
            )}
            {id === "run" && runSummary && (
              <span
                className={`absolute right-1 top-1 hidden h-2 w-2 rounded-full lg:block ${TONE_DOT[runSummary.tone]}`}
              />
            )}
          </button>
        ))}
        {runSummary && (
          <span className={`ml-1 truncate text-xs lg:hidden ${TONE_TEXT[runSummary.tone]}`}>{runSummary.text}</span>
        )}
      </aside>
    );
  }

  return (
    <aside className="flex w-full flex-col border-t border-base-300 bg-base-100 lg:min-h-0 lg:w-[400px] lg:border-l lg:border-t-0">
      <div className="flex items-center px-2 pt-1">
        {/* One row of tabs; on a narrow phone they scroll sideways rather than wrap. */}
        <div
          role="tablist"
          aria-label="Studio panel"
          className="tabs tabs-border tabs-sm min-w-0 flex-nowrap overflow-x-auto"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`tab shrink-0 whitespace-nowrap px-2 ${tab === id ? "tab-active" : ""}`}
              onClick={() => onTabChange(id)}
            >
              {label}
              {id === "problems" && problemCount > 0 ? ` (${problemCount})` : ""}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center">
          <button
            className="btn btn-ghost btn-xs btn-square"
            onClick={() => onModeChange("collapsed")}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronDoubleRightIcon className="hidden h-4 w-4 lg:block" />
            <ChevronDoubleDownIcon className="h-4 w-4 lg:hidden" />
          </button>
        </div>
      </div>
      <div className="p-4 lg:min-h-0 lg:grow lg:overflow-y-auto">{children}</div>
    </aside>
  );
}
