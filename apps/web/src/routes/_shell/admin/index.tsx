import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_ADMIN_SECTION } from "@/features/admin/admin-console-data";

/* `/admin` is an alias for the console's landing section rather than a page of
 * its own, so the address bar always names the section actually on screen. */
export const Route = createFileRoute("/_shell/admin/")({
  beforeLoad: () => {
    // TanStack Router signals navigation by throwing a redirect.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/admin/$section", params: { section: DEFAULT_ADMIN_SECTION } });
  },
});
