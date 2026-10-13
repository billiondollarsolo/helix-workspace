/* Admin › Security › Agent mail. An agent reads its mail and acts on it, so
 * mail is a way to instruct it. Here an administrator gives an agent a mail
 * address and says who may write to it from outside; anything else is held
 * here until an administrator delivers or deletes it. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  agentMailQueryKey,
  agentMailQueryOptions,
  deleteHeldMail,
  deliverHeldMail,
  heldAgentMailQueryKey,
  heldAgentMailQueryOptions,
  holdReasons,
  saveAgentMail,
  type AgentMailbox,
  type AgentMailReceiveMode,
  type HeldAgentMail,
} from "@/features/admin/agent-mail-api";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { formatRelativeTime } from "@/features/admin/console/format";
import {
  EmptyRow,
  LoadingState,
  MutationError,
  Notice,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";

const MODES: readonly {
  readonly mode: AgentMailReceiveMode;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    mode: "allowed_senders",
    label: "Only the senders I list",
    description:
      "Mail from anyone else, or that cannot prove it came from a listed sender, is held for you.",
  },
  {
    mode: "anyone",
    label: "Anyone",
    description:
      "Every sender reaches the agent. Only mail that tries to override the agent's instructions is held.",
  },
];

const REASONS: Record<string, string> = {
  "sender-not-allowed": "The sender is not on the agent's list.",
  "sender-not-verified": "The message could not prove it came from the sender it names.",
  "instructs-the-agent": "The message tells the agent to ignore its instructions.",
  "hidden-text": "The message contains hidden text.",
};

function parseSenders(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/u)
        .map((sender) => sender.trim().toLowerCase())
        .filter((sender) => sender !== ""),
    ),
  ];
}

/** Who can write to the agent from outside, in a sentence. */
function outsideMail(agent: AgentMailbox): string {
  if (agent.receiveMode === "anyone") return "Anyone outside can write to it.";
  return agent.allowedSenders.length === 0
    ? "Nobody outside can write to it yet."
    : `Outside, only ${agent.allowedSenders.join(", ")} can write to it.`;
}

export function AgentMailManagement() {
  const queryClient = useQueryClient();
  const mailQuery = useQuery(agentMailQueryOptions());
  const [editingId, setEditingId] = useState<string | null>(null);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: agentMailQueryKey });
  };
  const failure = useQueryFailure(mailQuery, reload);
  // A disabled agent is listed only while it still holds an address to take away.
  const agents = (mailQuery.data?.agents ?? []).filter(
    (agent) => !agent.disabled || agent.address !== null,
  );
  const editing = agents.find((agent) => agent.id === editingId) ?? null;

  return (
    <>
      <PageHeading
        title="Agent mail"
        subtitle="Give an agent a mail address and choose who may write to it from outside."
      />
      <div className="admin-stack">
        <HeldMail agents={agents} />

        <section className="admin-card" aria-labelledby="agent-mail-list-heading">
          <PanelHeading
            id="agent-mail-list-heading"
            title="Agents"
            subtitle="People in your organization can always write to an agent. These settings cover mail from outside."
          />
          {failure !== null ? (
            <QueryFailureBanner
              summary="Agent mail couldn't be loaded"
              subject="agent mail"
              error={failure.error}
              isRetrying={failure.isRetrying}
              onRetry={failure.retry}
            />
          ) : mailQuery.isPending ? (
            <LoadingState label="Loading agent mail" count={2} />
          ) : agents.length === 0 ? (
            <EmptyRow>
              There are no agents yet. Add one under{" "}
              <Link to="/admin/$section" params={{ section: "agent-credentials" }}>
                Agent credentials
              </Link>
              .
            </EmptyRow>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0" aria-label="Agents">
              {agents.map((agent) => (
                <li
                  key={agent.id}
                  className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                >
                  <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{agent.displayName}</span>
                      {agent.disabled ? (
                        <StatusChip tone="neutral" label="Disabled" dot={false} />
                      ) : null}
                    </div>
                    <p className="admin-muted m-0 type-caption">
                      {agent.address === null ? (
                        "No mail address."
                      ) : (
                        <>
                          <span className="break-all">{agent.address}</span>. {outsideMail(agent)}
                        </>
                      )}
                    </p>
                  </div>
                  <Button
                    onClick={() => setEditingId(agent.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Edit<span className="sr-only"> mail for {agent.displayName}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {editing === null ? null : (
          <AgentMailForm
            key={editing.id}
            agent={editing}
            domains={mailQuery.data?.domains ?? []}
            onDone={() => {
              setEditingId(null);
              reload();
            }}
            onCancel={() => setEditingId(null)}
          />
        )}
      </div>
    </>
  );
}

function AgentMailForm({
  agent,
  domains,
  onDone,
  onCancel,
}: {
  readonly agent: AgentMailbox;
  readonly domains: readonly string[];
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [current, currentDomain] = agent.address?.split("@") ?? ["", undefined];
  const [name, setName] = useState(current ?? "");
  const [domain, setDomain] = useState(currentDomain ?? domains[0] ?? "");
  const [mode, setMode] = useState(agent.receiveMode);
  const [senders, setSenders] = useState(agent.allowedSenders.join("\n"));
  const save = useMutation({
    mutationFn: () =>
      saveAgentMail(agent.id, {
        address: name.trim() === "" ? null : `${name.trim()}@${domain}`,
        receiveMode: mode,
        allowedSenders: parseSenders(senders),
      }),
    // The failure is shown in the form; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: onDone,
  });
  // A domain the agent already uses stays selectable even if mail was since turned off for it.
  const choices = [
    ...new Set([...(currentDomain === undefined ? [] : [currentDomain]), ...domains]),
  ];

  return (
    <section className="admin-card" aria-labelledby="agent-mail-form-heading">
      <PanelHeading
        id="agent-mail-form-heading"
        title={`Mail for ${agent.displayName}`}
        subtitle="Leave the address blank for an agent that should not have mail."
      />
      {choices.length === 0 ? (
        <Notice>
          An address needs a verified domain with mail turned on. Add one under{" "}
          <Link to="/admin/$section" params={{ section: "domains" }}>
            Domains
          </Link>
          .
        </Notice>
      ) : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label="Address">
            <AdminInput
              autoComplete="off"
              disabled={choices.length === 0}
              onChange={(event) => setName(event.target.value)}
              placeholder="billing-bot"
              value={name}
            />
          </AdminField>
          <AdminField label="Domain">
            <AdminSelect
              disabled={choices.length === 0}
              onChange={(event) => setDomain(event.target.value)}
              value={domain}
            >
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  @{choice}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
        </div>

        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="admin-field-label p-0">Who may write to it from outside</legend>
          {MODES.map((option) => (
            <label key={option.mode} className="flex items-start gap-2 type-meta">
              <input
                checked={mode === option.mode}
                className="mt-1"
                name="agent-mail-mode"
                onChange={() => setMode(option.mode)}
                type="radio"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="admin-muted block type-caption">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === "allowed_senders" ? (
          <div className="grid gap-1">
            <AdminField label="Allowed senders, one per line">
              <textarea
                aria-describedby="agent-mail-senders-hint"
                className="admin-control min-h-24 font-mono"
                onChange={(event) => setSenders(event.target.value)}
                placeholder={"ana@partner.example\n@supplier.example"}
                spellCheck={false}
                value={senders}
              />
            </AdminField>
            <p className="admin-muted m-0 type-caption" id="agent-mail-senders-hint">
              An address, or @domain for everyone at a domain. With none listed, all mail from
              outside is held.
            </p>
          </div>
        ) : null}

        <MutationError error={save.error} />
        <div className="flex gap-2">
          <Button disabled={save.isPending} type="submit">
            {save.isPending ? "Saving" : "Save"}
          </Button>
          <Button disabled={save.isPending} onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Mail an agent's policy kept out, waiting for an administrator. */
function HeldMail({ agents }: { readonly agents: readonly AgentMailbox[] }) {
  const queryClient = useQueryClient();
  const heldQuery = useQuery(heldAgentMailQueryOptions());
  const [toDecide, setToDecide] = useState<{
    readonly held: HeldAgentMail;
    readonly action: "deliver" | "delete";
  } | null>(null);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: heldAgentMailQueryKey });
  };
  const failure = useQueryFailure(heldQuery, reload);
  const decide = useMutation({
    mutationFn: (decision: NonNullable<typeof toDecide>) =>
      decision.action === "deliver"
        ? deliverHeldMail(decision.held.id)
        : deleteHeldMail(decision.held.id),
    // The failure is shown under the list; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => setToDecide(null),
    onSuccess: () => {
      setToDecide(null);
      reload();
    },
  });
  const held = heldQuery.data ?? [];
  const nameOf = (address: string) =>
    agents.find((agent) => agent.address === address)?.displayName ?? address;
  const recipients = (message: HeldAgentMail) => message.recipientAddresses.map(nameOf).join(", ");
  const sender = (message: HeldAgentMail) =>
    message.fromAddress ?? message.envelopeFrom ?? "an unknown sender";

  return (
    <section className="admin-card" aria-labelledby="agent-mail-held-heading">
      <PanelHeading
        id="agent-mail-held-heading"
        title="Held mail"
        subtitle="Mail from outside that an agent's settings did not let through. The agent has not seen it."
      />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Held mail couldn't be loaded"
          subject="held mail"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : heldQuery.isPending ? (
        <LoadingState label="Loading held mail" count={1} />
      ) : held.length === 0 ? (
        <EmptyRow>Nothing is held.</EmptyRow>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Held mail">
          {held.map((message) => (
            <li
              key={message.id}
              className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="grid min-w-0 gap-1">
                <p className="m-0 type-meta">
                  From <span className="break-all font-medium">{sender(message)}</span> to{" "}
                  <span className="font-medium">{recipients(message)}</span>
                </p>
                <p className="admin-muted m-0 type-caption">
                  {holdReasons(message)
                    .map((reason) => REASONS[reason] ?? reason)
                    .join(" ")}{" "}
                  Received {formatRelativeTime(message.createdAt)}.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setToDecide({ held: message, action: "deliver" })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Deliver<span className="sr-only"> the message from {sender(message)}</span>
                </Button>
                <Button
                  onClick={() => setToDecide({ held: message, action: "delete" })}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Delete<span className="sr-only"> the message from {sender(message)}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <MutationError error={decide.error} />

      {toDecide === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) setToDecide(null);
          }}
          title={
            toDecide.action === "deliver"
              ? `Deliver to ${recipients(toDecide.held)}`
              : "Delete held message"
          }
          confirmLabel={toDecide.action === "deliver" ? "Deliver" : "Delete"}
          isPending={decide.isPending}
          onConfirm={() => {
            decide.mutate(toDecide);
          }}
        >
          {toDecide.action === "deliver"
            ? `The message from ${sender(toDecide.held)} goes into the agent's mailbox, and the agent may act on what it says. It is checked for malware again first.`
            : `The message from ${sender(toDecide.held)} is erased. The agent never sees it and it cannot be recovered.`}
        </ConfirmDestructive>
      )}
    </section>
  );
}
