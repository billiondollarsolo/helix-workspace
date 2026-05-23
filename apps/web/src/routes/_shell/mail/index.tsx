import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MailShell } from "@/features/mail/mail-shell";

// Mail URL state — drill-down (folder + tab + selected thread + search
// query) round-trips through the URL so the back button restores the
// previous view and links are shareable.
const mailSearchSchema = z.object({
  folder: z.string().optional().catch(undefined),
  tab: z.enum(["primary","social","promotions","updates","forums"]).optional().catch(undefined),
  thread: z.string().uuid().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_shell/mail/")({
  component: MailRoute,
  validateSearch: (search) => mailSearchSchema.parse(search),
});

function MailRoute() {
  return <MailShell />;
}
