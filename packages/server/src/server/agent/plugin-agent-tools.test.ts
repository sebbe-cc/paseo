import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { readPluginManifest } from "../plugins/manifest.js";
import { type PluginAgentTool, resolveAgentTools } from "../plugins/runtime.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { createAgentMcpServer } from "./mcp-server.js";

const TOOLS: PluginAgentTool[] = [
  {
    pluginId: "changes-walkthrough",
    method: "walkthrough.sources",
    description: "List diff sources.",
    inputSchema: { type: "object", properties: { workspaceId: { type: "string" } } },
  },
  {
    pluginId: "other",
    method: "other.ping",
    description: "Ping.",
    inputSchema: { type: "object" },
  },
];

async function connect(pluginAgentTools?: {
  listAgentTools: () => PluginAgentTool[];
  invokeAgentTool: (pluginId: string, method: string, input: unknown) => Promise<unknown>;
}) {
  const server = await createAgentMcpServer({
    agentManager: { getAgent: () => null, listAgents: () => [] } as unknown as AgentManager,
    agentStorage: { list: async () => [] } as unknown as AgentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    ...(pluginAgentTools ? { pluginAgentTools } : {}),
    logger: createTestLogger(),
  });
  const client = new Client({ name: "plugin-agent-tools-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("plugin agent tool MCP bridge", () => {
  it("lists exposed tools, optionally for one plugin", async () => {
    const client = await connect({ listAgentTools: () => TOOLS, invokeAgentTool: vi.fn() });
    const all = await client.callTool({ name: "list_plugin_tools", arguments: {} });
    expect(all.structuredContent).toEqual({ tools: TOOLS });
    const one = await client.callTool({
      name: "list_plugin_tools",
      arguments: { pluginId: "other" },
    });
    expect(one.structuredContent).toEqual({ tools: [TOOLS[1]] });
  });

  it("forwards calls with an empty input by default", async () => {
    const invokeAgentTool = vi.fn().mockResolvedValue({ sources: [] });
    const client = await connect({ listAgentTools: () => TOOLS, invokeAgentTool });
    const result = await client.callTool({
      name: "call_plugin_tool",
      arguments: { pluginId: "changes-walkthrough", method: "walkthrough.sources" },
    });
    expect(invokeAgentTool).toHaveBeenCalledWith("changes-walkthrough", "walkthrough.sources", {});
    expect(result.structuredContent).toEqual({
      pluginId: "changes-walkthrough",
      method: "walkthrough.sources",
      output: { sources: [] },
    });
  });

  it("reports plugin errors as tool errors", async () => {
    const client = await connect({
      listAgentTools: () => TOOLS,
      invokeAgentTool: vi.fn().mockRejectedValue(new Error("not exposed")),
    });
    const result = await client.callTool({
      name: "call_plugin_tool",
      arguments: { pluginId: "other", method: "other.secret", input: {} },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not exposed");
  });

  it("fails clearly when the host has no plugin service", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "list_plugin_tools", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not configured");
  });
});

describe("plugin agent tool declarations", () => {
  it("keeps only declared methods the plugin actually handles", () => {
    const tools = resolveAgentTools(
      "p",
      [
        { method: "a.run", description: "Runs a." },
        { method: "b.missing", description: "Not registered." },
      ],
      { methods: ["a.run", "c.private"], inputSchemas: { "a.run": { type: "object" } } },
    );
    expect(tools).toEqual([
      { pluginId: "p", method: "a.run", description: "Runs a.", inputSchema: { type: "object" } },
    ]);
    expect(resolveAgentTools("p", undefined, { methods: ["a.run"] })).toEqual([]);
  });

  it("validates agentTools in the manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-tools-manifest-"));
    try {
      const write = (agentTools: unknown) =>
        writeFile(
          path.join(directory, "paseo-plugin.json"),
          JSON.stringify({ id: "p", agentTools }),
        );
      await write([{ method: "a.run", description: "Runs a." }]);
      await expect(readPluginManifest(directory)).resolves.toMatchObject({
        agentTools: [{ method: "a.run", description: "Runs a." }],
      });
      await write([{ method: "Bad Method", description: "x" }]);
      await expect(readPluginManifest(directory)).rejects.toThrow();
      await write([{ method: "a.run" }]);
      await expect(readPluginManifest(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
