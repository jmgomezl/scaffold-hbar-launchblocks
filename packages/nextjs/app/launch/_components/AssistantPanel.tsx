"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../_lib/api";
import type { AssistantStatus } from "../_lib/assistant";
import { Markdown } from "./Markdown";
import { ArrowPathIcon, PaperAirplaneIcon, SparklesIcon, StopIcon } from "@heroicons/react/24/outline";

export type ChatMessage = { role: "user" | "assistant"; content: string; error?: ApiError };

export type Suggestion = { label: string; question: string; focus?: { stepId?: string; type?: string } };

type Props = {
  status: AssistantStatus | null;
  messages: ChatMessage[];
  busy: boolean;
  suggestions: Suggestion[];
  onAsk: (question: string, focus?: Suggestion["focus"]) => void;
  onStop: () => void;
  onClear: () => void;
};

/**
 * The studio's AI companion: a conversation about the launch on screen. It
 * explains blocks, problems and failed runs, and suggests what to do next;
 * the Problems tab, the Run panel and each block's right-click menu open it
 * with a question already asked.
 */
export function AssistantPanel({ status, messages, busy, suggestions, onAsk, onStop, onClear }: Props) {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const lastLength = messages.at(-1)?.content.length ?? 0;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastLength]);

  if (!status) {
    return (
      <p className="flex items-center gap-2 text-sm opacity-70">
        <span className="loading loading-spinner loading-xs" /> Loading the assistant…
      </p>
    );
  }
  if (!status.enabled) {
    return (
      <div className="space-y-2 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <SparklesIcon className="h-4 w-4" /> The assistant is not set up here
        </p>
        <p className="opacity-80">
          It explains blocks, problems and failed runs, and suggests what to do next, using an OpenAI model. To turn it
          on, set <code>OPENAI_API_KEY</code> in <code>packages/nextjs/.env</code> and restart the app.
        </p>
      </div>
    );
  }

  const send = () => {
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    onAsk(question);
  };

  return (
    <div className="flex min-h-full flex-col gap-3 text-sm">
      {messages.length === 0 ? (
        <div className="space-y-1">
          <p className="flex items-center gap-2 font-semibold">
            <SparklesIcon className="h-4 w-4 text-primary" /> Ask about this launch
          </p>
          <p className="opacity-70">
            What a block does, why something is flagged, why a run failed, or what to add next. Right-click any block to
            ask about it.
          </p>
        </div>
      ) : (
        <ol className="space-y-3" aria-live="polite" aria-label="Conversation with the assistant">
          {messages.map((message, index) => (
            <li
              key={index}
              className={
                message.role === "user"
                  ? "ml-8 rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2"
                  : "mr-2 rounded-2xl rounded-bl-sm border border-base-300 px-3 py-2"
              }
            >
              {message.role === "user" ? (
                <p className="whitespace-pre-wrap">{message.content}</p>
              ) : message.content ? (
                <Markdown text={message.content} />
              ) : message.error ? null : (
                <span className="loading loading-dots loading-sm opacity-60" aria-label="Writing" />
              )}
              {message.error && (
                <div className="mt-1 text-xs text-warning-content">
                  <p className="font-semibold text-error">{message.error.message}</p>
                  {message.error.hint && <p className="opacity-80">{message.error.hint}</p>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {!busy && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
          {suggestions.map(suggestion => (
            <button
              key={suggestion.label}
              type="button"
              className="btn btn-xs btn-outline h-auto min-h-6 py-1 text-left font-normal normal-case"
              onClick={() => onAsk(suggestion.question, suggestion.focus)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}

      {/* Scrolled to after each change, with room kept for the question box stuck to the bottom. */}
      <div ref={end} className="scroll-mb-40" />
      <form
        className="sticky bottom-0 mt-auto space-y-1 bg-base-100 pt-2"
        onSubmit={event => {
          event.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            className="textarea textarea-bordered min-h-0 grow resize-none text-sm"
            rows={2}
            maxLength={2000}
            placeholder="Ask about a block, a problem, a failed run…"
            aria-label="Your question for the assistant"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn btn-square btn-sm" onClick={onStop} aria-label="Stop the answer">
              <StopIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary btn-square btn-sm"
              disabled={!draft.trim()}
              aria-label="Ask"
            >
              <PaperAirplaneIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="flex items-center gap-2 text-[11px] opacity-60">
          <span>
            {status.model} via OpenAI. Your question and this launch are sent to it; keys never are. It can be wrong:
            check before you spend HBAR.
          </span>
          {messages.length > 0 && !busy && (
            <button type="button" className="btn btn-ghost btn-xs ml-auto shrink-0 gap-1" onClick={onClear}>
              <ArrowPathIcon className="h-3 w-3" /> New chat
            </button>
          )}
        </p>
      </form>
    </div>
  );
}
