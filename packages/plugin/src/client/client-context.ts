// Global client context (pa-yi0bsm). Types only: no Node or React
// Native imports here, so the client boundary (boundaries.test.ts)
// holds and the client bundle never imports node:.
//
// This is the host half of the plugin's context contract
// (plugins/creator-micro/shared/client-context.ts in fleet/paseo):
// same field names and shapes. Routing always uses the exact
// {serverId, agentId} pair plus workspaceId for UI — never a title,
// cwd, alias, or a bare agentId.

export type PluginClientPane = "agent" | "terminal" | "file" | "diff" | "unknown";

export interface PluginClientContextSnapshot {
  /** Installation owning the window (stable client id from the app). */
  installationId: string;
  /** The window this snapshot describes. */
  windowId: string;
  /** Selected host, null when no host is selected. */
  serverId: string | null;
  /** Active workspace, null outside a workspace. */
  workspaceId: string | null;
  /** Focused panel — "unknown" when the app cannot determine it. */
  pane: PluginClientPane;
  /** Visible agent, null outside an agent panel with no locked target. */
  agentId: string | null;
  /** True while the app window has OS focus. */
  focused: boolean;
  /** Monotonic version per window; higher wins on ownership moves. */
  version: number;
}

/** Routing target: the exact {serverId, agentId} pair. */
export interface PluginRouteTarget {
  serverId: string;
  agentId: string;
}

/**
 * Trusted global client context on the client context. Available on
 * every client (desktop, browser, mobile) with app lifetime — not per
 * mounted panel — so navigation and focus keep working when no
 * plugin panel is mounted. The snapshot is null until the app has
 * resolved its installation and window identities; subscribe for
 * readiness instead of guessing.
 */
export interface PluginClientContextCapability {
  getSnapshot(): PluginClientContextSnapshot | null;
  subscribe(listener: (snapshot: PluginClientContextSnapshot | null) => void): () => void;
  /** Bring the app forward and navigate to the target's agent. */
  focusTarget(target: PluginRouteTarget): Promise<void>;
  /** Navigate to a workspace without requiring a mounted panel. */
  openWorkspace(input: { serverId: string; workspaceId: string }): void;
}
