import type {
  AssistantFileResolvePayload,
  AssistantFileResolveResult,
} from "@getpaseo/client/internal/daemon-client";

export type AssistantFileBatchRpc = (input: {
  cwd: string;
  workspaceRoot?: string;
  candidates: string[];
}) => Promise<AssistantFileResolvePayload>;

interface PendingBatchEntry {
  path: string;
  resolve: (result: AssistantFileResolveResult | null) => void;
  reject: (error: unknown) => void;
}

function missingResult(path: string): AssistantFileResolveResult {
  return { path, status: "missing", absolutePath: null, searchedRoots: [], modifiedAt: null };
}

/**
 * Coalesces concurrent per-link existence checks into one daemon batch per
 * flush window. Every file link of a message mounts in the same commit, so
 * one `assistant_file_resolve_request` covers the whole message (and any
 * other message that mounts in the same window). Results are cached by
 * react-query on top of this; the batcher only deduplicates in-flight work.
 */
export function createAssistantFileBatcher(
  rpc: AssistantFileBatchRpc,
  input: { cwd: string; workspaceRoot?: string; windowMs?: number; maxBatch?: number },
): (path: string) => Promise<AssistantFileResolveResult | null> {
  const windowMs = input.windowMs ?? 50;
  const maxBatch = input.maxBatch ?? 50;
  let pending: PendingBatchEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    const uniquePaths = [...new Set(batch.map((entry) => entry.path))].slice(0, maxBatch);
    const byPath = new Map<string, PendingBatchEntry[]>();
    for (const entry of batch) {
      const group = byPath.get(entry.path);
      if (group) group.push(entry);
      else byPath.set(entry.path, [entry]);
    }
    // Entries beyond maxBatch stay pending for the next flush.
    const flushed = new Set(uniquePaths);
    pending.push(...batch.filter((entry) => !flushed.has(entry.path)));
    if (pending.length > 0 && timer === null) {
      timer = setTimeout(flush, windowMs);
    }
    if (uniquePaths.length === 0) return;
    void (async () => {
      try {
        const payload = await rpc({
          cwd: input.cwd,
          workspaceRoot: input.workspaceRoot,
          candidates: uniquePaths,
        });
        const results = payload?.results ?? [];
        const byResultPath = new Map(results.map((result) => [result.path, result]));
        for (const path of uniquePaths) {
          const resolved = byResultPath.get(path) ?? missingResult(path);
          for (const entry of byPath.get(path) ?? []) entry.resolve(resolved);
        }
      } catch (error) {
        for (const path of uniquePaths) {
          for (const entry of byPath.get(path) ?? []) entry.reject(error);
        }
      }
    })();
  };

  return (path: string) =>
    new Promise<AssistantFileResolveResult | null>((resolve, reject) => {
      pending.push({ path, resolve, reject });
      if (timer === null) {
        timer = setTimeout(flush, windowMs);
      }
    });
}

export function assistantFileQueryKey(
  serverId: string | null | undefined,
  workspaceRoot: string | null | undefined,
  path: string,
): readonly ["assistantFileResolve", string | null, string | null, string] {
  return ["assistantFileResolve", serverId ?? null, workspaceRoot ?? null, path];
}

/** Existence checks refresh at most once a minute; the app-wide default is Infinity. */
export const ASSISTANT_FILE_STALE_MS = 60_000;
export const ASSISTANT_FILE_GC_MS = 5 * 60_000;
