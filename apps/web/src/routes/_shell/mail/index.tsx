import { createFileRoute } from "@tanstack/react-router";
import { MailShell } from "@/features/mail/mail-shell";
import {
  optionalEnumSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
} from "@/lib/search-params";

// Mail URL state — drill-down (folder + tab + selected thread + search
// query) round-trips through the URL so the back button restores the
// previous view and links are shareable.
const mailTabs = ["primary", "social", "promotions", "updates", "forums"] as const;

interface ShellMailRouteSearch {
  readonly folder?: string;
  readonly tab?: (typeof mailTabs)[number];
  readonly thread?: string;
  readonly q?: string;
  readonly label?: string;
}

export const Route = createFileRoute("/_shell/mail/")({
  component: MailRoute,
  validateSearch: (search): ShellMailRouteSearch => {
    const folder = optionalStringSearchParam(search.folder);
    const tab = optionalEnumSearchParam(search.tab, mailTabs);
    const thread = optionalUuidSearchParam(search.thread);
    const q = optionalStringSearchParam(search.q);
    const label = optionalStringSearchParam(search.label);
    return {
      ...(folder === undefined ? {} : { folder }),
      ...(tab === undefined ? {} : { tab }),
      ...(thread === undefined ? {} : { thread }),
      ...(q === undefined ? {} : { q }),
      ...(label === undefined ? {} : { label }),
    };
  },
});

function MailRoute() {
  return <MailShell />;
}
