import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import {
  findProjectContainerForProject,
  isValidProjectContainerName,
  normalizeProjectContainerName,
  projectContainerNameKey,
} from "./project-containers.js";

const container = {
  id: "pcnt_0123456789abcdef",
  name: "Heads",
  projectIds: ["prj_a"],
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

describe("project container wire schemas", () => {
  test("keeps the capability optional for stock daemons", () => {
    const payload = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "stock-host",
      features: {},
    });
    expect(payload.features?.projectContainers).toBeUndefined();
  });

  test("a stock client's features schema ignores the new flag", () => {
    const stockFeatures = z.object({ workspaceLabels: z.boolean().optional() });
    expect(stockFeatures.parse({ workspaceLabels: true, projectContainers: true })).toEqual({
      workspaceLabels: true,
    });
  });

  test("parses every request", () => {
    const requests = [
      { type: "project.container.list.request", requestId: "r1", subscribe: {} },
      { type: "project.container.list.request", requestId: "r1b" },
      { type: "project.container.create.request", requestId: "r2", name: "Heads" },
      {
        type: "project.container.create.request",
        requestId: "r2b",
        name: "Heads",
        projectIds: ["prj_a"],
      },
      {
        type: "project.container.rename.request",
        requestId: "r3",
        containerId: container.id,
        name: "B",
      },
      { type: "project.container.delete.request", requestId: "r4", containerId: container.id },
      { type: "project.container.reorder.request", requestId: "r5", containerIds: [container.id] },
      {
        type: "project.container.assign.request",
        requestId: "r6",
        projectIds: ["prj_a"],
        containerId: null,
      },
      {
        type: "project.container.assign.request",
        requestId: "r7",
        projectIds: ["prj_a", "prj_b"],
        containerId: container.id,
        index: 0,
      },
    ];
    for (const request of requests) {
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    }
  });

  test("rejects an empty assignment and a negative index", () => {
    const base = { type: "project.container.assign.request", requestId: "r", containerId: null };
    expect(() => SessionInboundMessageSchema.parse({ ...base, projectIds: [] })).toThrow();
    expect(() =>
      SessionInboundMessageSchema.parse({ ...base, projectIds: ["p"], index: -1 }),
    ).toThrow();
  });

  test("parses every response and the catalog push", () => {
    const catalog = { containers: [container], revision: 3 };
    const outbound = [
      { type: "project.container.list.response", payload: { requestId: "r1", ...catalog } },
      { type: "project.container.update", payload: { subscriptionId: "sub-1", ...catalog } },
      { type: "project.container.create.response", payload: { requestId: "r2", container } },
      { type: "project.container.rename.response", payload: { requestId: "r3", container } },
      {
        type: "project.container.delete.response",
        payload: { requestId: "r4", containerId: container.id, detachedProjectIds: ["prj_a"] },
      },
      {
        type: "project.container.reorder.response",
        payload: { requestId: "r5", containerIds: [container.id] },
      },
      {
        type: "project.container.assign.response",
        payload: { requestId: "r6", projectIds: ["prj_a"], containerId: null },
      },
    ];
    for (const message of outbound) {
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    }
  });
});

describe("project container names", () => {
  test("normalizes whitespace and folds case for the key", () => {
    expect(normalizeProjectContainerName("  Client   Work ")).toBe("Client Work");
    expect(projectContainerNameKey(" Client  WORK")).toBe("client work");
  });

  test("accepts 1..64 characters after trimming", () => {
    expect(isValidProjectContainerName("   ")).toBe(false);
    expect(isValidProjectContainerName("a".repeat(64))).toBe(true);
    expect(isValidProjectContainerName("a".repeat(65))).toBe(false);
  });

  test("finds the container that holds a repository", () => {
    expect(findProjectContainerForProject([container], "prj_a")?.id).toBe(container.id);
    expect(findProjectContainerForProject([container], "prj_x")).toBeNull();
  });
});
