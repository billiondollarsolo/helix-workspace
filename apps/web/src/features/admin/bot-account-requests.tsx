import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotAccountRequest } from "@helix/contracts";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { FormPanel } from "@/components/ui/form-panel";
import { SettingsField } from "@/components/shell/settings-controls";
import { callTool } from "@/lib/tool-call";
import { AdminTable } from "./console/table";
import { SettingToggle } from "./console/widgets";
import { useActorPicker, ActorSearchField } from "./credentials-form-fields";
import { botRequestsQueryOptions } from "@/features/bots/api";

export function BotAccountRequests() {
  const requests = useQuery(botRequestsQueryOptions());
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("botRequest"),
  );
  const selected = requests.data?.requests.find((request) => request.id === selectedId);
  return (
    <section className="admin-stack">
      <h2>Bot account requests</h2>
      <p className="type-body-sm text-muted-foreground">
        Review the identity, human owner and exact permissions before activating an external bot.
      </p>
      {requests.error ? (
        <p role="alert" className="text-destructive">
          {requests.error.message}
        </p>
      ) : null}
      <AdminTable
        label="Bot account requests"
        rows={requests.data?.requests ?? []}
        rowKey={(row) => row.id}
        searchText={(row) => `${row.displayName} ${row.purpose} ${row.status}`}
        empty={<p>No bot account requests.</p>}
        columns={[
          {
            id: "name",
            header: "Bot",
            cell: (row) => row.displayName,
            sortValue: (row) => row.displayName,
          },
          { id: "purpose", header: "Purpose", cell: (row) => row.purpose },
          {
            id: "status",
            header: "Status",
            cell: (row) => row.status,
            sortValue: (row) => row.status,
          },
          {
            id: "review",
            header: "Review",
            cell: (row) => (
              <Button size="sm" variant="outline" onClick={() => setSelectedId(row.id)}>
                Review
              </Button>
            ),
          },
        ]}
      />
      {selected ? (
        <ReviewBotRequest
          key={selected.id}
          request={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  );
}
function ReviewBotRequest({
  request,
  onClose,
}: {
  readonly request: BotAccountRequest;
  readonly onClose: () => void;
}) {
  const [owner, setOwner] = useState("");
  const [email, setEmail] = useState(request.requestedEmail ?? "");
  const [scopes, setScopes] = useState([...request.requestedScopes]);
  const [expires, setExpires] = useState(
    new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState("");
  const [observer, setObserver] = useState("");
  const picker = useActorPicker();
  const people = picker.actorsQuery.data?.users.filter((user) => user.type === "user") ?? [];
  const client = useQueryClient();
  const decide = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (approve: boolean) =>
      approve
        ? callTool("agent.account.approve", {
            requestId: request.id,
            ownerActorId: owner,
            scopes,
            email: email.trim() || null,
            expiresAt: new Date(`${expires}T23:59:59Z`).toISOString(),
          })
        : callTool("agent.account.reject", { requestId: request.id, reason }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["bots"] });
      await client.invalidateQueries({ queryKey: ["admin"] });
      onClose();
    },
  });
  const grant = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (enabled: boolean) =>
      callTool("agent.workspace.access.set", {
        botActorId: request.actorId,
        observerActorId: observer,
        enabled,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["bots"] }),
  });
  return (
    <FormPanel title={`Review ${request.displayName}`} onClose={onClose}>
      <div className="admin-stack">
        <p>{request.purpose}</p>
        <p>Status: {request.status}</p>
        <p className="type-caption">
          External identity: {request.externalBotId}. Account requests expire after seven days. Full
          app access does not grant access to existing users' resources.
        </p>
        <ActorSearchField
          id="bot-owner-search"
          value={picker.searchDraft}
          onChange={picker.onSearchChange}
        />
        {picker.actorsQuery.error ? <p role="alert">The people directory could not load.</p> : null}
        {request.status === "pending" ? (
          <>
            <SettingsField label="Human owner and approver" controlId="bot-account-owner">
              <select
                id="bot-account-owner"
                className="input"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              >
                <option value="">Choose a person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName} ({person.email})
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField
              label="Bot email address"
              controlId="bot-account-email"
              hint="Use a verified mail-enabled domain. External incoming mail still passes authentication and quarantine checks."
            >
              <Input
                id="bot-account-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </SettingsField>
            <SettingsField label="Credential expiry (UTC)" controlId="bot-account-expiry">
              <Input
                id="bot-account-expiry"
                type="date"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </SettingsField>
            <h3>Requested permissions</h3>
            {request.requestedScopes.map((scope) => (
              <SettingToggle
                key={scope}
                label={scope}
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes((current) =>
                    checked ? [...current, scope] : current.filter((item) => item !== scope),
                  )
                }
              />
            ))}
            <p className="type-body-sm">
              Approval activates the bot's locally held key with these permissions. Its human owner
              receives read-only oversight access. Outbound actions still follow Workspace policy.
            </p>
            <Button
              disabled={!owner || !scopes.length || !expires || decide.isPending}
              onClick={() => decide.mutate(true)}
            >
              Approve reviewed account
            </Button>
            <SettingsField label="Rejection reason" controlId="bot-rejection">
              <Textarea
                id="bot-rejection"
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </SettingsField>
            <Button
              variant="outline"
              disabled={!reason.trim() || decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              Reject request
            </Button>
          </>
        ) : null}
        {request.status === "approved" ? (
          <>
            <p>Approved address: {request.approvedEmail ?? "No mailbox"}</p>
            <p>Permissions: {request.approvedScopes.join(", ")}</p>
            <p>
              Credential expires:{" "}
              {request.credentialExpiresAt
                ? new Date(request.credentialExpiresAt).toLocaleString()
                : "Check credential inventory"}
            </p>
            <SettingsField label="Human observer" controlId="bot-observer">
              <select
                id="bot-observer"
                className="input"
                value={observer}
                onChange={(event) => setObserver(event.target.value)}
              >
                <option value="">Choose a person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </SettingsField>
            <p className="type-caption">
              Observers can read this bot's mail, files and joined conversations, including messages
              from other participants. They cannot send as the bot or manage its credentials.
            </p>
            <div className="flex gap-2">
              <Button disabled={!observer || grant.isPending} onClick={() => grant.mutate(true)}>
                Grant reviewed read access
              </Button>
              <Button
                variant="outline"
                disabled={!observer || grant.isPending}
                onClick={() => grant.mutate(false)}
              >
                Revoke read access
              </Button>
            </div>
            {grant.isSuccess ? <p role="status">Observer access updated.</p> : null}
          </>
        ) : null}
        {request.reason ? <p>{request.reason}</p> : null}
        {decide.error || grant.error ? (
          <p role="alert" className="text-destructive">
            {decide.error?.message ?? grant.error?.message}
          </p>
        ) : null}
      </div>
    </FormPanel>
  );
}
