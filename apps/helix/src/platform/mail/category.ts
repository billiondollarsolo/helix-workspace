/**
 * Mail category-tab classification.
 *
 * The Mail UI groups inbox threads into four category tabs — Primary, Updates,
 * Promotions, and Social. Classification is a derived, heuristic signal: it is
 * computed from a message's sender, subject, and (optionally) body, and cached
 * on the per-actor `mail_thread_state.category` column so the thread-list
 * projection stays a single indexed query.
 *
 * The heuristic is deterministic and dependency-free so it can run on ingest
 * and inside tests without a model call. `mail.message` classification (the
 * sensitivity label) is a separate concern handled by the resource classifier.
 */

export const MAIL_CATEGORY_TABS = ["primary", "updates", "promotions", "social"] as const;

export type MailCategoryTab = (typeof MAIL_CATEGORY_TABS)[number];

export interface MailCategorySignal {
  /** Sender email address (e.g. `notifications@github.com`). */
  readonly fromAddress?: string | null | undefined;
  /** Sender display name (e.g. `GitHub`). */
  readonly fromName?: string | null | undefined;
  /** Message subject line. */
  readonly subject?: string | null | undefined;
  /** Whether the message carries a `List-Unsubscribe` header. */
  readonly hasListUnsubscribe?: boolean | undefined;
}

const SOCIAL_DOMAINS = new Set([
  "linkedin.com",
  "facebook.com",
  "facebookmail.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "mastodon.social",
  "threads.net",
  "meetup.com",
  "nextdoor.com",
]);

const UPDATES_DOMAINS = new Set([
  "github.com",
  "gitlab.com",
  "stripe.com",
  "linear.app",
  "atlassian.net",
  "pagerduty.com",
  "datadoghq.com",
  "sentry.io",
  "calendly.com",
  "docusign.net",
  "amazonaws.com",
]);

/** Local-parts that strongly indicate an automated / transactional sender. */
const AUTOMATED_LOCALPARTS = [
  "no-reply",
  "noreply",
  "notifications",
  "notification",
  "updates",
  "alerts",
  "alert",
  "billing",
  "receipts",
  "support",
  "automated",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
];

const PROMOTIONS_KEYWORDS = [
  "% off",
  "sale",
  "discount",
  "deal",
  "offer",
  "save now",
  "limited time",
  "early bird",
  "webinar",
  "newsletter",
  "unsubscribe",
  "coupon",
  "promo",
  "free trial",
  "register now",
];

function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

function addressLocalPart(address: string): string {
  const at = address.lastIndexOf("@");
  return (at === -1 ? address : address.slice(0, at)).trim().toLowerCase();
}

/** True when `domain` equals `suffix` or is a sub-domain of it. */
function domainMatches(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

/** True when a non-empty `domain` matches any suffix in `suffixes`. */
function matchesAnyDomain(domain: string, suffixes: ReadonlySet<string>): boolean {
  if (domain.length === 0) return false;
  for (const suffix of suffixes) {
    if (domainMatches(domain, suffix)) return true;
  }
  return false;
}

/**
 * Classify a thread into a category tab from one message's headers. The
 * heuristic is intentionally conservative: anything that does not match a
 * recognised pattern falls through to `primary`.
 */
export function classifyMailCategory(signal: MailCategorySignal): MailCategoryTab {
  const address = (signal.fromAddress ?? "").trim().toLowerCase();
  const domain = addressDomain(address);
  const localPart = addressLocalPart(address);
  const subject = (signal.subject ?? "").toLowerCase();
  const name = (signal.fromName ?? "").toLowerCase();

  // Social — recognised social-network senders.
  if (matchesAnyDomain(domain, SOCIAL_DOMAINS)) {
    return "social";
  }

  // Promotions — bulk mail signalled by a List-Unsubscribe header or by
  // marketing language in the subject. Checked before Updates so that a
  // newsletter from an "updates@" address still lands in Promotions.
  const promotionalSubject = PROMOTIONS_KEYWORDS.some((keyword) => subject.includes(keyword));
  if (signal.hasListUnsubscribe === true && promotionalSubject) {
    return "promotions";
  }
  if (promotionalSubject && (localPart.includes("marketing") || name.includes("team"))) {
    return "promotions";
  }

  // Updates — transactional / automated mail from recognised service domains
  // or from automated local-parts.
  if (matchesAnyDomain(domain, UPDATES_DOMAINS)) {
    return "updates";
  }
  if (
    localPart.length > 0 &&
    AUTOMATED_LOCALPARTS.some(
      (part) => localPart === part || localPart.startsWith(`${part}+`) || localPart.includes(part),
    )
  ) {
    return promotionalSubject ? "promotions" : "updates";
  }

  // Promotions — a List-Unsubscribe header alone is a weak-but-real signal.
  if (signal.hasListUnsubscribe === true) {
    return "promotions";
  }

  return "primary";
}

/** Narrow an arbitrary string to a `MailCategoryTab`, defaulting to `primary`. */
export function coerceMailCategory(value: string | null | undefined): MailCategoryTab {
  return (MAIL_CATEGORY_TABS as readonly string[]).includes(value ?? "")
    ? (value as MailCategoryTab)
    : "primary";
}
