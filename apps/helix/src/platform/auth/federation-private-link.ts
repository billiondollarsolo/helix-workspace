/* Private links to federated apps.
 *
 * Workspace's own calls to a federated app (directory sync, credentials, backups)
 * should stay on a private network instead of crossing a public proxy. The app
 * advertises the private addresses it can be reached at; Workspace uses one only
 * after verifying it presents a valid TLS certificate for the app's public
 * hostname and answers as the same installation. An admin can also set the
 * address by hand. HELIX_FEDERATION_ROUTES (operator config) overrides both.
 */

import type { Actor } from "@helix/sdk-types";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../../api/api-error.js";
import {
  createOutboundHttpClient,
  OutboundHttpError,
  type OutboundRoute,
} from "../outbound-http.js";
import {
  withTenantIoSagaPostgresContext,
  withTenantPostgresContext,
} from "../tenancy/postgres-roles.js";
import type { FederationApplicationRow, FederationPairing } from "./federation-pairing.js";

/**
 * Calls through `routed`; when a learned private route can't connect, forgets it
 * (via `onFailure`) and retries once over the public origin with `direct`.
 */
export function withPrivateFallback(
  routed: typeof fetch,
  direct: typeof fetch,
  learned: (hostname: string) => boolean,
  onFailure: (hostname: string) => void,
): typeof fetch {
  return async (input, init) => {
    const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
    const usesLearnedRoute = learned(host);
    try {
      return await routed(input, init);
    } catch (error) {
      if (
        !usesLearnedRoute ||
        init?.signal?.aborted === true ||
        !(error instanceof OutboundHttpError) ||
        !["dns_failed", "transport_failed", "aborted"].includes(error.code)
      )
        throw error;
      onFailure(host);
      return direct(input, init);
    }
  };
}

/** How long a verified link is trusted before it is checked again. */
export const PRIVATE_LINK_RECHECK_MS = 10 * 60_000;

const target = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/u, "Use host:port, for example helix-agentspace:3000.")
  .refine((value) => {
    const port = Number(value.slice(value.lastIndexOf(":") + 1));
    return port >= 1 && port <= 65535;
  }, "The port must be between 1 and 65535.");
export const privateLinkInput = z.object({ target }).strict();

const addresses = z.object({
  installationId: z.string(),
  urls: z.array(z.string()).max(8),
});

export function parseTarget(value: string): OutboundRoute {
  const separator = value.lastIndexOf(":");
  return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) };
}

/** "https://host[:port]" → "host:port" (443 when absent); null when not a usable https origin. */
export function targetFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.hostname}:${url.port || "443"}`;
  } catch {
    return null;
  }
}

export function privateLinkView(
  staticRoutes: ReadonlyMap<string, OutboundRoute>,
  row: FederationApplicationRow,
) {
  const configured = staticRoutes.get(new URL(row.public_origin).hostname);
  if (configured)
    return {
      path: "private" as const,
      target: `${configured.host}:${String(configured.port)}`,
      source: "configured" as const,
      checkedAt: null,
      error: null,
    };
  return {
    path:
      row.private_target !== null && row.private_target_error === null
        ? ("private" as const)
        : ("public" as const),
    target: row.private_target,
    source: row.private_target_source,
    checkedAt: row.private_target_checked_at?.toISOString() ?? null,
    error: row.private_target_error,
  };
}

/**
 * Asks the app at `candidate` (over TLS for its public hostname) which installation
 * it is. Returns null when it is this app, else a short reason.
 */
export async function verifyPrivateTarget(
  federation: FederationPairing,
  row: FederationApplicationRow,
  candidate: string,
): Promise<string | null> {
  const host = new URL(row.public_origin).hostname;
  const client = createOutboundHttpClient({
    routes: new Map([[host, parseTarget(candidate)]]),
    maxRedirects: 0,
    maxRequestBytes: 4_096,
    maxResponseBytes: 64_000,
    timeoutMs: 5_000,
  });
  try {
    const response = await client(
      new URL(`/v1/federation/${row.connection_id}/addresses`, row.public_origin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${federation.material(row).scimToken}`,
          "content-type": "application/json",
          "user-agent": "HelixWorkspace/1.0",
        },
        body: "{}",
      },
    );
    if (!response.ok) return `It answered with HTTP ${String(response.status)}.`;
    const body = addresses.parse(await response.json());
    return body.installationId === row.installation_id
      ? null
      : "It answered as a different installation.";
  } catch {
    return `It isn’t reachable at ${candidate} with a valid certificate for ${host}.`;
  }
}

async function save(
  federation: FederationPairing,
  row: FederationApplicationRow,
  value: {
    target: string | null;
    source: "discovered" | "manual" | null;
    error: string | null;
  },
) {
  await withTenantIoSagaPostgresContext(
    federation.sql,
    { orgId: row.org_id, serviceContext: true },
    async (tx) =>
      tx`update federation_applications set private_target=${value.target},
        private_target_source=${value.source}, private_target_checked_at=now(),
        private_target_error=${value.error}
        where org_id=${row.org_id} and id=${row.id}`,
  );
  const host = new URL(row.public_origin).hostname;
  if (value.target !== null && value.error === null)
    federation.privateRoutes.set(host, parseTarget(value.target));
  else federation.privateRoutes.delete(host);
}

/**
 * Finds and verifies a private link for one app. Manual links are re-verified;
 * otherwise the app's advertised addresses are tried in order.
 */
export async function refreshPrivateLink(
  federation: FederationPairing,
  row: FederationApplicationRow,
): Promise<void> {
  if (row.status !== "active" || row.receipt_envelope === null) return;
  if (federation.staticRoutes.has(new URL(row.public_origin).hostname)) return;
  if (row.private_target_source === "manual" && row.private_target !== null) {
    const error = await verifyPrivateTarget(federation, row, row.private_target);
    await save(federation, row, { target: row.private_target, source: "manual", error });
    return;
  }
  let advertised: string[] = [];
  try {
    advertised = addresses.parse(
      await federation.request(
        row.public_origin,
        `/v1/federation/${row.connection_id}/addresses`,
        federation.material(row).scimToken,
        {},
      ),
    ).urls;
  } catch {
    // An app without the endpoint simply stays on its public address.
  }
  const candidates = advertised.flatMap((url) => targetFromUrl(url) ?? []);
  for (const candidate of candidates) {
    if ((await verifyPrivateTarget(federation, row, candidate)) === null) {
      await save(federation, row, { target: candidate, source: "discovered", error: null });
      return;
    }
  }
  await save(federation, row, {
    target: null,
    source: null,
    error: candidates.length > 0 ? "None of the app’s private addresses could be verified." : null,
  });
}

/** True when the link is due for discovery or re-verification. */
export function privateLinkDue(row: FederationApplicationRow, now = Date.now()): boolean {
  return (
    row.private_target_checked_at === null ||
    now - row.private_target_checked_at.getTime() >= PRIVATE_LINK_RECHECK_MS
  );
}

/** Loads verified links into the route cache at startup. */
export async function loadPrivateLinks(federation: FederationPairing, orgId: string) {
  const rows = await withTenantIoSagaPostgresContext(
    federation.sql,
    { orgId, serviceContext: true },
    async (tx) =>
      tx<
        Pick<FederationApplicationRow, "public_origin" | "private_target">[]
      >`select public_origin, private_target from federation_applications
        where org_id=${orgId} and status='active' and private_target is not null
        and private_target_error is null`,
  );
  for (const row of rows)
    if (row.private_target)
      federation.privateRoutes.set(
        new URL(row.public_origin).hostname,
        parseTarget(row.private_target),
      );
}

async function adminRow(federation: FederationPairing, actor: Actor, appId: string) {
  federation.admin(actor);
  const [row] = await withTenantPostgresContext(
    federation.sql,
    { orgId: actor.orgId, actorId: actor.id },
    async (tx) =>
      tx<
        FederationApplicationRow[]
      >`select * from federation_applications where org_id=${actor.orgId} and id=${appId}`,
  );
  if (!row || row.status !== "active") throw new NotFoundError("Application is unavailable.");
  return row;
}

async function adminView(federation: FederationPairing, actor: Actor, appId: string) {
  return federation.view(await adminRow(federation, actor, appId));
}

/** Admin: verify and save a private address typed by hand. */
export async function setPrivateLink(
  federation: FederationPairing,
  actor: Actor,
  appId: string,
  input: z.infer<typeof privateLinkInput>,
) {
  const row = await adminRow(federation, actor, appId);
  const error = await verifyPrivateTarget(federation, row, input.target);
  if (error !== null) throw new BadRequestError(`That private address didn’t work. ${error}`);
  await save(federation, row, { target: input.target, source: "manual", error: null });
  await federation.recordForApp(actor, appId, "federation.application.private_link.set");
  return adminView(federation, actor, appId);
}

/** Admin: forget the hand-set address and detect one automatically again. */
export async function resetPrivateLink(federation: FederationPairing, actor: Actor, appId: string) {
  const row = await adminRow(federation, actor, appId);
  await save(federation, row, { target: null, source: null, error: null });
  await refreshPrivateLink(federation, await adminRow(federation, actor, appId));
  await federation.recordForApp(actor, appId, "federation.application.private_link.reset");
  return adminView(federation, actor, appId);
}

/** Admin: check the link now. */
export async function checkPrivateLink(federation: FederationPairing, actor: Actor, appId: string) {
  await refreshPrivateLink(federation, await adminRow(federation, actor, appId));
  return adminView(federation, actor, appId);
}

/** A learned link stopped answering: show it and re-check on the next directory pass. */
export async function markPrivateLinkFailed(
  federation: FederationPairing,
  orgId: string,
  hostname: string,
) {
  await withTenantIoSagaPostgresContext(
    federation.sql,
    { orgId, serviceContext: true },
    async (tx) =>
      tx`update federation_applications set private_target_checked_at=null,
      private_target_error='The private address stopped answering; using the public address.'
      where org_id=${orgId} and status='active' and private_target is not null
      and split_part(split_part(public_origin, '://', 2), ':', 1)=${hostname}`,
  );
}
