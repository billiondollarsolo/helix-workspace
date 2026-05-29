import type { JsonObject } from "@helix/sdk-types";
import type { EventSchemaDefinition } from "../events/schema-registry.js";

export const signupFunnelSubjects = {
  formViewed: "signup.form_viewed",
  formSubmitted: "signup.form_submitted",
  verificationSent: "signup.verification_sent",
  verified: "signup.verified",
  onboardingStarted: "signup.onboarding_started",
  onboardingCompleted: "signup.onboarding_completed",
  onboardingInviteAccepted: "signup.onboarding_invite_accepted",
  welcomeViewed: "signup.welcome_viewed",
  welcomeActionClicked: "signup.welcome_action_clicked",
} as const;

export const signupActivationSloObservedSubject = "tenant.signup_activation_slo.observed";

const stringSchema = { type: "string" } as const;
const timestampSchema = { type: "string", format: "date-time" } as const;
const booleanSchema = { type: "boolean" } as const;
const integerSchema = { type: "integer", minimum: 0 } as const;
const numberSchema = { type: "number", minimum: 0 } as const;

const tenantProperties = {
  orgId: stringSchema,
  orgSlug: stringSchema,
  tier: stringSchema,
  planId: stringSchema,
  region: stringSchema,
  source: { const: "signup" },
} as const;

export const signupEventSchemas: readonly EventSchemaDefinition[] = [
  signupFunnelSchema({
    id: signupFunnelSubjects.formViewed,
    subject: signupFunnelSubjects.formViewed,
    title: "Signup form viewed",
    step: "form_viewed",
    properties: {
      page: stringSchema,
      attribution: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["page"],
    tenantScoped: false,
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.formSubmitted,
    subject: signupFunnelSubjects.formSubmitted,
    title: "Signup form submitted",
    step: "form_submitted",
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.verificationSent,
    subject: signupFunnelSubjects.verificationSent,
    title: "Signup verification sent",
    step: "verification_sent",
    properties: {
      expiresAt: timestampSchema,
    },
    required: ["expiresAt"],
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.verified,
    subject: signupFunnelSubjects.verified,
    title: "Signup verified",
    step: "verified",
    properties: {
      ownerActorId: stringSchema,
      betterAuthUserId: stringSchema,
    },
    required: ["ownerActorId", "betterAuthUserId"],
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.onboardingStarted,
    subject: signupFunnelSubjects.onboardingStarted,
    title: "Signup onboarding started",
    step: "onboarding_started",
    properties: {
      actorId: stringSchema,
    },
    required: ["actorId"],
    tenantIdentity: "actor",
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.onboardingCompleted,
    subject: signupFunnelSubjects.onboardingCompleted,
    title: "Signup onboarding completed",
    step: "onboarding_completed",
    properties: {
      actorId: stringSchema,
      planChoice: stringSchema,
      inviteCount: integerSchema,
      identityChoice: stringSchema,
      skipped: booleanSchema,
    },
    required: ["actorId"],
    tenantIdentity: "actor",
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.onboardingInviteAccepted,
    subject: signupFunnelSubjects.onboardingInviteAccepted,
    title: "Signup onboarding invite accepted",
    step: "onboarding_invite_accepted",
    properties: {
      actorId: stringSchema,
      invitedByActorId: stringSchema,
    },
    required: ["actorId", "invitedByActorId"],
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.welcomeViewed,
    subject: signupFunnelSubjects.welcomeViewed,
    title: "Signup welcome viewed",
    step: "welcome_viewed",
    properties: {
      actorId: stringSchema,
    },
    required: ["actorId"],
    tenantIdentity: "actor",
  }),
  signupFunnelSchema({
    id: signupFunnelSubjects.welcomeActionClicked,
    subject: signupFunnelSubjects.welcomeActionClicked,
    title: "Signup welcome action clicked",
    step: "welcome_action_clicked",
    properties: {
      actorId: stringSchema,
      action: stringSchema,
    },
    required: ["actorId", "action"],
    tenantIdentity: "actor",
  }),
  {
    id: signupActivationSloObservedSubject,
    subject: signupActivationSloObservedSubject,
    title: "Signup activation SLO observed",
    description: "A self-service signup activation duration has been observed.",
    direction: "publish",
    tags: ["Signup", "SLO"],
    payloadSchema: objectSchema(
      {
        ...tenantProperties,
        slo: { const: "signup_activation" },
        targetSeconds: numberSchema,
        durationSeconds: numberSchema,
        withinTarget: booleanSchema,
        startedAt: timestampSchema,
        completedAt: timestampSchema,
        completedStepCount: integerSchema,
      },
      [
        "orgId",
        "orgSlug",
        "tier",
        "planId",
        "region",
        "source",
        "slo",
        "targetSeconds",
        "durationSeconds",
        "withinTarget",
        "startedAt",
        "completedAt",
        "completedStepCount",
      ],
    ),
  },
];

function signupFunnelSchema(input: {
  readonly id: string;
  readonly subject: string;
  readonly title: string;
  readonly step: string;
  readonly properties?: JsonObject;
  readonly required?: readonly string[];
  readonly tenantScoped?: boolean;
  readonly tenantIdentity?: "actor" | "org";
}): EventSchemaDefinition {
  const tenantScoped = input.tenantScoped ?? true;
  const tenantIdentity = input.tenantIdentity ?? "org";
  const properties = {
    ...(tenantScoped ? tenantScopedProperties(tenantIdentity) : { source: { const: "signup" } }),
    step: { const: input.step },
    ...(input.properties ?? {}),
  };
  const required = [
    ...(tenantScoped
      ? tenantIdentity === "actor"
        ? ["orgId", "actorId", "source", "step"]
        : ["orgId", "orgSlug", "tier", "planId", "region", "source", "step"]
      : ["source", "step"]),
    ...(input.required ?? []),
  ];

  return {
    id: input.id,
    subject: input.subject,
    title: input.title,
    description: "Privacy-safe signup funnel telemetry event.",
    direction: "publish",
    tags: ["Signup"],
    payloadSchema: objectSchema(properties, required),
  };
}

function tenantScopedProperties(identity: "actor" | "org"): JsonObject {
  return identity === "actor"
    ? {
        orgId: stringSchema,
        actorId: stringSchema,
        source: { const: "signup" },
      }
    : tenantProperties;
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}
