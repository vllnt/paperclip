import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { COMMAND_ACTIONS, type CommandActionDefinition } from "@paperclipai/shared/command-actions";
import { recordCommandActionUse, type CommandActionUsage } from "@paperclipai/shared/command-action-rank";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import {
  getCommandActionUsageStorageKey,
  readCommandActionUsage,
  writeCommandActionUsage,
} from "../lib/command-action-usage";
import { useCompany } from "./CompanyContext";

/** A handler for one catalog action. */
export interface CommandActionBinding {
  run: () => void;
  /** Replaces the catalog title, e.g. "My work" for the inbox. */
  title?: string;
}

/**
 * Handlers by catalog action id. A missing or null entry means "this page
 * does not provide the action"; another provider (an older page or the
 * layout's global handlers) may still provide it.
 */
export type CommandActionBindings = Readonly<Record<string, CommandActionBinding | null | undefined>>;

/** A catalog action that has a handler right now. */
export interface AvailableCommandAction extends CommandActionDefinition {
  /** True when the current page registered the action. */
  contextual: boolean;
}

export interface CommandActionsValue {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  openCommandPalette: () => void;
  /** Available actions in catalog order. */
  actions: readonly AvailableCommandAction[];
  contextualIds: ReadonlySet<string>;
  usage: Readonly<Record<string, CommandActionUsage>>;
  /** Runs an available action and records the use. Returns false when it has no handler. */
  run: (actionId: string) => boolean;
  register: (ids: readonly string[], getBindings: () => CommandActionBindings) => () => void;
}

interface Registration {
  token: number;
  ids: readonly string[];
  getBindings: () => CommandActionBindings;
}

/** Imperative access for the layout shell, which renders the provider itself. */
export interface CommandActionsHandle {
  run: (actionId: string) => boolean;
  openCommandPalette: () => void;
}

type RegisterCommandActions = CommandActionsValue["register"];

const CommandActionsContext = createContext<CommandActionsValue | null>(null);
// Pages only need the stable `register`; a separate context keeps them from
// re-rendering whenever the palette opens or usage changes.
const CommandActionsRegistryContext = createContext<RegisterCommandActions | null>(null);

/** The newest page registration wins over older ones and over the global handlers. */
function resolveBinding(
  registrations: readonly Registration[],
  globalBindings: CommandActionBindings,
  actionId: string,
): { binding: CommandActionBinding; contextual: boolean } | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (!registration?.ids.includes(actionId)) continue;
    const binding = registration.getBindings()[actionId];
    if (binding) return { binding, contextual: true };
  }
  const binding = globalBindings[actionId];
  return binding ? { binding, contextual: false } : null;
}

function useCommandActionsController(globalBindings: CommandActionBindings): CommandActionsValue {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const nextTokenRef = useRef(0);
  const globalBindingsRef = useRef(globalBindings);
  useLayoutEffect(() => {
    globalBindingsRef.current = globalBindings;
  });

  const { selectedCompanyId } = useCompany();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: !!selectedCompanyId,
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const storageKey = selectedCompanyId ? getCommandActionUsageStorageKey(selectedCompanyId, userId) : null;
  const [usage, setUsage] = useState<Record<string, CommandActionUsage>>({});
  const usageRef = useRef(usage);
  useEffect(() => {
    const stored = storageKey ? readCommandActionUsage(storageKey) : {};
    usageRef.current = stored;
    setUsage(stored);
  }, [storageKey]);

  const register = useCallback((ids: readonly string[], getBindings: () => CommandActionBindings) => {
    nextTokenRef.current += 1;
    const token = nextTokenRef.current;
    setRegistrations((current) => [...current, { token, ids, getBindings }]);
    return () => setRegistrations((current) => current.filter((entry) => entry.token !== token));
  }, []);

  const actions = useMemo(() => {
    const available: AvailableCommandAction[] = [];
    for (const action of COMMAND_ACTIONS) {
      const resolved = resolveBinding(registrations, globalBindings, action.id);
      if (!resolved) continue;
      available.push({ ...action, title: resolved.binding.title ?? action.title, contextual: resolved.contextual });
    }
    return available;
  }, [registrations, globalBindings]);

  const contextualIds = useMemo(
    () => new Set(actions.filter((action) => action.contextual).map((action) => action.id)),
    [actions],
  );

  const run = useCallback((actionId: string) => {
    const resolved = resolveBinding(registrations, globalBindingsRef.current, actionId);
    if (!resolved) return false;
    const nextUsage = recordCommandActionUse(usageRef.current, actionId, Date.now());
    usageRef.current = nextUsage;
    setUsage(nextUsage);
    if (storageKey) writeCommandActionUsage(storageKey, nextUsage);
    resolved.binding.run();
    return true;
  }, [registrations, storageKey]);

  const openCommandPalette = useCallback(() => setPaletteOpen(true), []);

  return useMemo(() => ({
    paletteOpen,
    setPaletteOpen,
    openCommandPalette,
    actions,
    contextualIds,
    usage,
    run,
    register,
  }), [paletteOpen, openCommandPalette, actions, contextualIds, usage, run, register]);
}

/**
 * Holds the launcher state: palette open state, page registrations and
 * frecency. Each layout shell wraps its tree in this provider and reaches it
 * through `handleRef`. Keeping the state here, not in the layout, means that
 * opening the palette re-renders only the palette.
 */
export function CommandActionsProvider({
  globalBindings,
  handleRef,
  children,
}: {
  globalBindings: CommandActionBindings;
  handleRef?: Ref<CommandActionsHandle>;
  children: ReactNode;
}) {
  const value = useCommandActionsController(globalBindings);
  const { run, openCommandPalette, register } = value;
  useImperativeHandle(handleRef, () => ({ run, openCommandPalette }), [run, openCommandPalette]);
  return (
    <CommandActionsRegistryContext.Provider value={register}>
      <CommandActionsContext.Provider value={value}>{children}</CommandActionsContext.Provider>
    </CommandActionsRegistryContext.Provider>
  );
}

export function useCommandActions(): CommandActionsValue {
  const value = useContext(CommandActionsContext);
  if (!value) throw new Error("useCommandActions must be used inside a CommandActionsProvider");
  return value;
}

/**
 * Registers the current page's contextual actions while it is mounted. The
 * handlers are read when an action runs, so they can change every render;
 * the registration changes only when the set of available ids changes.
 */
export function useRegisterCommandActions(bindings: CommandActionBindings): void {
  const register = useContext(CommandActionsRegistryContext);
  const bindingsRef = useRef(bindings);
  useLayoutEffect(() => {
    bindingsRef.current = bindings;
  });
  const idsKey = Object.keys(bindings).filter((id) => bindings[id]).sort().join("\n");
  useEffect(() => {
    if (!register || !idsKey) return undefined;
    return register(idsKey.split("\n"), () => bindingsRef.current);
  }, [register, idsKey]);
}
