import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginTurnPrepareRequest } from "@getpaseo/plugin/server";
import { PluginHookHandlers, validateBeforeResult } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.addHook("workspace.create.before", async () => {
    return;
  });
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "workspace.create.before", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async (_input, context) => {
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
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual([]);
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "agent.open.before",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
        initialPrompt: null,
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.open.before hooks can only change env");
});

test.each([{ title: "Changed" }, { labels: { changed: "true" } }])(
  "session-open targeting metadata is read-only: %j",
  async (patch) => {
    const hooks = new PluginHookHandlers(() => {});
    hooks.addHook("agent.open.before", async ({ request }) => ({ ...request, ...patch }));
    await expect(
      hooks.invoke(
        "operation",
        "agent.open.before",
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
        },
        paseo,
      ),
    ).rejects.toThrow("agent.open.before hooks can only change env, tools, and mcpServers");
  },
);

test("new request-changing registrations compose with legacy registrations in registration order", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => ({ ...request, title: "legacy" }));
  hooks.addHook("workspace.create.before", async ({ request }) => ({
    ...request,
    title: request.title + ":new",
  }));
  hooks.before("workspace.create", ({ request }) => ({
    ...request,
    title: request.title + ":last",
  }));
  expect(
    await hooks.invoke(
      "operation",
      "workspace.create.before",
      {
        source: { kind: "directory", path: "/project" },
      },
      paseo,
    ),
  ).toEqual({ source: { kind: "directory", path: "/project" }, title: "legacy:new:last" });
});

test.each(["agent.session_open", "agent.create.prepare", "nonsense"])(
  "addHook rejects unsupported name %s at registration",
  (name) => {
    const hooks = new PluginHookHandlers(() => {});
    // @ts-expect-error Runtime validation also protects untyped plugins.
    expect(() => hooks.addHook(name, async () => {})).toThrow(name);
  },
);

test.each([
  ["workspace.create", "workspace.create.before"],
  ["workspace.created", "workspace.create.after"],
  ["workspace.archived", "workspace.archive.after"],
  ["agent.create", "agent.create.before"],
  ["agent.created", "agent.create.after"],
  ["agent.session_open", "agent.open.before"],
  ["agent.closed", "agent.close.after"],
  ["agent.archived", "agent.archive.after"],
  ["agent.turn_started", "agent.turn.before"],
  ["agent.turn_ended", "agent.turn.after"],
  ["agent.permission_requested", "agent.permission.before"],
  ["agent.permission_resolved", "agent.permission.after"],
] as const)("legacy %s registers only %s across the process boundary", (oldName, newName) => {
  const hooks = new PluginHookHandlers(() => {});
  const handler = async () => {};
  const remove =
    oldName === "workspace.create" || oldName === "agent.create" || oldName === "agent.session_open"
      ? hooks.before(oldName, handler)
      : hooks.on(oldName, handler);
  hooks.addHook(newName, async () => {});
  expect(hooks.catalog()).toEqual([newName]);
  remove();
  expect(hooks.catalog()).toEqual([newName]);
  hooks.close();
  expect(hooks.catalog()).toEqual([]);
});

test("legacy notifications and addHook share payloads, registration order, and cleanup", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: unknown[] = [];
  const remove = hooks.on("workspace.created", (event) => {
    received.push(["old", event]);
  });
  hooks.addHook("workspace.create.after", async (event) => {
    received.push(["new", event]);
  });
  const payload = {
    workspace: {
      id: "workspace",
      projectId: "project",
      cwd: "/project",
      name: null,
      archivedAt: null,
    },
  };
  await hooks.invoke("first", "workspace.create.after", payload, paseo);
  remove();
  remove();
  await hooks.invoke("second", "workspace.create.after", payload, paseo);
  expect(received).toEqual([
    ["old", payload],
    ["new", payload],
    ["new", payload],
  ]);
});

test("a waiting after hook propagates failures and stops later handlers", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: string[] = [];
  hooks.addHook("worktree.create.after", async ({ worktree }) => {
    received.push(worktree.path);
    throw new Error("cannot initialize worktree");
  });
  hooks.addHook("worktree.create.after", async () => {
    received.push("unexpected later handler");
  });
  await expect(
    hooks.invoke(
      "worktree",
      "worktree.create.after",
      {
        worktree: { path: "/worktree", branch: "feature", sourceCheckout: "/source" },
      },
      paseo,
    ),
  ).rejects.toThrow("cannot initialize worktree");
  expect(received).toEqual(["/worktree"]);
});

test("checkout-branch hooks reject a branch-off baseRef", async () => {
  const request = {
    kind: "checkout-branch" as const,
    repoRoot: "/repo",
    sourceCheckout: "/repo",
    branch: "feature",
    slug: "feature",
    path: "/work/feature",
  };
  await expect(
    validateBeforeResult("worktree.create.before", request, { ...request, baseRef: "main" }),
  ).rejects.toThrow(/baseRef/);
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
      "agent.create.before",
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
      "agent.create.before",
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
    "agent.open.before",
    {
      agentId: "agent",
      workspaceId: "workspace",
      provider: "codex",
      cwd: "/project",
      reason: "resume",
      purpose: "interactive",
      env: {},
      labels: { "gc-session": "test" },
      title: null, tools: [], mcpServers: {},
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
      "agent.open.before",
      {
        agentId: "agent",
        workspaceId: null,
        provider: "codex",
        cwd: "/project",
        reason: "resume",
        purpose: "history",
        title: null, tools: [], mcpServers: {},
        env: {},
        labels: {},
        initialPrompt: null,
      },
      paseo,
    ),
  ).rejects.toThrow("agent.open.before hooks cannot change instructions for history opens");
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
    "agent.turn_prepare.before",
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
    "agent.turn_prepare.before",
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

function turnPrepareRequest(): PluginTurnPrepareRequest {
  // Real 0.14.0 payload shape.
  return {
    agent: {
      id: "agent-1",
      workspaceId: "workspace-1",
      parentAgentId: null,
      provider: "codex",
      cwd: "/project",
      title: "Worker",
      labels: { "gc-session": "test" },
    },
    turn: { prompt: "do the thing", kind: "next", purpose: "interactive", turnNumber: 2 },
    accumulatedContext: [],
  };
}

test("agent.turn_prepare keeps the accumulated request form from a child host (pa-89is1.9)", async () => {
  // Child plugin hosts answer with the full request shape (their in-process
  // invokeTurnPrepare returns {...request, accumulatedContext}). The daemon
  // used to parse that as the bare {context} handler form and threw
  // `unrecognized_keys [agent, turn, accumulatedContext]` on every turn,
  // then dropped the memory by returning the empty input.
  const request = turnPrepareRequest();
  const output = await validateBeforeResult("agent.turn_prepare.before", request, {
    ...structuredClone(request),
    accumulatedContext: ["memory: sentinel-alpha"],
  });
  expect(output.accumulatedContext).toEqual(["memory: sentinel-alpha"]);
  expect(output.agent).toEqual(request.agent);
  expect(output.turn).toEqual(request.turn);
  expect(request.accumulatedContext).toEqual([]);
  // What agent-manager composes from the validated result reaches the model.
  const { composeTurnContext } = await import("./index.js");
  expect(composeTurnContext(output.accumulatedContext ?? [])).toContain("memory: sentinel-alpha");
});

test("agent.turn_prepare merges child context without losing earlier plugins", async () => {
  const request: PluginTurnPrepareRequest = {
    ...turnPrepareRequest(),
    accumulatedContext: ["memory: sentinel-alpha"],
  };
  const output = await validateBeforeResult("agent.turn_prepare.before", request, {
    ...structuredClone(request),
    accumulatedContext: ["memory: sentinel-alpha", "memory: sentinel-beta"],
  });
  expect(output.accumulatedContext).toEqual(["memory: sentinel-alpha", "memory: sentinel-beta"]);
});

test("agent.turn_prepare accepts an empty echo without throwing (pa-89is1.9)", async () => {
  // A plugin with nothing to add echoes the request back. This is the exact
  // per-turn daemon.log case: it must validate quietly, not fail open.
  const request = turnPrepareRequest();
  const output = await validateBeforeResult("agent.turn_prepare.before", request, {
    ...structuredClone(request),
    accumulatedContext: [],
  });
  expect(output.accumulatedContext).toEqual([]);
  expect(output.agent).toEqual(request.agent);
});

test("agent.turn_prepare rejects identity changes from a child host", async () => {
  const request = turnPrepareRequest();
  await expect(
    validateBeforeResult("agent.turn_prepare.before", request, {
      ...structuredClone(request),
      agent: { ...structuredClone(request).agent, id: "other-agent" },
      accumulatedContext: ["memory: sentinel-alpha"],
    }),
  ).rejects.toThrow("agent.turn_prepare hooks cannot change agent or turn identity");
});

test("agent.turn_prepare still accepts the bare {context} handler form", async () => {
  const request = turnPrepareRequest();
  expect(
    (await validateBeforeResult("agent.turn_prepare.before", request, { context: "memory: sentinel-alpha" })).accumulatedContext,
  ).toEqual(["memory: sentinel-alpha"]);
  expect(
    (await validateBeforeResult("agent.turn_prepare.before", request, {
      context: ["memory: sentinel-alpha", "memory: sentinel-alpha", "  "],
    })).accumulatedContext,
  ).toEqual(["memory: sentinel-alpha"]);
  expect((await validateBeforeResult("agent.turn_prepare.before", request, undefined)).accumulatedContext).toEqual(
    [],
  );
});

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
  await expect(hooks.invoke("skip", "agent.compact.before", input, paseo)).resolves.toEqual({
    ...input,
    skip: true,
  });
  remove();
  hooks.before("agent.compact", ({ request }) => ({ ...request, reason: "manual" }));
  await expect(hooks.invoke("reason", "agent.compact.before", input, paseo)).rejects.toThrow(
    "agent.compact hooks can only change skip",
  );
});
