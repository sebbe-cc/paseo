import type {
  PluginRequestOrigin,
  PluginAgentBinding,
  PluginAdmissionOperation,
} from "./admission.js";
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
  origin: PluginRequestOrigin;
  operation: PluginAdmissionOperation;
  binding: PluginAgentBinding | null;
  history: {
    epoch: string | null;
    nextSeq: number;
    persistence: { provider: string; sessionId: string | null } | null;
  };
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.session_opened": {
    agent: PluginHookAgent;
    operation: PluginAdmissionOperation;
    persistence: { provider: string; sessionId: string | null } | null;
    historyEpochChanged: boolean;
  };
  "agent.session_open_failed": {
    agent: PluginHookAgent;
    operation: PluginAdmissionOperation;
    error: { code: string; message: string };
    stage: "hook" | "fence" | "provider" | "interrupted";
  };
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
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

export interface PluginBeforeRequests {
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    origin: PluginRequestOrigin;
    bindingIntent?: unknown;
  };
  "agent.session_open": PluginSessionOpenRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export type PluginBeforeResult<R> = R | void | { deny: { code: string; message: string } };

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
    ) =>
      | PluginBeforeResult<PluginBeforeRequests[Name]>
      | Promise<PluginBeforeResult<PluginBeforeRequests[Name]>>,
  ): () => void;
}
