import { describe, expect, it } from "vitest";
import {
  evaluateInboundAuthenticationPolicy,
  parseInboundAuthenticationPolicy,
  type InboundAuthenticationVerdict,
} from "./inbound-policy.js";

const defaults = parseInboundAuthenticationPolicy({});

function verdict(
  overrides: Partial<InboundAuthenticationVerdict> = {},
): InboundAuthenticationVerdict {
  return {
    spf: "fail",
    dkim: "fail",
    dmarc: "fail",
    arc: "none",
    evidence: {
      dmarc: {
        policy: "reject",
        pct: 100,
        alignment: { spf: { result: null }, dkim: { result: null } },
      },
    },
    ...overrides,
  };
}

describe("inbound authentication policy vectors", () => {
  it("allows DMARC only when mailauth reports an aligned SPF or DKIM identity", () => {
    const aligned = verdict({
      spf: "pass",
      dmarc: "pass",
      evidence: {
        dmarc: {
          policy: "reject",
          alignment: { spf: { result: "sender.example" }, dkim: { result: null } },
        },
      },
    });
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: aligned,
        fromAddress: "sender@sender.example",
        policy: defaults,
        sample: 0,
      }),
    ).toEqual({ disposition: "allow", reasons: [] });

    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict({ dmarc: "pass" }),
        fromAddress: "spoof@sender.example",
        policy: defaults,
        sample: 0,
      }),
    ).toEqual({ disposition: "reject", reasons: ["dmarc-reject"] });
  });

  it.each([
    ["reject", 100, 0, "reject", "dmarc-reject"],
    ["quarantine", 100, 0, "quarantine", "dmarc-quarantine"],
    ["reject", 25, 24, "reject", "dmarc-reject"],
    ["reject", 25, 25, "tag", "dmarc-pct-not-applied"],
    ["none", 100, 0, "tag", "dmarc-none"],
  ] as const)(
    "applies published DMARC p=%s pct=%i at sample %i as %s",
    (policy, pct, sample, disposition, reason) => {
      expect(
        evaluateInboundAuthenticationPolicy({
          auth: verdict({ evidence: { dmarc: { policy, pct } } }),
          fromAddress: "sender@example.test",
          policy: defaults,
          sample,
        }),
      ).toEqual({ disposition, reasons: [reason] });
    },
  );

  it("tags an ARC-authenticated forward instead of enforcing the original DMARC reject", () => {
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict({ arc: "pass" }),
        fromAddress: "sender@example.test",
        policy: defaults,
        sample: 0,
      }),
    ).toEqual({ disposition: "tag", reasons: ["arc-forwarding-override"] });
  });

  it("uses tenant block rules before allow rules and applies them to subdomains", () => {
    const policy = parseInboundAuthenticationPolicy({
      allowDomains: ["trusted.example"],
      blockDomains: ["blocked.trusted.example"],
    });
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict(),
        fromAddress: "sender@child.blocked.trusted.example",
        policy,
        sample: 0,
      }),
    ).toEqual({ disposition: "reject", reasons: ["sender-domain-blocklisted"] });
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict(),
        fromAddress: "sender@trusted.example",
        policy,
        sample: 0,
      }),
    ).toEqual({ disposition: "tag", reasons: ["allowlisted-dmarc-failure"] });
  });

  it("takes the strongest configured impersonation, lookalike, and URL verdict action", () => {
    const policy = parseInboundAuthenticationPolicy({ suspiciousUrlAction: "tag" });
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict({ spf: "pass", dkim: "pass", dmarc: "pass", evidence: {} }),
        fromAddress: "sender@example.test",
        policy,
        threats: { impersonation: true, lookalike: true, url: "malicious" },
        sample: 0,
      }),
    ).toEqual({ disposition: "reject", reasons: ["malicious-url"] });
    expect(
      evaluateInboundAuthenticationPolicy({
        auth: verdict({ spf: "pass", dkim: "pass", dmarc: "pass", evidence: {} }),
        fromAddress: "sender@example.test",
        policy,
        threats: { url: "suspicious" },
        sample: 0,
      }),
    ).toEqual({ disposition: "tag", reasons: ["suspicious-url"] });
  });
});
