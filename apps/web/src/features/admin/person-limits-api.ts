import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";
import { parseResponse } from "@/features/admin/api-response";
import { updateTenantConfig } from "@/features/admin/tenant-config-api";

/**
 * Admin Console — limits for each person.
 *
 * The organization's defaults are settings (`quotas` in tenant config); one
 * person's own values live at `/api/admin/person-limits/:actorId`. An empty
 * value in a person's limits means "use the default"; an empty default means
 * "no limit".
 */

const valuesSchema = z.object({
  storageBytes: z.number().nullable(),
  mailSendPerHour: z.number().nullable(),
  mailSendPerDay: z.number().nullable(),
});

const personSchema = z.object({
  actorId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  type: z.string(),
  overrides: valuesSchema,
  effective: valuesSchema,
  usage: z.object({
    storageBytes: z.number(),
    mailSentLastHour: z.number(),
    mailSentLastDay: z.number(),
  }),
});

export type PersonLimitValues = z.infer<typeof valuesSchema>;
export type PersonLimits = z.infer<typeof personSchema>;

const PATH = "/api/admin/person-limits";
export const personLimitsQueryKey = ["admin", "person-limits"] as const;

export function personLimitsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: personLimitsQueryKey,
    queryFn: async () =>
      parseResponse(
        await fetchImpl(PATH),
        "load limits",
        z.object({ defaults: valuesSchema, people: z.array(personSchema) }),
      ),
  });
}

export function personLimitQueryOptions(
  actorId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: [...personLimitsQueryKey, actorId] as const,
    queryFn: async () =>
      (
        await parseResponse(
          await fetchImpl(`${PATH}/${actorId}`),
          "load this person's limits",
          z.object({ person: personSchema }),
        )
      ).person,
  });
}

export async function savePersonLimits(
  actorId: string,
  overrides: PersonLimitValues,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<PersonLimits> {
  const response = await fetchImpl(`${PATH}/${actorId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overrides),
  });
  return (await parseResponse(response, "save the limits", z.object({ person: personSchema })))
    .person;
}

/** The defaults are organization settings; an empty one means no limit. */
export async function saveDefaultLimits(
  defaults: PersonLimitValues,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await updateTenantConfig(
    {
      quotas: {
        storage_bytes_per_person_limit: defaults.storageBytes,
        mail_send_per_hour_limit: defaults.mailSendPerHour,
        mail_send_per_day_limit: defaults.mailSendPerDay,
      },
      reason: "admin limits update: defaults for each person",
    },
    fetchImpl,
  );
}

const GB = 1024 ** 3;

/** Storage is entered in gigabytes; an empty field is "no value". */
export function gigabytesToBytes(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * GB) : undefined;
}

export function bytesToGigabytes(bytes: number | null): string {
  return bytes === null ? "" : String(Math.round((bytes / GB) * 100) / 100);
}

/** A whole number of zero or more; an empty field is "no value". */
export function countFromText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
}
