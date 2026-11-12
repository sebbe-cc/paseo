export type {
  PluginHostProps,
  PluginTab,
  PluginPanelProps,
  PluginWorkspacePanelParams,
  PluginAgentPanelParams,
  PluginFilePanelParams,
  PluginAgentPanelContribution,
  PluginFilePanelContribution,
  PluginFilePanelProps,
  PluginTimelineSelection,
  PluginTimelineSelectionSegment,
  PluginTimelineSelectionActionProps,
  PluginTimelineSelectionActionContribution,
  PluginSurfaceProps,
  PluginScreenProps,
  PluginPopoverProps,
  PluginScreenParams,
  PluginOpenScreenInput,
  PluginScreenLocation,
  PluginSidebarItemProps,
  PluginSidebarViewProps,
  PluginSidebarViewContribution,
  PluginSidebarItemContribution,
  PluginIcon,
  PluginPanelLocation,
  PluginOpenPanelOptions,
  PluginPanelSplit,
  PluginWorkspacePanelProps,
  PluginAgentPanelProps,
  PluginClientOpenPanelOptions,
  PluginClientContext,
  PluginNavigationLocation,
  PluginRecentNavigation,
  PluginKeyboardShortcutContribution,
  PluginClientContribution,
  PluginWorkspacePanelContribution,
  PluginSettingsScreenContribution,
  PluginSurfaceContribution,
  PluginScreenContribution,
  PluginScreenTitle,
  PluginSidebarContribution,
  PluginTimelineTransformerContribution,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginInlineDecorationTone,
  PluginInlineDecoration,
  PluginInlineDecoratorMatch,
  PluginInlineDecoratorContribution,
  PluginInlineDecoratorRegistration,
  PluginWorkspaceLabelPresenterInput,
  PluginWorkspaceLabelDisplay,
  PluginWorkspaceLabelPresenterResult,
  PluginWorkspaceLabelPresenterContribution,
  PluginCommandCapabilities,
  PluginGlobalCommandContext,
  PluginWorkspaceCommandContext,
  PluginAgentCommandContext,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  SettingsState,
  PluginSettingsSnapshot,
} from "./contracts.js";
export type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonContext,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "./buttons.js";
export type { PluginIconProps, PluginSerializableIcon, PluginSvgIcon } from "../icons.js";
export type {
  PluginFile,
  PluginFileBytesState,
  PluginFileEvent,
  PluginFileTextState,
  PluginFileUrlState,
  PluginFileWriteOptions,
} from "./file.js";
export type {
  PluginHidUsagePair,
  PluginHidDeviceInfo,
  PluginHidBrokerState,
  PluginHidControlEvent,
  PluginHidRawReport,
  PluginHidBroker,
  PluginDeviceOwner,
  PluginHidCapability,
} from "./hid.js";
export type {
  PluginClientPane,
  PluginClientContextSnapshot,
  PluginRouteTarget,
  PluginClientContextCapability,
} from "./client-context.js";
export {
  PluginFileConflictError,
  PluginFileDeletedError,
  useFileBytes,
  useFileText,
  useFileUrl,
} from "./file.js";
export type {
  PluginClientActionsCapabilities,
  PluginClientActionsCapability,
  PluginClientActionsTarget,
  PluginPanelNavigationTarget,
  PluginPanelScrollAmount,
  PluginPanelScrollDirection,
} from "./client-actions.js";
export { usePaseo } from "./paseo-context.js";
export {
  useAgent,
  useWorkspace,
  useProject,
  useTerminal,
  useWorkspaces,
  useAgents,
  useProjects,
  useTerminals,
} from "./client-state.js";
export { useComposer, useComposers } from "./composer.js";
export type {
  PluginComposer,
  PluginComposerAttachment,
  PluginComposerFocusOptions,
  PluginComposerItemContribution,
  PluginComposerItemProps,
  PluginComposerSelector,
} from "./composer.js";
export { useNewWorkspace } from "./new-workspace.js";
export type {
  PluginNewWorkspace,
  PluginNewWorkspaceItemContribution,
  PluginNewWorkspaceItemProps,
} from "./new-workspace.js";
export { useRpc, useSubscription, type PluginSubscriptionState } from "./rpc-context.js";
export type {
  PluginSubscribeOptions,
  PluginSubscriptionClosed,
  PluginSubscriptionHandle,
} from "../rpc.js";
import type { SettingsDefinition } from "../settings.js";
import type { SettingsState } from "./contracts.js";
import type { ZodType } from "zod";
export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

/** Configured app host, including hosts that are currently disconnected. */
export interface PluginHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}
/** Live configured hosts. Supplied by the app's client bundle loader. */
export declare function useHosts(): readonly PluginHostSummary[];
/** Borrow an online host's API under this installation's lifetime. */
export declare function getPaseoClient(serverId: string): import("@getpaseo/client").PaseoApi;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

export { defineTranslations, useTranslation } from "./translations.js";
export type { PluginI18n } from "./translations.js";
export type { PluginText, PluginMessage, PluginTranslations } from "../text.js";

export { useTabState } from "./tab.js";

export type { WorkspaceRef, AgentRef, ProjectRef, TerminalRef } from "../refs.js";
export type { Query, Group, GroupKey } from "./query.js";

export type { PluginPaseoApi, PluginProjectHandle, PluginTerminalHandle } from "./reference-api.js";
