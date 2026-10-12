/* A random RFC 4122 v4 UUID that also works outside secure contexts.

   `crypto.randomUUID` only exists on HTTPS and localhost, so a workspace
   opened over plain HTTP on a LAN address would throw wherever the app needs
   an id (composing mail, rendering HTML mail, joining a meeting). Fall back to
   `crypto.getRandomValues`, which every context provides. */

export function randomId(): string {
  // eslint-disable-next-line no-restricted-properties -- the one sanctioned use
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
