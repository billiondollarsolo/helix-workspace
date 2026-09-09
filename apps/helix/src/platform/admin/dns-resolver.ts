import { Resolver, resolve4, resolve6, resolveNs } from "node:dns/promises";
import type { DnsRecordType, DnsResolver } from "./domains.js";

const missingDnsCodes = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP", "ENOTINITIALIZED"]);

/** Resolve records directly from the zone's authoritative name servers. */
export class AuthoritativeDnsResolver implements DnsResolver {
  async lookup(input: {
    readonly recordType: DnsRecordType;
    readonly host: string;
  }): Promise<readonly string[]> {
    const resolver = new Resolver({ timeout: 3_000, tries: 2 });
    resolver.setServers(await authorityAddresses(input.host));

    try {
      switch (input.recordType) {
        case "MX":
          return (await resolver.resolveMx(input.host)).map(
            ({ priority, exchange }) => `${String(priority)} ${exchange}`,
          );
        case "CNAME":
          return await resolver.resolveCname(input.host);
        case "A":
          return await resolver.resolve4(input.host);
        case "TXT":
        case "SPF":
        case "DKIM":
        case "DMARC":
          return (await resolver.resolveTxt(input.host)).map((chunks) => chunks.join(""));
      }
    } catch (error) {
      if (isMissingDnsRecord(error)) {
        return [];
      }
      throw error;
    }
  }
}

async function authorityAddresses(host: string): Promise<readonly string[]> {
  const labels = host.replace(/\.$/u, "").split(".");
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    try {
      const names = await resolveNs(labels.slice(offset).join("."));
      const addressGroups = await Promise.all(
        names.map(async (name) => {
          const [ipv4, ipv6] = await Promise.all([
            resolve4(name).catch(() => []),
            resolve6(name).catch(() => []),
          ]);
          return [...ipv4, ...ipv6];
        }),
      );
      const addresses = [...new Set(addressGroups.flat())];
      if (addresses.length > 0) {
        return addresses;
      }
    } catch (error) {
      if (!isMissingDnsRecord(error)) {
        throw error;
      }
    }
  }
  throw new Error(`No authoritative DNS servers found for ${host}.`);
}

function isMissingDnsRecord(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    missingDnsCodes.has(error.code)
  );
}
