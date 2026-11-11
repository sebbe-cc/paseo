import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  createLifecycleRegistration,
  pluginHookRegistry,
} from "@getpaseo/plugin/internal/lifecycle";
import { isDeepStrictEqual } from "node:util";
import {
  serializeAgentTool,
  agentToolMetadataSchema,
  type SessionOpenWireRequest,
  type PluginAgentTools,
} from "../agent-tools.js";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
import { z } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type {
  PluginBeforeRequests,
  PluginHookAgent,
  PluginHookPayload,
  PluginHookContext,
  PluginLifecycleRegistration,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginHookRequests,
  PluginHookWorkspace,
  PluginHookEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export type PluginWireBeforeRequests = Omit<PluginHookRequests, "agent.open.before"> & {
  "agent.open.before": SessionOpenWireRequest;
};

/** Daemon-only results; ownership never crosses the plugin process boundary. */
export type PluginBeforeResults = PluginWireBeforeRequests & {
  "agent.open.before": SessionOpenWireRequest & {
    mcpServerOwners?: Record<string, string>;
  };
};

const worktreeRequestFields = {
  repoRoot: z.string(),
  sourceCheckout: z.string(),
  branch: z.string().min(1),
  slug: z.string().refine((value) => validateBranchSlug(value).valid, "Invalid worktree slug"),
  path: z.string().min(1),
};
const changeRequestFields = {
  headRef: z.string().min(1),
  headRepositoryOwner: z.string().optional(),
  checkoutRefs: z
    .array(z.object({ remoteName: z.string().optional(), remoteRef: z.string() }))
    .optional(),
  pushRemoteUrl: z.string().optional(),
  trackOriginHead: z.boolean().optional(),
};
const worktreeRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...worktreeRequestFields,
      kind: z.literal("branch-off"),
      baseRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      kind: z.literal("checkout-branch"),
    })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      ...changeRequestFields,
      kind: z.literal("checkout-change-request"),
      baseRef: z.string().min(1),
      forge: z.string(),
      changeRequestNumber: z.number().int().positive(),
      headRepository: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      ...changeRequestFields,
      kind: z.literal("checkout-github-pr"),
      baseRef: z.string().min(1),
      githubPrNumber: z.number().int().positive(),
    })
    .strict(),
]);

export const TURN_PREPARE_MAX_CHARS = 8000;
const labelsSchema = z.record(z.string(), z.string());

const beforeSchemas = {
  "worktree.create.before": worktreeRequestSchema,
  "agent.create.before": CreateAgentRequestMessageSchema.pick({
    config: true,
    env: true,
    metadata: true,
  })
    .extend({
      labels: labelsSchema,
      initialPrompt: z.string().nullable().default(null),
    })
    .strict(),
  "agent.open.before": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      title: z.string().nullable(),
      labels: z.record(z.string(), z.string()),
      // Optional so a plugin that returns its own object keeps working; omitted means unchanged.
      metadata: z.record(z.string(), z.custom<JsonValue>()).optional(),
      tools: z.array(agentToolMetadataSchema),
      initialPrompt: z.string().nullable().default(null),
      systemPrompt: z.string().nullable().optional(),
      daemonAppendSystemPrompt: z.string().nullable().optional(),
      env: z.record(z.string(), z.string()),
      mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
    })
    .strict(),
  "agent.turn_prepare.before": z
    .object({
      agent: z
        .object({
          id: z.string(),
          workspaceId: z.string().nullable(),
          parentAgentId: z.string().nullable(),
          provider: z.string(),
          cwd: z.string(),
          title: z.string().nullable(),
          labels: labelsSchema,
        })
        .strict(),
      turn: z
        .object({
          prompt: z.string(),
          kind: z.enum(["start", "resume", "refresh", "compaction", "next"]),
          purpose: z.enum(["interactive", "history"]),
          turnNumber: z.number().int().min(1),
        })
        .strict(),
      accumulatedContext: z.array(z.string()),
    })
    .strict(),
  "agent.compact.before": z
    .object({
      agentId: z.string(),
      provider: z.string(),
      reason: z.enum(["auto", "manual"]),
      source: z.enum(["provider", "threshold"]),
      usage: z
        .object({
          contextWindowUsedTokens: z.number().nullable(),
          contextWindowMaxTokens: z.number().nullable(),
        })
        .strict(),
      skip: z.boolean(),
    })
    .strict(),
  "workspace.create.before": WorkspaceCreateRequestSchema.omit({
    type: true,
    requestId: true,
  }).strict(),
};

const sessionOpenLocalResultSchema = beforeSchemas["agent.open.before"].extend({
  tools: z.array(
    z.custom<AgentToolDefinition>(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "input" in tool &&
        "execute" in tool &&
        typeof tool.execute === "function",
    ),
  ),
});

const turnPrepareResultSchema = z
  .object({
    context: z.union([z.string(), z.array(z.string())]).nullish(),
  })
  .strict();

export const TURN_CONTEXT_MARKER_OPEN = "<system-reminder data-paseo-turn-context>";
export const TURN_CONTEXT_MARKER_CLOSE = "</system-reminder>";

export function normalizeTurnContextPieces(value: unknown): string[] {
  const raw = turnPrepareResultSchema.parse(value ?? {});
  let list: string[];
  if (raw.context == null) {
    list = [];
  } else if (Array.isArray(raw.context)) {
    list = raw.context;
  } else {
    list = [raw.context];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of list) {
    const text = piece.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Compose hidden per-turn context blocks in registration order, dropping
 * empties and exact duplicates, capped at TURN_PREPARE_MAX_CHARS.
 */
export function composeTurnContext(blocks: string[]): string | null {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const block of blocks) {
    const text = block.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    ordered.push(text);
  }
  if (ordered.length === 0) return null;
  let composed = ordered.join("\n\n");
  if (composed.length > TURN_PREPARE_MAX_CHARS) {
    composed = composed.slice(0, TURN_PREPARE_MAX_CHARS);
  }
  return composed;
}

/**
 * Wrap a provider-bound prompt with hidden turn context. The stored timeline
 * row keeps the original prompt; only the model request carries the wrapper.
 */
export function wrapPromptWithTurnContext(prompt: string, context: string | null): string {
  if (!context || !context.trim()) return prompt;
  return `${TURN_CONTEXT_MARKER_OPEN}\n${context.trim()}\n${TURN_CONTEXT_MARKER_CLOSE}\n\n${prompt}`;
}

export interface PluginLifecycle {
  wait(
    name: "worktree.create.after",
    payload: PluginHookPayload<"worktree.create.after">,
  ): Promise<void>;
  emit<Name extends keyof PluginHookEvents>(name: Name, event: PluginHookEvents[Name]): void;
  before<Name extends keyof PluginWireBeforeRequests>(
    name: Name,
    request: PluginWireBeforeRequests[Name],
  ): Promise<PluginBeforeResults[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  value: unknown,
): PluginWireBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginWireBeforeRequests[Name];
}

export function describeHookWorkspace(workspace: PersistedWorkspaceRecord): PluginHookWorkspace {
  return {
    id: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    name: workspace.title,
    archivedAt: workspace.archivedAt,
    metadata: workspace.metadata,
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  labels: Record<string, string>;
  metadata: Record<string, JsonValue>;
}): PluginHookAgent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
    metadata: agent.metadata,
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn.before", {
      agent,
      turnId: event.turnId ?? null,
    });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: {
        kind: "failed",
        error: { message: event.error, code: event.code },
      },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission.before", {
      agent,
      request: event.request,
    });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission.after", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

function sameLabels(
  previous: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): boolean {
  return JSON.stringify(previous ?? {}) === JSON.stringify(next ?? {});
}

function validateSessionOpenResult(
  previous: z.infer<(typeof beforeSchemas)["agent.open.before"]>,
  next: z.infer<(typeof beforeSchemas)["agent.open.before"]>,
): void {
  const identityChanged =
    previous.agentId !== next.agentId ||
    previous.workspaceId !== next.workspaceId ||
    previous.provider !== next.provider ||
    previous.cwd !== next.cwd ||
    previous.reason !== next.reason ||
    previous.purpose !== next.purpose ||
    previous.title !== next.title ||
    !sameLabels(previous.labels, next.labels);
  if (identityChanged) {
    throw new Error("agent.open.before hooks can only change env, tools, and mcpServers");
  }
  const contextChanged =
    !sameLabels(previous.labels, next.labels) ||
    (previous.initialPrompt ?? null) !== (next.initialPrompt ?? null);
  if (contextChanged) {
    throw new Error("agent.open.before hooks cannot change labels or initialPrompt");
  }
  const instructionsChanged =
    (next.systemPrompt ?? null) !== (previous.systemPrompt ?? null) ||
    (next.daemonAppendSystemPrompt ?? null) !== (previous.daemonAppendSystemPrompt ?? null);
  if (previous.purpose === "history" && instructionsChanged) {
    throw new Error("agent.open.before hooks cannot change instructions for history opens");
  }
}

function validateCreateResult(
  previous: z.infer<(typeof beforeSchemas)["agent.create.before"]>,
  next: z.infer<(typeof beforeSchemas)["agent.create.before"]>,
): void {
  if (previous.config.cwd !== next.config.cwd) {
    throw new Error("agent.create hooks cannot change the workspace directory");
  }
  const contextChanged =
    !sameLabels(previous.labels, next.labels) ||
    (previous.initialPrompt ?? null) !== (next.initialPrompt ?? null);
  if (contextChanged) {
    throw new Error("agent.create hooks cannot change labels or initialPrompt");
  }
}

/**
 * Merge a turn_prepare child answer into the running request. Child plugin
 * hosts answer with the full request shape `{...request, accumulatedContext}`
 * (their in-process `invokeTurnPrepare` accumulates each handler's
 * `{context}` piece and returns the request), never with the bare handler
 * `{context}` form — parsing that strict shape threw
 * `unrecognized_keys [agent, turn, accumulatedContext]` on every turn, and
 * returning the empty input dropped per-turn memory even when validation
 * passed. Agent/turn identity stays immutable; only accumulated context
 * merges through, in order without duplicates.
 */
function mergeTurnPrepareResult(
  input: PluginBeforeRequests["agent.turn_prepare"],
  output: unknown,
): PluginBeforeRequests["agent.turn_prepare"] {
  if (output === undefined) return input;
  if (typeof output !== "object" || output === null || !("accumulatedContext" in output)) {
    // Bare `{context}` handler form (tolerated for direct answers).
    return appendTurnContext(input, normalizeTurnContextPieces(output));
  }
  const parsed = beforeSchemas["agent.turn_prepare.before"].parse(output);
  const expected = beforeSchemas["agent.turn_prepare.before"].parse(input);
  if (
    JSON.stringify(parsed.agent) !== JSON.stringify(expected.agent) ||
    JSON.stringify(parsed.turn) !== JSON.stringify(expected.turn)
  ) {
    throw new Error("agent.turn_prepare hooks cannot change agent or turn identity");
  }
  return appendTurnContext(input, parsed.accumulatedContext);
}

function appendTurnContext(
  input: PluginBeforeRequests["agent.turn_prepare"],
  pieces: string[],
): PluginBeforeRequests["agent.turn_prepare"] {
  const merged = [...input.accumulatedContext];
  for (const piece of pieces) {
    if (!merged.includes(piece)) merged.push(piece);
  }
  return { ...input, accumulatedContext: merged };
}

/**
 * 0.16 lets a hook omit what it does not change. The fork's create context (labels,
 * initialPrompt) is read-only, so an omitted value is the one the hook was handed.
 */
function withCreateContext(name: string, input: unknown, output: unknown): unknown {
  if (name !== "agent.create.before" || !output || typeof output !== "object") return output;
  const previous = input as { labels?: unknown; initialPrompt?: unknown };
  const next = output as Record<string, unknown>;
  return {
    ...next,
    labels: next.labels ?? previous.labels,
    initialPrompt: next.initialPrompt === undefined ? previous.initialPrompt : next.initialPrompt,
  };
}

type SessionOpenSnapshot = ReturnType<(typeof beforeSchemas)["agent.open.before"]["parse"]>;

function changesSessionOpenIdentity(
  previous: SessionOpenSnapshot,
  next: SessionOpenSnapshot,
): boolean {
  return (
    previous.agentId !== next.agentId ||
    previous.workspaceId !== next.workspaceId ||
    previous.provider !== next.provider ||
    previous.cwd !== next.cwd ||
    previous.reason !== next.reason ||
    previous.purpose !== next.purpose ||
    previous.title !== next.title ||
    !isDeepStrictEqual(previous.labels, next.labels) ||
    (next.metadata !== undefined && !isDeepStrictEqual(previous.metadata, next.metadata))
  );
}

export async function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  input: PluginWireBeforeRequests[Name],
  output: unknown,
): Promise<PluginWireBeforeRequests[Name]> {
  if (name === "agent.turn_prepare.before") {
    return mergeTurnPrepareResult(
      input as PluginBeforeRequests["agent.turn_prepare"],
      output,
    ) as PluginWireBeforeRequests[Name];
  }
  const result = validateBeforeRequest(name, withCreateContext(name, input, output));
  if (name === "agent.open.before") {
    const previous = beforeSchemas["agent.open.before"].parse(input);
    validateSessionOpenResult(previous, beforeSchemas["agent.open.before"].parse(result));
    const next = beforeSchemas["agent.open.before"].parse(result);
    if (changesSessionOpenIdentity(previous, next)) {
      throw new Error("agent.open.before hooks can only change env, tools, and mcpServers");
    }
    return { ...result, metadata: previous.metadata };
  }
  if (name === "agent.compact.before") {
    const previous = beforeSchemas["agent.compact.before"].parse(input);
    const next = beforeSchemas["agent.compact.before"].parse(result);
    if (JSON.stringify({ ...previous, skip: next.skip }) !== JSON.stringify(next)) {
      throw new Error("agent.compact hooks can only change skip");
    }
  }
  if (name === "agent.create.before") {
    const previous = beforeSchemas["agent.create.before"].parse(input);
    validateCreateResult(previous, beforeSchemas["agent.create.before"].parse(result));
    const next = beforeSchemas["agent.create.before"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create.before hooks cannot change the workspace directory");
    }
    // Omitted means unchanged: the next hook sees what this one was handed.
    return { ...result, metadata: next.metadata ?? previous.metadata };
  }
  if (name === "workspace.create.before") {
    const previous = beforeSchemas["workspace.create.before"].parse(input);
    const next = beforeSchemas["workspace.create.before"].parse(result);
    // Omitted means unchanged; an explicit {} still replaces.
    return { ...result, metadata: next.metadata ?? previous.metadata };
  }
  if (name === "worktree.create.before") {
    const previous = beforeSchemas["worktree.create.before"].parse(input);
    const next = beforeSchemas["worktree.create.before"].parse(result);
    if (previous.repoRoot !== next.repoRoot || previous.sourceCheckout !== next.sourceCheckout) {
      throw new Error("worktree.create.before hooks cannot change repoRoot or sourceCheckout");
    }
  }
  return result;
}

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  private readonly agentTools: PluginAgentTools | undefined;

  constructor(changed: () => void, agentTools?: PluginAgentTools) {
    this.agentTools = agentTools;
    this.changed = changed;
    const registration = createLifecycleRegistration((name, handler) =>
      this.register(name, handler as Handler),
    );
    this.addHook = registration.addHook;
    this.on = registration.on;
    this.before = registration.before;
  }

  readonly addHook: PluginLifecycleRegistration["addHook"];
  readonly on: PluginLifecycleRegistration["on"];
  readonly before: PluginLifecycleRegistration["before"];

  catalog(): string[] {
    return [...this.handlers.keys()];
  }

  async invoke(
    id: string,
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (Object.hasOwn(beforeSchemas, name)) {
        const hookName = name as keyof PluginHookRequests;
        if (hookName === "agent.open.before") {
          return await this.openSession(input, {
            paseo,
            signal: controller.signal,
          });
        }
        let request = validateBeforeRequest(hookName, input);
        if (hookName === "agent.turn_prepare.before") {
          return this.invokeTurnPrepare(
            name,
            request as PluginBeforeRequests["agent.turn_prepare"],
            paseo,
            controller,
          );
        }
        type MutableHook = Exclude<typeof hookName, "agent.turn_prepare.before">;
        const mutableHook = hookName as MutableHook;
        for (const handler of this.handlers.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined)
            request = await validateBeforeResult(
              mutableHook,
              request as PluginWireBeforeRequests[MutableHook],
              result,
            );
        }
        return request;
      }
      for (const handler of this.handlers.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), {
            paseo,
            signal: controller.signal,
          });
        } catch (error) {
          if (
            Object.hasOwn(pluginHookRegistry, name) &&
            pluginHookRegistry[name as keyof typeof pluginHookRegistry].waits
          )
            throw error;
          console.error(`Lifecycle hook ${name} failed`, error);
        }
      }
      return null;
    } finally {
      this.active.delete(id);
    }
  }

  private async openSession(
    input: unknown,
    context: PluginHookContext,
  ): Promise<SessionOpenWireRequest> {
    let request = validateBeforeRequest("agent.open.before", input);
    this.agentTools?.detach(request.agentId);
    let tools: AgentToolDefinition[] = [];
    for (const handler of this.handlers.get("agent.open.before") ?? []) {
      context.signal.throwIfAborted();
      const result = await handler(
        { request: { ...structuredClone(request), tools: [...tools] } },
        context,
      );
      if (result === undefined) continue;
      const local = sessionOpenLocalResultSchema.parse(result);
      const metadata = local.tools.map(serializeAgentTool);
      request = await validateBeforeResult("agent.open.before", request, {
        ...local,
        tools: metadata,
      });
      tools = local.tools;
    }
    context.signal.throwIfAborted();
    if (request.purpose === "history") {
      request.tools = [];
      request.mcpServers = {};
    } else this.agentTools?.attach(request.agentId, tools);
    return request;
  }

  /**
   * Fail-open accumulation: each hook contributes hidden context only.
   * A throwing hook is logged and skipped; the turn still starts.
   */
  private async invokeTurnPrepare(
    name: string,
    request: PluginBeforeRequests["agent.turn_prepare"],
    paseo: PluginHookContext["paseo"],
    controller: AbortController,
  ): Promise<PluginBeforeRequests["agent.turn_prepare"]> {
    const accumulated: string[] = [];
    for (const handler of this.handlers.get(name) ?? []) {
      controller.signal.throwIfAborted();
      const result = await this.invokeOneTurnPrepare(
        handler,
        request,
        accumulated,
        paseo,
        controller,
      );
      for (const piece of result) {
        if (!accumulated.includes(piece)) accumulated.push(piece);
      }
    }
    return { ...request, accumulatedContext: accumulated };
  }

  private async invokeOneTurnPrepare(
    handler: Handler,
    request: PluginBeforeRequests["agent.turn_prepare"],
    accumulated: string[],
    paseo: PluginHookContext["paseo"],
    controller: AbortController,
  ): Promise<string[]> {
    try {
      const result = await handler(
        {
          request: structuredClone({
            ...request,
            accumulatedContext: [...accumulated],
          }),
        },
        { paseo, signal: controller.signal },
      );
      if (result === undefined) return [];
      return normalizeTurnContextPieces(result);
    } catch (error) {
      console.error("Lifecycle hook agent.turn_prepare failed", error);
      return [];
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.handlers.clear();
  }

  private register(name: string, handler: Handler): () => void {
    let handlers = this.handlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        this.handlers.delete(name);
      }
      this.changed();
    };
  }
}
