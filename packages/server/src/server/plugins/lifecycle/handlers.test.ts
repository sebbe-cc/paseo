import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
        initialPrompt: null,
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});

test.each([{ title: "Changed" }, { labels: { changed: "true" } }])(
  "session-open targeting metadata is read-only: %j",
  async (patch) => {
    const hooks = new PluginHookHandlers(() => {});
    hooks.before("agent.session_open", ({ request }) => ({ ...request, ...patch }));
    await expect(
      hooks.invoke(
        "operation",
        "before",
        "agent.session_open",
        {
          agentId: "agent",
          workspaceId: null,
          provider: "codex",
          cwd: "/project",
          title: "Original",
          labels: {},
          tools: [],
          mcpServers: {},
          env: {},
          reason: "create",
          purpose: "interactive",
          initialPrompt: null,
        },
        paseo,
      ),
    ).rejects.toThrow("agent.session_open hooks can only change env, tools, and mcpServers");
  },
);

test("agent.compact hooks can only change skip", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const input = {
    agentId: "agent-1",
    provider: "claude",
    reason: "auto",
    source: "provider",
    usage: { contextWindowUsedTokens: 900, contextWindowMaxTokens: 1000 },
    skip: false,
  };
  const remove = hooks.before("agent.compact", ({ request }) => ({ ...request, skip: true }));
  await expect(hooks.invoke("skip", "before", "agent.compact", input, paseo)).resolves.toEqual({
    ...input,
    skip: true,
  });
  remove();
  hooks.before("agent.compact", ({ request }) => ({ ...request, reason: "manual" }));
  await expect(hooks.invoke("reason", "before", "agent.compact", input, paseo)).rejects.toThrow(
    "agent.compact hooks can only change skip",
  );
});

test("agent.create exposes labels and initialPrompt but rejects changes to them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const seen: unknown[] = [];
  hooks.before("agent.create", ({ request }) => {
    seen.push({ labels: request.labels, initialPrompt: request.initialPrompt });
    return { ...request, labels: { changed: "yes" } };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.create",
      {
        config: { provider: "codex", cwd: "/project" },
        env: {},
        labels: { "gc-session": "test" },
        initialPrompt: "do the thing",
      },
      paseo,
    ),
  ).rejects.toThrow("agent.create hooks cannot change labels or initialPrompt");
  expect(seen).toEqual([{ labels: { "gc-session": "test" }, initialPrompt: "do the thing" }]);
});

test("agent.create still rejects moving the workspace directory", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { ...request, config: { ...request.config, cwd: "/elsewhere" } };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.create",
      {
        config: { provider: "codex", cwd: "/project" },
        env: {},
        labels: {},
        initialPrompt: null,
      },
      paseo,
    ),
  ).rejects.toThrow("agent.create hooks cannot change the workspace directory");
});

test("agent.session_open allows instruction recomposition for interactive opens", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return {
      ...request,
      env: { ...request.env, COMPANY_ENV: "development" },
      systemPrompt: "fresh role prompt",
      daemonAppendSystemPrompt: "fresh context",
    };
  });
  const output = (await hooks.invoke(
    "operation",
    "before",
    "agent.session_open",
    {
      agentId: "agent",
      workspaceId: "workspace",
      provider: "codex",
      cwd: "/project",
      reason: "resume",
      purpose: "interactive",
      env: {},
      title: null,
      labels: { "gc-session": "test" },
      tools: [],
      mcpServers: {},
      initialPrompt: "do the thing",
      systemPrompt: "stale role prompt",
      daemonAppendSystemPrompt: null,
    },
    paseo,
  )) as { env: Record<string, string>; systemPrompt: string; daemonAppendSystemPrompt: string };
  expect(output.env).toEqual({ COMPANY_ENV: "development" });
  expect(output.systemPrompt).toBe("fresh role prompt");
  expect(output.daemonAppendSystemPrompt).toBe("fresh context");
});

test("agent.session_open rejects instruction changes for history opens", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, systemPrompt: "fresh role prompt" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: null,
        provider: "codex",
        cwd: "/project",
        reason: "resume",
        purpose: "history",
        env: {},
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
        initialPrompt: null,
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks cannot change instructions for history opens");
});

test("agent.turn_prepare accumulates hidden context in order without touching identity", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const seen: unknown[] = [];
  hooks.before("agent.turn_prepare", ({ request }) => {
    seen.push({
      agentId: request.agent.id,
      labels: request.agent.labels,
      prompt: request.turn.prompt,
      kind: request.turn.kind,
      turnNumber: request.turn.turnNumber,
      accumulated: request.accumulatedContext,
    });
    return { context: "memory: sentinel-alpha" };
  });
  hooks.before("agent.turn_prepare", () => {
    return { context: ["memory: sentinel-beta", "memory: sentinel-alpha"] };
  });
  hooks.before("agent.turn_prepare", () => undefined);
  const output = (await hooks.invoke(
    "operation",
    "before",
    "agent.turn_prepare",
    {
      agent: {
        id: "agent-1",
        workspaceId: "workspace-1",
        parentAgentId: null,
        provider: "codex",
        cwd: "/project",
        title: "Worker",
        labels: { "gc-session": "test" },
      },
      turn: { prompt: "do the thing", kind: "start", purpose: "interactive", turnNumber: 1 },
      accumulatedContext: [],
    },
    paseo,
  )) as { accumulatedContext: string[] };
  // Exact duplicates are delivered once, in registration order.
  expect(output.accumulatedContext).toEqual(["memory: sentinel-alpha", "memory: sentinel-beta"]);
  expect(seen).toEqual([
    {
      agentId: "agent-1",
      labels: { "gc-session": "test" },
      prompt: "do the thing",
      kind: "start",
      turnNumber: 1,
      accumulated: [],
    },
  ]);
});

test("agent.turn_prepare is fail-open: a throwing hook is skipped and the turn keeps the rest", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.turn_prepare", () => {
    throw new Error("hindsight is down");
  });
  hooks.before("agent.turn_prepare", () => {
    return { context: "memory: sentinel-alpha" };
  });
  const output = (await hooks.invoke(
    "operation",
    "before",
    "agent.turn_prepare",
    {
      agent: {
        id: "agent-1",
        workspaceId: null,
        parentAgentId: null,
        provider: "claude",
        cwd: "/project",
        title: null,
        labels: {},
      },
      turn: { prompt: "do the thing", kind: "next", purpose: "interactive", turnNumber: 2 },
      accumulatedContext: [],
    },
    paseo,
  )) as { accumulatedContext: string[] };
  expect(output.accumulatedContext).toEqual(["memory: sentinel-alpha"]);
});

test("turn context composes once, wraps without mutating the prompt, and caps length", async () => {
  const { composeTurnContext, wrapPromptWithTurnContext, TURN_PREPARE_MAX_CHARS } =
    await import("./index.js");
  expect(composeTurnContext(["  ", "memory: sentinel-alpha", "memory: sentinel-alpha"])).toBe(
    "memory: sentinel-alpha",
  );
  expect(composeTurnContext([])).toBeNull();
  const long = "x".repeat(TURN_PREPARE_MAX_CHARS + 100);
  expect(composeTurnContext([long])?.length).toBe(TURN_PREPARE_MAX_CHARS);
  const wrapped = wrapPromptWithTurnContext("do the thing", "memory: sentinel-alpha");
  expect(wrapped).toContain("memory: sentinel-alpha");
  expect(wrapped).toContain("do the thing");
  expect(wrapPromptWithTurnContext("do the thing", null)).toBe("do the thing");
});
