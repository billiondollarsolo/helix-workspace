import type { ToolDefinition } from "@helix/sdk-types";

/**
 * Denial message when a tool that requires a signed-in person is invoked
 * through a delegated credential (an OAuth access token, API key, or mTLS
 * credential, all of which carry a `credentialId`). Such tools mint long-lived
 * credentials, which must not outlive or escape the delegated grant.
 */
export function interactiveSessionDenial(
  tool: Pick<ToolDefinition, "id" | "interactiveSessionOnly">,
  credentialId: string | undefined,
): string | null {
  if (tool.interactiveSessionOnly !== true || credentialId === undefined) return null;
  return `Tool ${tool.id} requires a signed-in session; delegated OAuth, API-key, and agent credentials cannot use it.`;
}
