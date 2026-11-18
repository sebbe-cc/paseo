import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../output/index.js";
import { permitResponseSchema, toPermissionResponseItem } from "./allow.js";
import type { Command } from "commander";
import { listPendingPermissions, runLsCommand } from "./ls.js";

const { connectToDaemon } = vi.hoisted(() => ({ connectToDaemon: vi.fn() }));
vi.mock("../../utils/client.js", () => ({ connectToDaemon }));

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";

function permissionRequest(id: string): AgentPermissionRequest {
  return { id, provider: "claude", name: "Write", kind: "tool" };
}

const writeRequest = permissionRequest("permission-cc93510e-a45d-4c4e-a0bf-fc2821f82783");
const editRequest = permissionRequest("permission-654ff862-b312-4f6e-8aac-427421ff65eb");

const agent = {
  id: agentId,
  pendingPermissions: [writeRequest, editRequest],
} as AgentSnapshotPayload;

describe("permit ls output", () => {
  it("emits full request ids that permit allow accepts", () => {
    const result = listPendingPermissions([agent]);

    const listed = JSON.parse(render(result, { format: "json" })) as Array<{ id: string }>;
    expect(listed.map((item) => item.id)).toEqual([writeRequest.id, editRequest.id]);
    expect(render(result, { quiet: true }).split("\n")).toEqual([writeRequest.id, editRequest.id]);
  });
});

describe("permit allow and deny output", () => {
  it("emits the full id of the request that was answered", () => {
    const result = {
      type: "list" as const,
      data: [toPermissionResponseItem(agentId, writeRequest, "allowed")],
      schema: permitResponseSchema,
    };

    const answered = JSON.parse(render(result, { format: "json" })) as Array<{
      requestId: string;
    }>;
    expect(answered.map((item) => item.requestId)).toEqual([writeRequest.id]);
  });
});

describe("permit ls", () => {
  it("lists pending permissions of background agents on every directory page", async () => {
    const pages = [
      { entries: [{ agent: { id: "a1", pendingPermissions: [] } }], pageInfo: { nextCursor: "c" } },
      {
        entries: [{ agent: { ...agent, background: true } }],
        pageInfo: { nextCursor: null },
      },
    ];
    const requests: unknown[] = [];
    const client = {
      async fetchAgents(options: unknown) {
        requests.push(options);
        return pages[requests.length - 1];
      },
      async close() {},
    };
    connectToDaemon.mockResolvedValue(client);

    const result = await runLsCommand({}, {} as Command);

    expect(result.data.map((item) => item.id)).toEqual([writeRequest.id, editRequest.id]);
    expect(requests[0]).toMatchObject({
      filter: { includeArchived: true, includeBackground: true },
    });
  });
});
