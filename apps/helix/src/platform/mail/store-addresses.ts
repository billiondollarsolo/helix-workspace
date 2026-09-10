import type { MailThreadMessage } from "./types.js";

export function mailAddress(value: unknown): MailThreadMessage["from"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.address === "string"
    ? {
        address: record.address,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      }
    : undefined;
}

export function mailAddressArray(
  value: unknown,
): readonly NonNullable<MailThreadMessage["from"]>[] {
  return Array.isArray(value)
    ? value
        .map(mailAddress)
        .filter(
          (address): address is NonNullable<MailThreadMessage["from"]> => address !== undefined,
        )
    : [];
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function stringMetadata(value: unknown): string {
  return typeof value === "string" ? value : "";
}
