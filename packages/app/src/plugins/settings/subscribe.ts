import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import type { RpcOutput, settingsRpc, SettingsDefinition } from "@getpaseo/plugin";
import type { PluginSettingsSnapshot } from "@getpaseo/plugin/client";
import type { ZodType } from "zod";
import { pluginSettingsKey } from "./query";

type ReadResult = RpcOutput<ReturnType<typeof settingsRpc>["read"]>;

interface SubscribeSettingsInput<Schema extends ZodType> {
  definition: SettingsDefinition<Schema>;
  queryClient: QueryClient;
  read: () => Promise<ReadResult>;
  signal: AbortSignal;
}

/** Shares the screen's replica cache and catalog push/reconnect invalidations. */
export function subscribePluginSettings<Schema extends ZodType>(
  { definition, queryClient, read, signal }: SubscribeSettingsInput<Schema>,
  listener: (snapshot: PluginSettingsSnapshot<Schema>) => void,
): () => void {
  if (signal.aborted) return () => {};
  const observer = new QueryObserver(queryClient, {
    queryKey: pluginSettingsKey(definition.id),
    queryFn: read,
    gcTime: Infinity,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    meta: { serverDataPolicy: { class: "replica", pushEvent: "plugin_settings_changed" } },
  });
  let active = true;
  function emit() {
    if (!active) return;
    const result = observer.getCurrentResult();
    if (result.isPending) return listener({ status: "loading" });
    if (result.isError) return listener({ status: "error", error: result.error.message });
    const data = result.data;
    if (data.status === "invalid") return listener(data);
    const parsed = definition.schema.safeParse(data.values);
    if (!parsed.success) {
      listener({ status: "invalid", revision: data.revision, error: parsed.error.message });
      return;
    }
    listener({ status: "ready", revision: data.revision, values: parsed.data });
  }
  let unsubscribe = () => {};
  function stop() {
    if (!active) return;
    active = false;
    signal.removeEventListener("abort", stop);
    unsubscribe();
    observer.destroy();
  }
  signal.addEventListener("abort", stop, { once: true });
  // Covers cached data too: QueryObserver need not notify on subscribe.
  try {
    unsubscribe = observer.subscribe(emit);
    emit();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
