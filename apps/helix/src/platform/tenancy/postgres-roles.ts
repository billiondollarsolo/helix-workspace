import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface TenantPostgresContextInput {
  readonly orgId: string;
  readonly actorId?: string | undefined;
}

export interface TenantIoSagaPostgresContextInput extends TenantPostgresContextInput {
  /** Explicitly retain an already-unset actor for a trusted tenant service phase. */
  readonly serviceContext?: boolean | undefined;
}

interface ActiveTenantPostgresContext {
  readonly orgId: string;
  actorId: string | null;
  readonly tx: postgres.TransactionSql;
}

const activeTenantContext = new AsyncLocalStorage<ActiveTenantPostgresContext>();
const rawSqlByTenantAwareClient = new WeakMap<postgres.Sql, postgres.Sql>();

export async function withTenantPostgresContext<T>(
  sql: postgres.Sql,
  input: TenantPostgresContextInput,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const normalized = normalizeContext(input);
  const active = activeTenantContext.getStore();
  if (active !== undefined) {
    if (active.orgId !== normalized.orgId) {
      throw new Error("A PostgreSQL transaction cannot switch tenant context.");
    }
    if (normalized.actorId !== null) {
      await setTenantPostgresActorId(normalized.actorId);
    }
    return active.tx.savepoint((tx) =>
      activeTenantContext.run({ ...active, tx }, () => callback(tx)),
    ) as Promise<T>;
  }

  const result = await sql.begin(async (tx) => {
    await applyTenantPostgresContext(tx, input);
    return activeTenantContext.run(
      { orgId: normalized.orgId, actorId: normalized.actorId, tx },
      () => callback(tx),
    );
  });
  return result as T;
}

/**
 * Run one short, RLS-scoped database phase of an external-I/O saga without
 * inheriting the request-long transaction. The raw client stays private; an
 * ambient request may escape only for its own tenant and authenticated actor,
 * or through an explicit already-active tenant service context. The fresh
 * transaction retains the same least-privileged runtime session role.
 */
export async function withTenantIoSagaPostgresContext<T>(
  sql: postgres.Sql,
  input: TenantIoSagaPostgresContextInput,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const active = activeTenantContext.getStore();
  if (active === undefined) {
    return withTenantPostgresContext(sql, input, callback);
  }
  const normalized = normalizeContext(input);
  if (active.orgId !== normalized.orgId) {
    throw new Error("A PostgreSQL I/O saga cannot switch tenant context.");
  }
  const serviceContext = input.serviceContext === true;
  if (serviceContext && (input.actorId !== undefined || active.actorId !== null)) {
    throw new Error("A PostgreSQL service I/O saga requires an existing actor-free context.");
  }
  const actorId = serviceContext ? null : (normalized.actorId ?? active.actorId);
  if (!serviceContext && actorId === null) {
    throw new Error("A PostgreSQL I/O saga requires an authenticated actor context.");
  }
  if (actorId !== null) await setTenantPostgresActorId(actorId);
  const rawSql = rawSqlByTenantAwareClient.get(sql);
  if (rawSql === undefined) {
    throw new Error("A PostgreSQL I/O saga requires the tenant-aware runtime client.");
  }
  return activeTenantContext.exit(() =>
    rawSql.begin(async (tx) => {
      await applyTenantPostgresContext(tx, {
        orgId: normalized.orgId,
        ...(actorId === null ? {} : { actorId }),
      });
      return activeTenantContext.run({ orgId: normalized.orgId, actorId, tx }, () => callback(tx));
    }),
  ) as Promise<T>;
}

/**
 * Run a self-contained unit on its own pooled connection, outside any ambient
 * request/job transaction. Use it for work whose locks must be released at its
 * own commit (identity activation), never held for the rest of a request where
 * a later phase on another connection could wait on them forever.
 */
export function detachedFromTenantPostgresContext<T>(callback: () => Promise<T>): Promise<T> {
  return activeTenantContext.exit(callback);
}

/**
 * Run `callback` as another actor inside the active request transaction, then
 * return to the caller's own identity. A transaction otherwise never changes
 * actor; this exists for one case: a person has confirmed an action that an
 * agent (or another person) asked for, and that action must run as whoever
 * asked. The caller has already checked that the requester is still authorized.
 *
 * It stays in the same transaction because the approval and its audit entries
 * are already written there, and a second transaction would wait on them.
 */
export async function withRequesterPostgresActor<T>(
  actorId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const active = activeTenantContext.getStore();
  const requester = normalizeUuid(actorId, "actorId");
  if (active === undefined || active.actorId === requester) return callback();
  // A savepoint: if the work fails, the identity change is undone with it.
  const result = (await active.tx.savepoint(async (tx) => {
    await tx`select set_config('helix.actor_id', ${requester}, true)`;
    return activeTenantContext.run({ orgId: active.orgId, actorId: requester, tx }, callback);
  })) as T;
  await active.tx`select set_config('helix.actor_id', ${active.actorId ?? ""}, true)`;
  return result;
}

async function applyTenantPostgresContext(
  tx: postgres.TransactionSql,
  input: TenantPostgresContextInput,
): Promise<void> {
  const context = normalizeContext(input);
  await tx`
    select
      set_config('helix.org_id', ${context.orgId}, true),
      set_config('helix.actor_id', ${context.actorId ?? ""}, true)
  `;
}

/** Set the authenticated actor on the active request/job transaction, if one exists. */
export async function setTenantPostgresActorId(actorId: string): Promise<boolean> {
  const active = activeTenantContext.getStore();
  if (active === undefined) return false;
  const normalizedActorId = normalizeUuid(actorId, "actorId");
  if (active.actorId === normalizedActorId) return true;
  if (active.actorId !== null) {
    throw new Error("A PostgreSQL transaction cannot switch actor context.");
  }
  await active.tx`select set_config('helix.actor_id', ${normalizedActorId}, true)`;
  active.actorId = normalizedActorId;
  return true;
}

/**
 * Route every query made by a shared store to the active request/job transaction.
 * Outside a tenant unit it behaves exactly like the original postgres.js client.
 */
export function tenantAwarePostgresSql(sql: postgres.Sql): postgres.Sql {
  const tenantAware = new Proxy(sql, {
    apply(target, _thisArg, argumentsList): unknown {
      const active = activeTenantContext.getStore();
      const destination = active?.tx ?? target;
      return callPostgres(destination, argumentsList);
    },
    get(target, property, receiver): unknown {
      const active = activeTenantContext.getStore();
      if (property === "begin" && active !== undefined) {
        return (...argumentsList: readonly unknown[]): Promise<unknown> => {
          const callback = argumentsList.at(-1);
          if (typeof callback !== "function") {
            throw new TypeError("postgres.begin requires a transaction callback");
          }
          const run = callback as (tx: postgres.TransactionSql) => Promise<unknown>;
          return active.tx.savepoint((tx) =>
            activeTenantContext.run({ ...active, tx }, () => run(tx)),
          );
        };
      }
      if (
        active !== undefined &&
        (property === "unsafe" || property === "file" || property === "notify")
      ) {
        const value = Reflect.get(active.tx, property, active.tx) as unknown;
        return bindMethod(active.tx, value);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return bindMethod(target, value);
    },
  });
  rawSqlByTenantAwareClient.set(tenantAware, sql);
  return tenantAware;
}

function callPostgres(
  sql: postgres.Sql | postgres.TransactionSql,
  argumentsList: readonly unknown[],
): unknown {
  return Reflect.apply(sql, undefined, argumentsList);
}

function bindMethod(owner: unknown, value: unknown): unknown {
  if (typeof value !== "function") return value;
  const method = value as (...input: readonly unknown[]) => unknown;
  return (...input: readonly unknown[]) => Reflect.apply(method, owner, input);
}

function normalizeContext(input: TenantPostgresContextInput): {
  readonly orgId: string;
  readonly actorId: string | null;
} {
  return {
    orgId: normalizeUuid(input.orgId, "orgId"),
    actorId: input.actorId === undefined ? null : normalizeUuid(input.actorId, "actorId"),
  };
}

function normalizeUuid(value: string, name: "orgId" | "actorId"): string {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a valid UUID before entering PostgreSQL context`);
  }
  return normalized;
}
