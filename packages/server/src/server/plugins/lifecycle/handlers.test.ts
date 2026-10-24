import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers, validateBeforeResult } from "./index.js";

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
        ...admissionFields,
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});

const admissionFields = {
  origin: { kind: "plugin" as const, pluginId: "owner" },
  operation: {
    id: "op",
    agentId: "agent",
    reason: "resume" as const,
    attempt: 1,
    supersedes: null,
    startedAt: "2026-10-23T00:00:00Z",
  },
  binding: null,
  history: { epoch: null, nextSeq: 1, persistence: null },
};
const opening = {
  ...admissionFields,
  agentId: "agent",
  workspaceId: "workspace",
  provider: "claude",
  cwd: "/project",
  reason: "resume" as const,
  purpose: "interactive" as const,
  env: {},
};

test.each([
  ["origin", { kind: "daemon", source: "restore" }],
  ["operation", { ...admissionFields.operation, id: "forged" }],
  [
    "binding",
    { revision: 1, data: {}, boundAt: "2026-10-23T00:00:00Z", boundBy: admissionFields.origin },
  ],
  ["history", { ...admissionFields.history, nextSeq: 99 }],
])("session-open rejects valid but changed read-only %s", (field, value) => {
  expect(() =>
    validateBeforeResult(
      "agent.session_open",
      opening,
      { ...opening, [String(field)]: value },
      "owner",
    ),
  ).toThrow("can only change env");
});

test("denials preserve their code and stop the before chain", async () => {
  const hooks = new PluginHookHandlers(() => {}, "owner");
  hooks.before("agent.session_open", () => ({
    deny: { code: "RESERVATION_REJECTED", message: "No reservation" },
  }));
  hooks.before("agent.session_open", () => {
    throw new Error("must not run");
  });
  const output = await hooks.invoke("op", "before", "agent.session_open", opening, paseo);
  expect(() => validateBeforeResult("agent.session_open", opening, output, "owner")).toThrow(
    expect.objectContaining({ code: "RESERVATION_REJECTED", stage: "hook" }),
  );
});

test("only the originating plugin can set bindingIntent", () => {
  const creating = {
    config: { provider: "claude", cwd: "/project" },
    origin: admissionFields.origin,
  };
  expect(
    validateBeforeResult(
      "agent.create",
      creating,
      { ...creating, bindingIntent: { pin: true } },
      "owner",
    ),
  ).toMatchObject({ bindingIntent: { pin: true } });
  expect(() =>
    validateBeforeResult("agent.create", creating, { ...creating, bindingIntent: {} }, "foreign"),
  ).toThrow("originating plugin");
  const client = {
    ...creating,
    origin: { kind: "client" as const, principalId: "owner", clientId: "cli", clientType: "cli" },
  };
  expect(() =>
    validateBeforeResult("agent.create", client, { ...client, bindingIntent: {} }, "owner"),
  ).toThrow("originating plugin");
  expect(() =>
    validateBeforeResult("agent.create", client, { ...client, origin: creating.origin }, "owner"),
  ).toThrow("read-only");
});
