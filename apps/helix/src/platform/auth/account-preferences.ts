import {
  type AccountPreferences,
  accountPreferencesGetInputSchema,
  accountPreferencesSchema,
  type AccountPreferencesSetInput,
  accountPreferencesSetInputSchema,
  type AccountWorkingHours,
} from "@helix/contracts";
import type { ToolDefinition } from "@helix/sdk-types";
import type postgres from "postgres";
import type { z } from "zod";
import { ForbiddenError } from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { toSqlJson } from "../util/sql.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

interface PreferenceRow {
  readonly language: string | null;
  readonly time_zone: string | null;
  readonly date_format: AccountPreferences["dateFormat"];
  readonly time_format: AccountPreferences["timeFormat"];
  readonly week_start: number | null;
  readonly working_hours: AccountWorkingHours | null;
  readonly mail_reading_pane: AccountPreferences["mail"]["readingPane"];
  readonly mail_density: AccountPreferences["mail"]["density"];
  readonly mail_conversation_view: boolean;
  readonly updated_at: Date | null;
}

const DEFAULTS: AccountPreferences = {
  language: null,
  timeZone: null,
  dateFormat: null,
  timeFormat: null,
  weekStart: null,
  workingHours: null,
  mail: { readingPane: "none", density: "default", conversationView: true },
  updatedAt: null,
};

function mapPreferences(row: PreferenceRow | undefined): AccountPreferences {
  if (row === undefined) return DEFAULTS;
  return {
    language: row.language,
    timeZone: row.time_zone,
    dateFormat: row.date_format,
    timeFormat: row.time_format,
    weekStart: row.week_start,
    workingHours: row.working_hours,
    mail: {
      readingPane: row.mail_reading_pane,
      density: row.mail_density,
      conversationView: row.mail_conversation_view,
    },
    updatedAt: row.updated_at?.toISOString() ?? null,
  };
}

/** The signed-in member's personal preferences, scoped by RLS to their own membership. */
export class PostgresAccountPreferencesStore {
  constructor(private readonly sql: postgres.Sql) {}

  get(input: { readonly orgId: string; readonly actorId: string }): Promise<AccountPreferences> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<(PreferenceRow & { readonly membership_id: string })[]>`
        select membership.id as membership_id, preference.language, preference.time_zone,
          preference.date_format, preference.time_format, preference.week_start,
          preference.working_hours, preference.mail_reading_pane, preference.mail_density,
          preference.mail_conversation_view, preference.updated_at
        from organization_memberships membership
        left join workspace_member_preferences preference
          on preference.org_id = membership.org_id and preference.membership_id = membership.id
        where membership.org_id = ${input.orgId}
          and membership.actor_id = ${input.actorId}
          and membership.status = 'active'
        limit 1
      `;
      const row = rows[0];
      if (row === undefined) throw new ForbiddenError("Active organization membership required.");
      // No preference row yet: the left join leaves every column null.
      return row.updated_at === null ? DEFAULTS : mapPreferences(row);
    });
  }

  set(
    input: { readonly orgId: string; readonly actorId: string } & AccountPreferencesSetInput,
  ): Promise<AccountPreferences> {
    const has = (key: keyof AccountPreferencesSetInput) => input[key] !== undefined;
    const mail = input.mail ?? {};
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<PreferenceRow[]>`
        insert into workspace_member_preferences as preference (
          org_id, membership_id, language, time_zone, date_format, time_format, week_start,
          working_hours, mail_reading_pane, mail_density, mail_conversation_view
        )
        select ${input.orgId}, membership.id, ${input.language ?? null},
          ${input.timeZone === undefined ? (input.detectedTimeZone ?? null) : input.timeZone},
          ${input.dateFormat ?? null},
          ${input.timeFormat ?? null}, ${input.weekStart ?? null},
          ${input.workingHours === undefined || input.workingHours === null ? null : tx.json(toSqlJson(input.workingHours))},
          ${mail.readingPane ?? "none"}, ${mail.density ?? "default"},
          ${mail.conversationView ?? true}
        from organization_memberships membership
        where membership.org_id = ${input.orgId}
          and membership.actor_id = ${input.actorId}
          and membership.status = 'active'
        on conflict (org_id, membership_id) do update set
          language = case when ${has("language")} then excluded.language else preference.language end,
          time_zone = case
            when ${has("timeZone")} then excluded.time_zone
            else coalesce(preference.time_zone, excluded.time_zone)
          end,
          date_format = case when ${has("dateFormat")} then excluded.date_format else preference.date_format end,
          time_format = case when ${has("timeFormat")} then excluded.time_format else preference.time_format end,
          week_start = case when ${has("weekStart")} then excluded.week_start else preference.week_start end,
          working_hours = case
            when ${has("workingHours")} then excluded.working_hours else preference.working_hours
          end,
          mail_reading_pane = case
            when ${mail.readingPane !== undefined} then excluded.mail_reading_pane
            else preference.mail_reading_pane
          end,
          mail_density = case
            when ${mail.density !== undefined} then excluded.mail_density
            else preference.mail_density
          end,
          mail_conversation_view = case
            when ${mail.conversationView !== undefined} then excluded.mail_conversation_view
            else preference.mail_conversation_view
          end,
          updated_at = now()
        returning language, time_zone, date_format, time_format, week_start, working_hours,
          mail_reading_pane, mail_density, mail_conversation_view, updated_at
      `;
      if (rows[0] === undefined)
        throw new ForbiddenError("Active organization membership required.");
      return mapPreferences(rows[0]);
    });
  }
}

function createAccountPreferenceTools(
  store: Pick<PostgresAccountPreferencesStore, "get" | "set">,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof accountPreferencesGetInputSchema>, AccountPreferences>({
      id: "account.preferences.get",
      description:
        "Read your personal preferences: language, time zone, date and time format, week start, working hours and Mail layout. Null means the browser locale applies.",
      permission: "profile.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(accountPreferencesGetInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(accountPreferencesSchema, genericObjectJsonSchema),
      handler: (_input, ctx) => store.get({ orgId: ctx.actor.orgId, actorId: ctx.actor.id }),
    }),
    defineTool<z.output<typeof accountPreferencesSetInputSchema>, AccountPreferences>({
      id: "account.preferences.set",
      description:
        "Update your personal preferences. Omitted fields keep their value and null clears one. detectedTimeZone (the browser zone) is saved only while no time zone is set.",
      permission: "profile.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(accountPreferencesSetInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(accountPreferencesSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const preferences = await store.set({
          ...input,
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
        });
        await ctx.audit("account.preferences.updated", {
          fields: Object.keys(input).filter((key) => key !== "detectedTimeZone"),
        });
        return preferences;
      },
    }),
  ];
}

export function registerAccountPreferenceTools(
  registry: RuntimeToolRegistry,
  options: { readonly store: Pick<PostgresAccountPreferencesStore, "get" | "set"> },
): void {
  for (const tool of createAccountPreferenceTools(options.store)) registry.register(tool);
}
