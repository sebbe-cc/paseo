import { QueryClient } from "@tanstack/react-query";
import { defineSettings, settingsRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { subscribePluginSettings } from "./subscribe";
import { pluginSettingsKey } from "./query";

const definition = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ enabled: z.boolean() }),
});
type ReadResult = RpcOutput<ReturnType<typeof settingsRpc>["read"]>;

function setup(read: () => Promise<ReadResult>) {
  const queryClient = new QueryClient();
  const lifetime = new AbortController();
  const states: unknown[] = [];
  const stop = subscribePluginSettings(
    { definition, queryClient, read, signal: lifetime.signal },
    (state) => states.push(state),
  );
  return { queryClient, lifetime, states, stop };
}

describe("app-lifetime settings subscriptions", () => {
  it("initializes without a surface, follows saved settings and reconnect invalidations, then releases", async () => {
    let revision = "1";
    let enabled = false;
    const h = setup(async () => ({ status: "ready", revision, values: { enabled } }));
    await expect
      .poll(() => h.states.at(-1))
      .toEqual({ status: "ready", revision: "1", values: { enabled: false } });
    revision = "2";
    enabled = true;
    await h.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(definition.id) });
    expect(h.states.at(-1)).toEqual({ status: "ready", revision: "2", values: { enabled: true } });
    revision = "3";
    await h.queryClient.invalidateQueries({ queryKey: ["plugin-settings"], refetchType: "all" });
    expect(h.states.at(-1)).toEqual({ status: "ready", revision: "3", values: { enabled: true } });
    h.lifetime.abort();
    const count = h.states.length;
    h.queryClient.setQueryData(pluginSettingsKey(definition.id), {
      status: "ready",
      revision: "4",
      values: { enabled: false },
    });
    expect(h.states).toHaveLength(count);
    expect(h.queryClient.getQueryCache().getAll()[0].getObserversCount()).toBe(0);
    h.stop();
    h.queryClient.clear();
  });

  it("validates cached values and reports read failure without a screen", async () => {
    const h = setup(async () => ({
      status: "ready",
      revision: "1",
      values: { enabled: "invalid" },
    }));
    await expect.poll(() => h.states.at(-1)).toMatchObject({ status: "invalid", revision: "1" });
    h.stop();
    h.queryClient.clear();
    const failed = setup(async () => {
      throw new Error("offline");
    });
    await expect.poll(() => failed.states.at(-1)).toEqual({ status: "error", error: "offline" });
    failed.lifetime.abort();
    failed.queryClient.clear();
  });

  it("ignores an in-flight read after unsubscribe", async () => {
    let resolve!: (value: ReadResult) => void;
    const h = setup(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    h.stop();
    const count = h.states.length;
    resolve({ status: "ready", revision: "late", values: { enabled: true } });
    await new Promise((accept) => setTimeout(accept, 0));
    expect(h.states).toHaveLength(count);
    h.queryClient.clear();
  });
  it("releases the observer if the initial consumer throws", () => {
    function failConsumer(): never {
      throw new Error("consumer failed");
    }
    const queryClient = new QueryClient();
    const lifetime = new AbortController();
    expect(() =>
      subscribePluginSettings(
        {
          definition,
          queryClient,
          signal: lifetime.signal,
          read: async () => ({ status: "ready", revision: "1", values: { enabled: true } }),
        },
        failConsumer,
      ),
    ).toThrow("consumer failed");
    expect(queryClient.getQueryCache().getAll()[0].getObserversCount()).toBe(0);
    lifetime.abort();
    queryClient.clear();
  });
});
