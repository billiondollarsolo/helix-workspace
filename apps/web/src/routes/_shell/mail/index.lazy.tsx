import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { MailShell } from "@/features/mail/mail-shell";
import { mailRouteSearchFromState, mailSearchStateFromRouteSearch } from "@/features/mail/queries";

export const Route = createLazyFileRoute("/_shell/mail/")({
  component: MailRoute,
});

function MailRoute() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { message, thread } = search;

  return (
    <CoreAppGate app="mail">
      <MailShell
        initialMessageId={message}
        initialThreadId={thread}
        onSearchStateChange={(state) => {
          void navigate({
            to: "/mail",
            search: mailRouteSearchFromState(state, { message, thread }),
          });
        }}
        onThreadRouteStateChange={(threadState, state) => {
          void navigate({
            to: "/mail",
            search: mailRouteSearchFromState(state, {
              message: threadState.messageId,
              thread: threadState.threadId,
            }),
          });
        }}
        searchState={mailSearchStateFromRouteSearch(search)}
      />
    </CoreAppGate>
  );
}
