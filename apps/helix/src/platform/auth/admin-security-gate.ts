import type { Actor, SecurityTier } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildErrorEnvelope } from "../../api/error-envelope.js";
import type { SecurityPoliciesStore } from "../admin/security-policies.js";
import { evaluateOrgAdminMfa } from "../admin/security-policy-runtime.js";
import {
  isSecurityPolicyRecoveryRequest,
  resolveAdminSecurityControls,
  securityPolicyChangeRequirements,
} from "./admin-security-policy.js";
import { installCrownJewelGate, type CrownJewelApprovalStore } from "./crown-jewel.js";
import type { MfaVerificationResolver } from "./mfa.js";

export function installAdminSecurityGate(
  app: FastifyInstance,
  options: {
    readonly policies: SecurityPoliciesStore;
    readonly approvals: CrownJewelApprovalStore;
    readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
    readonly mfa: MfaVerificationResolver;
    readonly securityTier: () => SecurityTier;
    readonly protectedPath: (url: string) => boolean;
    readonly traceId: (request: FastifyRequest) => string;
  },
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (
      !options.protectedPath(request.url) ||
      isSecurityPolicyRecoveryRequest(request.method, request.url)
    )
      return;
    const actor = await options.actorFromRequest(request);
    const orgMfaPolicy = await options.policies.get(actor.orgId, "mfa");
    const decision = evaluateOrgAdminMfa({
      tier: options.securityTier(),
      actor,
      mfaVerified: await options.mfa.isMfaVerified(request, actor),
      orgMfaPolicy,
    });
    if (!decision.allowed)
      return reply.code(decision.statusCode).send(
        buildErrorEnvelope({
          statusCode: decision.statusCode,
          code: decision.code,
          message: decision.message,
          traceId: options.traceId(request),
        }),
      );
  });
  installCrownJewelGate(app, {
    store: options.approvals,
    actorFromRequest: options.actorFromRequest,
    mfa: options.mfa,
    traceId: options.traceId,
    requirements: async (request, actor) => {
      const changingPolicy =
        request.method === "PUT" && isSecurityPolicyRecoveryRequest(request.method, request.url);
      const policy = await options.policies.get(actor.orgId, "mfa", changingPolicy);
      if (changingPolicy) {
        return securityPolicyChangeRequirements(policy);
      }
      const controls = resolveAdminSecurityControls(options.securityTier(), policy);
      return {
        mfaRequired: controls.sensitiveActionMfaRequired,
        approvalRequired: controls.secondAdminApprovalRequired,
      };
    },
  });
}
