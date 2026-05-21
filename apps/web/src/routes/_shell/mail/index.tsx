import { createFileRoute } from "@tanstack/react-router";
import {
  mailSearchInputFromRouteSearch,
  mailSearchQueryOptions,
  mailThreadQueryOptions,
  validateMailRouteSearch,
} from "@/features/mail/queries";

export const Route = createFileRoute("/_shell/mail/")({
  validateSearch: validateMailRouteSearch,
  loaderDeps: ({ search }) => ({
    thread: search.thread,
    query: search.q,
    label: search.label,
  }),
  loader: async ({ context, deps }) => {
    const searchInput = mailSearchInputFromRouteSearch({
      q: deps.query,
      label: deps.label,
    });

    await Promise.all([
      context.queryClient
        .ensureQueryData(mailSearchQueryOptions(searchInput))
        .catch(() => undefined),
      deps.thread
        ? context.queryClient
            .ensureQueryData(mailThreadQueryOptions(deps.thread))
            .catch(() => undefined)
        : Promise.resolve(),
    ]);
  },
});
