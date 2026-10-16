import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormPanel } from "@/components/ui/form-panel";
import { mailThreadsQueryOptions } from "../queries";
import {
  prepareProductivityArtifact,
  actionDigestQueryOptions,
  productivityArtifactsQueryOptions,
  productivitySettingsQueryOptions,
} from "./api";
import { AutomationSettings } from "./automation-settings";
import { RuleProposal } from "./rule-proposal";

export function ProductivityPanel({ onClose }: { readonly onClose: () => void }) {
  const [section, setSection] = useState<"digest" | "automation" | "rules">("digest");
  const settings = useQuery(productivitySettingsQueryOptions());
  return (
    <FormPanel title="Mail assistance" onClose={onClose}>
      <div className="admin-stack">
        <nav className="flex flex-wrap gap-2" aria-label="Mail assistance sections">
          {(
            [
              ["digest", "Action digest"],
              ["automation", "Automation"],
              ["rules", "Draft a rule"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              variant={section === id ? "default" : "outline"}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        {section === "digest" ? <Digest /> : null}
        {section === "automation" ? (
          settings.data ? (
            <AutomationSettings
              initial={settings.data.settings}
              aiEnabled={settings.data.aiEnabled}
            />
          ) : (
            <p role={settings.error ? "alert" : "status"}>
              {settings.error?.message ?? "Loading preferences…"}
            </p>
          )
        ) : null}
        {section === "rules" ? (
          settings.data?.aiEnabled ? (
            <RuleProposal />
          ) : (
            <p>
              Enable Mail AI in administrator settings to draft rules. You can always create filters
              manually in Mail settings.
            </p>
          )
        ) : null}
      </div>
    </FormPanel>
  );
}
function Digest() {
  const client = useQueryClient();
  const digest = useQuery(actionDigestQueryOptions());
  const artifacts = useQuery(productivityArtifactsQueryOptions());
  const [threadIds, setThreadIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const threads = useQuery(mailThreadsQueryOptions({ folder: "all", query: search, limit: 25 }));
  const brief = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (eventId: string) =>
      prepareProductivityArtifact("mail.meeting.brief", { eventId, threadIds }),
  });
  return (
    <div className="admin-stack">
      <Button
        variant="outline"
        onClick={() => {
          void client.invalidateQueries(actionDigestQueryOptions());
          void client.invalidateQueries(productivityArtifactsQueryOptions());
        }}
        disabled={digest.isFetching}
      >
        Refresh digest
      </Button>
      {digest.error ? (
        <p role="alert" className="text-destructive">
          {digest.error.message}
        </p>
      ) : null}
      {digest.data ? (
        <>
          <p className="type-caption">
            Updated {new Date(digest.data.generatedAt).toLocaleString()}. {digest.data.note}
          </p>
          {(
            [
              ["Needs reply", digest.data.needsReply, "is:needs-reply"],
              ["Waiting on", digest.data.waitingOn, "is:waiting-on"],
            ] as const
          ).map(([title, page, query]) => (
            <section key={title} aria-label={title}>
              <h3>
                {title} ({page.total})
              </h3>
              {page.threads.length ? (
                <ul>
                  {page.threads.map((thread) => (
                    <li key={thread.threadId}>
                      <a href={`/mail?thread=${thread.threadId}`}>
                        {thread.subject || "(no subject)"}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Nothing waiting here.</p>
              )}
              {page.total > page.threads.length ? (
                <a href={`/mail?q=${encodeURIComponent(query)}`}>
                  View all {page.total} conversations
                </a>
              ) : null}
            </section>
          ))}
          <a href={digest.data.approvalsHref}>Open human approvals</a>
          <h3>Upcoming meetings</h3>
          <label htmlFor="brief-conversations" className="type-body-sm">
            Find related conversations (optional)
          </label>
          <Input
            id="brief-conversations"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your mail"
          />
          <fieldset className="admin-stack">
            <legend>Select up to five conversations</legend>
            {threads.data?.threads.map((thread) => (
              <label key={thread.threadId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={threadIds.includes(thread.threadId)}
                  disabled={threadIds.length >= 5 && !threadIds.includes(thread.threadId)}
                  onChange={(event) =>
                    setThreadIds((current) =>
                      event.target.checked
                        ? [...current, thread.threadId]
                        : current.filter((id) => id !== thread.threadId),
                    )
                  }
                />
                {thread.subject || "(no subject)"}
              </label>
            ))}
          </fieldset>
          {threads.error ? <p role="alert">{threads.error.message}</p> : null}
          {digest.data.calendarError ? <p role="alert">{digest.data.calendarError}</p> : null}
          {digest.data.meetings.length ? (
            <ul>
              {digest.data.meetings.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2">
                  <a href={event.href}>{event.title}</a>
                  <span className="type-caption">{new Date(event.startsAt).toLocaleString()}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={brief.isPending}
                    onClick={() => brief.mutate(event.id)}
                  >
                    Prepare brief
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No visible meetings in the next 24 hours.</p>
          )}
        </>
      ) : (
        <p role="status">Loading digest…</p>
      )}
      {brief.error ? (
        <p role="alert" className="text-destructive">
          {brief.error.message}
        </p>
      ) : null}
      {brief.data ? (
        <section aria-label="Meeting brief">
          <h3>Private meeting brief</h3>
          <div className="whitespace-pre-wrap type-body-sm">
            {brief.data.text || brief.data.error || "Preparation is in progress."}
          </div>
        </section>
      ) : null}
      <h3>Recent preparation</h3>
      {artifacts.error ? <p role="alert">{artifacts.error.message}</p> : null}
      <ul>
        {artifacts.data?.artifacts.map((item) => (
          <li key={item.id}>
            <span>
              {item.kind === "reply" ? "Reply suggestion" : "Attachment filing"}: {item.status}
            </span>
            {item.kind === "reply" ? (
              <a className="ml-2" href={`/mail?thread=${item.sourceKey.split(":")[0]}`}>
                Open conversation
              </a>
            ) : null}
            {item.objectId ? (
              <a className="ml-2" href={`/drive?file=${item.objectId}`}>
                Open filed copy
              </a>
            ) : null}
            {item.error ? <p>{item.error}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
