import { createEventSchemaRegistry } from "../platform/events/schema-registry.js";
import { signupEventSchemas } from "../platform/signup/event-schemas.js";

export function createPlatformEventSchemas() {
  return createEventSchemaRegistry([
    ...signupEventSchemas,
    {
      id: "platform.pending_action.created",
      subject: "platform.pending_action.created",
      title: "Pending action status",
      description: "A pending tool invocation was created or changed state.",
      direction: "publish",
      tags: ["Tools"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "platform.ai_cost.warning",
      subject: "platform.ai_cost.warning",
      title: "AI cost budget warning",
      description: "An actor has crossed 80% of a daily AI cost budget.",
      direction: "publish",
      tags: ["AI"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.storage.exceeded",
      subject: "quota.storage.exceeded",
      title: "Storage quota exceeded",
      description: "A tenant storage quota denied object storage work before execution.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.export_jobs.exceeded",
      subject: "quota.export_jobs.exceeded",
      title: "Export jobs quota exceeded",
      description: "A tenant export job quota denied work before execution.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.api_rps.exceeded",
      subject: "quota.api_rps.exceeded",
      title: "API RPS quota exceeded",
      description: "A tenant API request-rate quota denied an HTTP request.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
  ]);
}
