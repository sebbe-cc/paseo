import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginTimelineSelection,
  PluginTimelineSelectionActionContribution,
  PluginTimelineSelectionActionProps,
} from "@getpaseo/plugin/client";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import {
  TimelineSelectionProvider,
  type TimelineSelectionContextValue,
} from "@/assistant-selection-copy/timeline-selection";
import { freezeTimelineSelection } from "@/assistant-selection-copy/snapshot";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneFocus } from "@/panels/pane-context";
import { MenuRoot, MenuSurface, useMenuContext, type Rect } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { Theme } from "@/styles/theme";
import { createTimelineSelectionComposer } from "./composer";
import { createPluginClientStateSource } from "../client-state/source";
import { pluginRegistry, useInstalledPlugins } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin } from "../types";

const FORM_STYLE = { padding: 12 };

function requestComposerFocus(draftKey: string) {
  useDraftStore.setState((state) => ({
    attachmentFocusRequestByDraftKey: {
      ...state.attachmentFocusRequestByDraftKey,
      [draftKey]: (state.attachmentFocusRequestByDraftKey[draftKey] ?? 0) + 1,
    },
  }));
}

interface SelectionSession {
  id: number;
  installation: InstalledPlugin;
  action: PluginTimelineSelectionActionContribution;
  selection: PluginTimelineSelection;
  anchor: Rect;
  lifetime: AbortController;
}

interface HostProps {
  serverId: string;
  agentId: string;
  enabled: boolean;
  children: ReactNode;
}

function SelectionForm({
  session,
  agentId,
  close,
  theme,
}: {
  session: SelectionSession;
  agentId: string;
  close(): void;
  theme: PluginTheme;
}) {
  const { installation, action, selection } = session;
  const serverId = installation.serverId;
  const client = useHostRuntimeClient(serverId);
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const { setAnchorRect, presentation } = useMenuContext("TimelineSelection");
  useEffect(() => {
    if (presentation === "popover") setAnchorRect(session.anchor);
  }, [setAnchorRect, presentation, session]);
  const composer = useMemo(() => {
    const draftKey = buildDraftStoreKey({ serverId, agentId });
    return createTimelineSelectionComposer({
      signal: session.lifetime.signal,
      installationSignal: installation.lifetime.signal,
      isRegistered: () =>
        pluginRegistry.getSnapshot().includes(installation) &&
        installation.timelineSelectionActions.includes(action),
      isConnected: () => getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus === "online",
      source: {
        pluginId: installation.id,
        sourceId: action.id,
        sourceTitle: action.title,
        sourceIcon: action.icon,
      },
      readDraft: () => {
        const store = useDraftStore.getState();
        const draft = store.getDraftInput(draftKey);
        if (!draft && store.drafts[draftKey]?.lifecycle === "active")
          throw new Error("Composer draft is still loading");
        return draft;
      },
      saveDraft: (draft) => useDraftStore.getState().saveDraftInput({ draftKey, draft }),
    });
  }, [session, installation, action, serverId, agentId]);
  if (!client) return null;
  const Content = action.Content;
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const props: PluginTimelineSelectionActionProps = {
    theme,
    host: {
      id: serverId,
      label: hosts.find((host) => host.serverId === serverId)?.label ?? serverId,
    },
    layout: { compact, platform },
    agentId,
    selection,
    composer,
    close,
  };
  return (
    <MenuSurface
      sheetTitle={action.title}
      side="bottom"
      minWidth={280}
      maxWidth={420}
      maxHeight={480}
      scrollable
    >
      <SurfaceErrorBoundary installation={installation} Surface={Content}>
        <PluginInstallationProvider plugin={installation}>
          <PluginClientStateProvider source={stateSource}>
            <View style={FORM_STYLE}>
              <Content {...props} />
            </View>
          </PluginClientStateProvider>
        </PluginInstallationProvider>
      </SurfaceErrorBoundary>
    </MenuSurface>
  );
}

const ThemedSelectionForm = withUnistyles(SelectionForm);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function TimelineSelectionHost({
  serverId,
  agentId,
  enabled: allowed,
  children,
}: HostProps) {
  const { isInteractive } = usePaneFocus();
  const retainedActive = useRetainedPanelActive();
  const enabled = allowed && isInteractive && retainedActive;
  const plugins = useInstalledPlugins();
  const connected = useHostRuntimeIsConnected(serverId);
  const [session, setSession] = useState<SelectionSession | null>(null);
  const active = useRef<SelectionSession | null>(null);
  const sequence = useRef(0);
  const origin = useRef({ serverId, agentId, enabled, connected });
  origin.current = { serverId, agentId, enabled, connected };
  if (!enabled || !connected) active.current?.lifetime.abort();
  const close = useCallback(() => {
    active.current?.lifetime.abort();
    active.current = null;
    setSession(null);
  }, []);
  const dismiss = useCallback(() => {
    close();
    requestAnimationFrame(() => {
      const current = origin.current;
      if (
        !active.current &&
        current.enabled &&
        current.connected &&
        current.serverId === serverId &&
        current.agentId === agentId
      ) {
        requestComposerFocus(buildDraftStoreKey({ serverId, agentId }));
      }
    });
  }, [close, serverId, agentId]);
  const actions = useMemo(
    () =>
      enabled && connected
        ? plugins
            .filter((plugin) => plugin.serverId === serverId)
            .flatMap((installation) =>
              installation.timelineSelectionActions.map((action) => ({
                id: `${installation.id}/${action.id}`,
                title: action.title,
                icon: action.icon,
              })),
            )
        : [],
    [plugins, serverId, enabled, connected],
  );
  const select = useCallback<TimelineSelectionContextValue["select"]>(
    (selection, actionId, anchor) => {
      const installation = plugins.find(
        (plugin) => plugin.serverId === serverId && actionId.startsWith(`${plugin.id}/`),
      );
      const action = installation?.timelineSelectionActions.find(
        (candidate) => `${installation.id}/${candidate.id}` === actionId,
      );
      if (
        !enabled ||
        !connected ||
        !installation ||
        !action ||
        !selection.text.trim() ||
        !selection.segments.length
      )
        return;
      active.current?.lifetime.abort();
      const next = {
        id: ++sequence.current,
        installation,
        action,
        selection: freezeTimelineSelection(selection),
        anchor: anchor ?? { x: 16, y: 80, width: 1, height: 1 },
        lifetime: new AbortController(),
      };
      active.current = next;
      setSession(next);
    },
    [plugins, serverId, enabled, connected],
  );
  useEffect(() => {
    if (
      session &&
      (!enabled ||
        !connected ||
        !plugins.includes(session.installation) ||
        !session.installation.timelineSelectionActions.includes(session.action))
    )
      close();
  }, [session, enabled, connected, plugins, close]);
  useEffect(() => close, [serverId, agentId, close]);
  const context = useMemo(() => ({ actions, select }), [actions, select]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) dismiss();
    },
    [dismiss],
  );
  return (
    <TimelineSelectionProvider value={context}>
      {children}
      {session ? (
        <MenuRoot
          dismissKeyboardOnOpen={false}
          open
          compactMode="sheet"
          onOpenChange={onOpenChange}
        >
          <ThemedSelectionForm
            key={session.id}
            session={session}
            agentId={agentId}
            close={dismiss}
            uniProps={themeMapping}
          />
        </MenuRoot>
      ) : null}
    </TimelineSelectionProvider>
  );
}
