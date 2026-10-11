/* General access for a file: who can open it with a link. Helix maps the
   three Drive choices onto governed share links — no link is Restricted, a
   link limited to the viewer's email domain is "Anyone at <domain>", and an
   unrestricted link is "Anyone with the link" (always view-only). */
import type { DriveShareLink } from "./api";

export type DriveGeneralAccess = "restricted" | "domain" | "anyone";

/** Links that still open: not revoked, not expired, not used up. */
export function activeShareLinks(
  links: readonly DriveShareLink[],
  now: number = Date.now(),
): DriveShareLink[] {
  return links.filter(
    (link) =>
      link.revokedAt === null &&
      (link.expiresAt === null || new Date(link.expiresAt).getTime() > now) &&
      !(link.oneTime && link.consumedAt !== null),
  );
}

export function generalAccessFromLinks(
  links: readonly DriveShareLink[],
  now: number = Date.now(),
): DriveGeneralAccess {
  const active = activeShareLinks(links, now);
  if (active.length === 0) return "restricted";
  return active.some((link) => link.allowedDomains.length === 0) ? "anyone" : "domain";
}

export function emailDomain(email: string | null | undefined): string | null {
  const domain = email?.split("@").at(-1)?.trim().toLowerCase();
  return domain === undefined || domain.length === 0 || domain === email ? null : domain;
}

export function generalAccessOptions(domain: string | null): ReadonlyArray<{
  readonly value: DriveGeneralAccess;
  readonly label: string;
  readonly description: string;
}> {
  return [
    {
      value: "restricted",
      label: "Restricted",
      description: "Only people with access can open it",
    },
    ...(domain === null
      ? []
      : [
          {
            value: "domain" as const,
            label: `Anyone at ${domain}`,
            description: `Anyone signed in with a ${domain} account who has the link can view`,
          },
        ]),
    {
      value: "anyone",
      label: "Anyone with the link",
      description: "Anyone on the internet with the link can view",
    },
  ];
}
