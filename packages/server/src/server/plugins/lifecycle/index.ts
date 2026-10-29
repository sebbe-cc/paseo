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

export const lifecycleEventNames = [
  "agent.created",
  "agent.closed",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
] as const;
export const beforeHookNames = [
  "agent.create",
  "agent.session_open",
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
      env: z.record(z.string(), z.string()),
      labels: labelsSchema,
      initialPrompt: z.string().nullable(),
      systemPrompt: z.string().nullable().optional(),
      daemonAppendSystemPrompt: z.string().nullable().optional(),
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
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    request: PluginBeforeRequests[Name],
  ): Promise<PluginBeforeRequests[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginBeforeRequests>(
  name: Name,
  value: unknown,
): PluginBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginBeforeRequests[Name];
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

function sameLabels(
  previous: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): boolean {
  return JSON.stringify(previous ?? {}) === JSON.stringify(next ?? {});
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
    previous.purpose !== next.purpose;
  if (identityChanged) {
    throw new Error("agent.session_open hooks can only change env");
  }
  const contextChanged =
    !sameLabels(previous.labels, next.labels) ||
    (previous.initialPrompt ?? null) !== (next.initialPrompt ?? null);
  if (contextChanged) {
    throw new Error("agent.session_open hooks cannot change labels or initialPrompt");
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
    !sameLabels(previous.labels, next.labels) ||
    (previous.initialPrompt ?? null) !== (next.initialPrompt ?? null);
  if (contextChanged) {
    throw new Error("agent.create hooks cannot change labels or initialPrompt");
  }
}

export function validateBeforeResult<Name extends keyof PluginBeforeRequests>(
  name: Name,
  input: PluginBeforeRequests[Name],
  output: unknown,
): PluginBeforeRequests[Name] {
  if (name === "agent.turn_prepare") {
    // turn_prepare hooks contribute hidden context only; agent/turn identity
    // is verified and immutable. The daemon accumulates `context` itself.
    normalizeTurnContextPieces(output);
    return input;
  }
  const result = validateBeforeRequest(name, output);
  if (name === "agent.session_open") {
    validateSessionOpenResult(
      beforeSchemas["agent.session_open"].parse(input),
      beforeSchemas["agent.session_open"].parse(result),
    );
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

  constructor(changed: () => void) {
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
              request as PluginBeforeRequests[MutableHook],
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
