"use client";

import { type ComponentProps, useEffect, useRef } from "react";
import { AssistantAvatar } from "./AssistantAvatar";
import { AssistantPanel } from "./AssistantPanel";
import type { PanelMode } from "./StudioPanel";
import { ArrowPathIcon, ChevronDownIcon } from "@heroicons/react/24/outline";

type Props = ComponentProps<typeof AssistantPanel> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClear: () => void;
  /** Something the assistant could explain now: a problem or a failed run. The button shows a dot. */
  attention: boolean;
  /** Where the studio's side panel is, so the window opens beside it rather than over it. */
  panelMode: PanelMode;
};

/**
 * Above Blockly's toolbox (70) and flyout (80), below its menus and dropdowns (999 and up), so a block's
 * right-click menu still opens over the window.
 */
const LAYER = "z-[90]";

/** Side by side (lg+), the window sits on the canvas, left of the Run panel in whatever state it is. */
const RIGHT_OF_PANEL: Record<PanelMode, string> = {
  open: "lg:right-[416px]",
  collapsed: "lg:right-[60px]",
  closed: "lg:right-4",
};

/**
 * The studio's AI companion, floating: a button that stays in sight at the
 * bottom right, and a chat window it opens over the canvas. On a phone the
 * window is a sheet across the bottom of the screen.
 */
export function AssistantDock({ open, onOpenChange, onClear, attention, panelMode, ...panel }: Props) {
  const dialog = useRef<HTMLElement>(null);
  // Blocky thinks while it answers, and looks worried while there is something wrong on screen.
  const mood = panel.busy ? "thinking" : attention ? "worried" : "idle";

  // Escape minimises it from anywhere, unless something else (a Blockly menu, say) used the key.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Opened without a question box to focus (while loading, or not set up), focus the window itself.
  useEffect(() => {
    if (open && !dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [open]);

  return (
    <>
      {open && (
        <section
          ref={dialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="false"
          aria-label="Assistant"
          className={`fixed inset-x-2 bottom-2 ${LAYER} flex outline-none h-[75dvh] flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl lg:inset-x-auto lg:bottom-20 lg:h-[min(620px,calc(100dvh-12rem))] lg:w-[400px] ${RIGHT_OF_PANEL[panelMode]}`}
        >
          <header className="flex items-center gap-2 border-b border-base-300 px-4 py-2">
            <AssistantAvatar mood={mood} className="h-11 w-9 shrink-0" />
            <div className="leading-tight">
              <div className="font-semibold">Blocky</div>
              <div className="text-[11px] opacity-60">Your LaunchBlocks assistant</div>
            </div>
            <div className="ml-auto flex items-center">
              {panel.messages.length > 0 && !panel.busy && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs gap-1"
                  onClick={onClear}
                  title="Start a new conversation"
                >
                  <ArrowPathIcon className="h-3.5 w-3.5" /> New chat
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square"
                onClick={() => onOpenChange(false)}
                aria-label="Minimise the assistant"
                title="Minimise (Esc)"
              >
                <ChevronDownIcon className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div className="min-h-0 grow">
            <AssistantPanel {...panel} />
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        data-attention={attention && !open ? "true" : undefined}
        aria-label={open ? "Minimise the assistant" : "Open the assistant"}
        // Plain utilities, not daisyUI's .btn, whose own background would cover the gradient.
        className={`fixed bottom-4 right-4 ${LAYER} inline-flex h-12 cursor-pointer items-center gap-2 rounded-full bg-linear-135 from-hedera-ultraviolet to-hedera-azure pl-1.5 pr-5 font-semibold text-white shadow-xl transition max-sm:w-12 max-sm:justify-center max-sm:px-0 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:right-32 ${open ? "max-lg:hidden" : ""}`}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/95 shadow-inner">
          <AssistantAvatar mood={mood} className="h-8 w-7" />
        </span>
        {/* On a phone the button is just Blocky, so it covers less of the page. */}
        <span className="max-sm:sr-only">{open ? "Hide Blocky" : "Ask Blocky"}</span>
        {attention && !open && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-base-100 bg-warning" />
          </span>
        )}
      </button>
    </>
  );
}
