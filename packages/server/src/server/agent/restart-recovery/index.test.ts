import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { AgentManager, type ManagedAgent } from "../agent-manager.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import { PiRpcAgentClient } from "../providers/pi/agent.js";
import { FakePi } from "../providers/pi/test-utils/fake-pi.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const reported: Array<{ id: string; error: unknown }> = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken")
          throw new Error(
            'Cannot resume Pi session "broken": session file is missing: /tmp/pi-sessions/broken.jsonl. The previous context is unavailable. Restore the file or start a new session instead.',
          );
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: (id, error) => {
        reported.push({ id, error });
      },
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    // A resume that fails before registration (e.g. a missing Pi session
    // file) reaches the report hook with the agent id and the error, so the
    // startup wiring can surface it as stored error attention.
    expect(reported.map(({ id }) => id)).toEqual(["broken"]);
    expect(String((reported[0]?.error as Error)?.message)).toContain("session file is missing");
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.listAll()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A missing Pi session file at automatic restart recovery throws in
// PiRpcAgentClient.resumeSession before the agent is registered, so the
// startup dispatch (sendPromptToAgent -> ensureAgentLoaded ->
// resumeAgentFromPersistence) rejects into the recovery report hook. The
// bootstrap wiring persists that failure as stored error attention (the
// provider handle is preserved) and dispatches the stored state, instead of
// failing silently into the daemon log or starting a fresh empty Pi session
// (pa-h9i2). Pre-existing unread attention on the record is replaced by the
// current recovery error rather than suppressing it.
test("startup recovery surfaces a missing Pi session file as stored error attention without launching a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-pi-missing-"));
  const logger = createTestLogger();
  try {
    const storage = new AgentStorage(root, logger);
    const pi = new FakePi();
    const piClient = new PiRpcAgentClient({ logger, runtime: pi });
    vi.spyOn(piClient, "isAvailable").mockResolvedValue(true);
    const manager = new AgentManager({
      clients: { pi: piClient },
      registry: storage,
      logger,
    });
    // The session file is never created: resume must be refused.
    const missing = join(root, "pi-sessions", "gone.jsonl");
    const agentId = randomUUID();
    const now = new Date().toISOString();
    // The record already carries unread finished attention (preserved across
    // restart): the missing-session recovery error must still replace it
    // instead of being suppressed by the pre-existing flag.
    const staleAttentionAt = new Date(Date.now() - 60_000).toISOString();
    await storage.upsert(
      parseStoredAgentRecord({
        id: agentId,
        provider: "pi",
        cwd: root,
        createdAt: now,
        updatedAt: now,
        lastStatus: "running",
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: staleAttentionAt,
        lastError: "previous finished attention",
        config: { model: "openrouter/model-a" },
        persistence: {
          provider: "pi",
          sessionId: "pi-session-1",
          nativeHandle: missing,
          metadata: { cwd: root, model: "openrouter/model-a" },
        },
      }),
    );
    const before = await storage.get(agentId);
    expect(before?.persistence?.nativeHandle).toBe(missing);

    const events: ManagedAgent[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === agentId) {
          events.push(event.agent);
        }
      },
      { replayState: false },
    );

    // Mirror the bootstrap wiring: dispatch through sendPromptToAgent and
    // surface report failures as stored error attention.
    let flagged: Promise<boolean> | undefined;
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Resume working." }),
      eligible: async () => true,
      dispatch: (id, prompt) =>
        sendPromptToAgent({
          agentId: id,
          prompt,
          agentManager: manager,
          agentStorage: storage,
          logger,
          unarchive: false,
        }),
      report: (id, err) => {
        flagged = manager.markStoredAgentError(id, err);
        void flagged.catch(() => undefined);
      },
    });
    await recovery.prepareStartup();
    expect((await storage.get(agentId))?.resumeOnStartup).toBe(true);
    expect((await storage.get(agentId))?.lastStatus).toBe("closed");
    recovery.resumePending();
    await recovery.waitForResume(agentId, new AbortController().signal);
    await flagged;

    // No replacement Pi session is launched and no live agent is registered.
    expect(pi.recordedLaunches).toEqual([]);
    expect(manager.getAgent(agentId)).toBeNull();

    // The failure is user-visible: error attention plus the message are
    // persisted and dispatched, while the original provider handle is
    // preserved so the context can be retried or inspected.
    const after = await storage.get(agentId);
    expect(after?.persistence).toEqual(before?.persistence);
    expect(after).toMatchObject({
      lastStatus: "closed",
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: expect.any(String),
      lastError: expect.stringContaining("session file is missing"),
    });
    expect(String(after?.lastError)).toContain(missing);
    // The stale finished attention was replaced, not kept.
    expect(after?.attentionTimestamp).not.toBe(staleAttentionAt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: agentId,
      lifecycle: "closed",
      attention: {
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: expect.any(Date),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
