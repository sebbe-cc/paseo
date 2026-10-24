import type { HostInventoryClock } from "./host-inventory-clock.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  PluginAdmissionRecordSchema,
  PluginAgentBindingSchema,
  PluginRequestOriginSchema,
  PluginAdmissionOperationSchema,
  type PluginAdmissionRecord,
  type PluginHookAgent,
  type PluginRequestOrigin,
} from "@getpaseo/plugin/server";

const JournalRecordSchema = PluginAdmissionRecordSchema.extend({
  agent: z.object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    parentAgentId: z.string().nullable(),
    provider: z.string(),
    cwd: z.string(),
    title: z.string().nullable(),
  }),
  previousEpoch: z.string().nullable(),
  boundRecipients: z.record(z.string(), PluginAgentBindingSchema).optional(),
  recipientReleases: z
    .array(
      z.object({
        pluginId: z.string(),
        at: z.string(),
        reason: z.string(),
        origin: PluginRequestOriginSchema,
        binding: PluginAgentBindingSchema,
      }),
    )
    .optional(),
});
const BoundPoliciesSchema = z.record(
  z.string(),
  z.object({ fenceWaitMs: z.number().int().min(0).max(30000).optional() }),
);
export type AdmissionJournalRecord = z.infer<typeof JournalRecordSchema>;

function operationId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = (BigInt(Date.now()) << 80n) | BigInt("0x" + randomBytes(10).toString("hex"));
  let id = "";
  for (let i = 0; i < 26; i++) {
    id = alphabet[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

export class AdmissionJournal {
  private policies: z.infer<typeof BoundPoliciesSchema> = {};
  private records = new Map<string, AdmissionJournalRecord>();
  private attempts = new Map<string, number>();
  private outcomes = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | undefined;
  private loaded = false;
  private pendingMutations = new Map<string, number>();
  private prunedOn = "";
  private discarded = 0;
  private checkpointAnchor: AdmissionJournalRecord | undefined;
  constructor(
    private readonly directory: string,
    readonly retentionDays = 14,
    readonly inventoryClock?: HostInventoryClock,
  ) {}

  initialize(): Promise<void> {
    return (this.ready ??= this.inventoryClock
      ? this.inventoryClock.track("admissions", () => this.load())
      : this.load());
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.policies = BoundPoliciesSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, "bound-policies.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const files = (await fs.readdir(this.directory))
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort();
    for (const file of files) {
      const filename = path.join(this.directory, file);
      const content = await fs.readFile(filename, "utf8");
      const lines = content.split("\n");
      let validBytes = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const record = JournalRecordSchema.parse(parsed);
          // Keep the marker on a real record so older daemons can still read the
          // journal. An empty snapshot uses the last discarded record as its anchor.
          // The marker and snapshot share an atomic rename: an undeleted old segment
          // cannot resurrect acknowledged outcomes after a crash.
          if (parsed.admissionCheckpoint === 1) {
            this.records.clear();
            this.outcomes.clear();
          }
          if (parsed.admissionCheckpoint === 1 && parsed.checkpointOnly === true) {
            this.checkpointAnchor = record;
            validBytes += Buffer.byteLength(line) + 1;
            continue;
          }
          this.records.set(record.id, record);
          if (record.status !== "pending") this.outcomes.add(record.id);
          validBytes += Buffer.byteLength(line) + 1;
        } catch (error) {
          if (index < lines.length - 2) throw error;
          // A killed append can leave a partial final row. Remove it before appending.
          await fs.truncate(filename, validBytes);
        }
      }
      if (content && !content.endsWith("\n") && validBytes > Buffer.byteLength(content)) {
        await fs.appendFile(filename, "\n");
      }
    }
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      await this.append({
        ...record,
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        error: {
          code: "PLUGIN_ADMISSION_INTERRUPTED",
          message: "Daemon stopped before the session outcome was recorded",
          stage: "interrupted",
        },
      });
    }
    await this.prune(files);
    await this.boundFailures();
    if (this.discarded) await this.checkpoint();
    this.loaded = true;
  }

  private async prune(files: string[]): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    for (const [id, record] of this.records) {
      if (
        record.finishedAt &&
        record.finishedAt < cutoff &&
        !record.undeliveredTo.length &&
        !record.recipientReleases?.length
      ) {
        this.checkpointAnchor = record;
        this.records.delete(id);
        this.outcomes.delete(id);
        this.discarded++;
      }
    }
    if (this.discarded || files.some((file) => file.slice(0, 10) < cutoff.slice(0, 10))) {
      await this.checkpoint();
    }
    this.prunedOn = new Date().toISOString().slice(0, 10);
  }

  // Only fully delivered failures can be discarded. Pending, opened and replayable
  // outcomes remain census evidence regardless of the per-agent failure budget.
  private async boundFailures(): Promise<void> {
    const counts = new Map<string, number>();
    for (const record of [...this.records.values()].toReversed()) {
      if (
        record.status !== "failed" ||
        record.undeliveredTo.length ||
        record.recipientReleases?.length
      )
        continue;
      const count = (counts.get(record.agentId) ?? 0) + 1;
      counts.set(record.agentId, count);
      if (count <= 64) continue;
      this.checkpointAnchor = record;
      this.records.delete(record.id);
      this.outcomes.delete(record.id);
      this.discarded++;
    }
    // Amortize fsync/rewrite while keeping the append log bounded too.
    if (this.discarded >= 64) await this.checkpoint();
  }

  private async checkpoint(): Promise<void> {
    const files = (await fs.readdir(this.directory)).filter((file) =>
      /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file),
    );
    const name = new Date().toISOString().slice(0, 10) + ".jsonl";
    const filename = path.join(this.directory, name);
    const temporary = filename + ".tmp";
    // Outcome insertion order is delivery order; Map insertion order is start order.
    const records = [
      ...[...this.records.values()].filter((record) => record.status === "pending"),
      ...[...this.outcomes].flatMap((id) => this.records.get(id) ?? []),
    ];
    const file = await fs.open(temporary, "w", 0o600);
    try {
      const checkpointOnly = records.length === 0;
      const anchor = records.shift() ?? this.checkpointAnchor;
      const snapshot = anchor
        ? [{ ...anchor, admissionCheckpoint: 1, checkpointOnly }, ...records]
        : [];
      await file.writeFile(snapshot.map((record) => JSON.stringify(record) + "\n").join(""));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filename);
    if (process.platform !== "win32") {
      const directory = await fs.open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    for (const old of files) if (old !== name) await fs.unlink(path.join(this.directory, old));
    this.discarded = 0;
  }

  private async append(record: AdmissionJournalRecord): Promise<void> {
    const filename = path.join(this.directory, new Date().toISOString().slice(0, 10) + ".jsonl");
    const file = await fs.open(filename, "a");
    try {
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== "win32") {
      const directory = await fs.open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    this.records.set(record.id, structuredClone(record));
    if (record.status !== "pending") this.outcomes.add(record.id);
  }

  private mutate<T>(action: () => Promise<T>, pendingId?: string): Promise<T> {
    if (pendingId)
      this.pendingMutations.set(pendingId, (this.pendingMutations.get(pendingId) ?? 0) + 1);
    const result = this.queue
      .then(async () => {
        const finish = await this.inventoryClock?.beginAsync("admissions");
        try {
          await this.initialize();
          if (this.prunedOn !== new Date().toISOString().slice(0, 10)) {
            const files = (await fs.readdir(this.directory)).filter((file) =>
              /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file),
            );
            await this.prune(files);
          }
          return await action();
        } finally {
          finish?.();
        }
      })
      .finally(() => {
        if (pendingId) {
          const remaining = this.pendingMutations.get(pendingId)! - 1;
          if (remaining) this.pendingMutations.set(pendingId, remaining);
          else this.pendingMutations.delete(pendingId);
        }
      });
    this.queue = result.catch(() => undefined);
    return result;
  }

  boundPolicies(): z.infer<typeof BoundPoliciesSchema> {
    if (!this.loaded) throw new Error("Admission journal has not initialized");
    return structuredClone(this.policies);
  }

  rememberBoundPolicy(pluginId: string, fenceWaitMs?: number): Promise<void> {
    return this.mutate(async () => {
      // A removed/disabled manifest cannot revoke a fence on durable bindings.
      const prior = Object.hasOwn(this.policies, pluginId) ? this.policies[pluginId] : undefined;
      const policy = { fenceWaitMs: fenceWaitMs ?? prior?.fenceWaitMs };
      if (prior && prior.fenceWaitMs === policy.fenceWaitMs) return;
      const next = { ...this.policies, [pluginId]: policy };
      const filename = path.join(this.directory, "bound-policies.json");
      const file = await fs.open(filename + ".tmp", "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(filename + ".tmp", filename);
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.policies = next;
    });
  }

  addBoundRecipients(
    id: string,
    bindings: NonNullable<AdmissionJournalRecord["boundRecipients"]>,
  ): Promise<AdmissionJournalRecord> {
    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record || record.status !== "pending") throw new Error("Admission is not pending");
      const next = {
        ...record,
        boundRecipients: { ...record.boundRecipients, ...bindings },
        undeliveredTo: [...new Set([...record.undeliveredTo, ...Object.keys(bindings)])],
      };
      await this.append(next);
      return structuredClone(next);
    }, id);
  }

  releaseBoundRecipient(
    pluginId: string,
    origin: PluginRequestOrigin,
    reason: string,
  ): Promise<void> {
    return this.mutate(async () => {
      if (origin.kind !== "client" || !reason.trim() || reason.length > 2000)
        throw new Error("An operator and bounded release reason are required");
      if (!Object.hasOwn(this.policies, pluginId))
        throw new Error("Plugin has no bound recipient policy");
      const records = [...this.records.values()].filter(
        (record) =>
          record.undeliveredTo.includes(pluginId) &&
          Object.hasOwn(record.boundRecipients ?? {}, pluginId),
      );
      if (records.some((record) => record.status === "pending"))
        throw new Error("Bound admission is still pending; retry after it finishes");
      for (const record of records) {
        await this.append({
          ...record,
          undeliveredTo: record.undeliveredTo.filter((id) => id !== pluginId),
          recipientReleases: [
            ...(record.recipientReleases ?? []),
            {
              pluginId,
              at: new Date().toISOString(),
              origin,
              reason,
              binding: record.boundRecipients![pluginId]!,
            },
          ],
        });
      }
    });
  }

  begin(input: {
    agent: PluginHookAgent;
    reason: PluginAdmissionRecord["reason"];
    origin: PluginRequestOrigin;
    previousEpoch: string | null;
    recipients: string[];
    boundRecipients?: AdmissionJournalRecord["boundRecipients"];
  }): Promise<AdmissionJournalRecord> {
    return this.mutate(async () => {
      const earlier = [...this.records.values()].filter(
        (record) => record.agentId === input.agent.id && record.status === "opened",
      );
      const attempt = (this.attempts.get(input.agent.id) ?? 0) + 1;
      this.attempts.set(input.agent.id, attempt);
      const record: AdmissionJournalRecord = {
        id: operationId(),
        agentId: input.agent.id,
        reason: input.reason,
        attempt,
        supersedes:
          input.reason === "create" || input.reason === "import"
            ? null
            : (earlier.at(-1)?.id ?? null),
        startedAt: new Date().toISOString(),
        status: "pending",
        finishedAt: null,
        effect: null,
        error: null,
        origin: input.origin,
        undeliveredTo: input.recipients,
        ...(input.boundRecipients ? { boundRecipients: input.boundRecipients } : {}),
        agent: input.agent,
        previousEpoch: input.previousEpoch,
      };
      await this.append(record);
      return structuredClone(record);
    });
  }

  finish(
    id: string,
    outcome: Pick<PluginAdmissionRecord, "status" | "effect" | "error">,
    agent?: PluginHookAgent,
  ): Promise<AdmissionJournalRecord> {
    return this.mutate(async () => {
      const current = this.records.get(id);
      if (!current || current.status !== "pending") throw new Error("Admission is not pending");
      const record = {
        ...current,
        ...outcome,
        agent: agent ?? current.agent,
        finishedAt: new Date().toISOString(),
      };
      await this.append(record);
      await this.boundFailures();
      return structuredClone(record);
    }, id);
  }

  async get(id: string): Promise<AdmissionJournalRecord | null> {
    await this.initialize();
    return structuredClone(this.records.get(id) ?? null);
  }

  /** Called synchronously with the binding observation and provider dispatch. */
  observeAdmission(id: string) {
    if (!this.loaded) throw new Error("Admission journal has not initialized");
    return {
      record: structuredClone(this.records.get(id) ?? null),
      busy: this.pendingMutations.has(id),
    };
  }

  async query(
    filter: {
      agentId?: string;
      status?: PluginAdmissionRecord["status"][];
      since?: string;
      limit?: number;
    } = {},
  ): Promise<AdmissionJournalRecord[]> {
    await this.initialize();
    return structuredClone(
      [...this.records.values()]
        .filter(
          (record) =>
            (!filter.agentId || record.agentId === filter.agentId) &&
            (!filter.status || filter.status.includes(record.status)) &&
            (!filter.since || record.startedAt >= filter.since),
        )
        .slice(0, filter.limit ?? 10000),
    );
  }

  inventoryRecords(): IterableIterator<AdmissionJournalRecord> {
    if (!this.ready) throw new Error("Admission inventory has not initialized");
    return this.records.values();
  }

  async undelivered(pluginId: string): Promise<AdmissionJournalRecord[]> {
    await this.initialize();
    return [...this.outcomes].flatMap((id) => {
      const record = this.records.get(id);
      return record?.undeliveredTo.includes(pluginId) ? [structuredClone(record)] : [];
    });
  }

  ack(id: string, pluginId: string): Promise<void> {
    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record || record.status === "pending")
        throw new Error("Admission outcome is unavailable");
      if (!record.undeliveredTo.includes(pluginId)) return;
      await this.append({
        ...record,
        undeliveredTo: record.undeliveredTo.filter((recipient) => recipient !== pluginId),
      });
      await this.boundFailures();
    }, id);
  }
}

export function admissionOutcome(record: AdmissionJournalRecord) {
  if (record.status === "opened")
    return {
      name: "agent.session_opened" as const,
      event: {
        agent: record.agent,
        operation: PluginAdmissionOperationSchema.parse(record),
        persistence: record.effect!.persistence,
        historyEpochChanged: record.previousEpoch !== record.effect!.historyEpoch,
      },
    };
  return {
    name: "agent.session_open_failed" as const,
    event: {
      agent: record.agent,
      operation: PluginAdmissionOperationSchema.parse(record),
      error: { code: record.error!.code, message: record.error!.message },
      stage: record.error!.stage,
    },
  };
}
