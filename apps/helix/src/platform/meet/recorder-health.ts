import { createOutboundHttpClient } from "../outbound-http.js";

interface JibriHealthPayload {
  readonly status?: {
    readonly busyStatus?: unknown;
    readonly health?: { readonly healthStatus?: unknown };
  };
}

/** Returns a bounded live check; absence or any malformed/unhealthy response is unavailable. */
export function createJibriRecorderHealthCheck(
  healthUrl: string,
  fetchImpl?: typeof fetch,
): () => Promise<boolean> {
  const url = new URL(healthUrl);
  const request =
    fetchImpl ??
    createOutboundHttpClient({
      allowHttp: url.protocol === "http:",
      allowPrivateNetwork: true,
      allowedHosts: [url.hostname],
      timeoutMs: 2_000,
      maxResponseBytes: 16 * 1024,
      maxRedirects: 0,
    });
  return async () => {
    try {
      const response = await request(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as JibriHealthPayload;
      return (
        payload.status?.health?.healthStatus === "HEALTHY" &&
        payload.status.busyStatus === "IDLE"
      );
    } catch {
      return false;
    }
  };
}
