import type { MailStore } from "../mail/index.js";
import { MailSendService } from "../mail/outbound.js";

export interface DriveShareMailRecipient {
  readonly email: string;
  readonly displayName: string | null;
}

export interface DriveShareMailInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly title: string;
  readonly role: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly message?: string;
  readonly recipients: readonly DriveShareMailRecipient[];
}

export interface DriveAccessRequestMailInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly title: string;
  readonly message: string | null;
  readonly requesterName: string;
  readonly requesterEmail: string;
  readonly ownerEmail: string;
  readonly ownerName: string | null;
}

export interface DriveAccessDecisionMailInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly title: string;
  readonly approved: boolean;
  readonly ownerName: string;
  readonly ownerEmail: string;
  readonly requesterEmail: string;
  readonly requesterName: string | null;
}

export interface DriveShareMailer {
  sendShare(input: DriveShareMailInput): Promise<void>;
  sendAccessRequest(input: DriveAccessRequestMailInput): Promise<void>;
  sendAccessDecision(input: DriveAccessDecisionMailInput): Promise<void>;
}

export function createMailDriveShareSender(options: {
  readonly store: MailStore;
  readonly publicBaseUrl?: string;
}): DriveShareMailer {
  const service = new MailSendService({ store: options.store, undoWindowMs: 0 });
  const baseUrl = (options.publicBaseUrl ?? "http://localhost:3000").replace(/\/$/u, "");
  const openUrl = (objectId: string) => `${baseUrl}/drive?file=${encodeURIComponent(objectId)}`;

  return {
    async sendShare(input) {
      const from = address(input.authorEmail, input.authorName);
      for (const recipient of input.recipients) {
        const url = openUrl(input.objectId);
        await service.queue({
          orgId: input.orgId,
          actorId: input.actorId,
          envelope: {
            from,
            to: [address(recipient.email, recipient.displayName)],
            cc: [],
            bcc: [],
            subject: `${input.authorName} shared "${input.title}" with you`,
            text: shareText(input, url),
            html: shareHtml(input, url),
            attachments: [],
          },
        });
      }
    },
    async sendAccessRequest(input) {
      const url = openUrl(input.objectId);
      await service.queue({
        orgId: input.orgId,
        actorId: input.actorId,
        envelope: {
          from: address(input.requesterEmail, input.requesterName),
          to: [address(input.ownerEmail, input.ownerName)],
          cc: [],
          bcc: [],
          subject: `${input.requesterName} requested access to "${input.title}"`,
          text: accessRequestText(input, url),
          html: accessRequestHtml(input, url),
          attachments: [],
        },
      });
    },
    async sendAccessDecision(input) {
      const url = openUrl(input.objectId);
      const verb = input.approved ? "approved" : "declined";
      await service.queue({
        orgId: input.orgId,
        actorId: input.actorId,
        envelope: {
          from: address(input.ownerEmail, input.ownerName),
          to: [address(input.requesterEmail, input.requesterName)],
          cc: [],
          bcc: [],
          subject: `${input.ownerName} ${verb} your request to access "${input.title}"`,
          text: accessDecisionText(input, url),
          html: accessDecisionHtml(input, url),
          attachments: [],
        },
      });
    },
  };
}

function address(email: string, name: string | null): { address: string; name?: string } {
  if (name === null || name.trim().length === 0) {
    return { address: email };
  }
  return { address: email, name };
}

function roleLabel(role: string): string {
  if (role === "editor") return "edit";
  if (role === "commenter") return "comment";
  if (role === "owner") return "manage";
  return "view";
}

function shareText(input: DriveShareMailInput, url: string): string {
  const lines = [
    `${input.authorName} (${input.authorEmail}) shared "${input.title}" with you.`,
    `You can ${roleLabel(input.role)} this item in Helix Drive:`,
    url,
  ];
  if (input.message !== undefined && input.message.trim().length > 0) {
    lines.splice(1, 0, "", input.message.trim(), "");
  }
  return lines.join("\n");
}

function shareHtml(input: DriveShareMailInput, url: string): string {
  const note =
    input.message !== undefined && input.message.trim().length > 0
      ? `<p>${escapeHtml(input.message.trim())}</p>`
      : "";
  return `<p>${escapeHtml(input.authorName)} (${escapeHtml(input.authorEmail)}) shared <strong>${escapeHtml(input.title)}</strong> with you.</p>${note}<p>You can ${escapeHtml(roleLabel(input.role))} this item in Helix Drive.</p><p><a href="${escapeHtml(url)}">Open</a></p>`;
}

function accessRequestText(input: DriveAccessRequestMailInput, url: string): string {
  const lines = [
    `${input.requesterName} (${input.requesterEmail}) requested access to "${input.title}".`,
    `Review the request in Helix Drive:`,
    url,
  ];
  if (input.message !== null && input.message.trim().length > 0) {
    lines.splice(1, 0, "", input.message.trim(), "");
  }
  return lines.join("\n");
}

function accessRequestHtml(input: DriveAccessRequestMailInput, url: string): string {
  const note =
    input.message !== null && input.message.trim().length > 0
      ? `<p>${escapeHtml(input.message.trim())}</p>`
      : "";
  return `<p>${escapeHtml(input.requesterName)} (${escapeHtml(input.requesterEmail)}) requested access to <strong>${escapeHtml(input.title)}</strong>.</p>${note}<p><a href="${escapeHtml(url)}">Review request</a></p>`;
}

function accessDecisionText(input: DriveAccessDecisionMailInput, url: string): string {
  const verb = input.approved ? "approved" : "declined";
  return [
    `${input.ownerName} ${verb} your request to access "${input.title}".`,
    input.approved ? `Open it in Helix Drive:\n${url}` : url,
  ].join("\n");
}

function accessDecisionHtml(input: DriveAccessDecisionMailInput, url: string): string {
  const verb = input.approved ? "approved" : "declined";
  const link = input.approved
    ? `<p><a href="${escapeHtml(url)}">Open</a></p>`
    : `<p><a href="${escapeHtml(url)}">View item</a></p>`;
  return `<p>${escapeHtml(input.ownerName)} ${verb} your request to access <strong>${escapeHtml(input.title)}</strong>.</p>${link}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
