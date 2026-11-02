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
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleRegistration,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginBeforeRequests,
  PluginHookWorkspace,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export type PluginWireBeforeRequests = Omit<PluginBeforeRequests, "agent.session_open"> & {
  "agent.session_open": SessionOpenWireRequest;
};

/** Daemon-only results; ownership never crosses the plugin process boundary. */
export type PluginBeforeResults = PluginWireBeforeRequests & {
  "agent.session_open": SessionOpenWireRequest & { mcpServerOwners?: Record<string, string> };
};

export const lifecycleEventNames = [
  "agent.created",
  "agent.closed",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.tool_call_started",
  "agent.tool_call_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
] as const;
export const beforeHookNames = [
  "agent.create",
  "agent.session_open",
  "agent.compact",
  "agent.turn_prepare",
  "workspace.create",
] as const;

/** Max hidden turn context delivered to the model per turn (characters). */
export const TURN_PREPARE_MAX_CHARS = 8000;

const labelsSchema = z.record(z.string(), z.string());

const beforeSchemas = {
  "agent.create": CreateAgentRequestMessageSchema.pick({ config: true, env: true })
    .extend({
      labels: labelsSchema,
      initialPrompt: z.string().nullable(),
    })
    .strict(),
  "agent.session_open": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      title: z.string().nullable(),
      labels: z.record(z.string(), z.string()),
      tools: z.array(agentToolMetadataSchema),
      env: z.record(z.string(), z.string()),
      mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
      initialPrompt: z.string().nullable(),
      systemPrompt: z.string().nullable().optional(),
      daemonAppendSystemPrompt: z.string().nullable().optional(),
    })
    .strict(),
  "agent.compact": z
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
  "agent.turn_prepare": z
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
  "workspace.create": WorkspaceCreateRequestSchema.omit({ type: true, requestId: true }).strict(),
};

const sessionOpenLocalResultSchema = beforeSchemas["agent.session_open"].extend({
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
  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void;
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
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  labels: Record<string, string>;
}): PluginHookAgent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn_started", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission_requested", { agent, request: event.request });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission_resolved", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

function validateSessionOpenResult(
  previous: z.infer<(typeof beforeSchemas)["agent.session_open"]>,
  next: z.infer<(typeof beforeSchemas)["agent.session_open"]>,
): void {
  const identityChanged =
    previous.agentId !== next.agentId ||
    previous.workspaceId !== next.workspaceId ||
    previous.provider !== next.provider ||
    previous.cwd !== next.cwd ||
    previous.reason !== next.reason ||
    previous.purpose !== next.purpose ||
    previous.title !== next.title ||
    !isDeepStrictEqual(previous.labels, next.labels);
  if (identityChanged) {
    throw new Error("agent.session_open hooks can only change env, tools, and mcpServers");
  }
  if ((previous.initialPrompt ?? null) !== (next.initialPrompt ?? null)) {
    throw new Error("agent.session_open hooks cannot change initialPrompt");
  }
  const instructionsChanged =
    (next.systemPrompt ?? null) !== (previous.systemPrompt ?? null) ||
    (next.daemonAppendSystemPrompt ?? null) !== (previous.daemonAppendSystemPrompt ?? null);
  if (previous.purpose === "history" && instructionsChanged) {
    throw new Error("agent.session_open hooks cannot change instructions for history opens");
  }
}

function validateCreateResult(
  previous: z.infer<(typeof beforeSchemas)["agent.create"]>,
  next: z.infer<(typeof beforeSchemas)["agent.create"]>,
): void {
  if (previous.config.cwd !== next.config.cwd) {
    throw new Error("agent.create hooks cannot change the workspace directory");
  }
  const contextChanged =
    !isDeepStrictEqual(previous.labels, next.labels) ||
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
  const parsed = beforeSchemas["agent.turn_prepare"].parse(output);
  const expected = beforeSchemas["agent.turn_prepare"].parse(input);
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

export function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  input: PluginWireBeforeRequests[Name],
  output: unknown,
): PluginWireBeforeRequests[Name] {
  if (name === "agent.turn_prepare") {
    // turn_prepare hooks contribute hidden context only; agent/turn identity
    // is verified and immutable. The daemon merges the child's accumulated
    // result itself.
    return mergeTurnPrepareResult(
      input as PluginBeforeRequests["agent.turn_prepare"],
      output,
    ) as PluginWireBeforeRequests[Name];
  }
  const result = validateBeforeRequest(name, output);
  if (name === "agent.session_open") {
    validateSessionOpenResult(
      beforeSchemas["agent.session_open"].parse(input),
      beforeSchemas["agent.session_open"].parse(result),
    );
  }
  if (name === "agent.compact") {
    const previous = beforeSchemas["agent.compact"].parse(input);
    const next = beforeSchemas["agent.compact"].parse(result);
    if (JSON.stringify({ ...previous, skip: next.skip }) !== JSON.stringify(next)) {
      throw new Error("agent.compact hooks can only change skip");
    }
  }
  if (name === "agent.create") {
    validateCreateResult(
      beforeSchemas["agent.create"].parse(input),
      beforeSchemas["agent.create"].parse(result),
    );
  }
  return result;
}

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly events = new Map<string, Set<Handler>>();
  private readonly transforms = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  private readonly agentTools: PluginAgentTools | undefined;

  constructor(changed: () => void, agentTools?: PluginAgentTools) {
    this.agentTools = agentTools;
    this.changed = changed;
  }

  readonly on: PluginLifecycleRegistration["on"] = (name, handler) => {
    if (!lifecycleEventNames.includes(name)) {
      throw new Error(`Unknown lifecycle event: ${name}`);
    }
    return this.register(this.events, name, handler as Handler);
  };

  readonly before: PluginLifecycleRegistration["before"] = (name, handler) => {
    if (!beforeHookNames.includes(name)) {
      throw new Error(`Unknown before hook: ${name}`);
    }
    return this.register(this.transforms, name, handler as Handler);
  };

  catalog(): { events: string[]; before: string[] } {
    return { events: [...this.events.keys()], before: [...this.transforms.keys()] };
  }

  async invoke(
    id: string,
    kind: "event" | "before",
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (kind === "before") {
        if (
          !beforeHookNames.includes(
            name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests,
          )
        ) {
          throw new Error(`Unknown before hook: ${name}`);
        }
        const hookName = name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests;
        if (hookName === "agent.session_open") {
          return await this.openSession(input, { paseo, signal: controller.signal });
        }
        let request = validateBeforeRequest(hookName, input);
        if (hookName === "agent.turn_prepare") {
          return this.invokeTurnPrepare(
            name,
            request as PluginBeforeRequests["agent.turn_prepare"],
            paseo,
            controller,
          );
        }
        // agent.turn_prepare returns early above, so only mutating hooks
        // reach this loop. The casts are compile-time only; the runtime
        // name still selects the schema.
        type MutableHook = Exclude<typeof hookName, "agent.turn_prepare">;
        const mutableHook = hookName as MutableHook;
        for (const handler of this.transforms.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined) {
            request = validateBeforeResult(
              mutableHook,
              request as PluginWireBeforeRequests[MutableHook],
              result,
            ) as typeof request;
          }
        }
        return request;
      }
      for (const handler of this.events.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), { paseo, signal: controller.signal });
        } catch (error) {
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
    let request = validateBeforeRequest("agent.session_open", input);
    this.agentTools?.detach(request.agentId);
    let tools: AgentToolDefinition[] = [];
    for (const handler of this.transforms.get("agent.session_open") ?? []) {
      context.signal.throwIfAborted();
      const result = await handler(
        { request: { ...structuredClone(request), tools: [...tools] } },
        context,
      );
      if (result === undefined) continue;
      const local = sessionOpenLocalResultSchema.parse(result);
      const metadata = local.tools.map(serializeAgentTool);
      request = validateBeforeResult("agent.session_open", request, { ...local, tools: metadata });
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
    for (const handler of this.transforms.get(name) ?? []) {
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
          request: structuredClone({ ...request, accumulatedContext: [...accumulated] }),
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
    this.events.clear();
    this.transforms.clear();
  }

  private register(
    registry: Map<string, Set<Handler>>,
    name: string,
    handler: Handler,
  ): () => void {
    let handlers = registry.get(name);
    if (!handlers) {
      handlers = new Set();
      registry.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        registry.delete(name);
      }
      this.changed();
    };
  }
}
