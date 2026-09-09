import { describe, expect, it } from "vitest";
import { NodeDnsResolver, type DnsLookups } from "./dns-resolver.js";

/** A resolver whose answers are fixed; unstubbed methods reject as "no record". */
function resolverWith(answers: Partial<DnsLookups>): NodeDnsResolver {
  const absent = <T>(): Promise<T> =>
    Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
  return new NodeDnsResolver({
    resolveTxt: answers.resolveTxt ?? absent,
    resolveMx: answers.resolveMx ?? absent,
    resolveCname: answers.resolveCname ?? absent,
    resolve4: answers.resolve4 ?? absent,
  });
}

describe("NodeDnsResolver", () => {
  it("reassembles a TXT value split across 255-byte chunks", async () => {
    // A long DKIM key arrives chunked; the record is their concatenation, so
    // returning only the first chunk would fail every real DKIM verification.
    const resolver = resolverWith({
      resolveTxt: () => Promise.resolve([["v=DKIM1; k=rsa; p=MIGfMA0G", "CSqGSIb3DQEBAQUAA4GN"]]),
    });

    await expect(
      resolver.lookup({ recordType: "DKIM", host: "s1._domainkey.helix.io" }),
    ).resolves.toBe("v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN");
  });

  it("picks the policy record out of a host's other TXT records", async () => {
    /* The reason the resolver cannot just return answers[0]: a domain
       routinely carries a verification token beside its SPF policy, and which
       one comes back first is not defined. */
    const resolver = resolverWith({
      resolveTxt: () =>
        Promise.resolve([
          ["google-site-verification=abc123"],
          ["v=spf1 include:helix.io ~all"],
          ["stripe-verification=xyz"],
        ]),
    });

    await expect(resolver.lookup({ recordType: "SPF", host: "helix.io" })).resolves.toBe(
      "v=spf1 include:helix.io ~all",
    );
  });

  it("reports no SPF record rather than an unrelated TXT value", async () => {
    // Handing back a verification token as though it were an SPF policy would
    // tell the operator their SPF is wrong; the truth is there is not one.
    const resolver = resolverWith({
      resolveTxt: () => Promise.resolve([["google-site-verification=abc123"]]),
    });

    await expect(resolver.lookup({ recordType: "SPF", host: "helix.io" })).resolves.toBeNull();
  });

  it("selects the matching answer for an untyped TXT record", async () => {
    const resolver = resolverWith({
      resolveTxt: () => Promise.resolve([["other=1"], ["helix-verification=token-2"]]),
    });

    await expect(
      resolver.lookup({
        recordType: "TXT",
        host: "helix.io",
        expectedValue: "helix-verification=token-2",
      }),
    ).resolves.toBe("helix-verification=token-2");
  });

  it("returns an answer that does not match, so the route can fail it honestly", async () => {
    /* Selection must not become a verdict: when nothing matches, the operator
       needs to SEE what is actually published to fix it. */
    const resolver = resolverWith({
      resolveTxt: () => Promise.resolve([["helix-verification=stale-token"]]),
    });

    await expect(
      resolver.lookup({
        recordType: "TXT",
        host: "helix.io",
        expectedValue: "helix-verification=new",
      }),
    ).resolves.toBe("helix-verification=stale-token");
  });

  it("renders MX as priority and host, and matches the expected entry", async () => {
    const resolver = resolverWith({
      resolveMx: () =>
        Promise.resolve([
          { priority: 20, exchange: "mx2.helix.io." },
          { priority: 10, exchange: "mx1.helix.io." },
        ]),
    });

    // Trailing dot is the wire form; an operator types the hostname without it.
    await expect(
      resolver.lookup({ recordType: "MX", host: "helix.io", expectedValue: "10 mx1.helix.io" }),
    ).resolves.toBe("10 mx1.helix.io");
  });

  it("normalises case and whitespace when selecting", async () => {
    const resolver = resolverWith({
      resolveMx: () => Promise.resolve([{ priority: 10, exchange: "MX1.Helix.IO." }]),
    });

    await expect(
      resolver.lookup({ recordType: "MX", host: "helix.io", expectedValue: "10   mx1.helix.io" }),
    ).resolves.toBe("10 MX1.Helix.IO");
  });

  it("strips the trailing dot from a CNAME target", async () => {
    const resolver = resolverWith({
      resolveCname: () => Promise.resolve(["target.helix.io."]),
    });

    await expect(resolver.lookup({ recordType: "CNAME", host: "www.helix.io" })).resolves.toBe(
      "target.helix.io",
    );
  });

  it("resolves an A record", async () => {
    const resolver = resolverWith({ resolve4: () => Promise.resolve(["203.0.113.10"]) });

    await expect(resolver.lookup({ recordType: "A", host: "helix.io" })).resolves.toBe(
      "203.0.113.10",
    );
  });

  it.each(["ENODATA", "ENOTFOUND"])("treats %s as a missing record, not a fault", async (code) => {
    const resolver = resolverWith({
      resolveTxt: () => Promise.reject(Object.assign(new Error(code), { code })),
    });

    await expect(resolver.lookup({ recordType: "TXT", host: "helix.io" })).resolves.toBeNull();
  });

  it("propagates a resolver failure instead of reporting the record missing", async () => {
    /* SERVFAIL means we could not look, which is not the same as the record
       being absent. Collapsing it to null would tell an operator their DNS is
       misconfigured when the real problem is ours. */
    const resolver = resolverWith({
      resolveTxt: () => Promise.reject(Object.assign(new Error("SERVFAIL"), { code: "SERVFAIL" })),
    });

    await expect(resolver.lookup({ recordType: "TXT", host: "helix.io" })).rejects.toThrow(
      "SERVFAIL",
    );
  });

  it("treats an empty answer set as a missing record", async () => {
    const resolver = resolverWith({ resolveMx: () => Promise.resolve([]) });

    await expect(resolver.lookup({ recordType: "MX", host: "helix.io" })).resolves.toBeNull();
  });
});
