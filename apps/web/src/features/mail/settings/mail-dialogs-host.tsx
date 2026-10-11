/* Mounted once by the app shell. Renders the dialog asked for through
   `openFilterDialog` / `openLabelDialog`, wherever the request came from. */

import { lazy, Suspense } from "react";
import { useOpenMailDialog } from "./dialog-store";

const MailDialogs = lazy(() => import("./mail-dialogs"));

export function MailDialogsHost() {
  const open = useOpenMailDialog();
  if (open === null) return null;
  return (
    <Suspense fallback={null}>
      <MailDialogs key={open.seq} request={open.request} />
    </Suspense>
  );
}
