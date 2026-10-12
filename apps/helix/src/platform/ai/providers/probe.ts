import type { LLMProviderCapability } from "@helix/sdk-types";
import { bearerHeaders, discardResponseBody, type ProviderRequestConfig } from "./shared.js";

/**
 * What a provider's reachability probe found: it answered, it refused the
 * credentials Helix holds for it, or it could not be reached at all (connection
 * refused, DNS, outbound policy, timeout, or a server error).
 */
export type ProviderProbeResult = "reachable" | "rejected_credentials" | "unreachable";

/** An HTTP provider that can check its endpoint without spending tokens. */
export interface ProbeableLLMProvider extends LLMProviderCapability {
  probe(signal: AbortSignal): Promise<ProviderProbeResult>;
}

export function isProbeableProvider(
  provider: LLMProviderCapability,
): provider is ProbeableLLMProvider {
  return typeof (provider as Partial<ProbeableLLMProvider>).probe === "function";
}

/**
 * GETs a provider's model listing through the provider's own outbound client
 * (so the same host allowlist and private-network policy apply) and classifies
 * the outcome. Any non-auth 4xx still proves the endpoint answers: some
 * compatible servers do not implement the listing.
 */
export async function probeProviderEndpoint(
  url: URL,
  config: ProviderRequestConfig & { readonly signal: AbortSignal },
): Promise<ProviderProbeResult> {
  try {
    const response = await config.fetch(url, {
      method: "GET",
      headers: { ...bearerHeaders(config.apiKey), ...(config.headers ?? {}) },
      signal: config.signal,
    });
    await discardResponseBody(response);
    if (response.status === 401 || response.status === 403) return "rejected_credentials";
    return response.status >= 500 ? "unreachable" : "reachable";
  } catch {
    return "unreachable";
  }
}
