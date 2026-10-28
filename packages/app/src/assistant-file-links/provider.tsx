import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";
import type { AssistantFileBatchRpc } from "./queries";
import { createAssistantFileBatcher } from "./queries";
import type { AssistantFileResolveResult } from "@getpaseo/client/internal/daemon-client";

export interface AssistantFileLinkDaemonClient {
  readFile?: import("@getpaseo/client/internal/daemon-client").DaemonClient["readFile"];
  getDirectorySuggestions: GetDirectorySuggestions;
  resolveAssistantFiles?: import("@getpaseo/client/internal/daemon-client").DaemonClient["resolveAssistantFiles"];
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  relativePathBase?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
  /**
   * Opt in to the daemon batch existence check (`assistant_file_resolve_request`).
   * Call sites pass this only when the daemon advertises
   * `features.assistantFileResolve`; older daemons keep the legacy
   * per-link suggestion lookup.
   */
  batchResolve?: boolean;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  getAssistantFileResolution: (path: string) => Promise<AssistantFileResolveResult | null> | null;
  batchSupported: boolean;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function useAssistantFileLinkEnvironmentBridge() {
  const value = useContext(AssistantFileLinkResolverContext);
  return useCallback(
    (children: ReactNode) => (
      <AssistantFileLinkResolverContext.Provider value={value}>
        {children}
      </AssistantFileLinkResolverContext.Provider>
    ),
    [value],
  );
}

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  relativePathBase,
  onOpenWorkspaceFile,
  toast,
  batchResolve,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  });
  configRef.current = {
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  // Coalesces the concurrent per-link checks of one render commit into a
  // single daemon batch. Recreated when the client, server, or workspace
  // changes so batches never mix scopes.
  const batcher = useMemo(() => {
    if (batchResolve !== true || !client?.resolveAssistantFiles || !workspaceRoot?.trim()) {
      return null;
    }
    const activeClient = client;
    const activeRoot = workspaceRoot;
    return createAssistantFileBatcher(
      (batchInput: Parameters<AssistantFileBatchRpc>[0]) =>
        activeClient.resolveAssistantFiles!({
          cwd: batchInput.cwd,
          workspaceRoot: batchInput.workspaceRoot,
          candidates: batchInput.candidates,
        }),
      { cwd: activeRoot, workspaceRoot: activeRoot },
    );
  }, [client, workspaceRoot, batchResolve]);

  const getAssistantFileResolution = useCallback(
    (path: string) => batcher?.(path) ?? null,
    [batcher],
  );

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({
      configRef,
      getDirectorySuggestions,
      getAssistantFileResolution,
      batchSupported: batcher !== null,
    }),
    [getDirectorySuggestions, getAssistantFileResolution, batcher],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  return context ?? EMPTY_CONTEXT;
}

export type { AssistantFileLinkContext };

const EMPTY_CONTEXT: AssistantFileLinkResolverContextValue = {
  configRef: { current: {} },
  getDirectorySuggestions: async () => ({ entries: [], error: null }),
  getAssistantFileResolution: () => null,
  batchSupported: false,
};

export function useAssistantFileLinkEnvironment() {
  return useAssistantFileLinkResolverContext().configRef.current;
}
