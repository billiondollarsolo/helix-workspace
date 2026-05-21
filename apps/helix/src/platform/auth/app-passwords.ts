import { z } from "zod";
import { getCryptoProvider } from "../crypto/index.js";
import type postgres from "postgres";
import type { Actor, JsonObject, ToolDefinition } from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { hashSecret, parseScope, OAuthError, verifySecret } from "./oauth.js";
import { appPasswordScopeCatalog } from "../permissions/scope-catalog.js";

export const appPasswordAdminScope = "admin.users";

/**
 * Scope catalog for legacy app passwords (DAV / IMAP / SMTP clients).
 *
 * As of P1-6 this is re-exported from the single canonical scope-catalog module
 * (derived as the `app_password` surface) rather than hand-maintained here.
 */
export { appPasswordScopeCatalog };

export interface AppPasswordRecord {
  readonly id: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface AppPasswordCreateInput {
  readonly actorId: string;
  readonly orgId: string;
  readonly label: string;
  readonly passwordHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date | null;
}

export interface AppPasswordListInput {
  readonly orgId: string;
  readonly actorId?: string;
  readonly includeRevoked?: boolean;
}

export interface AppPasswordStore {
  createAppPassword(input: AppPasswordCreateInput): Promise<AppPasswordRecord>;
  listAppPasswords(input: AppPasswordListInput): Promise<readonly AppPasswordRecord[]>;
  revokeAppPassword(input: {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: Date;
  }): Promise<AppPasswordRecord | null>;
}

export interface AppPasswordAuthenticationInput {
  readonly username: string;
  readonly password: string;
  readonly requiredScope: string;
  readonly compatibilityScope?: string;
}

export interface AppPasswordAuthenticator {
  authenticateAppPassword(input: AppPasswordAuthenticationInput): Promise<Actor | null>;
}

export interface AppPasswordRegistration {
  readonly appPassword: AppPasswordRecord;
  readonly password: string;
}

export class AppPasswordManager {
  constructor(private readonly store: AppPasswordStore) {}

  async create(
    input: Omit<AppPasswordCreateInput, "passwordHash">,
  ): Promise<AppPasswordRegistration> {
    const password = `helix_ap_${getCryptoProvider().randomBytes(24).toString("base64url")}`;
    const appPassword = await this.store.createAppPassword({
      ...input,
      scopes: normalizeScopes(input.scopes),
      passwordHash: await hashSecret(password),
    });
    return { appPassword, password };
  }

  list(input: AppPasswordListInput): Promise<readonly AppPasswordRecord[]> {
    return this.store.listAppPasswords(input);
  }

  revoke(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<AppPasswordRecord | null> {
    return this.store.revokeAppPassword({ ...input, revokedAt: new Date() });
  }
}

export class InMemoryAppPasswordStore implements AppPasswordStore {
  readonly #records = new Map<string, AppPasswordRecord & { readonly passwordHash: string }>();
  readonly #actors = new Map<string, Actor>();

  addActor(actor: Actor): void {
    this.#actors.set(actor.id, actor);
    if (actor.email !== undefined) {
      this.#actors.set(actor.email.toLowerCase(), actor);
    }
  }

  async createAppPassword(input: AppPasswordCreateInput): Promise<AppPasswordRecord> {
    const createdAt = new Date();
    const record = {
      id: getCryptoProvider().randomUuid(),
      actorId: input.actorId,
      orgId: input.orgId,
      label: input.label,
      passwordHash: input.passwordHash,
      scopes: uniqueScopes(input.scopes),
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt,
    };
    this.#records.set(record.id, record);
    return stripHash(record);
  }

  async listAppPasswords(input: AppPasswordListInput): Promise<readonly AppPasswordRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.orgId === input.orgId)
      .filter((record) => input.actorId === undefined || record.actorId === input.actorId)
      .filter((record) => input.includeRevoked === true || record.revokedAt === null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(stripHash);
  }

  async revokeAppPassword(input: {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: Date;
  }): Promise<AppPasswordRecord | null> {
    const existing = this.#records.get(input.id);
    if (existing === undefined || existing.orgId !== input.orgId || existing.revokedAt !== null) {
      return null;
    }
    const revoked = { ...existing, revokedAt: input.revokedAt };
    this.#records.set(input.id, revoked);
    return stripHash(revoked);
  }

  async authenticateAppPassword(input: AppPasswordAuthenticationInput): Promise<Actor | null> {
    const actor =
      this.#actors.get(input.username) ?? this.#actors.get(input.username.toLowerCase());
    if (actor === undefined) {
      return null;
    }
    const now = new Date();
    for (const record of this.#records.values()) {
      if (
        record.actorId !== actor.id ||
        record.orgId !== actor.orgId ||
        record.revokedAt !== null ||
        (record.expiresAt !== null && record.expiresAt <= now)
      ) {
        continue;
      }
      const scopes = [...new Set([...(actor.scopes ?? []), ...record.scopes])];
      if (
        !scopes.includes(input.requiredScope) &&
        (input.compatibilityScope === undefined || !scopes.includes(input.compatibilityScope))
      ) {
        continue;
      }
      if (await verifySecret(input.password, record.passwordHash)) {
        return { ...actor, scopes };
      }
    }
    return null;
  }
}

export class PostgresAppPasswordStore implements AppPasswordStore, AppPasswordAuthenticator {
  constructor(private readonly sql: postgres.Sql) {}

  async createAppPassword(input: AppPasswordCreateInput): Promise<AppPasswordRecord> {
    const rows = (await this.sql`
      with selected_actor as (
        select id, org_id
        from actors
        where id = ${input.actorId}
          and org_id = ${input.orgId}
          and disabled_at is null
      ),
      inserted as (
        insert into app_passwords (actor_id, label, hash, scopes, expires_at)
        select
          selected_actor.id,
          ${input.label},
          ${input.passwordHash},
          ${this.sql.array(uniqueScopes(input.scopes))},
          ${input.expiresAt ?? null}
        from selected_actor
        returning id, actor_id, label, scopes, last_used_at, expires_at, revoked_at, created_at
      )
      select
        inserted.id,
        inserted.actor_id,
        selected_actor.org_id,
        inserted.label,
        inserted.scopes,
        inserted.last_used_at,
        inserted.expires_at,
        inserted.revoked_at,
        inserted.created_at
      from inserted
      join selected_actor on selected_actor.id = inserted.actor_id
    `) as unknown as readonly AppPasswordRow[];
    const record = rowToRecord(rows[0]);
    if (record === null) {
      throw new Error("Failed to create app password for actor in org.");
    }
    return record;
  }

  async listAppPasswords(input: AppPasswordListInput): Promise<readonly AppPasswordRecord[]> {
    const rows = (await this.sql`
      select
        p.id,
        p.actor_id,
        a.org_id,
        p.label,
        p.scopes,
        p.last_used_at,
        p.expires_at,
        p.revoked_at,
        p.created_at
      from app_passwords p
      join actors a on a.id = p.actor_id
      where a.org_id = ${input.orgId}
        and (${input.actorId ?? null}::uuid is null or p.actor_id = ${input.actorId ?? null}::uuid)
        and (${input.includeRevoked === true}::boolean or p.revoked_at is null)
      order by p.created_at desc, p.id asc
    `) as unknown as readonly AppPasswordRow[];
    return rows.flatMap((row) => {
      const record = rowToRecord(row);
      return record === null ? [] : [record];
    });
  }

  async revokeAppPassword(input: {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: Date;
  }): Promise<AppPasswordRecord | null> {
    const rows = (await this.sql`
      with updated as (
        update app_passwords
        set revoked_at = ${input.revokedAt}
        from actors
        where app_passwords.id = ${input.id}
          and app_passwords.actor_id = actors.id
          and actors.org_id = ${input.orgId}
          and app_passwords.revoked_at is null
        returning
          app_passwords.id,
          app_passwords.actor_id,
          actors.org_id,
          app_passwords.label,
          app_passwords.scopes,
          app_passwords.last_used_at,
          app_passwords.expires_at,
          app_passwords.revoked_at,
          app_passwords.created_at
      )
      select * from updated
    `) as unknown as readonly AppPasswordRow[];
    return rowToRecord(rows[0]);
  }

  async authenticateAppPassword(input: AppPasswordAuthenticationInput): Promise<Actor | null> {
    const rows = (await this.sql`
      select
        a.id,
        a.org_id,
        a.type,
        a.email,
        a.display_name,
        a.scopes as actor_scopes,
        p.id as password_id,
        p.hash,
        p.scopes as password_scopes
      from app_passwords p
      join actors a on a.id = p.actor_id
      where p.revoked_at is null
        and (p.expires_at is null or p.expires_at > now())
        and a.disabled_at is null
        and (lower(a.email) = lower(${input.username}) or a.id::text = ${input.username})
    `) as unknown as readonly AppPasswordAuthRow[];
    for (const row of rows) {
      const scopes = [...new Set([...row.actor_scopes, ...row.password_scopes])];
      if (
        !scopes.includes(input.requiredScope) &&
        (input.compatibilityScope === undefined || !scopes.includes(input.compatibilityScope))
      ) {
        continue;
      }
      if (await verifySecret(input.password, row.hash)) {
        await this.sql`update app_passwords set last_used_at = now() where id = ${row.password_id}`;
        return {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          displayName: row.display_name,
          scopes,
          ...(row.email === null ? {} : { email: row.email }),
        };
      }
    }
    return null;
  }
}

export interface RegisterAppPasswordToolsOptions {
  readonly store: AppPasswordStore;
  readonly manager?: AppPasswordManager;
  readonly scopeCatalog?: readonly string[];
}

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const uuidSchema = z.string().uuid();
const listSchema = z.object({
  actorId: uuidSchema.optional(),
  includeRevoked: z.boolean().default(false),
});
const createSchema = (scopeCatalog: ReadonlySet<string>) =>
  z
    .object({
      actorId: uuidSchema,
      label: z.string().trim().min(1).max(120),
      scopes: z.array(z.string().min(1)).min(1),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .superRefine((input, ctx) => {
      let scopes: readonly string[];
      try {
        scopes = normalizeScopes(input.scopes);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scopes"],
          message: error instanceof Error ? error.message : "Invalid scope token.",
        });
        return;
      }
      for (const scope of scopes) {
        if (!scopeCatalog.has(scope)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scopes"],
            message: `Unknown or unsupported app password scope: ${scope}`,
          });
        }
      }
    });
const revokeSchema = z.object({
  passwordId: uuidSchema,
});

export function createAppPasswordToolDefinitions(
  options: RegisterAppPasswordToolsOptions,
): readonly ToolDefinition[] {
  const manager = options.manager ?? new AppPasswordManager(options.store);
  const createInputSchema = createSchema(new Set(options.scopeCatalog ?? appPasswordScopeCatalog));

  return [
    defineTool<z.output<typeof createInputSchema>, unknown>({
      id: "app.passwords.create",
      description: "Create a scoped app password for legacy DAV, IMAP, or SMTP clients.",
      permission: appPasswordAdminScope,
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(createInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const registration = await manager.create({
          actorId: input.actorId,
          orgId: ctx.actor.orgId,
          label: input.label,
          scopes: normalizeScopes(input.scopes),
          expiresAt:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
        });
        await ctx.audit("app.password.created", {
          credentialType: "app_password",
          targetActorId: registration.appPassword.actorId,
          targetOrgId: registration.appPassword.orgId,
          passwordId: registration.appPassword.id,
          label: registration.appPassword.label,
          scopes: [...registration.appPassword.scopes],
          expiresAt: dateToJson(registration.appPassword.expiresAt),
        });
        return {
          appPassword: serializeAppPassword(registration.appPassword),
          password: registration.password,
        };
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "app.passwords.list",
      description: "List app passwords for actors in the current org without exposing secrets.",
      permission: appPasswordAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const appPasswords = await manager.list({
          orgId: ctx.actor.orgId,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          includeRevoked: input.includeRevoked,
        });
        await ctx.audit("app.password.listed", {
          credentialType: "app_password",
          ...(input.actorId === undefined ? {} : { targetActorId: input.actorId }),
          includeRevoked: input.includeRevoked,
          resultCount: appPasswords.length,
        });
        return { appPasswords: appPasswords.map(serializeAppPassword) };
      },
    }),
    defineTool<z.output<typeof revokeSchema>, unknown>({
      id: "app.passwords.revoke",
      description: "Revoke an app password in the current org.",
      permission: appPasswordAdminScope,
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const revoked = await manager.revoke({ id: input.passwordId, orgId: ctx.actor.orgId });
        if (revoked === null) {
          return { status: "not_found", passwordId: input.passwordId };
        }
        await ctx.audit("app.password.revoked", {
          credentialType: "app_password",
          targetActorId: revoked.actorId,
          targetOrgId: revoked.orgId,
          passwordId: revoked.id,
          label: revoked.label,
          revokedAt: dateToJson(revoked.revokedAt),
        });
        return {
          status: "revoked",
          appPassword: serializeAppPassword(revoked),
        };
      },
    }),
  ];
}

export function registerAppPasswordTools(
  registry: RuntimeToolRegistry,
  options: RegisterAppPasswordToolsOptions,
): void {
  for (const tool of createAppPasswordToolDefinitions(options)) {
    registry.register(tool);
  }
}

interface AppPasswordRow {
  readonly id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

interface AppPasswordAuthRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: Actor["type"];
  readonly email: string | null;
  readonly display_name: string;
  readonly actor_scopes: readonly string[];
  readonly password_id: string;
  readonly hash: string;
  readonly password_scopes: readonly string[];
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  try {
    return parseScope(scopes.join(" "));
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new TypeError(error.message);
    }
    throw error;
  }
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}

function rowToRecord(row: AppPasswordRow | undefined): AppPasswordRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    orgId: row.org_id,
    label: row.label,
    scopes: [...row.scopes],
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function stripHash(
  record: AppPasswordRecord & { readonly passwordHash?: string },
): AppPasswordRecord {
  return {
    id: record.id,
    actorId: record.actorId,
    orgId: record.orgId,
    label: record.label,
    scopes: [...record.scopes],
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
  };
}

function serializeAppPassword(appPassword: AppPasswordRecord): JsonObject {
  return {
    id: appPassword.id,
    actorId: appPassword.actorId,
    orgId: appPassword.orgId,
    label: appPassword.label,
    scopes: [...appPassword.scopes],
    lastUsedAt: dateToJson(appPassword.lastUsedAt),
    expiresAt: dateToJson(appPassword.expiresAt),
    revokedAt: dateToJson(appPassword.revokedAt),
    createdAt: appPassword.createdAt.toISOString(),
  };
}

function dateToJson(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
