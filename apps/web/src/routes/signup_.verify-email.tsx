import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { VerifyEmailShell } from "@/features/signup/verify-email-shell";

const verifyEmailSearchSchema = z.object({
  token: z.string().optional().default(""),
});

export const Route = createFileRoute("/signup_/verify-email")({
  validateSearch: (search) => verifyEmailSearchSchema.parse(search),
  component: VerifyEmailRoute,
});

function VerifyEmailRoute() {
  const search = Route.useSearch();
  return <VerifyEmailShell token={search.token} />;
}

