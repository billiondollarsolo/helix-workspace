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

export interface SignupVerificationEmailWorkerOptions {
  readonly events: EventBus;
  readonly transport: OutboundMailTransport;
  readonly subject?: string;
  readonly from?: MailOutboundEnvelope["from"];
  readonly productName?: string;
  readonly onError?: (error: unknown) => void;
}

export interface SignupOnboardingInviteEmailWorkerOptions {
  readonly events: EventBus;
  readonly transport: OutboundMailTransport;
  readonly subject?: string;
  readonly from?: MailOutboundEnvelope["from"];
  readonly productName?: string;
  readonly onError?: (error: unknown) => void;
}

export class SignupVerificationEmailWorker {
  private readonly subject: string;
  private readonly from: MailOutboundEnvelope["from"];
  private readonly productName: string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  constructor(private readonly options: SignupVerificationEmailWorkerOptions) {
    this.subject = options.subject ?? signupVerificationEmailSubject;
    this.from = options.from ?? { address: "no-reply@localhost", name: "Helix" };
    this.productName = options.productName ?? "Helix";
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
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
      const payload = parseSignupVerificationEmailPayload(event.payload);
      return await this.options.transport.send(
        renderSignupVerificationEmail({
          payload,
          from: this.from,
          productName: this.productName,
        }),
      );
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
  }
}

export class SignupOnboardingInviteEmailWorker {
  private readonly subject: string;
  private readonly from: MailOutboundEnvelope["from"];
  private readonly productName: string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  constructor(private readonly options: SignupOnboardingInviteEmailWorkerOptions) {
    this.subject = options.subject ?? signupOnboardingInviteEmailSubject;
    this.from = options.from ?? { address: "no-reply@localhost", name: "Helix" };
    this.productName = options.productName ?? "Helix";
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
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
      const payload = parseSignupOnboardingInviteEmailPayload(event.payload);
      return await this.options.transport.send(
        renderSignupOnboardingInviteEmail({
          payload,
          from: this.from,
          productName: this.productName,
        }),
      );
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
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
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly orgId?: unknown }).orgId === "string" &&
    typeof (value as { readonly orgSlug?: unknown }).orgSlug === "string" &&
    typeof (value as { readonly email?: unknown }).email === "string" &&
    typeof (value as { readonly verificationUrl?: unknown }).verificationUrl === "string" &&
    typeof (value as { readonly expiresAt?: unknown }).expiresAt === "string" &&
    (value as { readonly source?: unknown }).source === "signup"
  ) {
    return {
      orgId: (value as { readonly orgId: string }).orgId,
      orgSlug: (value as { readonly orgSlug: string }).orgSlug,
      email: (value as { readonly email: string }).email,
      verificationUrl: (value as { readonly verificationUrl: string }).verificationUrl,
      expiresAt: (value as { readonly expiresAt: string }).expiresAt,
      source: "signup",
    };
  }
  throw new Error("Invalid signup verification email payload.");
}

export function parseSignupOnboardingInviteEmailPayload(
  value: unknown,
): SignupOnboardingInviteEmailPayload {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly orgId?: unknown }).orgId === "string" &&
    typeof (value as { readonly orgSlug?: unknown }).orgSlug === "string" &&
    typeof (value as { readonly actorId?: unknown }).actorId === "string" &&
    typeof (value as { readonly email?: unknown }).email === "string" &&
    typeof (value as { readonly inviteUrl?: unknown }).inviteUrl === "string" &&
    (value as { readonly source?: unknown }).source === "signup"
  ) {
    return {
      orgId: (value as { readonly orgId: string }).orgId,
      orgSlug: (value as { readonly orgSlug: string }).orgSlug,
      actorId: (value as { readonly actorId: string }).actorId,
      email: (value as { readonly email: string }).email,
      inviteUrl: (value as { readonly inviteUrl: string }).inviteUrl,
      source: "signup",
    };
  }
  throw new Error("Invalid signup onboarding invite email payload.");
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
    "<tr><td align=\"center\">",
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
