import { authenticatedFetch } from "./auth";
import { responseError } from "./tool-call";

/** Forward only the provider-declared signed fields; verification stays on the server. */
export function familyAuthorizationQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig") || params.getAll("ba_param").length === 0) return undefined;
  const names = new Set([...params.getAll("ba_param"), "sig", "ba_param"]);
  const signed = new URLSearchParams();
  for (const [key, value] of params) if (names.has(key)) signed.append(key, value);
  return signed.toString();
}

/** Resume only after normal authentication has recorded password/MFA assurance. */
export async function resumeFamilySignIn(): Promise<void> {
  const query = familyAuthorizationQuery(window.location.search);
  if (query === undefined) return;
  const response = await authenticatedFetch("/api/auth/oauth2/continue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postLogin: true, oauth_query: query }),
  });
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response, output, "Workspace sign-in");
  if (
    typeof output !== "object" ||
    output === null ||
    !("redirect" in output) ||
    output.redirect !== true ||
    !("url" in output) ||
    typeof output.url !== "string"
  )
    throw new Error("Workspace sign-in did not return an application destination. Try again.");
  const target = new URL(output.url, window.location.origin);
  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  )
    throw new Error("Workspace sign-in returned an insecure destination.");
  window.location.assign(target.href);
  await new Promise<never>(() => undefined);
}
