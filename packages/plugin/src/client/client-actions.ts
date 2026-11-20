// Generic app-action capability for trusted hardware controls (pa-84qjv2).
// Types only: no Node or React Native imports here, so the client boundary
// (boundaries.test.ts) holds and the client bundle never imports node:.
//
// This is the host half of the plugin's app-action contract
// (plugins/creator-micro/shared/app-actions.ts in fleet/paseo): same
// field names and shapes, so a plugin can consume an app-provided
// capability structurally. Voice hooks the app's existing
// dictation/voice pipeline — never a new pipeline, never a fabricated
// transcription, never in browser/mobile. Scroll acts on the focused
// panel via client-context and works without a mounted plugin panel.
// No vendor rules here — no VID/PID, report codes or LED policies.
// Those belong to the plugin.

/** Route target: the exact {serverId, agentId} pair, never a bare agentId. */
export interface PluginClientActionsTarget {
  serverId: string;
  agentId: string;
}

export type PluginPanelScrollDirection = "up" | "down";

export type PluginPanelScrollAmount = "page" | "step";

export type PluginPanelNavigationTarget = "history" | "sidebar" | "forward" | "back";

/**
 * Per-part capability prob. The plugin probes each part separately:
 * voice and scroll go live independently, and every missing part is
 * an honest `unsupported` with reason — never a crash, never a
 * WebHID fallback.
 */
export interface PluginClientActionsCapabilities {
  voiceInput: boolean;
  panelScroll: boolean;
}

/**
 * Trusted app-action surface on the client context. Present only on
 * clients whose app implements it (desktop); undefined on older apps,
 * browser and mobile, where the plugin reports "unsupported" and
 * stays a no-op. App-owned with app lifetime: subscribe in
 * contribute() and release in cleanup.
 *
 * Joystick navigation is gated under `panelScroll` — there is no
 * separate joystick flag.
 */
export interface PluginClientActionsCapability {
  getCapabilities(): PluginClientActionsCapabilities;
  /**
   * Hold-to-talk: starts the app's existing dictation/voice pipeline
   * for the target agent. The press-moment requestId is captured
   * plugin-side and travels with routing; the app stops on dropped
   * release, window change and disconnect as the last guarantor, so
   * the microphone is never left on.
   */
  startVoiceInput(target: PluginClientActionsTarget): Promise<void>;
  /** Release-to-send: stops the pipeline and delivers the transcript. */
  stopVoiceInput(): Promise<void>;
  /**
   * Scrolls the focused panel without requiring a mounted plugin
   * panel; never a global daemon-status fallback.
   */
  scrollFocusedPanel(direction: PluginPanelScrollDirection, amount: PluginPanelScrollAmount): void;
  /**
   * Joystick: up/down navigate history/sidebar, left/right navigate
   * forward/back. Sector names stay working assumptions until
   * light/capture proof confirms them.
   */
  navigatePanel(target: PluginPanelNavigationTarget): void;
}
