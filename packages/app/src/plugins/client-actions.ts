import type {
  PluginClientActionsCapabilities,
  PluginClientActionsCapability,
  PluginClientActionsTarget,
  PluginPanelNavigationTarget,
  PluginPanelScrollAmount,
  PluginPanelScrollDirection,
} from "@getpaseo/plugin/client";

/**
 * App-side `ForkClientActions` capability (Task 2, pa-84qjv2).
 *
 * The plugin SDK half (`PluginClientActionsCapability` in
 * `@getpaseo/plugin/client`) is types-only; this module is the app-side
 * implementation that runs against the existing panel and voice surfaces.
 * Everything platform-specific arrives through injected dependencies so the
 * session lifecycle and mic-safety stay unit-testable in a bare node
 * environment, and so browser/mobile builds honestly report unsupported
 * parts instead of crashing.
 *
 * Mic-safety: every voice session carries a generation. Starting a new
 * session retires the previous one, and stop/disconnect/window-blur all
 * funnel through the same guarded stop path, so a dropped release, a
 * window change, or a disconnect can never leave the microphone on. The
 * app side is the last guarantor; the plugin's `pttTransition` machine is
 * the first.
 *
 * Voice transcripts are delivered by the injected pipeline (the app's
 * existing dictation/voice pipeline — never a new pipeline, never a
 * fabricated transcription). This module only owns the hold-to-talk
 * session lifecycle.
 */

export type ClientActionsUnsupportedPart = "voiceInput" | "panelScroll";

/** Thrown when a capability part is probed as unsupported. Never a crash: the plugin maps it to `unsupported` with reason. */
export class ClientActionsPartUnavailableError extends Error {
  readonly part: ClientActionsUnsupportedPart;

  constructor(part: ClientActionsUnsupportedPart, reason: string) {
    super(reason);
    this.name = "ClientActionsPartUnavailableError";
    this.part = part;
  }
}

/**
 * The app's existing dictation/voice pipeline behind a narrow seam.
 * Production glue (mic capture + DictationStreamSender + daemon stream
 * client) is constructed where those pieces exist; tests inject fakes.
 */
export interface ClientActionsVoicePipeline {
  start(target: PluginClientActionsTarget): Promise<void>;
  stop(): Promise<void>;
  /** Invoke the handler when the daemon connection is lost; returns an unsubscribe. */
  subscribeConnectionLoss(handler: () => void): () => void;
  /** Invoke the handler when the window loses focus; defaults to the global window. */
  subscribeWindowBlur?(handler: () => void): () => void;
}

/** A scrollable viewport around the focused panel. Structural so tests can inject fakes. */
export interface ScrollablePanel {
  readonly viewportHeight: number;
  scrollBy(dy: number): void;
}

/** Resolves the focused panel's scrollable viewport, or null when nothing can scroll. Never requires a mounted plugin panel. */
export interface FocusedPanelResolver {
  resolveFocusedScrollablePanel(): ScrollablePanel | null;
}

/** Panel navigation targets for joystick input. Sector names stay working assumptions. */
export interface PanelNavigator {
  openHistory(): void;
  openSidebar(): void;
  goForward(): void;
  goBack(): void;
}

export interface CreateAppClientActionsOptions {
  voice?: ClientActionsVoicePipeline | null;
  panels?: FocusedPanelResolver | null;
  navigator?: PanelNavigator | null;
}

/** Pixels scrolled for a `"step"` amount (three 40px lines). */
export const CLIENT_ACTIONS_SCROLL_STEP_PX = 120;

function requireRouteTarget(target: PluginClientActionsTarget): {
  serverId: string;
  agentId: string;
} {
  const serverId = target.serverId.trim();
  const agentId = target.agentId.trim();
  if (!serverId) throw new Error("startVoiceInput requires a non-empty serverId");
  if (!agentId) throw new Error("startVoiceInput requires a non-empty agentId");
  return { serverId, agentId };
}

function defaultBlurSubscription(handler: () => void): () => void {
  const candidate = (
    globalThis as { window?: { addEventListener?: unknown; removeEventListener?: unknown } }
  ).window;
  if (
    !candidate ||
    typeof candidate.addEventListener !== "function" ||
    typeof candidate.removeEventListener !== "function"
  ) {
    return () => undefined;
  }
  const add = candidate.addEventListener as (type: string, listener: () => void) => void;
  const remove = candidate.removeEventListener as (type: string, listener: () => void) => void;
  add("blur", handler);
  return () => remove("blur", handler);
}

export function createAppClientActionsCapability(
  options: CreateAppClientActionsOptions = {},
): PluginClientActionsCapability {
  const voice = options.voice ?? null;
  const panels = options.panels ?? null;
  const navigator = options.navigator ?? null;

  const capabilities: PluginClientActionsCapabilities = {
    voiceInput: voice !== null,
    // Joystick navigation is gated under panelScroll: there is no separate joystick flag.
    panelScroll: panels !== null && navigator !== null,
  };

  let generation = 0;
  let activeSession: { generation: number; release: () => void } | null = null;

  async function guardedStop(): Promise<void> {
    const session = activeSession;
    activeSession = null;
    generation += 1;
    if (!session || !voice) return;
    session.release();
    await voice.stop();
  }

  function armAutoStop(): () => void {
    if (!voice) return () => undefined;
    const sessionGeneration = generation;
    const autoStop = () => {
      // Only the session that armed this guard may be stopped by it; a
      // newer press owns the mic now.
      if (activeSession?.generation !== sessionGeneration) return;
      void guardedStop().catch(() => undefined);
    };
    const releaseConnection = voice.subscribeConnectionLoss(autoStop);
    const releaseBlur = voice.subscribeWindowBlur
      ? voice.subscribeWindowBlur(autoStop)
      : defaultBlurSubscription(autoStop);
    return () => {
      releaseConnection();
      releaseBlur();
    };
  }

  return {
    getCapabilities: () => ({ ...capabilities }),

    async startVoiceInput(target: PluginClientActionsTarget): Promise<void> {
      if (!voice) {
        throw new ClientActionsPartUnavailableError(
          "voiceInput",
          "Voice input is not supported here (requires desktop voice support).",
        );
      }
      const route = requireRouteTarget(target);
      // Last press wins: retire the previous session before the new one
      // owns the mic, so a dropped release can never leak recording.
      await guardedStop();
      generation += 1;
      const sessionGeneration = generation;
      const release = armAutoStop();
      activeSession = { generation: sessionGeneration, release };
      try {
        await voice.start(route);
      } catch (error) {
        if (activeSession?.generation === sessionGeneration) {
          activeSession = null;
          release();
        }
        throw error;
      }
    },

    async stopVoiceInput(): Promise<void> {
      await guardedStop();
    },

    scrollFocusedPanel(
      direction: PluginPanelScrollDirection,
      amount: PluginPanelScrollAmount,
    ): void {
      if (!panels) {
        throw new ClientActionsPartUnavailableError(
          "panelScroll",
          "Focused-panel scroll is not supported here.",
        );
      }
      const panel = panels.resolveFocusedScrollablePanel();
      // No scrollable panel (e.g. no mounted plugin panel and no focused
      // pane): an honest no-op, not an error — the part itself is supported.
      if (!panel) return;
      const distance = amount === "page" ? panel.viewportHeight : CLIENT_ACTIONS_SCROLL_STEP_PX;
      panel.scrollBy(direction === "down" ? distance : -distance);
    },

    navigatePanel(target: PluginPanelNavigationTarget): void {
      if (!navigator) {
        throw new ClientActionsPartUnavailableError(
          "panelScroll",
          "Panel navigation is not supported here (requires panelScroll).",
        );
      }
      switch (target) {
        case "history":
          navigator.openHistory();
          return;
        case "sidebar":
          navigator.openSidebar();
          return;
        case "forward":
          navigator.goForward();
          return;
        case "back":
          navigator.goBack();
          return;
      }
    },
  };
}

interface DomScrollNode {
  scrollBy?(options: { top: number }): void;
  parentElement?: DomScrollNode | null;
  clientHeight?: unknown;
  scrollHeight?: unknown;
}

interface DomComputedStyle {
  overflowY?: unknown;
}

interface DomScrollHost {
  activeElement?: DomScrollNode | null;
  getComputedStyle?(element: DomScrollNode): DomComputedStyle | null;
}

/**
 * code-3: a node is a vertical scroll viewport only when content overflows
 * it (scrollHeight > clientHeight > 0) and CSS allows scrolling
 * (overflow-y auto/scroll where style info is available). Method presence
 * alone is not enough: inputs, buttons and plain pane wrappers all expose
 * scrollBy without being scrollable.
 */
function isScrollableViewport(node: DomScrollNode, host: DomScrollHost): boolean {
  if (typeof node.scrollBy !== "function") return false;
  if (typeof node.clientHeight !== "number" || !(node.clientHeight > 0)) return false;
  if (typeof node.scrollHeight !== "number" || !(node.scrollHeight > node.clientHeight)) {
    return false;
  }
  if (typeof host.getComputedStyle === "function") {
    const style = host.getComputedStyle(node);
    const overflowY = style?.overflowY;
    if (typeof overflowY === "string" && overflowY !== "auto" && overflowY !== "scroll") {
      return false;
    }
  }
  return true;
}

function findScrollableAncestor(element: DomScrollNode, host: DomScrollHost): DomScrollNode | null {
  let current: DomScrollNode | null = element;
  const seen = new Set<DomScrollNode>();
  while (current && !seen.has(current)) {
    seen.add(current);
    // Start at the focused element itself: a focused multiline composer is
    // a real viewport. Non-overflowing inputs/buttons/wrappers are skipped
    // so scrolling reaches the timeline viewport instead.
    if (isScrollableViewport(current, host)) return current;
    // Structural DOM hosts expose parentage through `parentElement`; plain
    // fakes simply terminate the walk by omitting it.
    current = current.parentElement ?? null;
  }
  return null;
}

/**
 * DOM resolver for the focused panel: walks from the focused element to the
 * nearest real scroll viewport (overflow + dimensions, no marker query —
 * code-3: no producer of data-focused-pane exists in the app, so a marker
 * lookup can never supply the pane). Works without a mounted plugin panel.
 * Returns null (→ panelScroll unsupported) where no document exists
 * (native, SSR, bare node) or nothing focused is inside a viewport.
 */
export function createDomPanelResolver(doc?: DomScrollHost): FocusedPanelResolver | null {
  const host =
    doc ??
    (typeof (globalThis as { document?: unknown }).document === "object"
      ? ((globalThis as { document: unknown }).document as DomScrollHost)
      : null);
  if (!host) return null;
  return {
    resolveFocusedScrollablePanel: () => {
      const start = host.activeElement ?? null;
      if (!start) return null;
      const scrollable = findScrollableAncestor(start, host);
      if (!scrollable || typeof scrollable.scrollBy !== "function") return null;
      const viewportHeight =
        typeof scrollable.clientHeight === "number" ? scrollable.clientHeight : 0;
      if (!(viewportHeight > 0)) return null;
      const scroll = scrollable.scrollBy.bind(scrollable);
      return {
        viewportHeight,
        scrollBy: (dy: number) => scroll({ top: dy }),
      };
    },
  };
}

interface HistoryLike {
  back(): void;
  forward(): void;
}

interface WebNavigatorHost {
  history?: HistoryLike;
}

function defaultWebNavigatorHost(): WebNavigatorHost | null {
  const candidate = (globalThis as { window?: unknown }).window as WebNavigatorHost | undefined;
  if (!candidate) return null;
  if (!candidate.history) return null;
  return candidate;
}

/**
 * code-4/S2: the app-owned navigation path. Back/forward ride the real
 * session history (the desktop/web app routes on window.history —
 * see utils/host-route-browser.ts), so they visibly navigate. History
 * and sidebar panels have no headless app seam outside React: no store,
 * no command, no event producer/consumer exists in packages/app/src,
 * so they report unsupported instead of silently succeeding. Only
 * implemented operations are advertised — never an optional no-op.
 */
export function createWebPanelNavigator(host?: WebNavigatorHost): PanelNavigator | null {
  const resolved = host ?? defaultWebNavigatorHost();
  if (!resolved) return null;
  const history = resolved.history;
  if (!history || typeof history.back !== "function" || typeof history.forward !== "function") {
    return null;
  }
  return {
    openHistory: () => {
      throw new ClientActionsPartUnavailableError(
        "panelScroll",
        "Agent history navigation is not wired in this app build.",
      );
    },
    openSidebar: () => {
      throw new ClientActionsPartUnavailableError(
        "panelScroll",
        "Sidebar navigation is not wired in this app build.",
      );
    },
    goForward: () => history.forward(),
    goBack: () => history.back(),
  };
}
