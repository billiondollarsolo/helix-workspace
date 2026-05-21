import { describe, expect, it } from "vitest";
import {
  renderCustomTemplate,
  renderDiscordWebhookPayload,
  renderGenericEnvelope,
  renderSlackWebhookPayload,
  renderTeamsWebhookPayload,
  type OutboundWebhookEvent,
} from "./index.js";

const event: OutboundWebhookEvent = {
  deliveryId: "del_123",
  subject: "mail.received",
  createdAt: new Date("2026-05-19T12:00:00.000Z"),
  payload: {
    from: "ada@example.com",
    subject: "Quarterly plan",
    preview: "Review the launch checklist.",
  },
  actor: {
    id: "act_123",
    type: "user",
    displayName: "Ada Lovelace",
  },
};

describe("outbound webhook formats", () => {
  it("renders the Helix native JSON envelope", () => {
    expect(renderGenericEnvelope(event)).toEqual({
      contentType: "application/json",
      body: {
        id: "del_123",
        event: "mail.received",
        createdAt: "2026-05-19T12:00:00.000Z",
        object: {
          from: "ada@example.com",
          subject: "Quarterly plan",
          preview: "Review the launch checklist.",
        },
        actor: {
          id: "act_123",
          type: "user",
          displayName: "Ada Lovelace",
        },
      },
    });
  });

  it("renders Slack, Discord, and Teams destination payloads", () => {
    const slackBody = renderSlackWebhookPayload(event, {
      textTemplate: "Mail from {{object.from}}: {{object.subject}}",
    }).body;
    expect(slackBody).toMatchObject({
      text: "Mail from ada@example.com: Quarterly plan",
    });
    expect(JSON.stringify(slackBody)).toContain('"type":"section"');

    const discordBody = renderDiscordWebhookPayload(event).body;
    expect(discordBody).toMatchObject({
      content: "Helix event mail.received",
    });
    expect(JSON.stringify(discordBody)).toContain('"title":"mail.received"');
    expect(JSON.stringify(discordBody)).toContain('"description":"Review the launch checklist."');

    const teamsBody = renderTeamsWebhookPayload(event, { titleTemplate: "Mail: {{object.subject}}" }).body;
    expect(teamsBody).toMatchObject({
      type: "message",
    });
    expect(JSON.stringify(teamsBody)).toContain('"contentType":"application/vnd.microsoft.card.adaptive"');
    expect(JSON.stringify(teamsBody)).toContain('"type":"AdaptiveCard"');
    expect(JSON.stringify(teamsBody)).toContain('"version":"1.4"');
  });

  it("renders custom JSON templates with the sandboxed Liquid renderer", () => {
    const rendered = renderCustomTemplate(event, {
      template:
        '{"id":"{{ id }}","summary":"{{ event }} from {{ object.from }}","payload":{{ object | json }},"actor":{{ actor | json }}}',
    });

    expect(rendered).toEqual({
      contentType: "application/json",
      body: {
        id: "del_123",
        summary: "mail.received from ada@example.com",
        payload: {
          from: "ada@example.com",
          subject: "Quarterly plan",
          preview: "Review the launch checklist.",
        },
        actor: {
          id: "act_123",
          type: "user",
          displayName: "Ada Lovelace",
        },
      },
    });
  });
});
