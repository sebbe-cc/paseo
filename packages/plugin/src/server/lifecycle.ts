import type { AgentToolDefinition } from "./agent-tools.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
  ToolCallDetail,
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

export interface PluginHookWorktree {
  path: string;
  branch: string;
  sourceCheckout: string;
}

/** Resolved creation options before Git fetches refs or chooses a unique branch name. */
export type PluginWorktreeCreateRequest = {
  readonly repoRoot: string;
  readonly sourceCheckout: string;
  branch: string;
  slug: string;
  path: string;
} & (
  | { kind: "branch-off"; baseRef: string }
  | { kind: "checkout-branch" }
  | {
      kind: "checkout-change-request";
      baseRef: string;
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      headRepository?: string;
      checkoutRefs?: { remoteName?: string; remoteRef: string }[];
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      baseRef: string;
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      checkoutRefs?: { remoteName?: string; remoteRef: string }[];
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
);

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
  readonly title: string | null;
  readonly labels: Readonly<Record<string, string>>;
  tools: AgentToolDefinition[];
  initialPrompt: string | null;
  systemPrompt?: string | null;
  daemonAppendSystemPrompt?: string | null;
  env: Record<string, string>;
  mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
}

/**
 * Fired before an agent's context is compacted. Return `{ ...request, skip: true }` to
 * replace the compaction; only `skip` may change.
 */
export interface PluginCompactRequest {
  agentId: string;
  provider: string;
  reason: "auto" | "manual";
  /** "provider": the harness's own pre-compact hook; "threshold": Paseo's context usage watch. */
  source: "provider" | "threshold";
  usage: { contextWindowUsedTokens: number | null; contextWindowMaxTokens: number | null };
  skip: boolean;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export type PluginToolCallOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: unknown }
  | { kind: "canceled"; reason?: string };

/**
 * Shared before/after tool events (pa-89is1.6). Observe-only `on` events:
 * handlers run as async notifications, a throwing handler is logged and
 * skipped, and hook failures can never flip a tool result. No `before`
 * hook exists for tool calls on purpose, so observing them adds no model
 * turn and needs no permission round-trip.
 *
 * Identity: `toolCall.id` is the daemon timeline `callId`, stable from the
 * first `running` row to its terminal row on every provider. Ordering per
 * (agent, toolCall.id): exactly one `agent.tool_call_started`, then exactly
 * one `agent.tool_call_ended`. A terminal row without a prior `running` row
 * still emits `ended` (no `started` is synthesized). Re-emitted rows for an
 * already-seen state are suppressed, and history replay never emits: events
 * fire only for live timeline appends. When a turn ends while calls are
 * still open, the daemon synthesizes `ended` with `canceled`.
 *
 * Input/output: `detail` is the same mapped detail the timeline shows
 * (command/filePath/query/... per tool kind), content-capped like the
 * timeline broadcast; `metadata` carries the provider-mapped extras when
 * present. A nested call inside one provider tool call (for example several
 * MCP calls inside one code-mode `exec`) is a single provider tool call and
 * emits a single started/ended pair.
 */
export interface PluginToolCallStarted {
  agent: PluginHookAgent;
  turnId: string | null;
  toolCall: {
    id: string;
    name: string;
    detail: ToolCallDetail;
    metadata?: Record<string, unknown>;
  };
}

export interface PluginToolCallEnded {
  agent: PluginHookAgent;
  turnId: string | null;
  toolCall: { id: string; name: string };
  outcome: PluginToolCallOutcome;
  /**
   * Terminal mapped detail, content-capped like the timeline broadcast.
   * Full output stays in the timeline; refetch by `toolCall.id` for more.
   */
  detail: ToolCallDetail;
  /** Terminal error row as stored, null for completed/canceled. */
  error: unknown;
}

export interface PluginHookEvents {
  "agent.tool_call.before": PluginToolCallStarted;
  "agent.tool_call.after": PluginToolCallEnded;
  "agent.turn.before": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn.after": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission.before": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission.after": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archive.after": { agent: PluginHookAgent; archivedAt: string };
  "agent.create.after": { agent: PluginHookAgent };
  "agent.close.after": { agent: PluginHookAgent };
  "workspace.create.after": { workspace: PluginHookWorkspace };
  "workspace.archive.after": { workspace: PluginHookWorkspace };
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

export interface PluginHookRequests {
  "agent.turn_prepare.before": PluginTurnPrepareRequest;
  "agent.compact.before": PluginCompactRequest;
  "worktree.create.before": PluginWorktreeCreateRequest;
  "agent.create.before": PluginCreateRequest;
  "agent.open.before": PluginSessionOpenRequest;
  "workspace.create.before": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export type PluginHooks = {
  [Name in keyof PluginHookRequests]: {
    request: PluginHookRequests[Name];
    result: Name extends "agent.turn_prepare.before" ? PluginTurnPrepareResult : PluginHookRequests[Name];
  };
} & { [Name in keyof PluginHookEvents]: { payload: PluginHookEvents[Name] } } & {
  "worktree.create.after": { payload: { worktree: PluginHookWorktree } };
};

export type PluginHookPayload<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { request: infer Request }
    ? { request: Request }
    : PluginHooks[Key] extends { payload: infer Payload }
      ? Payload
      : never;
}[Name];
export type PluginHookResult<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { result: infer Result }
    ? Result | void
    : void;
}[Name];

type HookHandlers = {
  [Name in keyof PluginHooks]: (
    payload: PluginHookPayload<Name>,
    context: PluginHookContext,
  ) => Promise<PluginHookResult<Name>>;
};

export type PluginBeforeResult<Name extends keyof PluginBeforeRequests> =
  Name extends "agent.turn_prepare"
    ? PluginTurnPrepareResult | void | Promise<PluginTurnPrepareResult | void>
    : PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>;

export interface PluginLifecycleRegistration {
  addHook<Name extends keyof PluginHooks>(name: Name, handler: HookHandlers[Name]): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeResult<Name>,
  ): () => void;
}

/** @internal Lifecycle policy shared by the daemon and plugin process. */
export const pluginHookRegistry = {
  "agent.tool_call.before": { waits: false },
  "agent.tool_call.after": { waits: false },
  "agent.turn_prepare.before": { waits: true },
  "agent.compact.before": { waits: true },
  "workspace.create.before": { waits: true },
  "workspace.create.after": { waits: false },
  "workspace.archive.after": { waits: false },
  "worktree.create.before": { waits: true },
  "worktree.create.after": { waits: true },
  "agent.create.before": { waits: true },
  "agent.create.after": { waits: false },
  "agent.open.before": { waits: true },
  "agent.close.after": { waits: false },
  "agent.archive.after": { waits: false },
  "agent.turn.before": { waits: false },
  "agent.turn.after": { waits: false },
  "agent.permission.before": { waits: false },
  "agent.permission.after": { waits: false },
} as const satisfies Record<keyof PluginHooks, { waits: boolean }>;

// COMPAT(pluginHookNames): added in v0.14, remove after 2027-04-30
const legacyEvents = {
  "agent.tool_call_started": "agent.tool_call.before",
  "agent.tool_call_ended": "agent.tool_call.after",
  "workspace.created": "workspace.create.after",
  "workspace.archived": "workspace.archive.after",
  "agent.created": "agent.create.after",
  "agent.closed": "agent.close.after",
  "agent.archived": "agent.archive.after",
  "agent.turn_started": "agent.turn.before",
  "agent.turn_ended": "agent.turn.after",
  "agent.permission_requested": "agent.permission.before",
  "agent.permission_resolved": "agent.permission.after",
} as const;
const legacyRequests = {
  "agent.turn_prepare": "agent.turn_prepare.before",
  "agent.compact": "agent.compact.before",
  "workspace.create": "workspace.create.before",
  "agent.create": "agent.create.before",
  "agent.session_open": "agent.open.before",
} as const;
export type PluginLifecycleEvents = {
  [Name in keyof typeof legacyEvents]: PluginHookEvents[(typeof legacyEvents)[Name]];
};
export type PluginBeforeRequests = {
  [Name in keyof typeof legacyRequests]: PluginHookRequests[(typeof legacyRequests)[Name]];
};

/** @internal SDK adapter for the daemon's hook registry. */
export function createLifecycleRegistration(
  register: (
    name: keyof PluginHooks,
    handler: (input: never, context: PluginHookContext) => unknown,
  ) => () => void,
): PluginLifecycleRegistration {
  const names = new Set<string>(Object.keys(pluginHookRegistry));
  return {
    addHook(name, handler) {
      if (!names.has(name)) throw new Error(`Unknown lifecycle hook: ${name}`);
      return register(name, handler);
    },
    on(name, handler) {
      if (!Object.hasOwn(legacyEvents, name)) throw new Error(`Unknown lifecycle event: ${name}`);
      return register(legacyEvents[name], handler);
    },
    before(name, handler) {
      if (!Object.hasOwn(legacyRequests, name)) throw new Error(`Unknown before hook: ${name}`);
      return register(legacyRequests[name], handler);
    },
  };
}
