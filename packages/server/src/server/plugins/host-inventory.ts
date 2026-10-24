import { randomUUID } from "node:crypto";
import {
  HostInventoryRequestSchema,
  PluginAdmissionRecordSchema,
  type HostInventoryPage,
  type HostWatermark,
} from "@getpaseo/plugin/server";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AdmissionJournal, AdmissionJournalRecord } from "./admission-journal.js";
import type { HostInventoryClock } from "./host-inventory-clock.js";

type Row =
  | { kind: "agent"; value: HostInventoryPage["agents"][number] }
  | { kind: "admission"; value: HostInventoryPage["admissions"][number] };
interface Cursor {
  id: string;
  watermark: HostWatermark;
  expiresAt: number;
  rows: Generator<Row>;
  pending?: IteratorResult<Row>;
  recordsRead: number;
}
const MAX_BYTES = 262144;
const CURSOR_TTL_MS = 10000;
const MAX_CURSORS = 64;

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function sameGeneration(a: HostWatermark, b: HostWatermark): boolean {
  return a.epoch === b.epoch && a.sequence === b.sequence && !a.activeWriters && !b.activeWriters;
}

/** Enumerate the authoritative loaded host stores. No provider RPC, Git or GC scan.
 * Cursor state is plugin-scoped, bounded, expires, and is discarded on any write.
 * A single response contains at most 100 rows and 256 KiB, including its envelope.
 */
export class HostInventory {
  private readonly cursors = new Map<string, Cursor>();
  private readonly initializing = new Set<string>();
  constructor(
    private readonly storage: AgentStorage,
    private readonly journal: AdmissionJournal,
    private readonly clock: HostInventoryClock,
  ) {}

  async read(pluginId: string, input: unknown = {}): Promise<HostInventoryPage> {
    const request = HostInventoryRequestSchema.parse(input);
    if (this.initializing.has(pluginId))
      throw failure("HOST_INVENTORY_BUSY", "An inventory read is already in flight");
    this.initializing.add(pluginId);
    try {
      // Cold host loading is outside the publication critical section. Subsequent
      // requests allocate no full-store arrays and only walk this bounded page.
      await this.storage.initialize();
      await this.journal.initialize();
      const watermark = this.clock.snapshot();
      if (watermark.activeWriters)
        throw failure(
          "HOST_INVENTORY_BUSY",
          "Host writes are in flight; retry from the first page",
        );
      const cursor = this.resolveCursor(pluginId, request.cursor, watermark);
      const page: HostInventoryPage = {
        watermark,
        agents: [],
        admissions: [],
        complete: false,
        truncated: true,
        nextCursor: cursor.id,
        recordsRead: cursor.recordsRead,
        limits: { rows: 100, bytes: MAX_BYTES, cursorTtlMs: CURSOR_TTL_MS },
        admissionRetentionDays: this.journal.retentionDays,
      };
      // Reserve envelope space. Rows are serialized once, and an oversized row
      // fails explicitly rather than being silently omitted from a complete page.
      let bytes = Buffer.byteLength(JSON.stringify(page)) + 128;
      let count = 0;
      while (count < (request.limit ?? 100)) {
        const next = cursor.pending ?? cursor.rows.next();
        cursor.pending = next;
        if (next.done) break;
        const rowBytes = Buffer.byteLength(JSON.stringify(next.value.value)) + 1;
        if (rowBytes > MAX_BYTES - 16384)
          throw failure(
            "HOST_INVENTORY_ROW_TOO_LARGE",
            "An inventory row exceeds the response byte budget",
          );
        if (bytes + rowBytes > MAX_BYTES) break;
        bytes += rowBytes;
        if (next.value.kind === "agent") page.agents.push(next.value.value);
        else page.admissions.push(next.value.value);
        count++;
        cursor.recordsRead++;
        cursor.pending = undefined;
      }
      cursor.pending ??= cursor.rows.next();
      page.complete = !!cursor.pending.done;
      page.truncated = !page.complete;
      page.recordsRead = cursor.recordsRead;
      // Single-use continuation prevents concurrent or repeated cursor reads from
      // silently skipping pages. The generation remains fixed for the whole walk.
      cursor.id = randomUUID();
      page.nextCursor = page.complete ? null : cursor.id;
      if (!sameGeneration(watermark, this.clock.snapshot())) {
        throw failure("HOST_INVENTORY_STALE", "Host changed during inventory");
      }
      if (page.complete) this.cursors.delete(pluginId);
      return page;
    } catch (error) {
      this.cursors.delete(pluginId);
      throw error;
    } finally {
      this.initializing.delete(pluginId);
    }
  }

  private resolveCursor(
    pluginId: string,
    cursorId: string | undefined,
    watermark: HostWatermark,
  ): Cursor {
    for (const [owner, cursor] of this.cursors) {
      if (cursor.expiresAt <= Date.now()) this.cursors.delete(owner);
    }
    let cursor: Cursor;
    if (cursorId) {
      const saved = this.cursors.get(pluginId);
      if (!saved || saved.id !== cursorId || !sameGeneration(saved.watermark, watermark)) {
        this.cursors.delete(pluginId);
        throw failure(
          "HOST_INVENTORY_STALE",
          "Cursor expired or the host changed; restart inventory",
        );
      }
      cursor = saved;
    } else {
      if (!this.cursors.has(pluginId) && this.cursors.size >= MAX_CURSORS) {
        throw failure("HOST_INVENTORY_BUSY", "Too many inventory readers");
      }
      cursor = {
        id: randomUUID(),
        watermark,
        expiresAt: Date.now() + CURSOR_TTL_MS,
        rows: inventoryRows(
          pluginId,
          this.storage.inventoryRecords(),
          this.journal.inventoryRecords(),
        ),
        recordsRead: 0,
      };
      this.cursors.set(pluginId, cursor);
    }
    return cursor;
  }

  fence() {
    return this.clock.fence();
  }

  watermark() {
    return this.clock.export();
  }
}

function* inventoryRows(
  pluginId: string,
  agents: IterableIterator<StoredAgentRecord>,
  admissions: IterableIterator<AdmissionJournalRecord>,
): Generator<Row> {
  for (const agent of agents) {
    yield {
      kind: "agent",
      value: {
        agentId: agent.id,
        provider: agent.provider,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId ?? null,
        archivedAt: agent.archivedAt ?? null,
        status: agent.lastStatus,
        persistence: agent.persistence
          ? {
              provider: agent.persistence.provider,
              sessionId: agent.persistence.sessionId,
            }
          : null,
        binding: structuredClone(agent.pluginBindings?.[pluginId] ?? null),
      },
    };
  }
  for (const record of admissions) {
    yield {
      kind: "admission",
      value: PluginAdmissionRecordSchema.parse(record),
    };
  }
}
