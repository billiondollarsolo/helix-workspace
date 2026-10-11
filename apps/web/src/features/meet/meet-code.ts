/* Meeting codes, read where the route validates `/meet?code=…`. Kept free of
   other imports so the route's search parsing stays out of the Meet bundle. */

/** Meeting codes look like `abcd-efgh-ijkl`. */
const CODE_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u;

/**
 * Reads a meeting code from what someone typed or pasted: a bare code, or a
 * Helix link carrying `?code=`. Returns null when neither is present.
 */
export function parseMeetCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (/^https?:\/\//iu.test(trimmed) || trimmed.startsWith("/")) {
    try {
      const url = new URL(trimmed, "https://helix.invalid");
      candidate = url.searchParams.get("code") ?? "";
    } catch {
      return null;
    }
  }
  const code = candidate.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}
