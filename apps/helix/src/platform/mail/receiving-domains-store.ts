import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ensureAdminDomain } from "../admin/domain-identity.js";
import { normalizeMailDomain, normalizeMailboxAddress } from "./address-normalization.js";

export const MAIL_RECEIVING_DOMAIN_STATUSES = [
  "pending",
  "verified",
  "active",
  "disabled",
] as const;
export type MailReceivingDomainStatus = (typeof MAIL_RECEIVING_DOMAIN_STATUSES)[number];

export interface MailReceivingDomainRecord {
  readonly id: string;
  readonly orgId: string;
  /** The `admin_domains` identity this capability hangs off (migration 0086). */
  readonly adminDomainId: string;
  readonly domain: string;
  readonly status: MailReceivingDomainStatus;
  readonly verifiedAt: string | null;
  readonly catchAllActorId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReceivingMailboxResolution {
  readonly orgId: string;
  readonly receivingDomainId: string;
  readonly domain: string;
  readonly normalizedAddress: string;
  readonly actorId: string;
  readonly match: "primary" | "alias" | "catch_all";
}

export interface CreateReceivingDomainInput {
  readonly orgId: string;
  readonly domain: string;
  readonly catchAllActorId?: string | null;
  readonly createdBy?: string | null;
}

export interface ReceivingDomainStore {
  listDomains(orgId: string): Promise<readonly MailReceivingDomainRecord[]>;
  getDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null>;
  createDomain(input: CreateReceivingDomainInput): Promise<MailReceivingDomainRecord>;
  markVerified(orgId: string, id: string): Promise<MailReceivingDomainRecord | null>;
  /* Remove the capability. The admin_domains identity survives: other
     capabilities may hang off it, and it carries the DNS records. */
  deleteDomain(orgId: string, id: string): Promise<boolean>;
  enableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null>;
  disableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null>;
  resolveReceivingDomain(domain: string): Promise<MailReceivingDomainRecord | null>;
  resolveMailbox(address: string): Promise<ReceivingMailboxResolution | null>;
}

export class ReceivingDomainConflictError extends Error {
  constructor(message = "Receiving domain conflicts with an existing configuration.") {
    super(message);
    this.name = "ReceivingDomainConflictError";
  }
}

export class ReceivingDomainTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivingDomainTransitionError";
  }
}

export class ReceivingDomainCatchAllError extends Error {
  constructor(message = "Catch-all actor must be an active actor in the same organization.") {
    super(message);
    this.name = "ReceivingDomainCatchAllError";
  }
}

export class ReceivingDomainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivingDomainInvariantError";
  }
}

export interface InMemoryReceivingDomainActor {
  readonly id: string;
  readonly orgId: string;
  readonly email?: string | null;
  readonly disabled?: boolean;
}

export interface InMemoryReceivingDomainAlias {
  readonly orgId: string;
  readonly actorId: string;
  readonly address: string;
  readonly enabled?: boolean;
}

/** Deterministic adapter used by route and state-machine tests. */
export class InMemoryReceivingDomainStore implements ReceivingDomainStore {
  readonly #domains = new Map<string, MailReceivingDomainRecord>();
  readonly #actors: readonly InMemoryReceivingDomainActor[];
  readonly #aliases: readonly InMemoryReceivingDomainAlias[];
  readonly #now: () => Date;

  constructor(options?: {
    readonly actors?: readonly InMemoryReceivingDomainActor[];
    readonly aliases?: readonly InMemoryReceivingDomainAlias[];
    readonly now?: () => Date;
  }) {
    this.#actors = options?.actors ?? [];
    this.#aliases = options?.aliases ?? [];
    this.#now = options?.now ?? (() => new Date());
  }

  async listDomains(orgId: string): Promise<readonly MailReceivingDomainRecord[]> {
    return [...this.#domains.values()]
      .filter((record) => record.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const record = this.#domains.get(id);
    return record?.orgId === orgId ? record : null;
  }

  async createDomain(input: CreateReceivingDomainInput): Promise<MailReceivingDomainRecord> {
    const domain = normalizeMailDomain(input.domain);
    this.#assertCatchAll(input.orgId, input.catchAllActorId ?? null);
    if (
      [...this.#domains.values()].some(
        (record) => record.orgId === input.orgId && record.domain === domain,
      )
    ) {
      throw new ReceivingDomainConflictError(
        "This organization already has a receiving-domain record for that domain.",
      );
    }
    const timestamp = this.#now().toISOString();
    const record: MailReceivingDomainRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      /* This adapter has no admin_domains table; one identity per (org, domain)
         is the invariant the database enforces, so deriving a stable id from
         that pair reproduces it. */
      adminDomainId: `${input.orgId}:${domain}`,
      domain,
      status: "pending",
      verifiedAt: null,
      catchAllActorId: input.catchAllActorId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#domains.set(record.id, record);
    return record;
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const current = await this.getDomain(orgId, id);
    if (current === null) {
      return false;
    }
    this.#domains.delete(id);
    return true;
  }

  async markVerified(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const current = await this.getDomain(orgId, id);
    if (current === null) {
      return null;
    }
    if (current.status === "verified" || current.status === "active") {
      return current;
    }
    if (current.status !== "pending") {
      throw new ReceivingDomainTransitionError(
        `Cannot verify a receiving domain in ${current.status} state.`,
      );
    }
    return this.#replace(current, {
      status: "verified",
      verifiedAt: this.#now().toISOString(),
    });
  }

  async enableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const current = await this.getDomain(orgId, id);
    if (current === null) {
      return null;
    }
    if (current.status === "active") {
      return current;
    }
    if (
      (current.status !== "verified" && current.status !== "disabled") ||
      current.verifiedAt === null
    ) {
      throw new ReceivingDomainTransitionError(
        "Receiving domain must be verified before it can be enabled.",
      );
    }
    this.#assertCatchAll(orgId, current.catchAllActorId);
    const occupied = [...this.#domains.values()].some(
      (record) =>
        record.id !== current.id && record.domain === current.domain && record.status === "active",
    );
    if (occupied) {
      throw new ReceivingDomainConflictError(
        "That receiving domain is already active for another organization.",
      );
    }
    return this.#replace(current, { status: "active" });
  }

  async disableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const current = await this.getDomain(orgId, id);
    if (current === null) {
      return null;
    }
    if (current.status === "disabled") {
      return current;
    }
    if (current.status !== "active" && current.status !== "verified") {
      throw new ReceivingDomainTransitionError(
        `Cannot disable a receiving domain in ${current.status} state.`,
      );
    }
    return this.#replace(current, { status: "disabled" });
  }

  async resolveReceivingDomain(domain: string): Promise<MailReceivingDomainRecord | null> {
    const normalized = normalizeMailDomain(domain);
    const matches = [...this.#domains.values()].filter(
      (record) => record.domain === normalized && record.status === "active",
    );
    if (matches.length > 1) {
      throw new ReceivingDomainInvariantError(
        "More than one active organization owns the receiving domain.",
      );
    }
    return matches[0] ?? null;
  }

  async resolveMailbox(address: string): Promise<ReceivingMailboxResolution | null> {
    const normalized = normalizeMailboxAddress(address);
    const receivingDomain = await this.resolveReceivingDomain(normalized.domain);
    if (receivingDomain === null) {
      return null;
    }

    const primaryActors = this.#actors.filter(
      (actor) =>
        !actor.disabled &&
        actor.orgId === receivingDomain.orgId &&
        actor.email !== null &&
        actor.email !== undefined &&
        normalizeMailboxAddress(actor.email).address === normalized.address,
    );
    const aliases = this.#aliases.filter(
      (alias) =>
        alias.enabled !== false &&
        alias.orgId === receivingDomain.orgId &&
        normalizeMailboxAddress(alias.address).address === normalized.address &&
        this.#actorIsActive(receivingDomain.orgId, alias.actorId),
    );
    const actorIds = new Set([
      ...primaryActors.map((actor) => actor.id),
      ...aliases.map((alias) => alias.actorId),
    ]);
    if (actorIds.size > 1) {
      throw new ReceivingDomainInvariantError(
        "Mailbox address maps to more than one active actor.",
      );
    }
    const actorId = [...actorIds][0];
    if (actorId !== undefined) {
      return resolution(
        receivingDomain,
        normalized.address,
        actorId,
        primaryActors.some((actor) => actor.id === actorId) ? "primary" : "alias",
      );
    }
    if (
      receivingDomain.catchAllActorId !== null &&
      this.#actorIsActive(receivingDomain.orgId, receivingDomain.catchAllActorId)
    ) {
      return resolution(
        receivingDomain,
        normalized.address,
        receivingDomain.catchAllActorId,
        "catch_all",
      );
    }
    return null;
  }

  #replace(
    current: MailReceivingDomainRecord,
    patch: Partial<Pick<MailReceivingDomainRecord, "status" | "verifiedAt">>,
  ): MailReceivingDomainRecord {
    const next = { ...current, ...patch, updatedAt: this.#now().toISOString() };
    this.#domains.set(next.id, next);
    return next;
  }

  #assertCatchAll(orgId: string, actorId: string | null): void {
    if (actorId !== null && !this.#actorIsActive(orgId, actorId)) {
      throw new ReceivingDomainCatchAllError();
    }
  }

  #actorIsActive(orgId: string, actorId: string): boolean {
    return this.#actors.some(
      (actor) => actor.id === actorId && actor.orgId === orgId && !actor.disabled,
    );
  }
}

interface ReceivingDomainRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain: string;
  readonly status: MailReceivingDomainStatus;
  readonly admin_domain_id: string;
  readonly verified_at: Date | string | null;
  readonly catch_all_actor_id: string | null;
  readonly created_by: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface MailboxActorRow {
  readonly actor_id: string;
  readonly source: "primary" | "alias";
}

/**
 * PostgreSQL persistence for receiving domains.
 *
 * `resolveReceivingDomain` is intentionally cross-tenant and must be given the
 * trusted SMTP/control-plane connection (table-owner or BYPASSRLS role), never
 * a request-scoped tenant connection.
 */
export class PostgresReceivingDomainStore implements ReceivingDomainStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listDomains(orgId: string): Promise<readonly MailReceivingDomainRecord[]> {
    const rows = await this.sql<ReceivingDomainRow[]>`
      select id, org_id, admin_domain_id, domain, status, verified_at,
             catch_all_actor_id, created_by, created_at, updated_at
      from mail_receiving_domains
      where org_id = ${orgId}
      order by created_at desc, id desc
    `;
    return rows.map(mapReceivingDomain);
  }

  async getDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const rows = await this.sql<ReceivingDomainRow[]>`
      select id, org_id, admin_domain_id, domain, status, verified_at,
             catch_all_actor_id, created_by, created_at, updated_at
      from mail_receiving_domains
      where org_id = ${orgId} and id = ${id}
      limit 1
    `;
    return rows[0] === undefined ? null : mapReceivingDomain(rows[0]);
  }

  async createDomain(input: CreateReceivingDomainInput): Promise<MailReceivingDomainRecord> {
    const domain = normalizeMailDomain(input.domain);
    await this.#assertCatchAll(input.orgId, input.catchAllActorId ?? null);
    /* Resolve (or register) the domain identity this capability hangs off.
       It lands `pending` — accepting mail still requires proving ownership. */
    const adminDomainId = await ensureAdminDomain(this.sql, {
      orgId: input.orgId,
      domain,
      createdBy: input.createdBy ?? null,
    });
    try {
      const rows = await this.sql<ReceivingDomainRow[]>`
        insert into mail_receiving_domains (
          org_id, admin_domain_id, domain, status, catch_all_actor_id, created_by
        )
        values (
          ${input.orgId}, ${adminDomainId}, ${domain}, 'pending',
          ${input.catchAllActorId ?? null}, ${input.createdBy ?? null}
        )
        returning id, org_id, admin_domain_id, domain, status, verified_at,
                  catch_all_actor_id, created_by, created_at, updated_at
      `;
      return mapRequiredRow(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReceivingDomainConflictError(
          "This receiving domain or verification challenge already exists.",
        );
      }
      if (isCatchAllConstraintViolation(error)) {
        throw new ReceivingDomainCatchAllError();
      }
      throw error;
    }
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      delete from mail_receiving_domains
      where org_id = ${orgId} and id = ${id}
      returning id
    `;
    return rows[0] !== undefined;
  }

  async markVerified(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const rows = await this.sql<ReceivingDomainRow[]>`
      update mail_receiving_domains
      set status = 'verified', verified_at = coalesce(verified_at, now()), updated_at = now()
      where org_id = ${orgId} and id = ${id} and status = 'pending'
      returning id, org_id, admin_domain_id, domain, status, verified_at,
                catch_all_actor_id, created_by, created_at, updated_at
    `;
    if (rows[0] !== undefined) {
      return mapReceivingDomain(rows[0]);
    }
    const current = await this.getDomain(orgId, id);
    if (current === null || current.status === "verified" || current.status === "active") {
      return current;
    }
    throw new ReceivingDomainTransitionError(
      `Cannot verify a receiving domain in ${current.status} state.`,
    );
  }

  async enableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const current = await this.getDomain(orgId, id);
    if (current === null || current.status === "active") {
      return current;
    }
    if (
      (current.status !== "verified" && current.status !== "disabled") ||
      current.verifiedAt === null
    ) {
      throw new ReceivingDomainTransitionError(
        "Receiving domain must be verified before it can be enabled.",
      );
    }
    await this.#assertCatchAll(orgId, current.catchAllActorId);
    try {
      const rows = await this.sql<ReceivingDomainRow[]>`
        update mail_receiving_domains
        set status = 'active', updated_at = now()
        where org_id = ${orgId}
          and id = ${id}
          and status in ('verified', 'disabled')
          and verified_at is not null
        returning id, org_id, admin_domain_id, domain, status, verified_at,
                  catch_all_actor_id, created_by, created_at, updated_at
      `;
      if (rows[0] !== undefined) {
        return mapReceivingDomain(rows[0]);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReceivingDomainConflictError(
          "That receiving domain is already active for another organization.",
        );
      }
      if (isCatchAllConstraintViolation(error)) {
        throw new ReceivingDomainCatchAllError();
      }
      throw error;
    }
    return this.getDomain(orgId, id);
  }

  async disableDomain(orgId: string, id: string): Promise<MailReceivingDomainRecord | null> {
    const current = await this.getDomain(orgId, id);
    if (current === null || current.status === "disabled") {
      return current;
    }
    if (current.status !== "active" && current.status !== "verified") {
      throw new ReceivingDomainTransitionError(
        `Cannot disable a receiving domain in ${current.status} state.`,
      );
    }
    const rows = await this.sql<ReceivingDomainRow[]>`
      update mail_receiving_domains
      set status = 'disabled', updated_at = now()
      where org_id = ${orgId} and id = ${id} and status in ('active', 'verified')
      returning id, org_id, admin_domain_id, domain, status, verified_at,
                catch_all_actor_id, created_by, created_at, updated_at
    `;
    return rows[0] === undefined ? this.getDomain(orgId, id) : mapReceivingDomain(rows[0]);
  }

  async resolveReceivingDomain(domain: string): Promise<MailReceivingDomainRecord | null> {
    const normalized = normalizeMailDomain(domain);
    const rows = await this.sql<ReceivingDomainRow[]>`
      select id, org_id, admin_domain_id, domain, status, verified_at,
             catch_all_actor_id, created_by, created_at, updated_at
      from mail_receiving_domains
      where domain = ${normalized} and status = 'active'
      limit 2
    `;
    if (rows.length > 1) {
      throw new ReceivingDomainInvariantError(
        "More than one active organization owns the receiving domain.",
      );
    }
    return rows[0] === undefined ? null : mapReceivingDomain(rows[0]);
  }

  async resolveMailbox(address: string): Promise<ReceivingMailboxResolution | null> {
    const normalized = normalizeMailboxAddress(address);
    const receivingDomain = await this.resolveReceivingDomain(normalized.domain);
    if (receivingDomain === null) {
      return null;
    }
    const rows = await this.sql<MailboxActorRow[]>`
      select actor_id, source
      from (
        select a.id as actor_id, 'primary'::text as source
        from actors a
        where a.org_id = ${receivingDomain.orgId}
          and a.disabled_at is null
          and lower(a.email) = ${normalized.address}
        union all
        select ma.actor_id, 'alias'::text as source
        from mail_aliases ma
        join actors a on a.id = ma.actor_id and a.org_id = ma.org_id
        where ma.org_id = ${receivingDomain.orgId}
          and ma.enabled = true
          and ma.disabled_at is null
          and a.disabled_at is null
          and lower(ma.email) = ${normalized.address}
      ) mailbox_matches
      limit 3
    `;
    const actorIds = new Set(rows.map((row) => row.actor_id));
    if (actorIds.size > 1) {
      throw new ReceivingDomainInvariantError(
        "Mailbox address maps to more than one active actor.",
      );
    }
    const actorId = [...actorIds][0];
    if (actorId !== undefined) {
      return resolution(
        receivingDomain,
        normalized.address,
        actorId,
        rows.some((row) => row.actor_id === actorId && row.source === "primary")
          ? "primary"
          : "alias",
      );
    }
    if (receivingDomain.catchAllActorId === null) {
      return null;
    }
    const catchAll = await this.sql<{ readonly id: string }[]>`
      select id
      from actors
      where id = ${receivingDomain.catchAllActorId}
        and org_id = ${receivingDomain.orgId}
        and disabled_at is null
      limit 1
    `;
    return catchAll[0] === undefined
      ? null
      : resolution(
          receivingDomain,
          normalized.address,
          receivingDomain.catchAllActorId,
          "catch_all",
        );
  }

  async #assertCatchAll(orgId: string, actorId: string | null): Promise<void> {
    if (actorId === null) {
      return;
    }
    const rows = await this.sql<{ readonly exists: boolean }[]>`
      select exists(
        select 1 from actors
        where id = ${actorId} and org_id = ${orgId} and disabled_at is null
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      throw new ReceivingDomainCatchAllError();
    }
  }
}

function mapReceivingDomain(row: ReceivingDomainRow): MailReceivingDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    status: row.status,
    adminDomainId: row.admin_domain_id,
    verifiedAt: iso(row.verified_at),
    catchAllActorId: row.catch_all_actor_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function mapRequiredRow(row: ReceivingDomainRow | undefined): MailReceivingDomainRecord {
  if (row === undefined) {
    throw new ReceivingDomainInvariantError("Receiving-domain write returned no record.");
  }
  return mapReceivingDomain(row);
}

function iso(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function resolution(
  domain: MailReceivingDomainRecord,
  normalizedAddress: string,
  actorId: string,
  match: ReceivingMailboxResolution["match"],
): ReceivingMailboxResolution {
  return {
    orgId: domain.orgId,
    receivingDomainId: domain.id,
    domain: domain.domain,
    normalizedAddress,
    actorId,
    match,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

function isCatchAllConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "constraint_name" in error &&
    (error as { readonly constraint_name?: unknown }).constraint_name ===
      "mail_receiving_domains_catch_all_same_org"
  );
}
