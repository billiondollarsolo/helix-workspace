import { describe, expect, it } from "vitest";
import {
  signupActivationSloObservedSubject,
  signupEventSchemas,
  signupFunnelSubjects,
} from "../platform/signup/event-schemas.js";
import { buildAsyncApiDocument } from "./asyncapi.js";

const payloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actorId: { type: "string" },
    status: { type: "string", enum: ["pending_confirmation", "confirmed", "cancelled"] },
  },
  required: ["actorId", "status"],
} as const;

describe("buildAsyncApiDocument", () => {
  it("builds AsyncAPI channels, messages, and operations from registered event schemas", () => {
    const document = buildAsyncApiDocument(
      {
        info: { title: "Existing Events", version: "1.0.0" },
      },
      [
        {
          id: "platform.pending_action.created",
          subject: "platform.pending_action.created",
          title: "Pending action created",
          description: "A tool invocation is awaiting confirmation.",
          direction: "both",
          tags: ["Tools"],
          payloadSchema,
          headersSchema: {
            type: "object",
            properties: {
              traceparent: { type: "string" },
            },
          },
        },
      ],
    );

    expect(document.asyncapi).toBe("3.0.0");
    expect(document.info).toEqual({ title: "Existing Events", version: "1.0.0" });
    expect(document.servers).toMatchObject({
      eventsWebSocket: {
        host: "{host}",
        pathname: "/events/ws",
        protocol: "wss",
        security: [{ oauthClientCredentials: [] }],
      },
      webhookDelivery: {
        host: "{webhookHost}",
        protocol: "https",
      },
    });
    expect(document.channels).toMatchObject({
      platform_pending_action_created: {
        address: "platform.pending_action.created",
        messages: {
          PlatformPendingActionCreated: {
            $ref: "#/components/messages/PlatformPendingActionCreated",
          },
        },
      },
    });
    expect(document.operations).toMatchObject({
      publishEvent_platform_pending_action_created: {
        action: "send",
        channel: { $ref: "#/channels/platform_pending_action_created" },
        "x-helix-event": {
          id: "platform.pending_action.created",
          subject: "platform.pending_action.created",
          direction: "publish",
        },
        "x-helix-delivery": {
          websocket: {
            server: "eventsWebSocket",
            path: "/events/ws",
            subjectQueryParam: "subject",
          },
          webhook: {
            adminTool: "webhook.outbound.create",
            deliverySubject: "platform.pending_action.created",
          },
        },
        security: [{ oauthClientCredentials: [] }],
      },
      subscribeEvent_platform_pending_action_created: {
        action: "receive",
        channel: { $ref: "#/channels/platform_pending_action_created" },
        "x-helix-event": {
          direction: "subscribe",
        },
      },
    });
    expect(document.components).toMatchObject({
      messages: {
        PlatformPendingActionCreated: {
          name: "platform.pending_action.created",
          title: "Pending action created",
          summary: "A tool invocation is awaiting confirmation.",
          contentType: "application/json",
          payload: payloadSchema,
          headers: {
            type: "object",
            properties: {
              traceparent: { type: "string" },
              tracestate: { type: "string" },
            },
          },
          tags: [{ name: "Tools" }],
        },
      },
      securitySchemes: {
        oauthClientCredentials: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "/oauth/token",
            },
          },
        },
      },
    });
    expect(document.tags).toEqual([
      { name: "Events", description: "Platform event schema registry." },
    ]);
  });

  it("adds trace context headers when an event omits explicit header schemas", () => {
    const document = buildAsyncApiDocument({}, [
      {
        id: "mail.received",
        subject: "mail.received",
        payloadSchema,
      },
    ]);

    expect(document.components).toMatchObject({
      messages: {
        MailReceived: {
          headers: {
            type: "object",
            properties: {
              traceparent: { type: "string" },
              tracestate: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("publishes signup funnel and activation SLO subjects as AsyncAPI channels", () => {
    const document = buildAsyncApiDocument({}, signupEventSchemas);

    expect(document.channels).toMatchObject({
      signup_form_submitted: {
        address: signupFunnelSubjects.formSubmitted,
      },
      tenant_signup_activation_slo_observed: {
        address: signupActivationSloObservedSubject,
      },
    });
    expect(document.operations).toMatchObject({
      publishEvent_signup_form_submitted: {
        action: "send",
        channel: { $ref: "#/channels/signup_form_submitted" },
        "x-helix-event": {
          id: signupFunnelSubjects.formSubmitted,
          subject: signupFunnelSubjects.formSubmitted,
          direction: "publish",
        },
      },
      publishEvent_tenant_signup_activation_slo_observed: {
        action: "send",
        channel: { $ref: "#/channels/tenant_signup_activation_slo_observed" },
        "x-helix-event": {
          id: signupActivationSloObservedSubject,
          subject: signupActivationSloObservedSubject,
          direction: "publish",
        },
      },
    });
  });
});
