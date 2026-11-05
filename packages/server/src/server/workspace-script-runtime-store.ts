import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import { writePrivateFileAtomic } from "./private-files.js";

const runtimeEntrySchema = z.object({
  workspaceId: z.string().min(1),
  scriptName: z.string().min(1),
  type: z.enum(["script", "service"]),
  lifecycle: z.enum(["running", "stopped"]),
  terminalId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  cwd: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  projectSlug: z.string().optional(),
  branchName: z.string().nullable().optional(),
});
const journalSchema = z.object({ version: z.literal(1), entries: z.array(runtimeEntrySchema) });

export interface ScriptRuntimeEntry {
  workspaceId: string;
  scriptName: string;
  type: "script" | "service";
  lifecycle: "running" | "stopped";
  terminalId: string;
  exitCode: number | null;
  cwd?: string;
  port?: number;
  projectSlug?: string;
  branchName?: string | null;
}

interface RuntimeEntryKey {
  workspaceId: string;
  scriptName: string;
}

export class WorkspaceScriptRuntimeStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly entries = new Map<string, ScriptRuntimeEntry>();
  private readonly scriptsByWorkspace = new Map<string, Set<string>>();

  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly persistence?: { path: string; logger: Pick<Logger, "warn"> }) {}

  static async open(persistence: {
    path: string;
    logger: Pick<Logger, "warn">;
  }): Promise<WorkspaceScriptRuntimeStore> {
    const store = new WorkspaceScriptRuntimeStore(persistence);
    try {
      const journal = journalSchema.parse(JSON.parse(await readFile(persistence.path, "utf8")));
      for (const entry of journal.entries) {
        store.entries.set(store.toEntryKey(entry), entry);
        store.addScriptToWorkspaceIndex(entry.workspaceId, entry.scriptName);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        persistence.logger.warn(
          { err: error, path: persistence.path },
          "Cannot restore workspace script journal",
        );
      }
    }
    return store;
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  async withScriptLock<T>(key: RuntimeEntryKey, run: () => Promise<T>): Promise<T> {
    const id = this.toEntryKey(key);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(run);
    this.locks.set(id, result);
    try {
      return await result;
    } finally {
      if (this.locks.get(id) === result) this.locks.delete(id);
    }
  }

  list(): ScriptRuntimeEntry[] {
    return structuredClone([...this.entries.values()]);
  }

  private persist(): void {
    if (!this.persistence) return;
    const { path, logger } = this.persistence;
    const data = JSON.stringify({ version: 1, entries: this.list() });
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(() => writePrivateFileAtomic(path, data));
    void this.pendingWrite.catch((error) =>
      logger.warn({ err: error, path }, "Cannot persist workspace script journal"),
    );
  }

  get(key: RuntimeEntryKey): ScriptRuntimeEntry | null {
    const entry = this.entries.get(this.toEntryKey(key));
    return entry ? { ...entry } : null;
  }

  set(entry: ScriptRuntimeEntry): void {
    const workspaceKey = this.toWorkspaceKey(entry.workspaceId);
    const entryKey = this.toEntryKey(entry);
    const previous = this.entries.get(entryKey);
    if (previous) {
      this.removeScriptFromWorkspaceIndex(previous.workspaceId, previous.scriptName);
    }

    this.entries.set(entryKey, { ...entry });
    this.addScriptToWorkspaceIndex(workspaceKey, entry.scriptName);
    this.persist();
  }

  remove(key: RuntimeEntryKey): void {
    const entryKey = this.toEntryKey(key);
    const existing = this.entries.get(entryKey);
    if (!existing) {
      return;
    }

    this.entries.delete(entryKey);
    this.removeScriptFromWorkspaceIndex(existing.workspaceId, existing.scriptName);
    this.persist();
  }

  listForWorkspace(workspaceId: string): ScriptRuntimeEntry[] {
    const scriptNames = this.scriptsByWorkspace.get(this.toWorkspaceKey(workspaceId));
    if (!scriptNames) {
      return [];
    }

    const entries: ScriptRuntimeEntry[] = [];
    for (const scriptName of scriptNames) {
      const entry = this.entries.get(
        this.toEntryKey({
          workspaceId,
          scriptName,
        }),
      );
      if (entry) {
        entries.push({ ...entry });
      }
    }
    return entries;
  }

  removeForWorkspace(workspaceId: string): void {
    for (const entry of this.listForWorkspace(workspaceId)) {
      this.entries.delete(this.toEntryKey(entry));
    }
    this.scriptsByWorkspace.delete(this.toWorkspaceKey(workspaceId));
    this.persist();
  }

  isRunning(key: RuntimeEntryKey): boolean {
    return this.get(key)?.lifecycle === "running";
  }

  private addScriptToWorkspaceIndex(workspaceKey: string, scriptName: string): void {
    const scripts = this.scriptsByWorkspace.get(workspaceKey) ?? new Set<string>();
    scripts.add(scriptName);
    this.scriptsByWorkspace.set(workspaceKey, scripts);
  }

  private removeScriptFromWorkspaceIndex(workspaceId: string, scriptName: string): void {
    const workspaceKey = this.toWorkspaceKey(workspaceId);
    const scripts = this.scriptsByWorkspace.get(workspaceKey);
    if (!scripts) {
      return;
    }

    scripts.delete(scriptName);
    if (scripts.size === 0) {
      this.scriptsByWorkspace.delete(workspaceKey);
    }
  }

  private toEntryKey(key: RuntimeEntryKey): string {
    return `${this.toWorkspaceKey(key.workspaceId)}::${key.scriptName}`;
  }

  private toWorkspaceKey(workspaceId: string): string {
    return workspaceId;
  }
}
