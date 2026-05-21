import { describe, expect, it } from "vitest";
import {
  createTemplateContext,
  renderCustomTemplate,
  renderTemplateString,
  type TemplateContext,
} from "./template.js";
import type { OutboundWebhookEvent } from "./types.js";

const event: OutboundWebhookEvent = {
  deliveryId: "del_900",
  subject: "mail.received",
  createdAt: new Date("2026-05-21T08:30:00.000Z"),
  payload: {
    subject: "Launch checklist",
    tags: ["urgent", "launch", "q3"],
    unread: true,
    attachments: 2,
  },
  actor: {
    id: "act_900",
    type: "user",
    displayName: "Grace Hopper",
  },
};

const context: TemplateContext = createTemplateContext(event);

describe("sandboxed Liquid webhook template renderer", () => {
  it("renders filters", () => {
    const output = renderTemplateString(
      "{{ object.subject | upcase }} ({{ object.attachments | plus: 1 }})",
      context,
    );
    expect(output).toBe("LAUNCH CHECKLIST (3)");
  });

  it("renders the json filter for structured values", () => {
    const output = renderTemplateString("{{ object.tags | json }}", context);
    expect(JSON.parse(output)).toEqual(["urgent", "launch", "q3"]);
  });

  it("renders conditionals", () => {
    const template =
      "{% if object.unread %}NEW{% else %}SEEN{% endif %}-" +
      "{% unless object.attachments == 0 %}HAS-FILES{% endunless %}";
    expect(renderTemplateString(template, context)).toBe("NEW-HAS-FILES");
  });

  it("renders loops over arrays", () => {
    const output = renderTemplateString(
      "{% for tag in object.tags %}[{{ tag }}]{% endfor %}",
      context,
    );
    expect(output).toBe("[urgent][launch][q3]");
  });

  it("combines loops, conditionals and filters into a JSON body", () => {
    const rendered = renderCustomTemplate(event, {
      template: [
        "{",
        '"event":"{{ event }}",',
        '"important":{% if object.tags contains "urgent" %}true{% else %}false{% endif %},',
        '"labels":[',
        "{% for tag in object.tags %}",
        '"{{ tag | capitalize }}"{% unless forloop.last %},{% endunless %}',
        "{% endfor %}",
        "]}",
      ].join(""),
    });

    expect(rendered).toEqual({
      contentType: "application/json",
      body: {
        event: "mail.received",
        important: true,
        labels: ["Urgent", "Launch", "Q3"],
      },
    });
  });

  it("throws on a malformed template", () => {
    expect(() =>
      renderTemplateString("{% if object.unread %}unterminated", context),
    ).toThrow(/Custom webhook template failed to render/);
  });

  it("throws when rendered output is not valid JSON", () => {
    expect(() =>
      renderCustomTemplate(event, { template: "{not json {{ id }}" }),
    ).toThrow(/not valid JSON/);
  });

  it("blocks the include tag to prevent file-system escape", () => {
    expect(() =>
      renderTemplateString('{% include "/etc/passwd" %}', context),
    ).toThrow(/cannot use the "include" tag/);
  });

  it("blocks the render tag to prevent file-system escape", () => {
    expect(() =>
      renderTemplateString('{% render "secrets" %}', context),
    ).toThrow(/cannot use the "render" tag/);
  });
});
