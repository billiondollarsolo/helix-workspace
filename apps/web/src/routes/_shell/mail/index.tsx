import { createFileRoute } from "@tanstack/react-router";
import { MailShell } from "@/features/mail/mail-shell";
import { MAIL_TAB_IDS } from "@/features/mail/mail-taxonomy";
import { mailComposeHandoffFromSearch, type MailComposeHandoff } from "@/features/people/handoff";
import {
  optionalEnumSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
} from "@/lib/search-params";

// Mail URL state — folder, Inbox tab, label, search query and the open
// thread round-trip through the URL so the back button restores the view
// and links are shareable. The settings overlay deep link (`?settings=`) is
// declared once by the `_shell` parent route.
interface ShellMailRouteSearch extends MailComposeHandoff {
  readonly folder?: string;
  readonly tab?: (typeof MAIL_TAB_IDS)[number];
  readonly thread?: string;
  readonly q?: string;
  readonly label?: string;
}

export const Route = createFileRoute("/_shell/mail/")({
  component: MailShell,
  validateSearch: (search): ShellMailRouteSearch => {
    const folder = optionalStringSearchParam(search.folder);
    const tab = optionalEnumSearchParam(search.tab, MAIL_TAB_IDS);
    const thread = optionalUuidSearchParam(search.thread);
    const q = optionalStringSearchParam(search.q);
    const label = optionalStringSearchParam(search.label);
    return {
      ...(folder === undefined ? {} : { folder }),
      ...(tab === undefined ? {} : { tab }),
      ...(thread === undefined ? {} : { thread }),
      ...(q === undefined ? {} : { q }),
      ...(label === undefined ? {} : { label }),
      ...mailComposeHandoffFromSearch(search),
    };
  },
});
