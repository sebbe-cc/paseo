import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

describe("daemon E2E - persistence", () => {
  let ctx: DaemonTestContext;
  let messages: SessionOutboundMessage[] = [];
  let unsubscribe: (() => void) | null = null;
  let cleaned = false;

  beforeEach(async () => {
    cleaned = false;
    ctx = await createDaemonTestContext();
    messages = [];
    unsubscribe = ctx.client.subscribeRawMessages((message) => {
      messages.push(message);
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    if (!cleaned) {
      await ctx.cleanup();
    }
  }, 60_000);

  test("persists and resumes Codex agent with conversation context", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Persistence Test Agent",
        modeId: "full-access",
      });

      messages.length = 0;
      await ctx.client.sendMessage(agent.id, "Say 'state saved' and nothing else");
      const afterMessage = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterMessage.status).toBe("idle");
      expect(afterMessage.final?.persistence).toBeTruthy();
      expect(afterMessage.final?.persistence?.provider).toBe("codex");
      expect(afterMessage.final?.persistence?.sessionId).toBeTruthy();
      expect(
        (afterMessage.final?.persistence?.metadata as { conversationId?: string } | undefined)
          ?.conversationId,
      ).toBeTruthy();

      const handle = afterMessage.final!.persistence!;

      await ctx.client.deleteAgent(agent.id);

      const resumed = await ctx.client.resumeAgent(handle);
      expect(resumed.provider).toBe("codex");
      expect(resumed.cwd).toBe(cwd);
      await ctx.client.subscribeAgentTimeline(resumed.id, () => {}).ready;

      messages.length = 0;
      await ctx.client.sendMessage(resumed.id, "What did I ask you to say earlier?");
      const afterResume = await ctx.client.waitForFinish(resumed.id, 5_000);
      expect(afterResume.status).toBe("idle");

      const assistantText = extractAssistantText(messages, resumed.id);
      expect(assistantText.toLowerCase()).toContain("state saved");

      await ctx.client.deleteAgent(resumed.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test.each(["claude", "codex", "opencode"])(
    "%s keeps MCP placeholders and history through daemon restart and resume",
    async (provider) => {
      const cwd = tmpCwd();
      const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "persistence-mcp-home-"));
      const mcpServers = {
        external: {
          type: "http" as const,
          url: "http://localhost/mcp",
          headers: { Authorization: "${PASEO_AGENT_ID}" },
        },
      };
      const digest = (value: unknown) =>
        createHash("sha256")
          .update(JSON.stringify(value ?? null))
          .digest("hex");
      const start = () =>
        createDaemonTestContext({
          paseoHomeRoot,
          cleanup: false,
          agentClients: createTestAgentClients({ supportsMcpServers: true }),
        });
      try {
        await ctx.cleanup();
        ctx = await start();
        const storage = new AgentStorage(
          path.join(ctx.daemon.paseoHome, "agents"),
          createTestLogger(),
        );
        const assertStored = async (agentId: string) => {
          const record = await storage.get(agentId);
          // Only hash comparisons: neither agent records nor header values reach test output.
          expect(digest(record?.config?.mcpServers)).toBe(digest(mcpServers));
          expect(digest(record?.persistence?.metadata?.mcpServers)).toBe(digest(mcpServers));
        };
        const agent = await ctx.client.createAgent({
          provider,
          cwd,
          mcpServers,
        });
        await assertStored(agent.id);
        await ctx.client.sendMessage(agent.id, "Say 'timeline test' and nothing else");
        expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");
        await assertStored(agent.id);

        await ctx.cleanup();
        ctx = await start();
        const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
        });
        expect(
          timeline.entries
            .flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : []))
            .join(""),
        ).toBe("timeline test");
        await assertStored(agent.id);
        // Sending after restart loads the stored agent and resumes its provider session.
        await ctx.client.sendMessage(agent.id, "Say 'state saved' and nothing else");
        expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");
        await assertStored(agent.id);
      } finally {
        await ctx.cleanup();
        cleaned = true;
        rmSync(cwd, { recursive: true, force: true });
        rmSync(paseoHomeRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("timeline survives daemon restart", async () => {
    const cwd = tmpCwd();
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-home-root-"));
    try {
      // Start daemon with a stable on-disk home so "restart" can observe persisted timeline.
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      unsubscribe?.();
      messages = [];
      unsubscribe = ctx.client.subscribeRawMessages((message) => {
        messages.push(message);
      });

      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Restart Timeline Test Agent",
        modeId: "full-access",
      });
      const agentId = agent.id;

      messages.length = 0;
      await ctx.client.sendMessage(agentId, "Say 'timeline test' and nothing else");
      const afterMessage = await ctx.client.waitForFinish(agentId, 5_000);
      expect(afterMessage.status).toBe("idle");
      expect(afterMessage.final?.persistence).toBeTruthy();

      await ctx.cleanup();
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      unsubscribe?.();
      messages = [];
      unsubscribe = ctx.client.subscribeRawMessages((message) => {
        messages.push(message);
      });

      const timeline = await ctx.client.fetchAgentTimeline(agentId, {
        direction: "tail",
        limit: 0,
      });
      const timelineItems = timeline.entries.map((entry) => entry.item);
      expect(timelineItems.length).toBeGreaterThan(0);
      const assistantMessages = timelineItems.filter(
        (item): item is Extract<(typeof timelineItems)[number], { type: "assistant_message" }> =>
          item.type === "assistant_message",
      );
      expect(assistantMessages.length).toBeGreaterThan(0);
      expect(assistantMessages.map((item) => item.text).join("")).toBe("timeline test");
    } finally {
      await ctx.cleanup();
      cleaned = true;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paseoHomeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function extractAssistantText(queue: SessionOutboundMessage[], agentId: string): string {
  const parts: string[] = [];
  for (const m of queue) {
    if (m.type !== "agent_stream") continue;
    if (m.payload.agentId !== agentId) continue;
    if (m.payload.event.type !== "timeline") continue;
    const item = m.payload.event.item;
    if (item.type === "assistant_message") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}
