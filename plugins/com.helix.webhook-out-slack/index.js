/**
 * Slack outbound-webhook connector — a genuinely loadable external connector.
 *
 * This is a real, bundled connector plugin (manifest `category: "connector"`,
 * `kind: "in-process"`). The Helix connector runtime discovers this directory,
 * validates the manifest, imports this module, and invokes `register()` at
 * server startup. The registered format renders Helix outbound-webhook events
 * into Slack incoming-webhook payloads.
 *
 * It is intentionally self-contained — a connector must not reach into the
 * monolith's internals; it only uses the narrow `ConnectorRegistrationSink`.
 */

/**
 * @param {{ id: string, type: string, displayName?: string, email?: string }} [actor]
 * @returns {Record<string, unknown>}
 */
function templateContext(event) {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : {};
  return {
    subject: event.subject,
    deliveryId: event.deliveryId,
    object: payload,
    actor: event.actor ?? {},
  };
}

/** Minimal `{{a.b.c}}` token substitution against a context object. */
function renderTemplate(template, context) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_match, path) => {
    let value = context;
    for (const segment of String(path).split(".")) {
      if (value && typeof value === "object" && segment in value) {
        value = value[segment];
      } else {
        return "";
      }
    }
    return value == null ? "" : String(value);
  });
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  return ["from", "sender", "subject", "title", "preview", "room", "name"]
    .flatMap((key) => {
      const value = payload[key];
      return typeof value === "string" && value.length > 0
        ? [{ type: "mrkdwn", text: `*${key}:* ${value}` }]
        : [];
    })
    .slice(0, 6);
}

/** @returns {{ contentType: "application/json", body: unknown }} */
function renderSlackPayload(event) {
  const context = templateContext(event);
  const text = renderTemplate(
    `Helix event ${event.subject}: {{object.subject}}{{object.title}}{{object.name}}`,
    context,
  );
  const fields = summarizePayload(event.payload);
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text } },
    ...(fields.length === 0 ? [] : [{ type: "section", fields }]),
  ];
  return {
    contentType: "application/json",
    body: { text, blocks },
  };
}

/** @type {import("../../apps/helix/src/platform/connectors/types.js").ConnectorPlugin} */
export default {
  id: "com.helix.webhook-out-slack",
  register(sink) {
    sink.registerWebhookFormat({
      id: "slack",
      render: renderSlackPayload,
    });
  },
};
