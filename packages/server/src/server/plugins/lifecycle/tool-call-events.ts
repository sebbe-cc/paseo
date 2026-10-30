import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent/agent-sdk-types.js";

export type ToolCallHookDecision = "started" | "ended";

export type ToolCallTerminalKind = "completed" | "failed" | "canceled";

interface OpenToolCall {
  name: string;
  turnId: string | null;
  /** Last observed (content-limited) detail, reused if the turn ends first. */
  detail: ToolCallDetail;
}

export interface SynthesizedToolCallEnd {
  callId: string;
  name: string;
  turnId: string | null;
  detail: ToolCallDetail;
}

/**
 * Per-(agent, callId) open-call state behind `agent.tool_call_started` /
 * `agent.tool_call_ended` (pa-89is1.6).
 *
 * Rules, shared by the daemon wiring and the contract doc:
 * - the first `running` row for an unknown callId decides "started";
 *   further `running` rows for the same open call are re-emissions and
 *   decide nothing (no duplicate events);
 * - a terminal row (`completed`/`failed`/`canceled`) for an open call
 *   decides "ended" and closes it; a repeated terminal row for an
 *   already-settled call is a re-emission and decides nothing;
 * - a terminal row with no prior `running` row and no settled record still
 *   decides "ended" (providers may compact the running row away); no
 *   `started` is synthesized for it;
 * - `closeTurn` synthesizes one end per still-open call of that turn, so
 *   every `started` is eventually followed by exactly one `ended`.
 *
 * The tracker never sees history replay: the daemon only feeds it live
 * timeline appends, so replayed rows can never emit.
 */
export class ToolCallHookTracker {
  private readonly open = new Map<string, Map<string, OpenToolCall>>();
  /**
   * callIds that already ended per agent: repeated terminal rows are
   * re-emissions. Turn-agnostic on purpose: a terminal row that arrives
   * after its turn closed is still a duplicate, never a second end. Capped
   * per agent (insertion-order eviction) so long sessions stay bounded.
   */
  private readonly settled = new Map<string, Map<string, string | null>>();
  private static readonly MAX_SETTLED_PER_AGENT = 1000;

  private callsFor(agentId: string): Map<string, OpenToolCall> {
    let calls = this.open.get(agentId);
    if (!calls) {
      calls = new Map();
      this.open.set(agentId, calls);
    }
    return calls;
  }

  private markSettled(agentId: string, callId: string, turnId: string | null): void {
    let calls = this.settled.get(agentId);
    if (!calls) {
      calls = new Map();
      this.settled.set(agentId, calls);
    }
    calls.delete(callId);
    calls.set(callId, turnId);
    while (calls.size > ToolCallHookTracker.MAX_SETTLED_PER_AGENT) {
      const oldest = calls.keys().next();
      if (oldest.done) break;
      calls.delete(oldest.value);
    }
  }

  noteTimelineItem(
    agentId: string,
    item: ToolCallTimelineItem,
    turnId: string | null,
    detail?: ToolCallDetail,
  ): ToolCallHookDecision | null {
    const calls = this.callsFor(agentId);
    if (item.status === "running") {
      if (calls.has(item.callId)) return null;
      calls.set(item.callId, { name: item.name, turnId, detail: detail ?? item.detail });
      return "started";
    }
    if (calls.delete(item.callId)) {
      if (calls.size === 0) this.open.delete(agentId);
      this.markSettled(agentId, item.callId, turnId);
      return "ended";
    }
    if (this.settled.get(agentId)?.has(item.callId)) return null;
    this.markSettled(agentId, item.callId, turnId);
    return "ended";
  }

  hasOpenCall(agentId: string, callId: string): boolean {
    return this.open.get(agentId)?.has(callId) ?? false;
  }

  openCallCount(agentId: string): number {
    return this.open.get(agentId)?.size ?? 0;
  }

  /**
   * Close every still-open call of `turnId` (turn ended while tools were
   * still running). Calls of other turns are left alone; a null turnId
   * closes calls recorded without a turn. Returns the closed calls so the
   * caller can emit one synthesized `ended` per call.
   */
  closeTurn(
    agentId: string,
    turnId: string | null,
    _outcome?: ToolCallTerminalKind,
  ): SynthesizedToolCallEnd[] {
    const calls = this.open.get(agentId);
    if (!calls || calls.size === 0) return [];
    const closed: SynthesizedToolCallEnd[] = [];
    for (const [callId, open] of calls) {
      if (open.turnId !== turnId) continue;
      closed.push({ callId, name: open.name, turnId: open.turnId, detail: open.detail });
      calls.delete(callId);
      this.markSettled(agentId, callId, open.turnId);
    }
    if (calls.size === 0) this.open.delete(agentId);
    return closed;
  }

  dropAgent(agentId: string): void {
    this.open.delete(agentId);
    this.settled.delete(agentId);
  }
}
