import { useEffect } from "react";
import { useNavigate } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../../components/PageTabBar";
import { useCombinedInboxTasksEnabled } from "../../hooks/useCombinedInboxTasksEnabled";
import { useDecisionsEnabled } from "../../hooks/useDecisionsEnabled";
import {
  INBOX_MODULE_TAB_LABELS,
  isInboxAttentionTab,
  saveLastInboxTab,
  visibleInboxModuleTabs,
  type InboxModuleTab,
} from "../../lib/inbox";
import { Inbox } from "../Inbox";
import { InboxArchivedTab } from "./InboxArchivedTab";
import { InboxAttentionTab } from "./InboxAttentionTab";

/**
 * The Inbox: one page for everything that needs the board, one tab per kind.
 *   - Decide / Alerts: the open attention feed (decisions, approvals, queues;
 *     stuck work), when the Decisions setting is on.
 *   - Mine / Recent / Unread / Blocked / All: task tabs, unless Combined Inbox
 *     + Task List hosts them in Tasks.
 *   - Archived: what left the other tabs.
 * The page owns the tab bar and hands it to the tab, which places it in its
 * own toolbar.
 */
export function InboxPage({ tab }: { tab: InboxModuleTab }) {
  const navigate = useNavigate();
  const decisionsEnabled = useDecisionsEnabled();
  const { enabled: issueTabsInTasks } = useCombinedInboxTasksEnabled();

  useEffect(() => {
    saveLastInboxTab(tab);
  }, [tab]);

  const items = visibleInboxModuleTabs({ decisionsEnabled, issueTabsInTasks, current: tab }).map((value) => ({
    value,
    label: INBOX_MODULE_TAB_LABELS[value],
  }));
  const openTab = (value: string) => navigate(`/inbox/${value}`);
  const tabBar = (
    <Tabs value={tab} onValueChange={openTab}>
      <PageTabBar items={items} value={tab} onValueChange={openTab} />
    </Tabs>
  );

  if (isInboxAttentionTab(tab)) return <InboxAttentionTab key={tab} tab={tab} tabBar={tabBar} />;
  if (tab === "archived") return <InboxArchivedTab tabBar={tabBar} decisionsEnabled={decisionsEnabled} />;
  return <Inbox tab={tab} toolbarContext={tabBar} />;
}
