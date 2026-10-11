import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { ApiError } from "../../api/api-error.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { defineTool } from "./define-tool.js";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

const actionsGetInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Pending action id returned by a tools/call that needed approval."),
  })
  .strict();

const actionsGetOutputSchema = z.object({ action: z.unknown() }).passthrough();

/**
 * `actions.get` (MC3): lets MCP and REST agents poll a pending action they
 * queued. Authorization is the same as `GET /actions/:id`: the confirmation
 * gate only returns the action to its requester or an eligible approver in
 * the same org; everyone else sees "not found".
 */
export function createActionTools(registry: RuntimeToolRegistry): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof actionsGetInputSchema>, z.output<typeof actionsGetOutputSchema>>({
      id: "actions.get",
      description:
        "Get the status of a pending action you queued or can approve: pending_confirmation, approved, executing, executed, failed, cancelled, or expired.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(actionsGetInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(actionsGetOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await registry.getPendingAction(input.id, { actor: ctx.actor });
        if (!result.ok) {
          throw new ApiError(
            result.statusCode === 404 ? "not_found" : "bad_request",
            result.statusCode === 404
              ? `Pending action ${input.id} was not found, or you are not its requester or approver.`
              : result.error,
          );
        }
        return { action: result.pending };
      },
    }),
  ];
}
