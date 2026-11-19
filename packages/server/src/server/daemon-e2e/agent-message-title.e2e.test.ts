import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("an untitled session takes its title from the first agent message's own text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-message-title-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients(),
    paseoHomeRoot: path.join(root, "daemon"),
    cleanup: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const sender = await client.createAgent({
      provider: "claude",
      cwd: root,
      title: "Orchestrator",
    });
    const recipient = await client.createAgent({ provider: "claude", cwd: root });
    expect((await client.fetchAgent({ agentId: recipient.id }))?.agent.title ?? null).toBeNull();

    // What `paseo send` does when PASEO_AGENT_ID is set: the daemon wraps the text in an
    // agent-message envelope before it reaches the provider.
    await client.sendAgentMessage(
      recipient.id,
      "Audit the nightly build\n\nReport blockers only.",
      {
        sourceAgentId: sender.id,
      },
    );
    await client.waitForFinish(recipient.id);

    const titled = await client.fetchAgent({ agentId: recipient.id });
    expect(titled?.agent.title).toBe("Audit the nightly build");

    await client.sendAgentMessage(recipient.id, "Now check the release branch", {
      sourceAgentId: sender.id,
    });
    await client.waitForFinish(recipient.id);
    expect((await client.fetchAgent({ agentId: recipient.id }))?.agent.title).toBe(
      "Audit the nightly build",
    );
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
