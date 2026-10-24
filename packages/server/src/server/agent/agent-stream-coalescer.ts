import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { mergeToolCallItems } from "./timeline-projection.js";
import { HostFenceError } from "../plugins/host-inventory-fence.js";

export const AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 60;
export const AGENT_FENCE_QUEUE_BYTES = 2 * 1024 * 1024;
export const GLOBAL_FENCE_QUEUE_BYTES = 32 * 1024 * 1024;
export const AGENT_FENCE_QUEUE_WAIT_MS = 30_000;

type CoalescableTextKind = "assistant_message" | "reasoning";
type CoalescableTimelineKind = CoalescableTextKind | "tool_call";
type CoalescableTextItem = Extract<AgentTimelineItem, { type: CoalescableTextKind }>;
type CoalescableTimelineItem = Extract<AgentTimelineItem, { type: CoalescableTimelineKind }>;
type CoalescableTimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }> & {
  item: CoalescableTimelineItem;
};

export interface AgentStreamCoalescerTimers {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: typeof clearTimeout;
}

export interface AgentStreamCoalescerFlush {
  agentId: string;
  item: CoalescableTimelineItem;
  provider: AgentProvider;
  turnId?: string;
}

export interface AgentStreamCoalescerOptions {
  windowMs?: number;
  timers: AgentStreamCoalescerTimers;
  now?: () => number;
  onFlush: (payload: AgentStreamCoalescerFlush) => void;
  onError?: (error: unknown, agentId: string) => void;
  onSaturated?: (agentId: string, error: HostFenceError) => void;
}

interface PendingTextEntry {
  bytes: number;
  kind: "text";
  item: CoalescableTextItem;
  text: string;
  provider: AgentProvider;
  turnId?: string;
}

interface PendingToolCallEntry {
  bytes: number;
  kind: "tool_call";
  item: Extract<AgentTimelineItem, { type: "tool_call" }>;
  provider: AgentProvider;
  turnId?: string;
}

type PendingAgentStreamEntry = PendingTextEntry | PendingToolCallEntry;

interface PendingAgentStreamBuffer {
  agentId: string;
  entries: PendingAgentStreamEntry[];
  toolCallEntryIndexes: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  lastFlushAt: number | null;
  blockedSince: number | null;
  warnedAt: number | null;
  discardWhenFlushed: boolean;
  bytes: number;
}

function isCoalescableTimelineEvent(event: AgentStreamEvent): event is CoalescableTimelineEvent {
  return (
    event.type === "timeline" &&
    (event.item.type === "assistant_message" ||
      event.item.type === "reasoning" ||
      event.item.type === "tool_call")
  );
}

function isTextTimelineItem(item: CoalescableTimelineItem): item is CoalescableTextItem {
  return item.type === "assistant_message" || item.type === "reasoning";
}

function isTerminalToolCall(item: CoalescableTimelineItem): boolean {
  return (
    item.type === "tool_call" &&
    (item.status === "completed" || item.status === "failed" || item.status === "canceled")
  );
}

function isSameTextStream(previous: PendingTextEntry, next: PendingTextEntry): boolean {
  if (previous.item.type !== next.item.type) {
    return false;
  }
  if (previous.item.type === "assistant_message" && next.item.type === "assistant_message") {
    return previous.item.messageId === next.item.messageId;
  }
  return true;
}

export class AgentStreamCoalescer {
  private readonly buffers = new Map<string, PendingAgentStreamBuffer>();
  private readonly onFlush: (payload: AgentStreamCoalescerFlush) => void;
  private readonly timers: AgentStreamCoalescerTimers;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown, agentId: string) => void;
  private readonly onSaturated: (agentId: string, error: HostFenceError) => void;
  private pendingBytes = 0;

  constructor(options: AgentStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
    this.timers = options.timers;
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
    this.onError = options.onError ?? ((error) => console.error(error));
    this.onSaturated = options.onSaturated ?? ((agentId, error) => this.onError(error, agentId));
  }

  handle(agentId: string, event: AgentStreamEvent): boolean {
    if (!isCoalescableTimelineEvent(event)) {
      return false;
    }

    if (isTextTimelineItem(event.item) && event.item.text === "") {
      return true;
    }

    const buffer = this.getOrCreateBuffer(agentId);
    const bytes = JSON.stringify(event).length * 2 + 256;
    if (
      buffer.bytes + bytes > AGENT_FENCE_QUEUE_BYTES ||
      this.pendingBytes + bytes > GLOBAL_FENCE_QUEUE_BYTES
    ) {
      this.saturate(buffer);
      return true;
    }
    this.appendToBuffer(buffer, event);

    if (isTerminalToolCall(event.item)) {
      this.flushBuffer(agentId);
      return true;
    }

    // Leading edge: the first event after an idle window flushes synchronously so
    // the first token of a turn isn't delayed a full window. Sustained bursts fall
    // through to the trailing timer, which keeps the message rate at one per
    // window. Same shape as TerminalOutputCoalescer.
    if (!buffer.timer) {
      const elapsed =
        buffer.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - buffer.lastFlushAt;
      if (elapsed >= this.windowMs) {
        this.flushBuffer(agentId);
        return true;
      }
      this.scheduleFlush(buffer);
    }

    return true;
  }

  flushFor(agentId: string): void {
    this.flushBuffer(agentId);
  }

  flushAll(): void {
    for (const agentId of Array.from(this.buffers.keys())) {
      this.flushBuffer(agentId);
    }
  }

  flushAndDiscard(agentId: string): void {
    this.flushBuffer(agentId);
    const buffer = this.buffers.get(agentId);
    if (buffer) {
      if (buffer.entries.length > 0) {
        buffer.discardWhenFlushed = true;
        return;
      }
      this.clearTimer(buffer);
      this.buffers.delete(agentId);
    }
  }

  discard(agentId: string): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) return;
    this.pendingBytes -= buffer.bytes;
    this.clearTimer(buffer);
    this.buffers.delete(agentId);
  }

  private saturate(buffer: PendingAgentStreamBuffer): void {
    this.discard(buffer.agentId);
    this.onSaturated(
      buffer.agentId,
      new HostFenceError(
        "HOST_FENCE_SATURATED",
        "Host publication exceeded the timeline queue time or memory limit; turn interrupted",
      ),
    );
  }

  private getOrCreateBuffer(agentId: string): PendingAgentStreamBuffer {
    const existing = this.buffers.get(agentId);
    if (existing) {
      return existing;
    }

    const buffer: PendingAgentStreamBuffer = {
      agentId,
      entries: [],
      toolCallEntryIndexes: new Map(),
      timer: null,
      flushing: false,
      lastFlushAt: null,
      blockedSince: null,
      warnedAt: null,
      discardWhenFlushed: false,
      bytes: 0,
    };
    this.buffers.set(agentId, buffer);
    return buffer;
  }

  private appendToBuffer(buffer: PendingAgentStreamBuffer, event: CoalescableTimelineEvent): void {
    const bytes = JSON.stringify(event).length * 2 + 256;
    buffer.bytes += bytes;
    this.pendingBytes += bytes;
    if (isTextTimelineItem(event.item)) {
      buffer.entries.push({
        bytes,
        kind: "text",
        item: event.item,
        text: event.item.text,
        provider: event.provider,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
      return;
    }

    const existingIndex = buffer.toolCallEntryIndexes.get(event.item.callId);
    const existing = existingIndex !== undefined ? buffer.entries[existingIndex] : undefined;
    // Merge rather than replace, so an update that carries less (an unknown detail after a
    // labeled one) cannot erase what the timeline would have kept had both been flushed.
    let item = event.item;
    if (existing?.kind === "tool_call") {
      item = mergeToolCallItems(existing.item, event.item);
    }
    const entry: PendingToolCallEntry = {
      bytes: bytes + (existing?.bytes ?? 0),
      kind: "tool_call",
      item,
      provider: event.provider,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    };

    if (existingIndex !== undefined) {
      buffer.entries[existingIndex] = entry;
      return;
    }

    buffer.toolCallEntryIndexes.set(event.item.callId, buffer.entries.length);
    buffer.entries.push(entry);
  }

  private scheduleFlush(buffer: PendingAgentStreamBuffer): void {
    const timer = this.timers.setTimeout(() => {
      this.flushBuffer(buffer.agentId, buffer);
    }, this.windowMs);
    timer.unref?.();
    buffer.timer = timer;
  }

  private clearTimer(buffer: PendingAgentStreamBuffer): void {
    if (!buffer.timer) {
      return;
    }
    this.timers.clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  private flushBuffer(agentId: string, expectedBuffer?: PendingAgentStreamBuffer): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return;
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return;
    }
    if (buffer.flushing) {
      return;
    }

    if (
      buffer.blockedSince !== null &&
      this.now() - buffer.blockedSince >= AGENT_FENCE_QUEUE_WAIT_MS
    ) {
      this.saturate(buffer);
      return;
    }

    this.clearTimer(buffer);
    if (buffer.entries.length === 0) {
      return;
    }

    const entries = this.collapseEntries(buffer.entries);
    this.pendingBytes -= buffer.bytes;
    buffer.bytes = 0;
    buffer.entries = [];
    buffer.toolCallEntryIndexes.clear();
    buffer.flushing = true;
    buffer.lastFlushAt = this.now();

    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        try {
          this.onFlush({
            agentId,
            item:
              entry.kind === "text"
                ? {
                    ...entry.item,
                    text: entry.text,
                  }
                : entry.item,
            provider: entry.provider,
            ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
          });
        } catch (error) {
          if (!(error instanceof HostFenceError && error.code === "HOST_FENCE_BUSY")) {
            // An arbitrary callback can fail after committing. Replaying it
            // would duplicate a row; only pre-mutation fence rejection is safe.
            this.onError(error, agentId);
            continue;
          }
          buffer.entries = [...entries.slice(index), ...buffer.entries];
          const retainedBytes = entries
            .slice(index)
            .reduce((total, pending) => total + pending.bytes, 0);
          buffer.bytes += retainedBytes;
          this.pendingBytes += retainedBytes;
          buffer.toolCallEntryIndexes.clear();
          buffer.entries.forEach((pending, pendingIndex) => {
            if (pending.kind === "tool_call")
              buffer.toolCallEntryIndexes.set(pending.item.callId, pendingIndex);
          });
          const now = this.now();
          buffer.blockedSince ??= now;
          if (
            now - buffer.blockedSince >= 5_000 &&
            (buffer.warnedAt === null || now - buffer.warnedAt >= 60_000)
          ) {
            buffer.warnedAt = now;
            this.onError(error, agentId);
          }
          this.scheduleFlush(buffer);
          return;
        }
      }
      buffer.blockedSince = null;
      buffer.warnedAt = null;
      if (buffer.discardWhenFlushed && buffer.entries.length === 0) this.buffers.delete(agentId);
    } finally {
      buffer.flushing = false;
    }
  }

  private collapseEntries(entries: PendingAgentStreamEntry[]): PendingAgentStreamEntry[] {
    const collapsed: PendingAgentStreamEntry[] = [];

    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.kind === "text" &&
        entry.kind === "text" &&
        isSameTextStream(previous, entry) &&
        previous.provider === entry.provider &&
        previous.turnId === entry.turnId
      ) {
        previous.text += entry.text;
        previous.bytes += entry.bytes;
        continue;
      }

      collapsed.push({ ...entry });
    }

    return collapsed;
  }
}
