import { BadRequestError, ForbiddenError } from "../../api/api-error.js";
import { evaluateExternalEmailSharePolicy } from "../admin/security-policy-runtime.js";
import type { CreateDriveToolDefinitionsOptions } from "./tools.js";

/**
 * Grants only reach workspace members, so sharing by name or email is internal and
 * always allowed. Refs that match no member get the external-sharing policy's answer
 * when it forbids them, otherwise a pointer to share links for outside recipients.
 */
export async function resolveInternalShareTargets(
  options: Pick<
    CreateDriveToolDefinitionsOptions,
    "resolveShareActorRefs" | "getExternalSharingPolicy"
  >,
  orgId: string,
  refs: readonly string[],
): Promise<readonly string[]> {
  if (options.resolveShareActorRefs === undefined) {
    throw new BadRequestError("Drive share by email or name is not configured.");
  }
  const result = await options.resolveShareActorRefs({ orgId, refs });
  if (result.unresolvedRefs.length === 0) return result.actorIds;
  const outsideEmails = result.unresolvedRefs.filter((ref) => ref.includes("@"));
  if (outsideEmails.length > 0 && options.getExternalSharingPolicy !== undefined) {
    const decision = evaluateExternalEmailSharePolicy(
      await options.getExternalSharingPolicy(orgId),
      outsideEmails,
    );
    if (!decision.allowed) {
      throw new ForbiddenError(decision.message, { details: { code: decision.code } });
    }
  }
  throw new BadRequestError(
    `Could not find workspace user(s): ${result.unresolvedRefs.join(", ")}. ` +
      "Share with people outside the organization through a share link.",
  );
}
