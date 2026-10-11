/* Admin › Apps › Assistant: on/off, models, and workspace search. */

import { useAdminSectionTab } from "@/features/admin/admin-section-search";
import { AIProvidersManagement } from "@/features/admin/ai-providers-management";
import { AIRetrievalManagement } from "@/features/admin/ai-retrieval-management";
import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { PageHeading } from "@/features/admin/console/primitives";
import { AdminTabs } from "@/features/admin/console/tabs";

export { prefetchAdminAppSettingsQueries } from "@/features/admin/console/app-settings";

const ASSISTANT_TABS = [
  { id: "general", label: "General" },
  { id: "models", label: "Models" },
  { id: "search", label: "Workspace search" },
] as const;

type AssistantTab = (typeof ASSISTANT_TABS)[number]["id"];

const ASSISTANT_TAB_IDS = ASSISTANT_TABS.map((tab) => tab.id);

const SEARCH_FLAGS = [
  {
    key: "assistant_retrieval",
    label: "Assistant searches workspace content",
    description:
      "Lets Assistant use mail, files, chats, and events each person can already open to answer their questions.",
  },
] as const;

function AssistantSearch() {
  return (
    <div className="admin-stack">
      <WorkspaceFlagsPanel title="Workspace content" flags={SEARCH_FLAGS} />
      <AIRetrievalManagement />
    </div>
  );
}

const TAB_CONTENT: Record<AssistantTab, () => React.ReactNode> = {
  general: () => <AppStatusPanel appId="assistant" />,
  models: AIProvidersManagement,
  search: AssistantSearch,
};

export function AssistantAdminSection() {
  const [tab, selectTab] = useAdminSectionTab(ASSISTANT_TAB_IDS, "general", "assistant");
  const Content = TAB_CONTENT[tab];
  return (
    <>
      <PageHeading
        title="Assistant"
        subtitle="Who can use Assistant, which models it runs on, and what it can search."
      />
      <AdminTabs
        label="Assistant settings"
        idPrefix="assistant"
        tabs={ASSISTANT_TABS}
        selected={tab}
        onSelect={selectTab}
      >
        <Content />
      </AdminTabs>
    </>
  );
}
