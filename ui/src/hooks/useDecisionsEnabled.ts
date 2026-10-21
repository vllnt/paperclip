import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";

/**
 * Decisions (Settings > Experimental): the Inbox's Decide and Alerts tabs, the
 * attention curtains on its Archived tab, and their share of the Inbox badge.
 * Off until the settings load.
 */
export function useDecisionsEnabled(): boolean {
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return experimentalSettings?.enableDecisions === true;
}
