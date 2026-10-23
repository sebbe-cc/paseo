import type { HostInventoryClock } from "../plugins/host-inventory-clock.js";
import { PluginAgentBindingSchema, type PluginAgentBinding } from "@getpaseo/plugin/server";
import {
  PluginBindingCasSchema,
  PluginBindingProofSchema,
  type PluginBindingObservationSchema,
  type PluginBindingSuccessorSchema,
} from "@getpaseo/plugin/server";
import { canonicalDigest, nativeRecordDigest } from "../plugins/binding-proof.js";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  pluginBindings: z.record(z.string(), PluginAgentBindingSchema).optional(),
  pluginBindingRevisions: z.record(z.string(), z.number().int()).optional(),
  pluginBindingProofs: z.record(z.string(), PluginBindingProofSchema).optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private inventoryComplete = true;
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(
    baseDir: string,
    logger: Logger,
    readonly inventoryClock?: HostInventoryClock,
  ) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((record) => record.workspaceId === workspaceId);
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    return this.queueRecordMutation(record.id, (existing) => ({
      ...record,
      pluginBindings: existing?.pluginBindings ?? record.pluginBindings,
      pluginBindingRevisions: existing?.pluginBindingRevisions ?? record.pluginBindingRevisions,
      pluginBindingProofs: existing?.pluginBindingProofs ?? record.pluginBindingProofs,
    }));
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord,
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const finish = this.inventoryClock?.begin("agent-records");
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          return undefined;
        }

        const record = mutate(this.cache.get(agentId) ?? null);
        try {
          await this.writeRecord(record);
        } catch (error) {
          this.inventoryComplete = false;
          throw error;
        }
        return undefined;
      });

    const tracked = next.finally(() => {
      try {
        finish?.();
      } finally {
        if (this.pendingWrites.get(agentId) === tracked) this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    if (this.inventoryClock)
      this.inventoryClock.run("agent-records", () => this.deleting.add(agentId));
    else this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    const finish = this.inventoryClock?.begin("agent-records");
    try {
      this.beginDelete(agentId);
      await (this.pendingWrites.get(agentId) ?? Promise.resolve());
      const paths = Array.from(this.pathsById.get(agentId) ?? []);
      await Promise.all(
        paths.map(async (filePath) => {
          try {
            await fs.unlink(filePath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              this.inventoryComplete = false;
              this.logger.warn(
                { err: error, agentId, filePath },
                "Failed to remove agent record file",
              );
            }
          }
        }),
      );

      this.cache.delete(agentId);
      this.removeOwnerIndex(agentId);
      this.pathById.delete(agentId);
      this.pathsById.delete(agentId);
    } finally {
      finish?.();
    }
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: {
      title?: string | null;
      internal?: boolean;
      initialBindings?: Record<string, PluginAgentBinding>;
    },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      record.pluginBindings = existing?.pluginBindings ?? options?.initialBindings;
      record.pluginBindingRevisions = existing?.pluginBindingRevisions;
      record.pluginBindingProofs = existing?.pluginBindingProofs;
      return record;
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) throw new Error(`Agent ${agentId} not found`);
      return { ...record, title };
    });
  }

  async getBinding(agentId: string, pluginId: string): Promise<PluginAgentBinding | null> {
    const record = await this.get(agentId);
    return structuredClone(record?.pluginBindings?.[pluginId] ?? null);
  }

  async observeBinding(
    agentId: string,
    pluginId: string,
  ): Promise<z.infer<typeof PluginBindingObservationSchema>> {
    await this.load();
    const record = this.cache.get(agentId);
    const generation = this.inventoryClock?.snapshot();
    if (!record || !generation || generation.activeWriters) throw new BindingConflictError();
    return {
      binding: structuredClone(record.pluginBindings?.[pluginId] ?? null),
      state: {
        epoch: generation.epoch,
        sequence: generation.sequence,
        recordDigest: nativeRecordDigest(record),
      },
    };
  }

  async setBindingWithProof(
    agentId: string,
    pluginId: string,
    data: unknown,
    options: z.infer<typeof PluginBindingCasSchema>,
  ): Promise<z.infer<typeof PluginBindingSuccessorSchema>> {
    const input = PluginBindingCasSchema.parse(options);
    const payload = validateBindingData(data);
    await this.load();
    const current = this.cache.get(agentId);
    const clock = this.inventoryClock;
    if (!current || !clock) throw new BindingConflictError();
    const generation = clock.snapshot();
    const observed = {
      epoch: generation.epoch,
      sequence: generation.sequence,
      recordDigest: nativeRecordDigest(current),
    };
    const original = current.pluginBindingProofs?.[pluginId];
    const prior = current.pluginBindings?.[pluginId];
    if (original?.operationKey === input.operationKey) {
      if (
        generation.activeWriters ||
        !prior ||
        original.expectRevision !== input.expectRevision ||
        canonicalDigest(original.predecessor) !== canonicalDigest(input.expected) ||
        canonicalDigest(original.successor) !== canonicalDigest(observed) ||
        canonicalDigest(prior.data) !== canonicalDigest(payload)
      )
        throw new BindingConflictError();
      return structuredClone({ binding: prior, proof: original });
    }
    if (
      generation.activeWriters ||
      canonicalDigest(observed) !== canonicalDigest(input.expected) ||
      (prior?.revision ?? null) !== input.expectRevision
    )
      throw new BindingConflictError();
    let result!: z.infer<typeof PluginBindingSuccessorSchema>;
    // compare + queued writer acquisition are synchronous. The write itself
    // retains native SH; any interleaving writer invalidates the successor below.
    await clock.compare(generation, () =>
      this.queueRecordMutation(agentId, (record) => {
        if (!record || nativeRecordDigest(record) !== input.expected.recordDigest)
          throw new BindingConflictError();
        const binding: PluginAgentBinding = {
          revision: (record.pluginBindingRevisions?.[pluginId] ?? prior?.revision ?? 0) + 1,
          data: payload,
          boundAt: new Date().toISOString(),
          boundBy: { kind: "plugin", pluginId },
        };
        const next = {
          ...record,
          pluginBindings: { ...record.pluginBindings, [pluginId]: binding },
          pluginBindingRevisions: {
            ...record.pluginBindingRevisions,
            [pluginId]: binding.revision,
          },
        };
        const proof = {
          operationKey: input.operationKey,
          agentId,
          pluginId,
          expectRevision: input.expectRevision,
          predecessor: input.expected,
          successor: {
            epoch: generation.epoch,
            sequence: generation.sequence + 2,
            recordDigest: nativeRecordDigest(next),
          },
        };
        result = { binding, proof };
        return { ...next, pluginBindingProofs: { ...next.pluginBindingProofs, [pluginId]: proof } };
      }),
    );
    const after = await this.observeBinding(agentId, pluginId);
    if (!result || canonicalDigest(after.state) !== canonicalDigest(result.proof.successor)) {
      // The CAS may be durable. Never manufacture a successor over another
      // writer; retain its original receipt for explicit reconciliation.
      throw Object.assign(
        new Error("Binding CAS committed with an unclassified concurrent writer"),
        {
          code: "BINDING_SUCCESSOR_UNCERTAIN",
        },
      );
    }
    return structuredClone(result);
  }

  async listBindings(pluginId: string, since?: string) {
    const records = await this.list();
    return records.flatMap((record) => {
      const binding = record.pluginBindings?.[pluginId];
      return binding && (!since || binding.boundAt >= since)
        ? [{ agentId: record.id, binding: structuredClone(binding) }]
        : [];
    });
  }

  async setBinding(
    agentId: string,
    pluginId: string,
    data: unknown,
    expectRevision: number | null,
  ): Promise<PluginAgentBinding> {
    const payload = validateBindingData(data);
    await this.load();
    let binding!: PluginAgentBinding;
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) throw new Error(`Agent ${agentId} not found`);
      const previous = record.pluginBindings?.[pluginId];
      if ((previous?.revision ?? null) !== expectRevision) throw new BindingConflictError();
      binding = {
        revision: (record.pluginBindingRevisions?.[pluginId] ?? previous?.revision ?? 0) + 1,
        data: payload,
        boundAt: new Date().toISOString(),
        boundBy: { kind: "plugin", pluginId },
      };
      return {
        ...record,
        pluginBindings: { ...record.pluginBindings, [pluginId]: binding },
        pluginBindingRevisions: { ...record.pluginBindingRevisions, [pluginId]: binding.revision },
      };
    });
    if (!binding) throw new Error(`Agent ${agentId} is being deleted`);
    return structuredClone(binding);
  }

  async clearBinding(agentId: string, pluginId: string, expectRevision: number): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) throw new Error(`Agent ${agentId} not found`);
      const previous = record.pluginBindings?.[pluginId];
      if (!previous || previous.revision !== expectRevision) throw new BindingConflictError();
      const bindings = { ...record.pluginBindings };
      delete bindings[pluginId];
      return {
        ...record,
        pluginBindings: bindings,
        pluginBindingRevisions: {
          ...record.pluginBindingRevisions,
          [pluginId]: previous.revision + 1,
        },
      };
    });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  inventoryRecords(): IterableIterator<StoredAgentRecord> {
    if (!this.loaded || !this.inventoryComplete) {
      throw Object.assign(new Error("Agent inventory is unavailable or has unreadable records"), {
        code: "HOST_INVENTORY_INCOMPLETE",
      });
    }
    return this.cache.values();
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.inventoryComplete = false;
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          this.inventoryComplete = false;
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.inventoryComplete = false;
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

export class BindingConflictError extends Error {
  readonly code = "PLUGIN_BINDING_CONFLICT";
  constructor() {
    super("Plugin binding revision conflict");
  }
}
export function validateBindingData(data: unknown): unknown {
  const parsed = z.json().parse(data);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 16 * 1024)
    throw new Error("Plugin binding exceeds 16 KiB");
  return structuredClone(parsed);
}
