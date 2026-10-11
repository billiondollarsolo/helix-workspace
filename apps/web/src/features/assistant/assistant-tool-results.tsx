import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, Clock, LoaderCircle, X } from "lucide-react";
import { iconMap as Icons, type IconName } from "@/components/icon-map";
import type { GlobalSearchType } from "@/features/search/api";
import { searchHitTarget, type SearchHitTarget } from "@/features/search/search-hits";
import type { AssistantCitation, AssistantSource, AssistantToolActivity } from "./api";

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
      <summary className="flex cursor-pointer list-none items-center gap-1 type-caption leading-4 text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
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
            <li key={entry.toolCallId} className="type-caption leading-4 text-muted-foreground">
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

const WORKSPACE_SOURCE_ICONS: Readonly<Record<GlobalSearchType, IconName>> = {
  mail: "Mail",
  drive: "Drive",
  chat: "Chat",
  calendar: "Calendar",
};

/** A workspace record the answer drew on, with where it opens in Helix. */
interface WorkspaceSource {
  readonly citation: AssistantCitation;
  readonly type: GlobalSearchType;
  readonly target: SearchHitTarget;
}

/**
 * Workspace records cited by an answer. The server re-checks the reader's
 * access on every load and sends each record's index path
 * (`/mail/<thread>?message=…`, `/drive/<file>`, `/chat/<room>…`,
 * `/calendar/events/<event>`); the owning app's URL comes from `searchHitTarget`.
 */
function workspaceSources(citations: readonly AssistantCitation[]): readonly WorkspaceSource[] {
  return citations.flatMap((citation) => {
    const type = citation.kind;
    const match = /^\/(?:mail|drive|chat|calendar\/events)\/([^/?#]+)/u.exec(citation.path);
    const id = match?.[1];
    if (id === undefined) return [];
    const attributes =
      type === "mail"
        ? { threadId: id }
        : type === "chat"
          ? { roomId: id }
          : type === "drive"
            ? { fileId: id }
            : { eventId: id };
    return [
      {
        citation,
        type,
        target: searchHitTarget({
          id: `${type}:${citation.id}`,
          type,
          ...(citation.title === null ? {} : { title: citation.title }),
          attributes,
        }),
      },
    ];
  });
}

export function WorkspaceSourceList({
  citations,
}: {
  readonly citations: readonly AssistantCitation[];
}) {
  const cited = workspaceSources(citations);
  if (cited.length === 0) return null;
  return (
    <ul aria-label="Workspace sources" className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
      {cited.map(({ citation, type, target }) => {
        const Icon = Icons[WORKSPACE_SOURCE_ICONS[type]];
        return (
          <li key={`${type}:${citation.id}`}>
            <Link
              {...target}
              className="focus-ring inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 type-caption text-foreground hover:bg-[var(--hover)]"
            >
              <Icon size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              <span className="truncate">{citation.title || "Untitled"}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
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
              className="type-caption leading-4 text-muted-foreground hover:text-foreground hover:underline"
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
        className="type-caption leading-4 text-muted-foreground hover:text-foreground hover:underline"
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
  // Focus moves in on open and back to the opener on close only. Callers pass
  // a fresh `onClose` each render; depending on it re-ran this effect on every
  // re-render and pulled focus out of whatever the person had opened since.
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);
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
      <ol className="m-0 flex-1 list-decimal space-y-3 overflow-y-auto p-4 pl-8 type-meta">
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
