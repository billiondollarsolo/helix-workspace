/* The static half of admin search: every page and the settings on it, so an
 * administrator can type "dkim" or "legal hold" and land on the right page and
 * tab. Users and groups come from the directory APIs instead. */

import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ROOT,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";

export interface AdminSettingEntry {
  /** What the result says. */
  readonly title: string;
  /** Where it lives, e.g. "Apps › Mail". */
  readonly location: string;
  readonly section: AdminSectionId;
  readonly tab?: string;
  /** Other words people use for it. */
  readonly keywords: readonly string[];
}

/** Settings and panels inside pages, with the words people search for. */
const SETTINGS: readonly Omit<AdminSettingEntry, "location">[] = [
  {
    title: "Send mail outside the organization",
    section: "mail",
    keywords: ["outbound", "external", "sending"],
  },
  {
    title: "Outbound providers",
    section: "mail",
    tab: "providers",
    keywords: ["smtp", "ses", "mailgun", "postmark", "relay", "sending service"],
  },
  {
    title: "Mail domains",
    section: "mail",
    tab: "domains",
    keywords: ["dkim", "spf", "sending domain", "dns"],
  },
  {
    title: "Deliverability",
    section: "mail",
    tab: "deliverability",
    keywords: ["dmarc", "reports", "spam rate", "bounces"],
  },
  {
    title: "Routing rules",
    section: "mail",
    tab: "routing",
    keywords: ["forwarding", "inbound", "rewrite", "route"],
  },
  {
    title: "Mail operations",
    section: "mail",
    tab: "operations",
    keywords: ["dead letter", "suppressions", "bounce", "journal", "delivery trace"],
  },
  {
    title: "Spam filtering",
    section: "mail",
    tab: "spam",
    keywords: ["spamd", "junk", "threshold", "quarantine", "phishing", "ai decision model"],
  },
  {
    title: "S3-compatible access",
    section: "drive",
    keywords: ["s3", "access keys", "rclone", "aws cli", "api"],
  },
  { title: "Drive storage", section: "drive", keywords: ["usage", "quota", "space"] },
  {
    title: "Trash and cleanup",
    section: "drive",
    keywords: ["trash retention", "orphan", "lifecycle", "delete"],
  },
  {
    title: "Message retention",
    section: "chat",
    keywords: ["retention", "history", "delete messages"],
  },
  { title: "Legal hold", section: "chat", keywords: ["hold", "ediscovery", "preserve"] },
  { title: "Chat exports", section: "chat", keywords: ["export", "download messages"] },
  {
    title: "Import calendar invitations from email",
    section: "calendar",
    keywords: ["ics", "invites", "invitation import"],
  },
  { title: "Meeting server", section: "meet", keywords: ["jitsi", "video", "conference", "jwt"] },
  {
    title: "Assistant models",
    section: "assistant",
    tab: "models",
    keywords: ["ai providers", "openai", "llm", "model", "api key"],
  },
  {
    title: "Assistant searches workspace content",
    section: "assistant",
    tab: "search",
    keywords: ["retrieval", "rag", "semantic search", "embeddings", "web search", "reindex"],
  },
  {
    title: "Turn apps on or off",
    section: "workspace-apps",
    keywords: ["enable", "disable", "service status"],
  },
  {
    title: "Multi-factor authentication",
    section: "policies",
    keywords: ["mfa", "2fa", "two-step", "two factor"],
  },
  {
    title: "External sharing",
    section: "policies",
    keywords: ["sharing", "outside", "dlp", "data protection"],
  },
  { title: "Session length", section: "policies", keywords: ["timeout", "sign out", "idle"] },
  {
    title: "Single sign-on",
    section: "identity",
    keywords: ["sso", "saml", "oidc", "identity provider", "idp"],
  },
  { title: "User provisioning", section: "identity", keywords: ["scim", "sync", "directory sync"] },
  {
    title: "Organization name and ID",
    section: "workspace-settings",
    keywords: ["tenant", "org id", "profile"],
  },
  {
    title: "Branding",
    section: "workspace-settings",
    keywords: ["logo", "color", "accent", "display name", "custom domain"],
  },
  {
    title: "Limits",
    section: "workspace-settings",
    keywords: ["quota", "storage limit", "rate limit", "accounts"],
  },
  {
    title: "Bring your own storage",
    section: "workspace-settings",
    keywords: ["byo", "bucket", "s3", "migration", "kms"],
  },
  {
    title: "Domain verification",
    section: "domains",
    keywords: ["dns", "txt record", "verify", "primary domain"],
  },
  {
    title: "HTTPS certificate",
    section: "domains",
    keywords: ["tls", "ssl", "certificate", "https", "let's encrypt", "expiry", "renew"],
  },
  {
    title: "Outbound webhooks",
    section: "webhooks",
    tab: "outbound",
    keywords: ["webhook", "events", "callback"],
  },
  {
    title: "Inbound webhooks",
    section: "webhooks",
    tab: "inbound",
    keywords: ["webhook", "receiver"],
  },
  {
    title: "Webhook deliveries",
    section: "webhooks",
    tab: "deliveries",
    keywords: ["retries", "replay", "failed deliveries"],
  },
  {
    title: "Service health",
    section: "services",
    keywords: ["status", "dependencies", "readiness", "uptime"],
  },
  {
    title: "Agent kill switch",
    section: "agent-controls",
    keywords: ["emergency", "stop agents", "disable agents"],
  },
  {
    title: "AI spending limits",
    section: "ai-costs",
    keywords: ["budget", "cost", "spend", "usd"],
  },
  { title: "Audit log", section: "audit", keywords: ["activity", "events", "history", "who did"] },
];

const LOCATION = new Map<AdminSectionId, string>([
  [ADMIN_NAV_ROOT.id, ADMIN_NAV_ROOT.label],
  ...ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item): [AdminSectionId, string] => [
      item.id,
      `${group.title} › ${item.label}`,
    ]),
  ),
]);

/** Every page, then every setting, in nav order. */
export const ADMIN_SEARCH_INDEX: readonly AdminSettingEntry[] = [
  {
    title: ADMIN_NAV_ROOT.label,
    location: "Admin",
    section: ADMIN_NAV_ROOT.id,
    keywords: ["overview", "dashboard"],
  },
  ...ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item): AdminSettingEntry => ({
      title: item.label,
      location: group.title,
      section: item.id,
      keywords: [],
    })),
  ),
  ...SETTINGS.map((entry) => ({ ...entry, location: LOCATION.get(entry.section) ?? "" })),
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** How well an entry matches: title prefix beats title word beats keyword. 0 = no match. */
function score(entry: AdminSettingEntry, query: string): number {
  const title = normalize(entry.title);
  if (title.startsWith(query)) return 4;
  if (title.split(" ").some((word) => word.startsWith(query)) || title.includes(query)) return 3;
  if (entry.keywords.some((keyword) => normalize(keyword).includes(query))) return 2;
  if (normalize(entry.location).includes(query)) return 1;
  return 0;
}

/** Settings and pages matching `text`, best first. */
export function searchAdminSettings(text: string, limit = 6): readonly AdminSettingEntry[] {
  const query = normalize(text);
  if (query.length === 0) {
    return [];
  }
  return ADMIN_SEARCH_INDEX.map((entry, index) => ({ entry, index, score: score(entry, query) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((match) => match.entry);
}
