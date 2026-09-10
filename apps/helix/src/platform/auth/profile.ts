import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import type { SessionActorResolver } from "../../api/actor.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../api/api-error.js";
import {
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { setTenantPostgresActorId } from "../tenancy/postgres-roles.js";
import { isRecord } from "../util/json.js";
import { toSqlJson } from "../util/sql.js";
import { hasControlCharacter } from "../util/strings.js";

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !hasControlCharacter(value), "Use a single line.");
const profilePatch = z
  .object({
    displayName: singleLine(200).refine((value) => value.length > 0, "Enter a display name."),
    pronouns: singleLine(80),
    jobTitle: singleLine(200),
    about: z
      .string()
      .trim()
      .max(2000)
      .refine(
        (value) => !hasControlCharacter(value.replace(/[\r\n\t]/gu, "")),
        "Remove control characters.",
      ),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one profile field.");

export interface UserProfile {
  actorId: string;
  orgId: string;
  email: string | null;
  displayName: string;
  pronouns: string;
  jobTitle: string;
  about: string;
}

interface ProfileRow {
  id: string;
  org_id: string;
  email: string | null;
  display_name: string;
  metadata: JsonObject;
}

export class PostgresProfileStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(orgId: string, actorId: string): Promise<UserProfile | null> {
    const [row] = await this.sql<ProfileRow[]>`
      select id, org_id, email, display_name, metadata from actors
      where org_id = ${orgId} and id = ${actorId} and type = 'user'
    `;
    return row === undefined ? null : userProfile(row);
  }

  async update(
    orgId: string,
    actorId: string,
    patch: z.infer<typeof profilePatch>,
  ): Promise<UserProfile | null> {
    const { displayName, ...details } = patch;
    const [row] = await this.sql<ProfileRow[]>`
      update actors set
        display_name = coalesce(${displayName ?? null}, display_name),
        metadata = jsonb_set(metadata, '{profile}',
          (case when jsonb_typeof(metadata->'profile') = 'object'
            then metadata->'profile' else '{}'::jsonb end) || ${this.sql.json(toSqlJson(details))}::jsonb),
        updated_at = now()
      where org_id = ${orgId} and id = ${actorId} and type = 'user'
      returning id, org_id, email, display_name, metadata
    `;
    return row === undefined ? null : userProfile(row);
  }
}

function userProfile(row: ProfileRow): UserProfile {
  const details = isRecord(row.metadata.profile) ? row.metadata.profile : {};
  return {
    actorId: row.id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    pronouns: typeof details.pronouns === "string" ? details.pronouns : "",
    jobTitle: typeof details.jobTitle === "string" ? details.jobTitle : "",
    about: typeof details.about === "string" ? details.about : "",
  };
}

export function registerProfileRoutes(
  app: FastifyInstance,
  options: {
    store: Pick<PostgresProfileStore, "get" | "update">;
    sessionActorResolver: SessionActorResolver | undefined;
    actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    auditSink: AdminConsoleAuditSink;
  },
): void {
  for (const admin of [false, true]) {
    app.route({
      method: ["GET", "PATCH"],
      url: admin ? "/api/admin/users/:actorId/profile" : "/api/profile",
      async handler(request) {
        const actor = admin
          ? await options.actorFromRequest(request)
          : await options.sessionActorResolver?.resolve(request);
        if (actor == null || actor.id === "anonymous") {
          throw new UnauthorizedError("Sign in to manage your profile.");
        }
        assertActorMatchesRequestTenant(request, actor);
        await setTenantPostgresActorId(actor.id);
        if (admin) {
          const permitted = request.method === "GET" ? canReadAdminConsole : canWriteAdminConsole;
          if (!permitted(actor, "admin.users")) {
            throw new ForbiddenError("User administration permission is required.");
          }
        } else if (actor.type !== "user") {
          throw new ForbiddenError("Profiles are available for human users.");
        }
        const target = admin
          ? z.object({ actorId: z.string().uuid() }).safeParse(request.params)
          : { success: true as const, data: { actorId: actor.id } };
        if (!target.success) throw new BadRequestError("Invalid user ID.");
        let profile: UserProfile | null;
        if (request.method === "PATCH") {
          const parsed = profilePatch.safeParse(request.body);
          if (!parsed.success) {
            throw new BadRequestError("Invalid profile details.", { details: parsed.error.issues });
          }
          profile = await options.store.update(actor.orgId, target.data.actorId, parsed.data);
          if (profile !== null) {
            await auditAdminAction(options.auditSink, {
              orgId: actor.orgId,
              actorId: actor.id,
              verb: "user.profile.updated",
              objectType: "actor",
              objectId: target.data.actorId,
              metadata: {
                fields: Object.keys(parsed.data),
                self: actor.id === target.data.actorId,
              },
            });
          }
        } else {
          profile = await options.store.get(actor.orgId, target.data.actorId);
        }
        if (profile === null) throw new NotFoundError("User profile not found.");
        return { profile };
      },
    });
  }
}
