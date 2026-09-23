"use client";

import { useEffect, useRef } from "react";
import type { StepStatus, WorkspaceState } from "../_lib/blocks";
import {
  applyStatuses,
  applyWarnings,
  buildToolbox,
  defineBlocks,
  flowBlock,
  readDocument,
  registerOutputsCategory,
  stepIdGuard,
  writeDocument,
} from "../_lib/blocks";
import { darkTheme, lightTheme } from "../_lib/theme";
import type { Catalog, EditorDocument } from "@sh/launchblocks/editor";
import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";

export type LoadRequest = { document: EditorDocument; nonce: number };

type Props = {
  catalog: Catalog;
  load: LoadRequest | null;
  onChange: (state: WorkspaceState) => void;
  onLoadProblems?: (skippedStepIds: string[]) => void;
  statuses: Record<string, StepStatus | undefined>;
  warnings: ReadonlyMap<string, string[]>;
  dark: boolean;
};

/**
 * The Blockly workspace. Loaded client-side only (see LaunchStudio): Blockly
 * needs the DOM. It reports every structural change as a WorkspaceState and
 * takes status and warnings to paint back onto blocks.
 */
export default function BlockEditor({ catalog, load, onChange, onLoadProblems, statuses, warnings, dark }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const workspace = useRef<Blockly.WorkspaceSvg | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    Blockly.setLocale(En as unknown as Record<string, string>);
    defineBlocks(catalog);
    const ws = Blockly.inject(host.current, {
      toolbox: buildToolbox(catalog),
      renderer: "thrasos",
      theme: lightTheme,
      trashcan: true,
      sounds: false,
      grid: { spacing: 24, length: 2, colour: "#d7dbe2", snap: true },
      move: { scrollbars: true, drag: true, wheel: true },
      zoom: {
        controls: true,
        wheel: false,
        pinch: true,
        startScale: 0.85,
        maxScale: 2,
        minScale: 0.3,
        scaleSpeed: 1.15,
      },
    });
    registerOutputsCategory(ws, catalog);
    ws.addChangeListener(stepIdGuard(ws));

    const sync = () => {
      clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => onChangeRef.current(readDocument(ws, catalog)), 200);
    };
    ws.addChangeListener(event => {
      if (event.isUiEvent || ws.isDragging()) return;
      sync();
    });

    workspace.current = ws;
    // Blockly.svgResize compares against a cached size and skips the write
    // when they match, so if layout settles after inject (late CSS, a panel
    // toggle during a hot reload) the SVG can stay stale while the cache
    // claims it is current. Size it from the container every time instead.
    const fitToContainer = () => {
      const svg = ws.getParentSvg();
      const container = svg.parentElement;
      if (!container) return;
      const { offsetWidth: width, offsetHeight: height } = container;
      svg.setAttribute("width", `${width}px`);
      svg.setAttribute("height", `${height}px`);
      ws.setCachedParentSvgSize(width, height);
      ws.resize();
    };
    const resize = new ResizeObserver(fitToContainer);
    resize.observe(host.current);
    return () => {
      clearTimeout(syncTimer.current);
      resize.disconnect();
      workspace.current = null;
      ws.dispose();
    };
  }, [catalog]);

  useEffect(() => {
    const ws = workspace.current;
    if (!ws || !load) return;
    const skipped = writeDocument(ws, catalog, load.document);
    if (skipped.length) onLoadProblems?.(skipped);
    // Open on the Launch block's header rather than the middle of a tall flow.
    const root = flowBlock(ws) as Blockly.BlockSvg | null;
    if (root) {
      const box = root.getBoundingRectangle();
      ws.scroll(-box.left * ws.scale + 48, -box.top * ws.scale + 24);
    }
    onChangeRef.current(readDocument(ws, catalog));
    // Only a new load request (nonce) should rebuild the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load?.nonce, catalog]);

  useEffect(() => {
    workspace.current?.setTheme(dark ? darkTheme : lightTheme);
  }, [dark]);

  useEffect(() => {
    if (workspace.current) applyStatuses(workspace.current, statuses);
  }, [statuses]);

  useEffect(() => {
    if (workspace.current) applyWarnings(workspace.current, warnings);
  }, [warnings]);

  return <div ref={host} className="absolute inset-0" aria-label="LaunchBlocks block editor" />;
}
