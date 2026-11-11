import { createPlayAudio, type AudioEngine } from "@/audio";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { getPluginClientApi } from "./client-state/api";
import type { PluginClientOpenPanelOptions } from "@getpaseo/plugin/client";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import {
  createAppClientActionsCapability,
  createDomPanelResolver,
  createWebPanelNavigator,
} from "./client-actions";
import { createVoiceAudioSource, isVoiceCaptureAvailable } from "./voice-capture";
import { createPluginVoiceInput, isPackagedDesktopVoiceHost } from "./voice-pipeline";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import { getAppClientContextCapability, getAppHidCapability } from "./devices/app-context";
import type { InstalledPlugin } from "./types";
import { pluginKeyboardShortcuts } from "./keyboard-shortcuts";
import { pluginRecentNavigation } from "./recent-navigation";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  audio: Pick<AudioEngine, "play">,
): PluginClientRuntime {
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    hid: getAppHidCapability(),
    clientContext: getAppClientContextCapability(),
    i18n: installation.i18n,
    playAudio: createPlayAudio(audio, installation.lifetime.signal),
    navigation: pluginRecentNavigation,
    addKeyboardShortcut: (contribution) =>
      pluginKeyboardShortcuts.add(installation.serverId, installation.id, contribution),
    // Panel scroll/navigation live on DOM hosts. Voice hold-to-talk is
    // glued to the production dictation pipeline (mic capture +
    // DictationStreamSender + daemon stream client, transcript delivered
    // to the routed agent on release) where those pieces exist — packaged
    // desktop only. Everywhere else voiceInput probes false and the plugin
    // reports unsupported instead of crashing or faking a transcript.
    clientActions: createAppClientActionsCapability({
      voice: createPluginVoiceInput({
        isDesktopHost: isPackagedDesktopVoiceHost,
        isCaptureAvailable: () => isVoiceCaptureAvailable(),
        resolveClient: (serverId) => getHostRuntimeStore().getClient(serverId),
        createAudioSource: (config) => createVoiceAudioSource(config),
      }),
      panels: createDomPanelResolver(),
      navigator: createWebPanelNavigator(),
    }),
    hosts: getPluginClientApi(installation).hosts,
    addComposerPill(contribution) {
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, state, panelId, options });
    },
    subscribe: (contract, input, onEvent, options) =>
      subscribePluginRpc(contract, installation.subscribe, input, onEvent, options),
  };
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = options.agentId?.trim();
  const navigation = createPluginNavigation({
    serverId: installation.serverId,
    workspaceId,
  });
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
        agentId,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  action.openPanel(panelId, {
    location: options.location,
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.newTab === true ? { newTab: true as const } : {}),
  });
}
