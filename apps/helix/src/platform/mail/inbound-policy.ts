import type { JsonObject, JsonValue } from "@helix/sdk-types";
import { z } from "zod";

type InboundPolicyDisposition = "reject" | "quarantine" | "tag";

const disposition = z.enum(["reject", "quarantine", "tag"]);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

export const inboundAuthenticationPolicySchema = z
  .object({
    allowDomains: z.array(domain).max(500).default([]),
    blockDomains: z.array(domain).max(500).default([]),
    blocklistAction: disposition.default("reject"),
    impersonationAction: disposition.default("quarantine"),
    lookalikeAction: disposition.default("quarantine"),
    suspiciousUrlAction: disposition.default("tag"),
    maliciousUrlAction: disposition.default("reject"),
  })
  .strict();

export type InboundAuthenticationPolicy = z.output<typeof inboundAuthenticationPolicySchema>;

export interface InboundThreatVerdicts {
  readonly impersonation?: boolean;
  readonly lookalike?: boolean;
  readonly url?: "unknown" | "clean" | "suspicious" | "malicious";
}

export interface InboundAuthenticationVerdict {
  readonly spf: string;
  readonly dkim: string;
  readonly dmarc: string;
  readonly arc: string;
  readonly evidence?: JsonObject;
}

export interface InboundPolicyDecision {
  readonly disposition: "allow" | InboundPolicyDisposition;
  readonly reasons: readonly string[];
}

export function parseInboundAuthenticationPolicy(value: unknown): InboundAuthenticationPolicy {
  return inboundAuthenticationPolicySchema.parse(value ?? {});
}

export function evaluateInboundAuthenticationPolicy(input: {
  readonly auth: InboundAuthenticationVerdict;
  readonly fromAddress: string;
  readonly policy: InboundAuthenticationPolicy;
  readonly threats?: InboundThreatVerdicts;
  /** Stable 0-99 sample used for published DMARC pct enforcement. */
  readonly sample: number;
}): InboundPolicyDecision {
  const senderDomain = addressDomain(input.fromAddress);
  if (matchesDomain(senderDomain, input.policy.blockDomains)) {
    return decision(input.policy.blocklistAction, "sender-domain-blocklisted");
  }

  const threat = strongestThreat(input.policy, input.threats);
  if (threat !== null) return threat;

  const allowlisted = matchesDomain(senderDomain, input.policy.allowDomains);
  const dmarc = record(input.auth.evidence?.dmarc);
  const alignment = record(dmarc?.alignment);
  const alignmentKnown = alignment?.spf !== undefined || alignment?.dkim !== undefined;
  const aligned = alignedDomain(alignment?.spf) || alignedDomain(alignment?.dkim);
  const dmarcFailed = input.auth.dmarc === "fail" || (alignmentKnown && !aligned);
  if (dmarcFailed) {
    if (allowlisted) return decision("tag", "allowlisted-dmarc-failure");
    if (input.auth.arc === "pass") return decision("tag", "arc-forwarding-override");
    const pct = dmarcPct(dmarc?.pct);
    if (input.sample >= pct) return decision("tag", "dmarc-pct-not-applied");
    const policy = stringValue(dmarc?.policy) ?? stringValue(dmarc?.organizationalPolicy);
    return decision(
      policy === "reject" ? "reject" : policy === "quarantine" ? "quarantine" : "tag",
      `dmarc-${policy ?? "none"}`,
    );
  }
  if (input.auth.dmarc === "temperror" || input.auth.dmarc === "permerror") {
    return decision("quarantine", `dmarc-${input.auth.dmarc}`);
  }
  if (input.auth.dmarc !== "pass" && (input.auth.spf === "fail" || input.auth.dkim === "fail")) {
    return decision("tag", "unaligned-authentication-failure");
  }
  return { disposition: "allow", reasons: [] };
}

function strongestThreat(
  policy: InboundAuthenticationPolicy,
  threats: InboundThreatVerdicts | undefined,
): InboundPolicyDecision | null {
  const candidates: InboundPolicyDecision[] = [];
  if (threats?.impersonation === true) {
    candidates.push(decision(policy.impersonationAction, "impersonation"));
  }
  if (threats?.lookalike === true) {
    candidates.push(decision(policy.lookalikeAction, "lookalike-domain"));
  }
  if (threats?.url === "malicious") {
    candidates.push(decision(policy.maliciousUrlAction, "malicious-url"));
  } else if (threats?.url === "suspicious") {
    candidates.push(decision(policy.suspiciousUrlAction, "suspicious-url"));
  }
  return (
    candidates.sort((left, right) => severity(right.disposition) - severity(left.disposition))[0] ??
    null
  );
}

function decision(disposition: InboundPolicyDisposition, reason: string): InboundPolicyDecision {
  return { disposition, reasons: [reason] };
}

function severity(disposition: InboundPolicyDecision["disposition"]): number {
  return disposition === "reject"
    ? 3
    : disposition === "quarantine"
      ? 2
      : disposition === "tag"
        ? 1
        : 0;
}

function addressDomain(address: string): string {
  const separator = address.lastIndexOf("@");
  return separator < 0
    ? ""
    : address
        .slice(separator + 1)
        .toLowerCase()
        .replace(/\.$/u, "");
}

function matchesDomain(domain: string, rules: readonly string[]): boolean {
  return rules.some((rule) => domain === rule || domain.endsWith(`.${rule}`));
}

function alignedDomain(value: JsonValue | undefined): boolean {
  const result = stringValue(record(value)?.result);
  return result !== undefined && result.length > 0;
}

function dmarcPct(value: JsonValue | undefined): number {
  return typeof value === "number" && value >= 0 && value <= 100 ? value : 100;
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}
