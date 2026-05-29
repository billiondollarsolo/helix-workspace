import { createFileRoute } from "@tanstack/react-router";
import { OnboardingShell } from "@/features/onboarding/onboarding-shell";

export const Route = createFileRoute("/_shell/onboarding/")({
  component: OnboardingShell,
});
