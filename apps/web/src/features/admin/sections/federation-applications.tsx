import { pluralize } from "../console/format";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FormPanel } from "@/components/ui/form-panel";
import { AdminTable } from "@/features/admin/console/table";
import { AdminTabs } from "@/features/admin/console/tabs";
import {
  useAdminSectionSearch,
  resolveClosedSearchParam,
} from "@/features/admin/admin-section-search";
import { randomId } from "@/lib/random-id";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import {
  PageHeading,
  PanelHeading,
  LoadingState,
  ErrorNotice,
  EmptyRow,
} from "@/features/admin/console/primitives";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { adminUsersQueryOptions } from "@/features/admin/admin-users";
import {
  ApplicationSynchronization,
  FederationApplicationDetails,
} from "./federation-application-details";
import {
  federationApplicationsQueryOptions,
  federationAssignmentsQueryOptions,
  registerFederationApplication,
  setFederationAssignments,
  revokeFederationApplication,
  rotateFederationCredential,
  type FederationApplication,
  type FederationRole,
} from "@/features/admin/federation-applications-api";

export function FederationApplications() {
  const apps = useQuery(federationApplicationsQueryOptions());
  const queryClient = useQueryClient();
  const { search, patchSearch } = useAdminSectionSearch("federation-applications");
  const [adding, setAdding] = useState(false),
    [prepared, setPrepared] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const applications = apps.data?.applications ?? [];
  const selected = applications.find((app) => app.id === search.application);
  const tab = resolveClosedSearchParam(
    search.tab,
    ["overview", "people", "operations"] as const,
    "overview",
  );
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: ["admin", "federation-applications"],
      exact: true,
    });
  return (
    <>
      <div hidden={Boolean(selected)}>
        {!selected ? (
          <PageHeading
            title="Federated apps"
            subtitle="Manage connected applications and who can use them."
            meta={
              apps.data ? (
                <span className="admin-muted">{pluralize(applications.length, "application")}</span>
              ) : undefined
            }
            actions={
              <>
                <Button variant="ghost" disabled={apps.isFetching} onClick={refresh}>
                  Refresh connections
                </Button>
                <Button disabled={apps.data?.enabled !== true} onClick={() => setAdding(true)}>
                  + Add application
                </Button>
              </>
            }
          />
        ) : null}
        {apps.isPending ? <LoadingState label="Loading application connections" /> : null}
        {apps.error ? (
          <ErrorNotice>Connection status unavailable. {apps.error.message}</ErrorNotice>
        ) : null}
        {search.application && !selected && apps.isSuccess ? (
          <ErrorNotice>The application is no longer available.</ErrorNotice>
        ) : null}
        {apps.data?.enabled === false ? (
          <p>Application connections are not enabled. Ask your operator to enable them.</p>
        ) : null}
        {apps.data ? (
          <AdminTable
            label="Federated applications"
            rows={applications}
            rowKey={(app) => app.id}
            searchText={(app) => `Helix Bot ${app.origin} ${app.status}`}
            empty={
              <EmptyRow>
                No federated apps are connected. Add an application to get started.
              </EmptyRow>
            }
            columns={[
              {
                id: "application",
                header: "Application",
                sortValue: (app) => app.origin,
                cell: (app) => (
                  <>
                    <Link
                      className="admin-record-link"
                      to="/admin/$section"
                      params={{ section: "federation-applications" }}
                      search={{ application: app.id }}
                    >
                      Helix Bot
                    </Link>
                    <div className="admin-muted">{app.origin}</div>
                  </>
                ),
              },
              {
                id: "connection",
                header: "Connection and directory",
                cell: (app) => (
                  <>
                    <ApplicationSynchronization application={app} compact />
                    {app.error ? <p role="alert">{app.error}</p> : null}
                  </>
                ),
              },
              {
                id: "actions",
                header: "Actions",
                headerHidden: true,
                cell: (app) => (
                  <Button
                    variant="ghost"
                    onClick={() => patchSearch({ application: app.id, tab: undefined })}
                  >
                    View app details
                  </Button>
                ),
              },
            ]}
          />
        ) : null}
        <p className="admin-muted">
          Workspace governs sign-in and assigned access. Each application manages its own tools and
          resources.
        </p>
      </div>
      {applications.map((app) => (
        <div key={app.id} hidden={selected?.id !== app.id}>
          <Application
            application={app}
            active={selected?.id === app.id}
            tab={tab}
            onTab={(next) => patchSearch({ tab: next === "overview" ? undefined : next })}
            onBack={() => patchSearch({ application: undefined, tab: undefined })}
          />
        </div>
      ))}
      {adding ? (
        <FormPanel title="Connect Helix Bot" onClose={() => setAdding(false)}>
          <Registration
            onPrepared={async (result) => {
              setPrepared(result);
              setAdding(false);
              await queryClient.invalidateQueries({
                queryKey: ["admin", "federation-applications"],
              });
            }}
          />
        </FormPanel>
      ) : null}
      {prepared ? (
        <FormPanel title="Complete application pairing" onClose={() => setPrepared(null)}>
          <p>
            Paste this code into Bot's reviewed Workspace connection before{" "}
            {new Date(prepared.expiresAt).toLocaleTimeString()}. It completes only the installation
            shown in the registration.
          </p>
          <AdminField label="Pairing code">
            <textarea className="admin-control" readOnly rows={4} value={prepared.pairingCode} />
          </AdminField>
          <Button variant="secondary" onClick={() => setPrepared(null)}>
            Dismiss code
          </Button>
        </FormPanel>
      ) : null}
    </>
  );
}
function Registration({
  onPrepared,
}: {
  readonly onPrepared: (result: { pairingCode: string; expiresAt: string }) => Promise<void>;
}) {
  const [id] = useState(() => randomId()),
    [origin, setOrigin] = useState(""),
    [connectionId, setConnectionId] = useState(""),
    [proof, setProof] = useState(""),
    [validation, setValidation] = useState<string | null>(null);
  const errorId = useId(),
    errorRef = useRef<HTMLParagraphElement>(null);
  const mutation = useMutation({
    mutationFn: registerFederationApplication,
    onMutate: () => setValidation(null),
    onError: () => errorRef.current?.focus(),
    onSuccess: async (result) => {
      setProof("");
      await onPrepared(result);
    },
  });
  useEffect(() => {
    if (mutation.error || validation) errorRef.current?.focus();
  }, [mutation.error, validation]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let address: URL;
    try {
      address = new URL(origin.trim());
    } catch {
      setValidation("Enter Bot's full address.");
      return;
    }
    if (
      address.origin !== origin.trim() ||
      !(
        address.protocol === "https:" ||
        (address.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname))
      )
    ) {
      setValidation("Enter Bot's HTTPS origin, without a path.");
      return;
    }
    if (
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(connectionId.trim()) ||
      !/^[a-f0-9]{64}$/u.test(proof.trim())
    ) {
      setValidation("Copy the complete connection ID and installation proof from Bot.");
      return;
    }
    setValidation(null);
    mutation.mutate({
      id,
      origin: origin.trim(),
      connectionId: connectionId.trim(),
      proof: proof.trim(),
    });
  };
  return (
    <section className="grid gap-3" aria-label="Application registration">
      <p>
        First prepare the connection while signed in to Bot as its local recovery owner. Copy the
        address, connection ID and installation proof here. Workspace will manage assigned people;
        each bot still requires a separately approved account and resource grants.
      </p>
      <form
        className="grid gap-3"
        noValidate
        onSubmit={submit}
        aria-describedby={mutation.error || validation ? errorId : undefined}
      >
        <AdminField label="Bot address">
          <AdminInput
            required
            type="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            autoComplete="off"
            placeholder="https://bot.example.com"
          />
        </AdminField>
        <AdminField label="Connection ID">
          <AdminInput
            required
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            autoComplete="off"
          />
        </AdminField>
        <AdminField label="Installation proof">
          <AdminInput
            required
            type="password"
            value={proof}
            onChange={(event) => setProof(event.target.value)}
            autoComplete="off"
          />
        </AdminField>
        {mutation.error || validation ? (
          <p id={errorId} ref={errorRef} tabIndex={-1} role="alert">
            {validation ?? mutation.error?.message}
          </p>
        ) : null}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Preparing…" : "Review and prepare connection"}
        </Button>
      </form>
    </section>
  );
}
function Application({
  application,
  active,
  tab,
  onTab,
  onBack,
}: {
  readonly application: FederationApplication;
  readonly active: boolean;
  readonly tab: "overview" | "people" | "operations";
  readonly onTab: (tab: "overview" | "people" | "operations") => void;
  readonly onBack: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeFederationApplication(application.id),
    onMutate: () => queryClient.cancelQueries({ queryKey: ["admin", "federation-applications"] }),
    onError: () => setConfirming(false),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ["admin", "federation-applications"] });
    },
  });
  return (
    <section>
      <Button variant="ghost" onClick={onBack}>
        ← Federated apps
      </Button>
      {active ? (
        <PageHeading
          title="Helix Bot"
          subtitle={application.origin}
          actions={
            <a href={application.origin} target="_blank" rel="noopener noreferrer">
              Open application ↗
            </a>
          }
        />
      ) : null}
      <ApplicationSynchronization application={application} />
      {application.error ? <ErrorNotice>{application.error}</ErrorNotice> : null}
      <AdminTabs
        label="Application sections"
        idPrefix={`app-${application.id}`}
        selected={tab}
        onSelect={onTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "people", label: "People" },
          { id: "operations", label: "Operations" },
        ]}
      >
        <div hidden={tab !== "overview"}>
          <section className="admin-section">
            <PanelHeading title="Setting ownership" />
            <dl className="admin-facts">
              <div>
                <dt>Managed by Workspace</dt>
                <dd>
                  Assigned people, Bot roles, profile names and email addresses, groups and the
                  sign-in connection.
                </dd>
              </div>
              <div>
                <dt>Managed in Helix Bot</dt>
                <dd>
                  Local accounts, recovery ownership, password-account MFA, models, bots,
                  conversations, Work and resource grants.
                </dd>
              </div>
            </dl>
            <p className="admin-muted">
              Workspace sign-in policies apply through Workspace. Assigning a person does not grant
              bots access to Mail, Chat or Drive.
            </p>
          </section>
        </div>
        <div hidden={tab !== "people"}>
          <Assignments
            appId={application.id}
            expanded={active && tab === "people"}
            disabled={["revoked", "expired", "failed"].includes(application.status)}
          />
        </div>
        <div hidden={tab !== "operations"}>
          {active && tab === "operations" ? (
            <FederationApplicationDetails application={application} />
          ) : null}
          <section className="admin-section">
            <PanelHeading title="Connection credentials" />
            {application.status === "active" ? (
              <CredentialRotation application={application} />
            ) : (
              <p>Credentials can be rotated for active connections.</p>
            )}
          </section>
          <section className="admin-section">
            <PanelHeading
              title="Disconnect application"
              subtitle="Managed sign-ins and delegated work will stop. The local recovery owner remains available."
            />
            <div className="admin-section-actions">
              <Button
                variant="outline"
                disabled={application.status === "revoked"}
                onClick={() => setConfirming(true)}
              >
                Disconnect application
              </Button>
            </div>
            {revoke.error ? <ErrorNotice>{revoke.error.message}</ErrorNotice> : null}
          </section>
        </div>
      </AdminTabs>
      <ConfirmDestructive
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect application"
        confirmLabel="Disconnect"
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        blastRadius="Managed Bot sign-ins and work delegated by those people will stop. Bot's separate local recovery owner remains available."
      >
        {application.origin}
      </ConfirmDestructive>
    </section>
  );
}
function Assignments({
  appId,
  expanded,
  disabled,
}: {
  readonly appId: string;
  readonly expanded: boolean;
  readonly disabled: boolean;
}) {
  const assignmentKey = federationAssignmentsQueryOptions(appId, expanded).queryKey;
  const assignments = useQuery(federationAssignmentsQueryOptions(appId, expanded)),
    users = useQuery({
      ...adminUsersQueryOptions({ type: "user", includeDisabled: false, limit: 50 }),
      enabled: expanded,
    });
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [draft, setDraft] = useState<Record<string, FederationRole>>({}),
    [revision, setRevision] = useState<string | null>(null),
    [dirty, setDirty] = useState(false);
  const initialized = useRef(false);
  const [addingPeople, setAddingPeople] = useState(false);
  const matching = useQuery({
    ...adminUsersQueryOptions({ type: "user", includeDisabled: false, limit: 50, query: search }),
    enabled: expanded && search.length > 0,
  });
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      if (revision === null) throw new Error("Load assignments before saving.");
      return setFederationAssignments(
        appId,
        Object.entries(draft).map(([actorId, role]) => ({ actorId, role })),
        revision,
      );
    },
    onMutate: () => setDirty(true),
    onError: async () => {
      setDirty(true);
      await queries.invalidateQueries({ queryKey: assignmentKey, exact: true });
    },
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: assignmentKey, exact: true });
      await queries.invalidateQueries({
        queryKey: ["admin", "federation-applications"],
        exact: true,
      });
      if (queries.getQueryState(assignmentKey)?.status === "success") setDirty(false);
    },
  });
  useEffect(() => {
    if (!dirty && assignments.data) {
      setDraft(
        Object.fromEntries(
          assignments.data.assignments.map((entry) => [entry.actorId, entry.role]),
        ),
      );
      setRevision(assignments.data.revision);
      initialized.current = true;
    }
  }, [assignments.data, dirty]);
  if (!expanded) return null;
  const changed = revision !== null && assignments.data?.revision !== revision;
  const people = search.length > 0 ? matching.data?.users : users.data?.users;
  const candidates = new Map((people ?? []).map((person) => [person.id, person]));
  const assigned = new Map(
    (assignments.data?.assignments ?? []).map((person) => [person.actorId, person]),
  );
  const ids = new Set([
    ...Object.keys(draft),
    ...assigned.keys(),
    ...(addingPeople ? candidates.keys() : []),
  ]);
  return (
    <div className="grid gap-3">
      <PanelHeading
        title="Assigned people"
        subtitle="Bot ownership remains with its local recovery account."
        actions={
          <div className="admin-section-actions">
            <Button
              variant="ghost"
              disabled={assignments.isFetching || save.isPending}
              onClick={() =>
                void queries.invalidateQueries({ queryKey: assignmentKey, exact: true })
              }
            >
              Refresh assigned people
            </Button>
            <Button onClick={() => setAddingPeople((value) => !value)}>
              {addingPeople ? "Done adding people" : "+ Add people"}
            </Button>
          </div>
        }
      />
      <form
        hidden={!addingPeople}
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim() === search)
            void queries.invalidateQueries({
              queryKey: adminUsersQueryOptions({
                type: "user",
                includeDisabled: false,
                limit: 50,
                query: search,
              }).queryKey,
              exact: true,
            });
          setSearch(query.trim());
        }}
      >
        <AdminField label="Find people">
          <AdminInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </AdminField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {assignments.error ? <p role="alert">{assignments.error.message}</p> : null}
      {assignments.isPending ? <LoadingState label="Loading assigned people" /> : null}
      {(users.error ?? matching.error) ? (
        <p role="alert">People could not be loaded. Try again.</p>
      ) : null}
      <AdminTable
        label="Application assignments"
        rows={[...ids].map((id) => ({ id, person: assigned.get(id) ?? candidates.get(id) }))}
        rowKey={(row) => row.id}
        empty={<EmptyRow>No people assigned. Use + Add people to grant access.</EmptyRow>}
        columns={[
          {
            id: "person",
            header: "Person",
            sortValue: (row) => row.person?.displayName ?? row.person?.email ?? row.id,
            cell: ({ id, person }) => (
              <>
                <span className="admin-record-link">
                  {person?.displayName ?? person?.email ?? id}
                </span>
                <div className="admin-muted">{person?.email}</div>
              </>
            ),
          },
          {
            id: "role",
            header: "Bot role",
            cell: ({ id, person }) => (
              <AdminSelect
                aria-label={person?.email ?? person?.displayName ?? id}
                disabled={
                  disabled ||
                  !initialized.current ||
                  save.isPending ||
                  (candidates.get(id)?.status !== undefined &&
                    candidates.get(id)?.status !== "active")
                }
                value={draft[id] ?? "unassigned"}
                onChange={(event) => {
                  const role = event.target.value as FederationRole | "unassigned";
                  setDirty(true);
                  setDraft((previous) => {
                    const next = { ...previous };
                    if (role === "unassigned") delete next[id];
                    else next[id] = role;
                    return next;
                  });
                }}
              >
                <option value="unassigned">Not assigned</option>
                <option value="viewer">Viewer</option>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </AdminSelect>
            ),
          },
        ]}
      />
      <p className="admin-muted">
        {Object.keys(draft).length} {Object.keys(draft).length === 1 ? "person" : "people"}{" "}
        assigned.
        {dirty ? " Unsaved changes are retained when you search or refresh." : ""}
      </p>
      {save.error ? <p role="alert">{save.error.message}</p> : null}
      {dirty && changed ? (
        <p role="status">
          The directory or assignments changed. Your draft is retained.{" "}
          <Button
            variant="secondary"
            disabled={save.isPending || assignments.isFetching || assignments.isError}
            onClick={() => {
              save.reset();
              setDirty(false);
            }}
          >
            Use current assignments
          </Button>
        </p>
      ) : null}
      {save.isSuccess && !dirty ? (
        <p role="status">Assignments saved. Directory synchronization is pending.</p>
      ) : null}
      <div className="admin-section-actions">
        <Button
          variant="secondary"
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.reset();
            setDirty(false);
          }}
        >
          Cancel changes
        </Button>
        <Button
          disabled={disabled || !dirty || changed || save.isPending || assignments.isError}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save assignments"}
        </Button>
      </div>
    </div>
  );
}

function CredentialRotation({ application }: { readonly application: FederationApplication }) {
  const [kind, setKind] = useState<"oidc" | "scim" | "enrollment">("oidc");
  const operation = useRef<string | null>(null);
  const queries = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => {
      operation.current ??= randomId();
      return rotateFederationCredential(application.id, { id: operation.current, kind });
    },
    onMutate: () => queries.cancelQueries({ queryKey: ["admin", "federation-applications"] }),
    onError: () => queries.invalidateQueries({ queryKey: ["admin", "federation-applications"] }),
    onSuccess: async () => {
      operation.current = null;
      await queries.invalidateQueries({ queryKey: ["admin", "federation-applications"] });
    },
  });
  return (
    <div className="grid gap-3">
      <AdminField label="Connection credential">
        <AdminSelect
          value={kind}
          disabled={rotate.isPending || application.rotationPending}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            operation.current = null;
            rotate.reset();
          }}
        >
          <option value="oidc">Human sign-in</option>
          <option value="scim">Directory provisioning</option>
          <option value="enrollment">Bot account enrollment</option>
        </AdminSelect>
      </AdminField>
      <p>
        Rotating replaces this credential. Existing bots keep their separate approvals and resource
        grants.
      </p>
      <Button
        variant="secondary"
        disabled={rotate.isPending || application.rotationPending}
        onClick={() => rotate.mutate()}
      >
        {application.rotationPending
          ? "Credential delivery pending"
          : rotate.isPending
            ? "Rotating…"
            : "Rotate credential"}
      </Button>
      {rotate.error ? <p role="alert">{rotate.error.message}</p> : null}
      {rotate.isSuccess ? <p role="status">Credential rotated.</p> : null}
    </div>
  );
}
