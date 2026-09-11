import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, Clock, LoaderCircle, X } from "lucide-react";
import type { AssistantSource, AssistantToolActivity } from "./api";

const statusLabels = {
  running: "Running",
  executed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  pending_confirmation: "Needs approval",
} as const;

function toolLabel(toolId: string): string {
  if (toolId === "web.search") return "Search web";
  if (toolId === "web.fetch") return "Read page";
  return toolId;
}

function toolActivitySummary(
  activity: readonly AssistantToolActivity[],
  streaming: boolean,
): string {
  const running = activity.some((entry) => entry.status === "running");
  if (running) return streaming ? "Thinking" : "Interrupted";
  if (activity.some((entry) => entry.status === "pending_confirmation")) return "Needs approval";
  const failed = activity.filter((entry) => entry.status === "failed").length;
  if (failed === 1) return "Tool failed";
  if (failed > 1) return `${String(failed)} tools failed`;
  return activity.length === 1 ? "1 tool" : `${String(activity.length)} tools`;
}

export function AssistantToolActivityList({
  activity,
  streaming,
}: {
  readonly activity: readonly AssistantToolActivity[];
  readonly streaming: boolean;
}) {
  const running = activity.some((entry) => entry.status === "running");
  const failed = activity.some((entry) => entry.status === "failed");
  const [expanded, setExpanded] = useState(running || failed);
  useEffect(() => {
    if (running) setExpanded(true);
  }, [running]);
  if (activity.length === 0) return null;
  return (
    <details
      className="group mb-2"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] leading-4 text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {toolActivitySummary(activity, streaming)}
      </summary>
      <ul aria-label="Tool activity" className="mt-1 space-y-0.5 pl-4">
        {activity.map((entry) => {
          const Icon =
            entry.status === "running" && streaming
              ? LoaderCircle
              : entry.status === "executed"
                ? Check
                : entry.status === "failed"
                  ? X
                  : Clock;
          const label =
            entry.status === "running" && !streaming ? "Interrupted" : statusLabels[entry.status];
          return (
            <li key={entry.toolCallId} className="text-[11px] leading-4 text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Icon size={12} aria-hidden="true" />
                <span className="min-w-0 break-words">{toolLabel(entry.toolId)}</span>
                <span role="status" className="ml-auto shrink-0">
                  {label}
                </span>
              </div>
              {entry.error ? <p className="mt-0.5">{entry.error}</p> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export interface PublicWebSource {
  readonly source: AssistantSource;
  readonly url: URL;
}

export function publicWebSources(sources: readonly AssistantSource[]): readonly PublicWebSource[] {
  return sources.flatMap((source) => {
    if (source.type !== "web.search" && source.type !== "web.fetch") return [];
    try {
      const url = new URL(source.url ?? "");
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        ? [{ source, url }]
        : [];
    } catch {
      return [];
    }
  });
}

function hostLabel(url: URL): string {
  return url.hostname.replace(/^www\./u, "");
}

export function AssistantSourceList({
  sources,
  onOpenEvidence,
}: {
  readonly sources: readonly AssistantSource[];
  readonly onOpenEvidence: (sources: readonly PublicWebSource[]) => void;
}) {
  const links = publicWebSources(sources);
  if (links.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <ul
        aria-label="Sources"
        className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 p-0 [list-style:none]"
      >
        {links.map(({ source, url }, index) => (
          <li key={source.id}>
            <button
              type="button"
              className="[font-size:11px] leading-4 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => {
                onOpenEvidence(links);
              }}
            >
              {String(index + 1)} {hostLabel(url)}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="[font-size:11px] leading-4 text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => {
          onOpenEvidence(links);
        }}
      >
        Evidence
      </button>
    </div>
  );
}

export function AssistantEvidenceDrawer({
  sources,
  onClose,
}: {
  readonly sources: readonly PublicWebSource[];
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed top-0 right-0 bottom-0 z-40 flex w-[min(20rem,90vw)] flex-col border-l bg-card shadow-lg"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h2 id={titleId} className="m-0 min-w-0 flex-1 text-sm font-semibold">
          Evidence
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          className="icon-btn"
          aria-label="Close evidence"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <ol className="m-0 flex-1 list-decimal space-y-3 overflow-y-auto p-4 pl-8 [font-size:var(--text-meta)]">
        {sources.map(({ source, url }) => (
          <li key={source.id} className="min-w-0">
            <a
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-words text-sm font-medium underline-offset-2 hover:underline"
            >
              {source.title || hostLabel(url)}
            </a>
            <div className="truncate text-muted-foreground">{hostLabel(url)}</div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
