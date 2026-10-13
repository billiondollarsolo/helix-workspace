import { createOutboundHttpClient } from "../outbound-http.js";

/**
 * Fetch for the operator-configured platform object store.
 *
 * The default outbound guard refuses single-label hosts and private addresses,
 * which is right for tenant-supplied (BYO) endpoints but makes a bundled
 * `https://rustfs:9000` unreachable. The platform endpoint comes from operator
 * configuration, not from a tenant, so exactly that host may be private. Plain
 * HTTP stays limited to non-production by the Drive configuration.
 */
export function operatorStorageFetch(endpoint: string): typeof fetch {
  const url = new URL(endpoint);
  return createOutboundHttpClient({
    allowedHosts: [url.hostname],
    allowHttp: url.protocol === "http:",
    allowPrivateNetwork: true,
  });
}
