import { describe, expect, it } from "vitest";
import {
  signupActivationSloObservedSubject,
  signupEventSchemas,
  signupFunnelSubjects,
} from "./event-schemas.js";

describe("signup event schemas", () => {
  it("publishes schemas for all emitted signup funnel and activation SLO events", () => {
    const subjects = signupEventSchemas.map((schema) => schema.subject);

    expect(subjects).toEqual([
      signupFunnelSubjects.formViewed,
      signupFunnelSubjects.formSubmitted,
      signupFunnelSubjects.verificationSent,
      signupFunnelSubjects.verified,
      signupFunnelSubjects.onboardingStarted,
      signupFunnelSubjects.onboardingCompleted,
      signupFunnelSubjects.onboardingInviteAccepted,
      signupFunnelSubjects.welcomeViewed,
      signupFunnelSubjects.welcomeActionClicked,
      signupActivationSloObservedSubject,
    ]);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("keeps signup schemas privacy-scoped and closed to unreviewed payload fields", () => {
    for (const schema of signupEventSchemas) {
      expect(schema.direction).toBe("publish");
      expect(schema.tags).toContain(schema.subject.startsWith("signup.") ? "Signup" : "SLO");
      expect(schema.payloadSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(JSON.stringify(schema.payloadSchema)).not.toContain("email");
      expect(JSON.stringify(schema.payloadSchema)).not.toContain("password");
      expect(JSON.stringify(schema.payloadSchema)).not.toContain("token");
    }
  });
});
