import { Check, Clock, LoaderCircle, X } from "lucide-react";
import type { AssistantSource, AssistantToolActivity } from "./api";

const statusLabels = {
  running: "Running",
  executed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  pending_confirmation: "Needs approval",
} as const;

export function AssistantToolActivityList({
  activity,
  streaming,
}: {
  readonly activity: readonly AssistantToolActivity[];
  readonly streaming: boolean;
}) {
  if (activity.length === 0) return null;
  return (
    <ul aria-label="Tool activity" className="mb-3 space-y-2 text-sm">
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
          <li key={entry.toolCallId} className="rounded-lg border px-3 py-2">
            <div className="flex items-center gap-2">
              <Icon size={14} aria-hidden="true" />
              <span className="min-w-0 break-words">
                {entry.toolId === "web.search"
                  ? "Search web"
                  : entry.toolId === "web.fetch"
                    ? "Read page"
                    : entry.toolId}
              </span>
              <span role="status" className="ml-auto shrink-0 text-xs text-muted-foreground">
                {label}
              </span>
            </div>
            {entry.error ? <p className="mt-1 text-sm">{entry.error}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function AssistantSourceList({ sources }: { readonly sources: readonly AssistantSource[] }) {
  const links = sources.flatMap((source) => {
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
  if (links.length === 0) return null;
  return (
    <ul aria-label="Sources" className="mt-3 flex flex-wrap gap-2">
      {links.map(({ source, url }) => (
        <li key={source.id} className="min-w-0 max-w-full rounded-lg border px-3 py-2 text-sm">
          <span className="block text-xs text-muted-foreground">
            {source.type === "web.fetch" ? "Read page" : "Search result"}
          </span>
          <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words underline underline-offset-2"
          >
            {source.title || url.hostname}
          </a>
          <span className="block text-xs text-muted-foreground">{url.hostname}</span>
        </li>
      ))}
    </ul>
  );
}
