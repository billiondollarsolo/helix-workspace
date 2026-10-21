import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  adminConsoleReadScope,
  canReadAdminConsole,
  sendForbidden,
} from "../admin/console-shared.js";

/**
 * Admin → Domains → DNS and proxy. Web apps can sit behind an HTTP proxy such
 * as Cloudflare; mail and the Meet relay (TURN) carry protocols a proxy cannot
 * pass, so their records must point straight at the server. This resolves
 * each of the installation's hostnames and says whether its record is set the
 * way its purpose needs.
 */

export type DnsChecklistRole = "web" | "app" | "mail" | "turn";
export type DnsProxyMode = "proxied" | "dns-only";
export type DnsObserved = DnsProxyMode | "mixed" | "unresolved";
export type DnsChecklistStatus = "ok" | "recommend" | "problem";

export interface DnsChecklistTarget {
  readonly hostname: string;
  readonly role: DnsChecklistRole;
}

export interface DnsChecklistRow extends DnsChecklistTarget {
  readonly expected: DnsProxyMode;
  readonly observed: DnsObserved;
  readonly addresses: string[];
  readonly status: DnsChecklistStatus;
  readonly advice: string;
}

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). */
const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;
const CLOUDFLARE_IPV6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

const cloudflare = new BlockList();
for (const [ranges, family] of [
  [CLOUDFLARE_IPV4, "ipv4"],
  [CLOUDFLARE_IPV6, "ipv6"],
] as const) {
  for (const range of ranges) {
    const [network, prefix] = range.split("/");
    cloudflare.addSubnet(network ?? "", Number(prefix), family);
  }
}

/** True when `address` belongs to Cloudflare's proxy network. */
export function isCloudflareAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return cloudflare.check(address, family === 4 ? "ipv4" : "ipv6");
}

const ADVICE = {
  ok: "",
  mustBeDnsOnly: "Mail and TURN can’t pass through an HTTP proxy. Set this record to DNS-only.",
  shouldProxy: "Proxy this record and keep the origin locked to the proxy’s addresses.",
  unresolved: "This hostname doesn’t resolve.",
} as const;

/** Pure: what a hostname's record should be, what it is, and what to do about it. */
export function evaluateDnsChecklistRow(
  target: DnsChecklistTarget,
  addresses: readonly string[],
): DnsChecklistRow {
  const expected: DnsProxyMode =
    target.role === "mail" || target.role === "turn" ? "dns-only" : "proxied";
  const proxied = addresses.filter(isCloudflareAddress).length;
  const observed: DnsObserved =
    addresses.length === 0
      ? "unresolved"
      : proxied === addresses.length
        ? "proxied"
        : proxied === 0
          ? "dns-only"
          : "mixed";
  const [status, advice]: [DnsChecklistStatus, string] =
    observed === "unresolved"
      ? ["problem", ADVICE.unresolved]
      : expected === "dns-only"
        ? observed === "dns-only"
          ? ["ok", ADVICE.ok]
          : ["problem", ADVICE.mustBeDnsOnly]
        : observed === "dns-only"
          ? ["recommend", ADVICE.shouldProxy]
          : ["ok", ADVICE.ok];
  return { ...target, expected, observed, addresses: [...addresses], status, advice };
}

/**
 * One row per hostname. A hostname that serves both a web app and mail or
 * TURN keeps the stricter purpose, since a proxied record would break mail.
 */
export function dedupeDnsChecklistTargets(
  targets: readonly DnsChecklistTarget[],
): DnsChecklistTarget[] {
  const strict = (role: DnsChecklistRole) => role === "mail" || role === "turn";
  const byHost = new Map<string, DnsChecklistTarget>();
  for (const target of targets) {
    const hostname = target.hostname.trim().toLowerCase().replace(/\.$/u, "");
    if (hostname === "") continue;
    const existing = byHost.get(hostname);
    if (existing === undefined || (strict(target.role) && !strict(existing.role))) {
      byHost.set(hostname, { hostname, role: target.role });
    }
  }
  return [...byHost.values()];
}

export type DnsAddressResolver = (hostname: string) => Promise<string[]>;

/** A, then AAAA, with a short timeout. Lookup failures read as no addresses. */
export function createDnsAddressResolver(timeoutMs = 2_000): DnsAddressResolver {
  return async (hostname) => {
    if (isIP(hostname) !== 0) return [hostname];
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    const settled = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  };
}

export interface DnsChecklistRoutesOptions {
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  /** The installation's hostnames for this organization, in display order. */
  readonly targets: (actor: Actor) => Promise<readonly DnsChecklistTarget[]>;
  readonly resolve?: DnsAddressResolver;
}

export function registerDnsChecklistRoutes(
  app: FastifyInstance,
  options: DnsChecklistRoutesOptions,
): void {
  const resolve = options.resolve ?? createDnsAddressResolver();
  app.get("/api/admin/domains/dns-checklist", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.domains")) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const targets = dedupeDnsChecklistTargets(await options.targets(actor));
    const rows = await Promise.all(
      targets.map(async (target) =>
        evaluateDnsChecklistRow(target, await resolve(target.hostname).catch(() => [])),
      ),
    );
    return { rows };
  });
}
