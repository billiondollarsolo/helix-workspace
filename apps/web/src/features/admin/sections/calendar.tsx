/* Admin › Apps › Calendar. */

import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { PageHeading } from "@/features/admin/console/primitives";

export { prefetchAdminAppSettingsQueries } from "@/features/admin/console/app-settings";

const CALENDAR_FLAGS = [
  {
    key: "calendar_import_invitations",
    label: "Import calendar invitations from email",
    description:
      "Adds events from invitations people receive by email to their calendars. Off by default.",
  },
] as const;

export function CalendarAdminSection() {
  return (
    <>
      <PageHeading title="Calendar" subtitle="Calendar availability and invitations." />
      <div className="admin-stack">
        <AppStatusPanel appId="calendar" />
        <WorkspaceFlagsPanel title="Invitations" flags={CALENDAR_FLAGS} />
      </div>
    </>
  );
}
