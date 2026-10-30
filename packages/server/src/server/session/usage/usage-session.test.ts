import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push({ forceRefresh: options.forceRefresh, reportIds: options.reportIds });
        options.onReport?.(entry);
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    { type: "usage.list_reports.update", payload: { requestId: "list", report: entry } },
    { type: "usage.list_reports.response", payload: { requestId: "list", error: null } },
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage(): Promise<never> {
        throw new Error("quota service down");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleLegacyList({ type: "provider.usage.list.request", requestId: "u1" });
  expect(emitted[0]).toMatchObject({
    type: "rpc_error",
    payload: { requestId: "u1", code: "provider_usage_list_failed" },
  });
});

test("pushes invalidated card ids while subscribed and stops after stopPush", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const listeners = new Set<(reportIds: string[]) => void>();
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
      subscribeUsageChanged: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    logger: pino({ level: "silent" }),
  });
  // Not started: no push.
  for (const listener of listeners) listener(["muse:abc"]);
  expect(emitted).toEqual([]);
  usage.startPush();
  usage.startPush();
  for (const listener of listeners) listener(["muse:abc"]);
  expect(emitted).toEqual([
    { type: "usage.reports.changed", payload: { reportIds: ["muse:abc"] } },
  ]);
  usage.stopPush();
  for (const listener of listeners) listener(["muse:abc"]);
  expect(emitted).toHaveLength(1);
  expect(listeners.size).toBe(0);
});

test("startPush binds a real this-dependent runtime across start/stop/restart", async () => {
  // Mirrors the real PluginService: subscribeUsageChanged is a prototype
  // method that keeps its listeners on `this`. Lifting it into a local first
  // would throw here instead of delivering the push.
  class StubRuntime {
    private readonly listeners = new Set<(reportIds: string[]) => void>();
    subscribeUsageChanged(listener: (reportIds: string[]) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }
    async listUsageReports() {
      return [];
    }
    async listLegacyUsage() {
      return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
    }
    fire(reportIds: string[]): void {
      for (const listener of this.listeners) listener(reportIds);
    }
    get subscriptions(): number {
      return this.listeners.size;
    }
  }
  const emitted: SessionOutboundMessage[] = [];
  const runtime = new StubRuntime();
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime,
    logger: pino({ level: "silent" }),
  });
  runtime.fire(["muse:abc"]);
  expect(emitted).toEqual([]);
  usage.startPush();
  usage.startPush();
  expect(runtime.subscriptions).toBe(1);
  runtime.fire(["muse:abc"]);
  expect(emitted).toEqual([
    { type: "usage.reports.changed", payload: { reportIds: ["muse:abc"] } },
  ]);
  usage.stopPush();
  expect(runtime.subscriptions).toBe(0);
  runtime.fire(["muse:abc"]);
  expect(emitted).toHaveLength(1);
  // Reconnect resubscribes and delivers again, including empty inventories.
  usage.startPush();
  runtime.fire([]);
  expect(emitted).toHaveLength(2);
  expect(emitted[1]).toEqual({ type: "usage.reports.changed", payload: { reportIds: [] } });
  usage.stopPush();
});

test("startPush without a runtime subscription is a no-op", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });
  usage.startPush();
  usage.stopPush();
  expect(emitted).toEqual([]);
});

test("request failures terminate with an error response and no updates", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "failed" });
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "failed", error: "Plugin runtime is unavailable" },
    },
  ]);
});
