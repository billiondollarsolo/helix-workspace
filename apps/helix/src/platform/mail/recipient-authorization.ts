import type { ToolContext } from "@helix/sdk-types";
/** Lower-cased domain portion of an email address, or "" when unparseable. */
function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * True when any recipient of a send/reply call addresses a domain outside the
 * configured internal-domain set. Used to gate the `mail.external` scope.
 */
export function hasExternalRecipient(
  input: { readonly to?: unknown; readonly cc?: unknown; readonly bcc?: unknown },
  internalDomains: ReadonlySet<string>,
): boolean {
  const recipients = [input.to, input.cc, input.bcc]
    .flatMap((group): unknown[] => (Array.isArray(group) ? (group as unknown[]) : []))
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry !== null && typeof entry === "object" && "address" in entry) {
        const address = (entry as { address?: unknown }).address;
        return typeof address === "string" ? address : "";
      }
      return "";
    })
    .filter((address) => address.length > 0);
  return recipients.some((address) => {
    const domain = addressDomain(address);
    return domain.length > 0 && !internalDomains.has(domain);
  });
}

export async function requireTenantMailRecipients(
  input: { readonly to?: unknown; readonly cc?: unknown; readonly bcc?: unknown },
  ctx: ToolContext,
  resolveDomains: ((orgId: string) => Promise<readonly string[]>) | undefined,
): Promise<void> {
  if (resolveDomains === undefined) return;
  const domains = new Set(
    (await resolveDomains(ctx.actor.orgId)).map((domain) => domain.toLowerCase()),
  );
  if (hasExternalRecipient(input, domains)) await ctx.requirePermission("mail.external");
}
