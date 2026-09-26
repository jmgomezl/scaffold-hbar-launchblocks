import { Fragment, type ReactNode } from "react";

/**
 * The little Markdown the assistant writes: paragraphs, lists, headings,
 * code blocks, `code`, **bold**, *italics* and https links. Everything is
 * rendered as React text, never as HTML, so an answer cannot inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2 [overflow-wrap:anywhere]">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(<p key={out.length}>{inline(paragraph.join(" "))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item)}</li>);
    out.push(
      list.ordered ? (
        <ol key={out.length} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={out.length} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (index++; index < lines.length && !(lines[index] as string).trimStart().startsWith("```"); index++) {
        code.push(lines[index] as string);
      }
      out.push(
        <pre key={out.length} className="overflow-x-auto rounded-lg bg-base-200 p-2 text-xs">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(
        <p key={out.length} className="font-semibold">
          {inline(heading[1] as string)}
        </p>,
      );
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)?.[1] as string);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [token] = match;
    const key = match.index;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-base-200 px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token) ?? [];
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer nofollow" className="link link-primary">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}
