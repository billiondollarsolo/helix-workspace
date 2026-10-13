import { normalizeMailboxAddress, normalizeMailDomain } from "../address-normalization.js";

/**
 * Who may write to an agent's mailbox from outside the organization.
 *
 * An agent reads its mail and acts on it, so a message is a way to instruct
 * it. This policy is evaluated by Helix before the message is stored for the
 * agent; the agent never sees mail that fails it and cannot change the policy.
 */

export const AGENT_MAIL_RECEIVE_MODES = ["allowed_senders", "anyone"] as const;
export type AgentMailReceiveMode = (typeof AGENT_MAIL_RECEIVE_MODES)[number];

export interface AgentMailPolicy {
  readonly receiveMode: AgentMailReceiveMode;
  /** Addresses (`ana@example.com`) and domains (`@example.com`). */
  readonly allowedSenders: readonly string[];
}

/** An agent no administrator has configured receives nothing from outside. */
export const DEFAULT_AGENT_MAIL_POLICY: AgentMailPolicy = {
  receiveMode: "allowed_senders",
  allowedSenders: [],
};

export const AGENT_MAIL_MAX_ALLOWED_SENDERS = 200;

type AgentMailHoldReason =
  "sender-not-allowed" | "sender-not-verified" | "instructs-the-agent" | "hidden-text";

/** Prefix of the quarantine signature for mail held by an agent's policy. */
export const AGENT_MAIL_HOLD_SIGNATURE_PREFIX = "agent-mail:";

/**
 * Canonical form of one allowed sender: an address, or `@domain` for everyone
 * at a domain. A bare domain is accepted and stored as `@domain`.
 */
export function normalizeAllowedSender(raw: string): string {
  const value = raw.trim().replace(/^mailto:/iu, "");
  if (value.includes("@") && !value.startsWith("@")) {
    return normalizeMailboxAddress(value).address;
  }
  return `@${normalizeMailDomain(value.replace(/^@/u, ""))}`;
}

function senderIsAllowed(fromAddress: string, allowedSenders: readonly string[]): boolean {
  const from = fromAddress.trim().toLowerCase();
  const at = from.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = from.slice(at);
  return allowedSenders.some((entry) => entry === from || entry === domain);
}

// A tripwire for the crudest attempts, not a defence: the sender list is what
// keeps strangers out. Phrases are kept narrow so ordinary mail is not held.
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:your\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|prompts?|rules|messages)\b/iu,
  /\boverride\s+(?:your\s+)?(?:instructions|rules|safety|policy|guardrails)\b/iu,
  /\bdo\s+not\s+(?:tell|inform|alert|notify)\s+(?:the\s+|your\s+)?(?:user|owner|operator|administrator|admin)\b/iu,
  /\b(?:reveal|print|repeat|show)\s+(?:me\s+)?(?:your\s+|the\s+)?system\s+prompt\b/iu,
];

// Bidirectional overrides reorder what a person reviewing the message sees
// while a model still reads the text in its stored order.
const HIDDEN_TEXT = /[\u202A-\u202E\u2066-\u2069]/u;

/**
 * Why a message from outside must not reach this agent, or an empty list when
 * it may. `dmarc` is the receiving server's own result for the message.
 */
export function agentMailHoldReasons(input: {
  readonly policy: AgentMailPolicy;
  readonly fromAddress: string;
  readonly dmarc: string;
  readonly subject: string;
  readonly text: string;
}): readonly AgentMailHoldReason[] {
  const reasons: AgentMailHoldReason[] = [];
  if (input.policy.receiveMode === "allowed_senders") {
    if (!senderIsAllowed(input.fromAddress, input.policy.allowedSenders)) {
      reasons.push("sender-not-allowed");
    } else if (input.dmarc !== "pass") {
      // A From address is only text. Without DMARC anyone can write a listed one.
      reasons.push("sender-not-verified");
    }
  }
  const content = `${input.subject}\n${input.text}`;
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(content))) {
    reasons.push("instructs-the-agent");
  }
  if (HIDDEN_TEXT.test(content)) reasons.push("hidden-text");
  return reasons;
}
