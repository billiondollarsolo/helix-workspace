import { QueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { ColorMode, ColorModeApi } from "./theme";

export interface Actor {
  id: string;
  displayName: string;
  email: string;
  roles: readonly string[];
}

export interface Session {
  actor: Actor;
  authenticated: boolean;
}

export interface TRPCClient {
  readonly endpoint: string;
}

export interface PresetTokens {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  border: string;
  radius: string;
}

export interface ShellRoute {
  id: string;
  path: `/${string}`;
  label: string;
  pluginId: string;
  order?: number;
}

export interface LeftRailItem {
  id: string;
  route: `/${string}`;
  label: string;
  icon: LucideIcon;
  pluginId: string;
  order?: number;
  shortcut?: string;
  getBadge?: () => Promise<number | string | undefined>;
  adminOnly?: boolean;
}

export interface PanelExtension {
  id: string;
  pluginId: string;
  label: string;
  order?: number;
  appliesTo: (routePath: string) => boolean;
  render: () => ReactNode;
}

export interface CommandItem {
  id: string;
  pluginId: string;
  label: string;
  group?: string;
  keywords?: readonly string[];
  shortcut?: string;
  run: () => void | Promise<void>;
}

export interface SettingsPage {
  id: string;
  pluginId: string;
  path: `/${string}`;
  label: string;
  order?: number;
}

export interface SuggestionSlotDef {
  id: string;
  pluginId: string;
  label: string;
  description?: string;
  order?: number;
}

export type SuggestionClassification = "public" | "standard" | "confidential" | "restricted";

export interface SuggestionSlotResource {
  type: string;
  id: string;
  label?: string;
}

export interface SuggestionSlotContext {
  slotId: string;
  routePath?: string;
  resource?: SuggestionSlotResource;
  classification?: SuggestionClassification;
  input?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SuggestionSlotProviderRenderContext {
  slot: SuggestionSlotDef | undefined;
  context: SuggestionSlotContext;
}

export interface SuggestionSlotProvider {
  id: string;
  pluginId: string;
  slotId: string;
  label: string;
  order?: number;
  available?: (context: SuggestionSlotContext) => boolean | Promise<boolean>;
  render: (context: SuggestionSlotProviderRenderContext) => ReactNode;
}

export interface PreviewRenderer {
  pluginId: string;
  render: (sourceUrl: string) => ReactNode;
}

export interface WebPlatformHost {
  useSession(): Session;
  useActor(): Actor;
  useColorMode(): ColorModeApi;
  readonly trpc: TRPCClient;
  readonly queryClient: QueryClient;
  registerShellRoute(route: ShellRoute): void;
  registerLeftRailItem(item: LeftRailItem): void;
  registerRightRailPanel(panel: PanelExtension): void;
  registerCommandPaletteItems(items: readonly CommandItem[]): void;
  registerSettingsPage(page: SettingsPage): void;
  registerSuggestionSlot(slot: SuggestionSlotDef): void;
  registerSuggestionSlotProvider(slotId: string, provider: SuggestionSlotProvider): void;
  registerPreviewRenderer(mime: string, renderer: PreviewRenderer): void;
  getShellRoutes(): readonly ShellRoute[];
  getLeftRailItems(): readonly LeftRailItem[];
  getRightRailPanels(routePath: string): readonly PanelExtension[];
  getCommandPaletteItems(): readonly CommandItem[];
  getSettingsPages(): readonly SettingsPage[];
  getSuggestionSlots(): readonly SuggestionSlotDef[];
  getSuggestionSlot(slotId: string): SuggestionSlotDef | undefined;
  getSuggestionSlotProviders(slotId: string): readonly SuggestionSlotProvider[];
  getPreviewRenderer(mime: string): PreviewRenderer | undefined;
  getSnapshotVersion(): number;
  subscribe(listener: () => void): () => void;
  readonly tokens: PresetTokens;
  readonly colorMode: ColorMode;
}

export interface CreateWebPlatformHostOptions {
  queryClient: QueryClient;
  trpc?: TRPCClient;
  session?: Session;
  tokens?: Partial<PresetTokens>;
  getColorMode: () => ColorMode;
}

const fallbackActor: Actor = {
  id: "local-user",
  displayName: "Local User",
  email: "user@helix.local",
  roles: ["admin"]
};

const fallbackSession: Session = {
  actor: fallbackActor,
  authenticated: true
};

const defaultTokens: PresetTokens = {
  background: "var(--background)",
  foreground: "var(--foreground)",
  primary: "var(--primary)",
  primaryForeground: "var(--primary-foreground)",
  border: "var(--border)",
  radius: "var(--radius)"
};

function byOrderThenLabel<T extends { order?: number; label: string }>(left: T, right: T) {
  return (left.order ?? 1000) - (right.order ?? 1000) || left.label.localeCompare(right.label);
}

export function createWebPlatformHost(options: CreateWebPlatformHostOptions): WebPlatformHost {
  const listeners = new Set<() => void>();
  const shellRoutes = new Map<string, ShellRoute>();
  const leftRailItems = new Map<string, LeftRailItem>();
  const rightRailPanels = new Map<string, PanelExtension>();
  const commandItems = new Map<string, CommandItem>();
  const settingsPages = new Map<string, SettingsPage>();
  const suggestionSlots = new Map<string, SuggestionSlotDef>();
  const suggestionSlotProviders = new Map<string, SuggestionSlotProvider>();
  const previewRenderers = new Map<string, PreviewRenderer>();
  let snapshotVersion = 0;

  const emit = () => {
    snapshotVersion += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  const host: WebPlatformHost = {
    trpc: options.trpc ?? { endpoint: "/trpc" },
    queryClient: options.queryClient,
    tokens: { ...defaultTokens, ...options.tokens },
    get colorMode() {
      return options.getColorMode();
    },
    useSession() {
      return options.session ?? fallbackSession;
    },
    useActor() {
      return (options.session ?? fallbackSession).actor;
    },
    useColorMode() {
      throw new Error("useColorMode must be provided by ColorModeProvider.");
    },
    registerShellRoute(route) {
      shellRoutes.set(route.id, route);
      emit();
    },
    registerLeftRailItem(item) {
      leftRailItems.set(item.id, item);
      emit();
    },
    registerRightRailPanel(panel) {
      rightRailPanels.set(panel.id, panel);
      emit();
    },
    registerCommandPaletteItems(items) {
      for (const item of items) {
        commandItems.set(item.id, item);
      }
      emit();
    },
    registerSettingsPage(page) {
      settingsPages.set(page.id, page);
      emit();
    },
    registerSuggestionSlot(slot) {
      suggestionSlots.set(slot.id, slot);
      emit();
    },
    registerSuggestionSlotProvider(slotId, provider) {
      suggestionSlotProviders.set(`${slotId}:${provider.id}`, { ...provider, slotId });
      emit();
    },
    registerPreviewRenderer(mime, renderer) {
      previewRenderers.set(mime, renderer);
      emit();
    },
    getShellRoutes() {
      return [...shellRoutes.values()].sort(byOrderThenLabel);
    },
    getLeftRailItems() {
      return [...leftRailItems.values()].sort(byOrderThenLabel);
    },
    getRightRailPanels(routePath) {
      return [...rightRailPanels.values()]
        .filter((panel) => panel.appliesTo(routePath))
        .sort(byOrderThenLabel);
    },
    getCommandPaletteItems() {
      return [...commandItems.values()].sort(byOrderThenLabel);
    },
    getSettingsPages() {
      return [...settingsPages.values()].sort(byOrderThenLabel);
    },
    getSuggestionSlots() {
      return [...suggestionSlots.values()].sort(byOrderThenLabel);
    },
    getSuggestionSlot(slotId) {
      return suggestionSlots.get(slotId);
    },
    getSuggestionSlotProviders(slotId) {
      return [...suggestionSlotProviders.values()]
        .filter((provider) => provider.slotId === slotId)
        .sort(byOrderThenLabel);
    },
    getPreviewRenderer(mime) {
      return previewRenderers.get(mime);
    },
    getSnapshotVersion() {
      return snapshotVersion;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };

  return host;
}

const WebPlatformContext = createContext<WebPlatformHost | null>(null);

export function WebPlatformProvider({
  children,
  host,
  useColorMode
}: {
  children: ReactNode;
  host: WebPlatformHost;
  useColorMode: () => ColorModeApi;
}) {
  const value = useMemo<WebPlatformHost>(
    () => ({
      ...host,
      useColorMode
    }),
    [host, useColorMode]
  );

  return <WebPlatformContext.Provider value={value}>{children}</WebPlatformContext.Provider>;
}

export function useWebPlatformHost() {
  const host = useContext(WebPlatformContext);
  if (!host) {
    throw new Error("useWebPlatformHost must be used inside WebPlatformProvider.");
  }
  return host;
}

export function usePlatformSnapshot<T>(selector: (host: WebPlatformHost) => T): T {
  const host = useWebPlatformHost();
  const getSnapshot = useCallback(() => host.getSnapshotVersion(), [host]);
  const subscribe = useCallback((listener: () => void) => host.subscribe(listener), [host]);
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => selector(host), [host, selector, version]);
}

interface AvailabilityState {
  status: "loading" | "ready";
  providers: readonly SuggestionSlotProvider[];
}

function useAvailableSuggestionProviders(
  providers: readonly SuggestionSlotProvider[],
  context: SuggestionSlotContext
): AvailabilityState {
  const [state, setState] = useState<AvailabilityState>({ status: "ready", providers });

  useEffect(() => {
    let active = true;

    setState({ status: "loading", providers: [] });

    void Promise.all(
      providers.map(async (provider) => {
        const available = await Promise.resolve(provider.available?.(context) ?? true).catch(() => false);
        return { provider, available };
      })
    ).then((results) => {
      if (!active) {
        return;
      }

      setState({
        status: "ready",
        providers: results.filter((result) => result.available).map((result) => result.provider)
      });
    });

    return () => {
      active = false;
    };
  }, [context, providers]);

  return state;
}

export interface SuggestionSlotProps {
  slotId: string;
  context?: Omit<SuggestionSlotContext, "slotId">;
  className?: string;
  emptyFallback?: ReactNode;
  loadingFallback?: ReactNode;
  renderProvider?: (provider: SuggestionSlotProvider, rendered: ReactNode) => ReactNode;
}

export function SuggestionSlot({
  slotId,
  context,
  className,
  emptyFallback = null,
  loadingFallback = null,
  renderProvider
}: SuggestionSlotProps) {
  const selectSlot = useCallback((host: WebPlatformHost) => host.getSuggestionSlot(slotId), [slotId]);
  const selectProviders = useCallback((host: WebPlatformHost) => host.getSuggestionSlotProviders(slotId), [slotId]);
  const slot = usePlatformSnapshot(selectSlot);
  const providers = usePlatformSnapshot(selectProviders);
  const slotContext = useMemo<SuggestionSlotContext>(() => ({ ...context, slotId }), [context, slotId]);
  const availability = useAvailableSuggestionProviders(providers, slotContext);

  if (availability.status === "loading") {
    return loadingFallback;
  }

  if (availability.providers.length === 0) {
    return emptyFallback;
  }

  return (
    <div className={className} data-suggestion-slot={slotId}>
      {availability.providers.map((provider) => {
        const rendered = provider.render({ slot, context: slotContext });
        return (
          <div data-suggestion-provider={provider.id} key={provider.id}>
            {renderProvider ? renderProvider(provider, rendered) : rendered}
          </div>
        );
      })}
    </div>
  );
}
