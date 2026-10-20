import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomId } from "@/lib/random-id";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { PageHeading, LoadingState } from "@/features/admin/console/primitives";
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
  const [adding, setAdding] = useState(false),
    [prepared, setPrepared] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  return (
    <>
      <PageHeading
        title="Federated apps"
        subtitle="Connect applications to this Workspace organization and assign the people who may use them."
        actions={
          <Button
            disabled={apps.data?.enabled !== true}
            onClick={() => setAdding((value) => !value)}
          >
            + Add application
          </Button>
        }
      />
      {apps.isPending ? <LoadingState label="Loading application connections" /> : null}
      {apps.error ? <p role="alert">Connection status unavailable. {apps.error.message}</p> : null}
      <Button
        variant="secondary"
        disabled={apps.isFetching}
        onClick={() =>
          void queryClient.invalidateQueries({
            queryKey: ["admin", "federation-applications"],
            exact: true,
          })
        }
      >
        {apps.isFetching ? "Refreshing…" : "Refresh connections"}
      </Button>
      {apps.data?.enabled === false ? (
        <p>Application connections are not enabled. Ask your operator to enable them.</p>
      ) : null}
      {adding ? (
        <Registration
          onPrepared={async (result) => {
            setPrepared(result);
            setAdding(false);
            await queryClient.invalidateQueries({ queryKey: ["admin", "federation-applications"] });
          }}
        />
      ) : null}
      {prepared ? (
        <section className="admin-card grid gap-3" aria-label="Complete application pairing">
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
        </section>
      ) : null}
      {(apps.data?.applications ?? []).map((app) => (
        <Application key={app.id} application={app} />
      ))}
      {apps.data?.enabled && apps.data.applications.length === 0 ? (
        <p>No federated apps are connected.</p>
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
    <section className="admin-card grid gap-3" aria-labelledby="federation-register-title">
      <h2 id="federation-register-title">Connect Helix Bot</h2>
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
function Application({ application }: { readonly application: FederationApplication }) {
  const [expanded, setExpanded] = useState(false),
    [details, setDetails] = useState(false),
    [confirming, setConfirming] = useState(false);
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
    <section className="admin-card grid gap-3" aria-labelledby={`federation-app-${application.id}`}>
      <h2 id={`federation-app-${application.id}`}>Helix Bot · {application.origin}</h2>
      <ApplicationSynchronization application={application} />
      {application.error ? <p role="alert">{application.error}</p> : null}
      <p>
        <strong>Managed by Workspace:</strong> assigned people, their Bot roles (Viewer, Member or
        Admin), managed profile names and email addresses, groups and the application's sign-in
        connection. Workspace sign-in policies apply when people sign in through Workspace.
      </p>
      <p>
        <strong>Managed in Helix Bot:</strong> local accounts, recovery ownership, password-account
        MFA, models, bots, conversations, Work and resource grants. Assigning someone here does not
        grant bots access to Workspace Mail, Chat or Drive.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-expanded={details}
          onClick={() => setDetails((value) => !value)}
        >
          {details ? "Hide app details" : "View app details"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          Manage assigned people
        </Button>
        <Button
          variant="secondary"
          disabled={application.status === "revoked"}
          onClick={() => setConfirming(true)}
        >
          Disconnect application
        </Button>
      </div>
      {details ? <FederationApplicationDetails application={application} /> : null}
      <Assignments
        appId={application.id}
        expanded={expanded}
        disabled={["revoked", "expired", "failed"].includes(application.status)}
      />
      {revoke.error ? <p role="alert">{revoke.error.message}</p> : null}
      {application.status === "active" ? <CredentialRotation application={application} /> : null}
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
  const ids = new Set([...Object.keys(draft), ...assigned.keys(), ...candidates.keys()]);
  return (
    <div className="grid gap-3">
      <p>
        Assign only the people who need Bot. Admin access grants Bot team administration; ownership
        stays with the local recovery account.
      </p>
      <form
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
      <Button
        variant="secondary"
        disabled={assignments.isFetching || save.isPending}
        onClick={() => void queries.invalidateQueries({ queryKey: assignmentKey, exact: true })}
      >
        Refresh assigned people
      </Button>
      {(users.error ?? matching.error) ? (
        <p role="alert">People could not be loaded. Try again.</p>
      ) : null}
      {[...ids].map((id) => {
        const person = assigned.get(id) ?? candidates.get(id);
        return (
          <AdminField key={id} label={person?.email ?? person?.displayName ?? id}>
            <AdminSelect
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
          </AdminField>
        );
      })}
      <p>
        {Object.keys(draft).length} people assigned. Search to find additional people; saving
        retains assignments outside the current search. Refreshing keeps unsaved changes.
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
      <Button
        disabled={disabled || !dirty || changed || save.isPending || assignments.isError}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Saving…" : "Save assignments"}
      </Button>
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
