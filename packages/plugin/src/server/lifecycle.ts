import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
  /**
   * Verified agent labels at open time (for example `gc-session`). Read-only:
   * session_open hooks must not change them.
   */
  labels: Record<string, string>;
  /**
   * First user prompt when known, otherwise null. Read-only: hooks must not
   * change it. At create time this is usually null because the first prompt
   * has not been submitted yet; per-turn prompts arrive via
   * `agent.turn_prepare`.
   */
  initialPrompt: string | null;
  /**
   * Recomposable stable instructions. A session_open hook may return changed
   * values for interactive opens (create/resume/refresh/import); history
   * opens must leave them unchanged.
   */
  systemPrompt?: string | null;
  daemonAppendSystemPrompt?: string | null;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "agent.closed": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
}

export interface PluginCreateRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  /**
   * Verified labels the agent will be registered with. Read-only: create
   * hooks must not change them; they exist so retrieval can match task and
   * role without trusting env.
   */
  labels: Record<string, string>;
  /**
   * First user prompt when the caller supplied one, otherwise null.
   * Read-only: hooks must not change it. Normal agent creation happens
   * before the first prompt, so this is usually null; the per-turn prompt
   * snapshot arrives via `agent.turn_prepare`.
   */
  initialPrompt: string | null;
}

export type PluginTurnKind = "start" | "resume" | "refresh" | "compaction" | "next";

export interface PluginTurnPrepareRequest {
  agent: PluginHookAgent & { labels: Record<string, string> };
  turn: {
    /** Snapshot of the submitted user prompt for this turn. Never mutated. */
    prompt: string;
    /** Why this turn starts: first start, resume, refresh, post-compaction, or a later turn. */
    kind: PluginTurnKind;
    /** Interactive turns run the model; history opens never do. */
    purpose: "interactive" | "history";
    /** 1-based count of foreground turns started on this agent. */
    turnNumber: number;
  };
  /**
   * Hidden per-turn context contributed by earlier turn_prepare hooks.
   * A hook returns only its own addition via `context`; it never edits this.
   */
  accumulatedContext: string[];
}

export interface PluginTurnPrepareResult {
  /**
   * Hidden context for the effective model request. A separate channel from
   * the user prompt: the daemon delivers it without mutating stored user
   * text and without creating a new turn or a visible timeline message.
   */
  context?: string | string[] | null;
}

export interface PluginBeforeRequests {
  "agent.create": PluginCreateRequest;
  "agent.session_open": PluginSessionOpenRequest;
  "agent.turn_prepare": PluginTurnPrepareRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export type PluginBeforeResult<Name extends keyof PluginBeforeRequests> =
  Name extends "agent.turn_prepare"
    ? PluginTurnPrepareResult | void | Promise<PluginTurnPrepareResult | void>
    : PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>;

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeResult<Name>,
  ): () => void;
}
