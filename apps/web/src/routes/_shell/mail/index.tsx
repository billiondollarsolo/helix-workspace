import { createFileRoute } from "@tanstack/react-router";
import { MailShell } from "@/features/mail/mail-shell";

export const Route = createFileRoute("/_shell/mail/")({
  component: MailRoute,
});

function MailRoute() {
  return <MailShell />;
}
