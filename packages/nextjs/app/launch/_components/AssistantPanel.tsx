"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../_lib/api";
import type { AssistantStatus } from "../_lib/assistant";
import { AssistantAvatar } from "./AssistantAvatar";
import { Markdown } from "./Markdown";
import { ExclamationTriangleIcon, PaperAirplaneIcon, SparklesIcon, StopIcon } from "@heroicons/react/24/outline";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  error?: ApiError;
  /** From the server's checks on the finished answer, e.g. an account the launch does not use. */
  warning?: string;
};

export type Suggestion = { label: string; question: string; focus?: { stepId?: string; type?: string } };

type Props = {
  status: AssistantStatus | null;
  messages: ChatMessage[];
  busy: boolean;
  suggestions: Suggestion[];
  onAsk: (question: string, focus?: Suggestion["focus"]) => void;
  onStop: () => void;
};

/**
 * The conversation with the studio's AI companion: the messages scroll, the
 * question box stays at the bottom. It fills whatever holds it (the floating
 * window in the studio).
 */
export function AssistantPanel({ status, messages, busy, suggestions, onAsk, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastLength = messages.at(-1)?.content.length ?? 0;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, lastLength, busy]);

  useEffect(() => {
    if (status?.enabled) input.current?.focus();
  }, [status?.enabled]);

  if (!status) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm opacity-70">
        <span className="loading loading-spinner loading-xs" /> Loading the assistant…
      </p>
    );
  }
  if (!status.enabled) {
    return (
      <div className="space-y-2 p-4 text-sm">
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
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div ref={scroller} className="min-h-0 grow space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex items-start gap-3">
            <AssistantAvatar className="h-16 w-12 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold">Hi, I&apos;m Blocky!</div>
              <div className="opacity-70">
                Three blocks, two eyes, zero private keys. Ask me what a block does, why something is flagged, why a run
                failed, or what to add next; or right-click any block to ask about it.
              </div>
            </div>
          </div>
        ) : (
          <ol className="space-y-3" aria-live="polite" aria-label="Conversation with the assistant">
            {messages.map((message, index) => (
              <li
                key={index}
                className={
                  message.role === "user"
                    ? "ml-8 rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2"
                    : "relative ml-9 mr-2 rounded-2xl rounded-bl-sm border border-base-300 px-3 py-2"
                }
              >
                {message.role === "assistant" && (
                  <AssistantAvatar
                    mood={
                      busy && index === messages.length - 1
                        ? "thinking"
                        : message.warning || message.error
                          ? "worried"
                          : "idle"
                    }
                    className="absolute -left-9 bottom-0 h-10 w-8"
                  />
                )}
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap">{message.content}</p>
                ) : message.content ? (
                  <Markdown text={message.content} />
                ) : message.error ? null : (
                  <span className="loading loading-dots loading-sm opacity-60" aria-label="Writing" />
                )}
                {message.warning && (
                  <div role="alert" className="alert alert-warning alert-soft mt-2 items-start px-3 py-2 text-xs">
                    <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
                    <span>{message.warning}</span>
                  </div>
                )}
                {message.error && (
                  <div className="mt-1 text-xs">
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
      </div>

      <form
        className="space-y-1 border-t border-base-300 px-3 pb-2 pt-2"
        onSubmit={event => {
          event.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            className="textarea textarea-bordered min-h-0 grow resize-none text-sm focus:outline-2 focus:outline-primary/50"
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
        <p className="text-[11px] leading-snug opacity-60">
          {status.model} via OpenAI. Your question and this launch are sent to it; keys never are. It can be wrong:
          check before you spend HBAR.
        </p>
      </form>
    </div>
  );
}
