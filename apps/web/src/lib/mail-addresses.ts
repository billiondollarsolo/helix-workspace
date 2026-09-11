import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch } from "./auth";
import { responseError } from "./tool-call";

export const eligibleMailDomainsSchema = z.array(
  z.object({ domain: z.string(), primary: z.boolean(), aliases: z.boolean() }),
);

const mailAddressesSchema = z.object({
  actorId: z.string(),
  primaryEmail: z.string().nullable(),
  loginEmail: z.string().nullable().default(null),
  eligibleDomains: eligibleMailDomainsSchema,
  addresses: z.array(
    z.object({
      id: z.string().nullable(),
      address: z.string().email(),
      displayName: z.string().nullable(),
      isPrimary: z.boolean(),
      receiveEnabled: z.boolean(),
      sendAsEnabled: z.boolean(),
      source: z.enum(["primary", "alias", "domain_alias"]),
    }),
  ),
});
export type MailAddresses = z.infer<typeof mailAddressesSchema>;
export type MailSendingAddress = MailAddresses["addresses"][number];
export interface MailAddressOptions {
  readonly receiveEnabled?: boolean;
  readonly sendAsEnabled?: boolean;
}
export const mailAddressQueryKeys = {
  current: ["mail", "addresses"] as const,
  byActor: (actorId: string) => ["admin", "users", actorId, "addresses"] as const,
};
function addressPath(actorId?: string) {
  return actorId === undefined
    ? "/api/mail/addresses"
    : `/api/admin/users/${encodeURIComponent(actorId)}/addresses`;
}
async function requestAddresses(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<MailAddresses> {
  const response = await authenticatedFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response, output, "Load mail addresses");
  const result = mailAddressesSchema.safeParse(output);
  if (!result.success) throw new Error("Mail addresses returned an invalid response. Try again.");
  return result.data;
}
export function mailAddressesQueryOptions(actorId?: string) {
  return queryOptions({
    queryKey:
      actorId === undefined ? mailAddressQueryKeys.current : mailAddressQueryKeys.byActor(actorId),
    queryFn: () => requestAddresses(addressPath(actorId)),
    staleTime: 30_000,
    throwOnError: false,
  });
}
export function addMailAddress(
  actorId: string,
  input: { readonly address: string } & MailAddressOptions,
) {
  return requestAddresses(addressPath(actorId), "POST", input);
}
export function updateMailAddress(actorId: string, id: string, input: MailAddressOptions) {
  return requestAddresses(`${addressPath(actorId)}/${encodeURIComponent(id)}`, "PATCH", input);
}
export function removeMailAddress(actorId: string, id: string) {
  return requestAddresses(`${addressPath(actorId)}/${encodeURIComponent(id)}`, "DELETE");
}
export function setPrimaryMailAddress(actorId: string, address: string) {
  return requestAddresses(`${addressPath(actorId)}/primary`, "PUT", { address });
}
