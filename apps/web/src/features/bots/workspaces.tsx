import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FormPanel } from "@/components/ui/form-panel";
import { AdminTable } from "@/features/admin/console/table";
import { SettingsHeader } from "@/components/shell/settings-controls";
import { botsQueryOptions, botWorkspaceQueryOptions, type Bot } from "./api";
import type { SettingsSectionProps } from "@/components/shell/settings-sections";
export function BotWorkspaces({ tab, onTabChange, onNavigate }: SettingsSectionProps) {
  const [botOffset, setBotOffset] = useState(0);
  const bots = useQuery(botsQueryOptions({ offset: botOffset }));
  const detail = useQuery({
    ...botsQueryOptions(tab ? { botActorId: tab } : {}),
    enabled: !!tab,
  });
  const selected = detail.error ? undefined : detail.data?.bots.find((bot) => bot.id === tab);
  return (
    <section className="admin-stack">
      <SettingsHeader
        title="Bot workspaces"
        description="Read-only oversight of bots you are authorized to observe. Sending, file changes and credential management require separate authority."
      />
      {bots.error ? (
        <p role="alert" className="text-destructive">
          {bots.error.message}
        </p>
      ) : null}
      <AdminTable<Bot>
        label="Bot workspaces"
        rows={bots.data?.bots ?? []}
        rowKey={(bot) => bot.id}
        searchText={(bot) => `${bot.displayName} ${bot.email ?? ""}`}
        empty={
          <p>
            {bots.isPending
              ? "Loading bots…"
              : "No bots are available to you. Ask a Workspace administrator for access."}
          </p>
        }
        columns={[
          {
            id: "name",
            header: "Bot",
            cell: (bot) => bot.displayName,
            sortValue: (bot) => bot.displayName,
          },
          {
            id: "email",
            header: "Email",
            cell: (bot) => bot.email ?? "Not configured",
            sortValue: (bot) => bot.email,
          },
          {
            id: "status",
            header: "Status",
            cell: (bot) => (bot.disabled ? "Disabled" : "Active"),
            sortValue: (bot) => (bot.disabled ? 1 : 0),
          },
          {
            id: "open",
            header: "Workspace",
            cell: (bot) => (
              <Button variant="outline" size="sm" onClick={() => onTabChange(bot.id)}>
                Inspect
              </Button>
            ),
          },
        ]}
      />
      <div className="flex gap-2">
        {botOffset > 0 ? (
          <Button variant="outline" onClick={() => setBotOffset(Math.max(0, botOffset - 100))}>
            Previous bots
          </Button>
        ) : null}
        {bots.data?.hasMore ? (
          <Button variant="outline" onClick={() => setBotOffset(botOffset + 100)}>
            Next bots
          </Button>
        ) : null}
      </div>
      {tab && detail.isPending ? <p role="status">Loading bot…</p> : null}
      {tab && !detail.isPending && !selected ? (
        <p role="alert">
          {detail.error?.message ?? "Bot workspace is unavailable or your access was revoked."}
        </p>
      ) : null}
      {selected ? (
        <BotWorkspace key={selected.id} bot={selected} onClose={() => onNavigate("bots")} />
      ) : null}
    </section>
  );
}
function BotWorkspace({ bot, onClose }: { readonly bot: Bot; readonly onClose: () => void }) {
  const [surface, setSurface] = useState<"mail" | "files" | "chat" | "activity">("mail");
  const [threadId, setThread] = useState<string | null>(null);
  const [roomId, setRoom] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery(
    botWorkspaceQueryOptions({
      botActorId: bot.id,
      surface,
      offset,
      ...(threadId ? { threadId } : {}),
      ...(roomId ? { roomId } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  );
  const data = query.error ? undefined : query.data;
  return (
    <FormPanel title={`${bot.displayName} · Workspace`} onClose={onClose}>
      <div className="admin-stack">
        <p className="type-caption">
          Read-only. Access is audited and checked again for every read.
        </p>
        <nav className="flex flex-wrap gap-2" aria-label="Bot workspace sections">
          {(
            [
              ["mail", "Mail"],
              ["files", "Files"],
              ["chat", "Chat"],
              ["activity", "Activity"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              variant={surface === id ? "default" : "outline"}
              aria-current={surface === id ? "page" : undefined}
              onClick={() => {
                setSurface(id);
                setThread(null);
                setRoom(null);
                setOffset(0);
                setCursor(undefined);
              }}
            >
              {label}
            </Button>
          ))}
        </nav>
        {query.error ? (
          <p role="alert" className="text-destructive">
            {query.error.message}
          </p>
        ) : null}
        {query.isPending ? <p role="status">Loading workspace…</p> : null}
        {threadId || roomId ? (
          <Button
            variant="outline"
            onClick={() => {
              setThread(null);
              setRoom(null);
              setCursor(undefined);
            }}
          >
            Back to list
          </Button>
        ) : null}
        {data?.threads ? (
          <AdminTable
            label="Bot mail"
            rows={data.threads}
            rowKey={(row) => row.threadId}
            searchText={(row) => `${row.subject} ${row.from}`}
            partialNote="One page of 50 conversations"
            columns={[
              { id: "from", header: "From", cell: (row) => row.from, sortValue: (row) => row.from },
              {
                id: "subject",
                header: "Subject",
                cell: (row) => (
                  <Button variant="ghost" onClick={() => setThread(row.threadId)}>
                    {row.subject || "(no subject)"}
                  </Button>
                ),
                sortValue: (row) => row.subject,
              },
            ]}
            empty={<p>No mail on this page.</p>}
          />
        ) : null}
        {data?.thread ? (
          <section aria-label="Bot conversation">
            <h3>{data.thread.subject}</h3>
            {data.thread.messages.map((message) => (
              <article key={message.id} className="border-b border-border py-3">
                <p className="font-medium">
                  {message.from?.name ?? message.from?.address ?? "Unknown sender"} ·{" "}
                  {new Date(message.sentAt).toLocaleString()}
                </p>
                <div className="whitespace-pre-wrap break-words">
                  {message.plainBody ?? message.body}
                </div>
              </article>
            ))}
          </section>
        ) : null}
        {data?.entries ? (
          <AdminTable
            label="Bot files"
            rows={data.entries}
            rowKey={(row) => row.id}
            searchText={(row) => row.name}
            partialNote="One page of 50 files"
            columns={[
              { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
              {
                id: "size",
                header: "Bytes",
                cell: (row) => row.byteSize ?? "—",
                sortValue: (row) => row.byteSize ?? null,
              },
              {
                id: "download",
                header: "Download",
                cell: (row) =>
                  row.type === "folder" ? (
                    "Folder"
                  ) : (
                    <a href={`/v1/api/bots/${bot.id}/files/${row.id}`} download>
                      Download
                    </a>
                  ),
              },
            ]}
            empty={<p>No files on this page.</p>}
          />
        ) : null}
        {data?.rooms ? (
          <ul>
            {data.rooms.map((room) => (
              <li key={room.id}>
                <Button variant="ghost" onClick={() => setRoom(room.id)}>
                  {room.subject ??
                    (room.kind === "direct" ? "Direct conversation" : "Chat conversation")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {data?.messages ? (
          <section aria-label="Bot chat messages">
            <p className="type-caption">One page of up to 50 messages visible to this bot.</p>
            {cursor ? (
              <Button variant="outline" onClick={() => setCursor(undefined)}>
                Latest messages
              </Button>
            ) : null}
            {data.messages.map((message) => (
              <article key={message.id} className="border-b border-border py-2">
                <time className="type-caption">{new Date(message.sentAt).toLocaleString()}</time>
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
              </article>
            ))}
          </section>
        ) : null}
        {data?.activity ? (
          <ul>
            {data.activity.map((item) => (
              <li key={item.id}>
                {new Date(item.created_at).toLocaleString()} · {item.verb}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-2">
          {offset > 0 && !threadId && !roomId ? (
            <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 50))}>
              Previous page
            </Button>
          ) : null}
          {(data?.total ?? 0) > offset + 50 || data?.activity?.length === 50 || data?.hasMore ? (
            <Button variant="outline" onClick={() => setOffset(offset + 50)}>
              Next page
            </Button>
          ) : null}
          {data?.nextCursor || data?.thread?.nextCursor ? (
            <Button
              variant="outline"
              onClick={() => setCursor(data?.nextCursor ?? data?.thread?.nextCursor)}
            >
              Next page
            </Button>
          ) : null}
        </div>
      </div>
    </FormPanel>
  );
}
