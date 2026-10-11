/* What an app password is for, in the words people use, mapped to the scopes
   Helix checks. Each protocol endpoint accepts its product scopes or its
   protocol alias (smtp, caldav, carddav, webdav); a purpose is offered only when the
   person holds at least one of its scopes. */

import { apiPath } from "@/lib/auth";

export interface AppPasswordPurpose {
  readonly id: "mail" | "calendar" | "contacts" | "files";
  readonly label: string;
  readonly protocol: string;
  readonly scopes: readonly string[];
}

const APP_PASSWORD_PURPOSES: readonly AppPasswordPurpose[] = [
  {
    id: "mail",
    label: "Send mail from a mail app",
    protocol: "SMTP",
    scopes: ["mail.send", "mail.external", "smtp"],
  },
  {
    id: "calendar",
    label: "Sync your calendar",
    protocol: "CalDAV",
    scopes: ["calendar.read", "calendar.write", "caldav"],
  },
  {
    id: "contacts",
    label: "Sync your contacts",
    protocol: "CardDAV",
    scopes: ["contacts.read", "contacts.write", "carddav.read", "carddav.write"],
  },
  {
    id: "files",
    label: "Sync your files",
    protocol: "WebDAV",
    scopes: ["drive.read", "drive.write", "drive.delete", "webdav"],
  },
];

/** Purposes the person can grant, each limited to the scopes they hold. */
export function grantablePurposes(grantable: readonly string[]): readonly AppPasswordPurpose[] {
  const held = new Set(grantable);
  return APP_PASSWORD_PURPOSES.flatMap((purpose) => {
    const scopes = purpose.scopes.filter((scope) => held.has(scope));
    return scopes.length === 0 ? [] : [{ ...purpose, scopes }];
  });
}

/** The purposes an existing password's scopes cover. */
export function purposesForScopes(scopes: readonly string[]): readonly AppPasswordPurpose[] {
  return APP_PASSWORD_PURPOSES.filter((purpose) =>
    purpose.scopes.some((scope) => scopes.includes(scope)),
  );
}

export interface SetupHint {
  readonly purpose: AppPasswordPurpose;
  readonly server: string;
}

/** Where each purpose connects. SMTP submission uses implicit TLS on the
 *  mail host your administrator configures, so only the port is known here. */
export function setupHints(purposes: readonly AppPasswordPurpose[], origin: string): SetupHint[] {
  return purposes.map((purpose) => ({
    purpose,
    server:
      purpose.id === "mail"
        ? "Your organization’s mail server, port 465 with SSL/TLS (ask your administrator for the host name)"
        : `${origin}${apiPath(
            purpose.id === "calendar"
              ? "/dav/cal/"
              : purpose.id === "contacts"
                ? "/dav/card/"
                : "/dav/files/",
          )}`,
  }));
}
