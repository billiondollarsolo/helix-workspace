import { createFileRoute } from "@tanstack/react-router";
import { LandingPage, redirectSignedInRoot } from "./-landing-page";

export const Route = createFileRoute("/")({
  beforeLoad: () => redirectSignedInRoot(),
  component: LandingPage,
});
