import { DefaultChatTransport, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { Bot, CircleStop, RotateCcw, SendHorizontal, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ControllerQAProps = {
  seed: number;
  context: {
    scorecard: unknown;
    exceptions: unknown;
    forecast: unknown;
    matches: unknown;
  };
};

function messageText(message: UIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export function ControllerQA({ seed, context }: ControllerQAProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { controllerContext: context },
      }),
    [context],
  );
  const { messages, sendMessage, status, error, stop, clearError } = useChat({
    id: `controller-qa-${seed}`,
    transport,
    onError: clearError,
  });
  const isWorking = status === "submitted" || status === "streaming";

  useEffect(() => {
    textareaRef.current?.focus();
  }, [status]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const submit = async () => {
    const text = input.trim();
    if (!text || isWorking) return;
    setInput("");
    await sendMessage({ text });
    textareaRef.current?.focus();
  };

  return (
    <section className="mt-8 panel overflow-hidden" aria-labelledby="controller-qa-heading">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
            <Sparkles className="size-4" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="controller-qa-heading" className="text-lg font-semibold tracking-tight">
                Ask the controller
              </h2>
              <Badge variant="outline" className="border-accent/50 text-accent">
                live batch context
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Get a grounded read on matches, exceptions, accuracy, and cash runway.
            </p>
          </div>
        </div>
        {messages.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => window.location.reload()}
            title="Start a fresh Q&A session"
          >
            <RotateCcw aria-hidden="true" />
            New session
          </Button>
        ) : null}
      </div>

      <div className="min-h-[260px] space-y-4 px-5 py-5">
        {messages.length === 0 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              "Which exceptions need attention first?",
              "Explain the precision score.",
              "Will cash stay positive over eight weeks?",
            ].map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rounded-sm border border-border bg-secondary/40 px-3 py-3 text-left text-sm transition-colors hover:border-primary/60 hover:bg-secondary"
                onClick={() => {
                  setInput(prompt);
                  textareaRef.current?.focus();
                }}
              >
                <span className="text-muted-foreground">Ask</span>
                <span className="mt-1 block">{prompt}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="max-h-[430px] space-y-4 overflow-y-auto pr-1" aria-live="polite">
            {messages.map((message) => {
              const text = messageText(message);
              const reasoning = message.parts
                .filter((part) => part.type === "reasoning")
                .map((part) => (part.type === "reasoning" ? part.text : ""))
                .join("");
              return (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {message.role !== "user" ? (
                    <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-sm border border-accent/50 text-accent">
                      <Bot className="size-4" aria-hidden="true" />
                    </div>
                  ) : null}
                  <div
                    className={`max-w-[min(46rem,90%)] rounded-sm px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-secondary/45"}`}
                  >
                    {reasoning ? (
                      <details className="mb-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">Controller reasoning</summary>
                        <p className="mt-1 whitespace-pre-wrap">{reasoning}</p>
                      </details>
                    ) : null}
                    {message.role === "assistant" ? (
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
                          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        }}
                      >
                        {text || (isWorking ? "" : "No answer returned.")}
                      </ReactMarkdown>
                    ) : (
                      text
                    )}
                    {message.role === "assistant" && isWorking && !text ? (
                      <span className="inline-flex gap-1" aria-label="Controller is thinking">
                        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                        <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
                        <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
        {error ? (
          <div className="flex items-center justify-between gap-3 border border-negative/50 px-3 py-2 text-sm text-negative">
            <span>{error.message || "The controller could not answer this question."}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => clearError()}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>

      <form
        className="border-t border-border bg-secondary/25 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask about this batch..."
            aria-label="Ask the finance controller"
            rows={2}
            disabled={isWorking}
            className="min-h-[52px] resize-none bg-background"
          />
          {isWorking ? (
            <Button type="button" variant="outline" size="icon" onClick={() => void stop()} title="Stop response">
              <CircleStop aria-hidden="true" />
              <span className="sr-only">Stop response</span>
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} title="Send question">
              <SendHorizontal aria-hidden="true" />
              <span className="sr-only">Send question</span>
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Answers use only the current synthetic batch. Nothing is saved.</p>
      </form>
    </section>
  );
}