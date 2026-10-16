import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";

export function resourceReadTools(reader?: (actor: Actor, uri: string) => Promise<unknown>) {
  const input = z
    .object({ uri: z.string().min(1).max(2048), resourceId: z.string().min(1).max(512) })
    .strict();
  const tools = new Map<string, ToolDefinition>();
  for (const kind of ["mail", "chat", "calendar", "drive", "contacts"] as const) {
    const id = `${kind}.resource.read`;
    const schema = input.superRefine((value, context) => {
      let matches = false;
      try {
        const uri = new URL(value.uri);
        const [type, ...parts] = uri.pathname.split("/").filter(Boolean);
        const types = {
          mail: "thread",
          chat: "room",
          calendar: "event",
          drive: "file",
          contacts: "contact",
        };
        matches =
          uri.protocol === "helix:" &&
          decodeURIComponent(parts.join("/")) === value.resourceId &&
          ((uri.hostname === kind && type === types[kind]) ||
            (uri.hostname === "resources" && type === kind));
      } catch {
        /* Malformed identifiers cannot select a different policy resource. */
      }
      if (!matches)
        context.addIssue({
          code: "custom",
          message: "Resource URI must match the resource kind and identifier.",
        });
    });
    tools.set(id, {
      id,
      description: `Read one authorized ${kind} MCP resource.`,
      permission: `${kind}.read`,
      sideEffects: "read",
      inputSchema: zodToolSchema(schema, { type: "object" }),
      outputSchema: zodToolSchema(z.unknown(), { type: "object" }),
      handler: async (args, context) => {
        if (reader === undefined)
          throw new BadRequestError("Read this resource through MCP resources/read.");
        return reader(context.actor, input.parse(args).uri);
      },
    });
  }
  return tools;
}
