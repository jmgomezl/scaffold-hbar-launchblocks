"use client";

import { useEffect, useState } from "react";
import type { HLJSApi } from "highlight.js";

export type CodeLanguage = "typescript" | "json" | "yaml" | "markdown";

let highlighter: Promise<HLJSApi> | null = null;

/** highlight.js with only the languages the exports use, loaded the first time the dialog shows code. */
function loadHighlighter(): Promise<HLJSApi> {
  highlighter ??= Promise.all([
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/typescript"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/yaml"),
    import("highlight.js/lib/languages/markdown"),
  ]).then(([{ default: hljs }, typescript, json, yaml, markdown]) => {
    hljs.registerLanguage("typescript", typescript.default);
    hljs.registerLanguage("json", json.default);
    hljs.registerLanguage("yaml", yaml.default);
    hljs.registerLanguage("markdown", markdown.default);
    return hljs;
  });
  return highlighter;
}

export function languageOf(path: string): CodeLanguage | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "ts") return "typescript";
  if (extension === "json") return "json";
  if (extension === "yaml" || extension === "yml") return "yaml";
  if (extension === "md") return "markdown";
  return undefined;
}

/** Code with syntax colours (see `.code-view` in globals.css); plain text until the highlighter loads. */
export function HighlightedCode({ text, language }: { text: string; language: CodeLanguage | undefined }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (!text || !language) return;
    let cancelled = false;
    loadHighlighter().then(
      // highlight.js escapes the source, so its output is safe to insert.
      hljs => !cancelled && setHtml(hljs.highlight(text, { language }).value),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [text, language]);

  return html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>;
}
