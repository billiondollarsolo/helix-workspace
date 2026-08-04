import type { EventBus, EventEnvelope, JsonObject, Unsubscribe } from "@helix/sdk-types";
import type { MailOutboundDeliveryResult, MailOutboundEnvelope } from "../mail/types.js";
import type { OutboundMailTransport } from "../mail/outbound.js";

export const signupVerificationEmailSubject = "signup.verification_email.send";
export const signupOnboardingInviteEmailSubject = "signup.onboarding_invite_email.send";

export interface SignupVerificationEmailPayload extends JsonObject {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly email: string;
  readonly verificationUrl: string;
  readonly expiresAt: string;
  readonly source: "signup";
}

export interface SignupOnboardingInviteEmailPayload extends JsonObject {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly actorId: string;
  readonly email: string;
  readonly inviteUrl: string;
  readonly source: "signup";
}

export interface SignupEmailWorkerOptions {
  readonly events: EventBus;
  readonly transport: OutboundMailTransport;
  readonly subject?: string;
  readonly from?: MailOutboundEnvelope["from"];
  readonly productName?: string;
  readonly onError?: (error: unknown) => void;
}

export type SignupVerificationEmailWorkerOptions = SignupEmailWorkerOptions;

export type SignupOnboardingInviteEmailWorkerOptions = SignupEmailWorkerOptions;

/**
 * Shared subscribe/deliver machinery for the signup transactional email workers.
 * Subclasses only supply the default event subject and how a payload renders.
 */
abstract class SignupEmailWorker {
  protected readonly from: MailOutboundEnvelope["from"];
  protected readonly productName: string;
  private readonly subject: string;
  private readonly events: EventBus;
  private readonly transport: OutboundMailTransport;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  constructor(options: SignupEmailWorkerOptions, defaultSubject: string) {
    this.subject = options.subject ?? defaultSubject;
    this.events = options.events;
    this.transport = options.transport;
    this.from = options.from ?? { address: "no-reply@localhost", name: "Helix" };
    this.productName = options.productName ?? "Helix";
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.events.subscribe(this.subject, async (event) => {
      await this.handle(event);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe === undefined) {
      return;
    }

    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe();
  }

  async handle(event: EventEnvelope): Promise<MailOutboundDeliveryResult> {
    try {
      return await this.transport.send(this.render(event.payload));
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
  }

  protected abstract render(payload: unknown): MailOutboundEnvelope;
}

export class SignupVerificationEmailWorker extends SignupEmailWorker {
  constructor(options: SignupVerificationEmailWorkerOptions) {
    super(options, signupVerificationEmailSubject);
  }

  protected render(payload: unknown): MailOutboundEnvelope {
    return renderSignupVerificationEmail({
      payload: parseSignupVerificationEmailPayload(payload),
      from: this.from,
      productName: this.productName,
    });
  }
}

export class SignupOnboardingInviteEmailWorker extends SignupEmailWorker {
  constructor(options: SignupOnboardingInviteEmailWorkerOptions) {
    super(options, signupOnboardingInviteEmailSubject);
  }

  protected render(payload: unknown): MailOutboundEnvelope {
    return renderSignupOnboardingInviteEmail({
      payload: parseSignupOnboardingInviteEmailPayload(payload),
      from: this.from,
      productName: this.productName,
    });
  }
}

export function renderSignupVerificationEmail(input: {
  readonly payload: SignupVerificationEmailPayload;
  readonly from: MailOutboundEnvelope["from"];
  readonly productName?: string;
}): MailOutboundEnvelope {
  const productName = input.productName ?? "Helix";
  const workspaceName = workspaceLabel(input.payload.orgSlug);
  const expiry = new Date(input.payload.expiresAt).toISOString();
  const text = [
    `Verify ${workspaceName}`,
    "",
    `Welcome to ${productName}. Open this link to activate ${workspaceName}:`,
    input.payload.verificationUrl,
    "",
    `This link expires at ${expiry}.`,
    "If you did not request this signup, you can ignore this email.",
  ].join("\n");
  const html = renderBrandedEmailHtml({
    productName,
    preheader: `Activate ${workspaceName}.`,
    eyebrow: "Workspace verification",
    title: `Verify ${workspaceName}`,
    body: [
      `Welcome to ${productName}. Confirm this email address to activate your workspace and continue setup.`,
      `This link expires at ${expiry}.`,
    ],
    ctaLabel: "Verify workspace",
    ctaUrl: input.payload.verificationUrl,
    footer: "If you did not request this signup, you can ignore this email.",
  });

  return {
    from: input.from,
    to: [{ address: input.payload.email }],
    cc: [],
    bcc: [],
    subject: `Verify ${workspaceName}`,
    text,
    html,
    attachments: [],
  };
}

export function renderSignupOnboardingInviteEmail(input: {
  readonly payload: SignupOnboardingInviteEmailPayload;
  readonly from: MailOutboundEnvelope["from"];
  readonly productName?: string;
}): MailOutboundEnvelope {
  const productName = input.productName ?? "Helix";
  const workspaceName = workspaceLabel(input.payload.orgSlug);
  const text = [
    `Join ${workspaceName} on ${productName}`,
    "",
    `A teammate invited you to join ${workspaceName}.`,
    "Open this link to sign in with email/password or your organization's SSO:",
    input.payload.inviteUrl,
    "",
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
  const html = renderBrandedEmailHtml({
    productName,
    preheader: `You were invited to ${workspaceName}.`,
    eyebrow: "Workspace invitation",
    title: `Join ${workspaceName}`,
    body: [
      `A teammate invited you to collaborate in ${productName}.`,
      "You can accept with local email/password login or your organization's configured SSO.",
    ],
    ctaLabel: `Open ${workspaceName}`,
    ctaUrl: input.payload.inviteUrl,
    footer: "If you were not expecting this invitation, you can ignore this email.",
  });

  return {
    from: input.from,
    to: [{ address: input.payload.email }],
    cc: [],
    bcc: [],
    subject: `Join ${workspaceName} on ${productName}`,
    text,
    html,
    attachments: [],
  };
}

export function parseSignupVerificationEmailPayload(
  value: unknown,
): SignupVerificationEmailPayload {
  const { orgId, orgSlug, email, verificationUrl, expiresAt, source } = payloadRecord(value);
  if (
    typeof orgId !== "string" ||
    typeof orgSlug !== "string" ||
    typeof email !== "string" ||
    typeof verificationUrl !== "string" ||
    typeof expiresAt !== "string" ||
    source !== "signup"
  ) {
    throw new Error("Invalid signup verification email payload.");
  }
  return { orgId, orgSlug, email, verificationUrl, expiresAt, source: "signup" };
}

export function parseSignupOnboardingInviteEmailPayload(
  value: unknown,
): SignupOnboardingInviteEmailPayload {
  const { orgId, orgSlug, actorId, email, inviteUrl, source } = payloadRecord(value);
  if (
    typeof orgId !== "string" ||
    typeof orgSlug !== "string" ||
    typeof actorId !== "string" ||
    typeof email !== "string" ||
    typeof inviteUrl !== "string" ||
    source !== "signup"
  ) {
    throw new Error("Invalid signup onboarding invite email payload.");
  }
  return { orgId, orgSlug, actorId, email, inviteUrl, source: "signup" };
}

/**
 * Non-object payloads (including arrays) become an empty record so the field
 * checks below reject them with the same error as a malformed object.
 */
function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function renderBrandedEmailHtml(input: {
  readonly productName: string;
  readonly preheader: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly ctaLabel: string;
  readonly ctaUrl: string;
  readonly footer: string;
}): string {
  const body = input.body
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#334155;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta http-equiv="content-type" content="text/html; charset=utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    "</head>",
    '<body style="margin:0;background:#f8fafc;padding:32px 16px;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:560px;background:#ffffff;border:1px solid #e2e8f0;">',
    '<tr><td style="padding:28px 32px 8px;">',
    `<div style="color:#0f766e;font:700 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(input.productName)}</div>`,
    `<div style="color:#64748b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin-top:16px;">${escapeHtml(input.eyebrow)}</div>`,
    `<h1 style="margin:6px 0 16px;color:#0f172a;font:700 28px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(input.title)}</h1>`,
    body,
    `<p style="margin:24px 0 28px;"><a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font:700 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(input.ctaLabel)}</a></p>`,
    `<p style="margin:0;color:#64748b;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(input.footer)}</p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");
}

function workspaceLabel(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.length === 0) {
    return "your workspace";
  }
  return `${trimmed} workspace`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
