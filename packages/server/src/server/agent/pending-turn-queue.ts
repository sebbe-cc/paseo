import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";

/**
 * One message waiting for the provider's active foreground turn to end.
 * The turnId is reserved at enqueue time so the daemon can bind its run to
 * the queued turn before the provider starts it.
 */
export interface PendingTurn {
  turnId: string;
  prompt: AgentPromptInput;
  options?: AgentRunOptions;
}

/**
 * FIFO for messages sent to a provider session while its foreground turn is
 * still active. A busy provider must queue instead of throwing: every sender
 * (user, agent messages, mail wakeups) funnels through startTurn, and a
 * rejection there loses the message. The provider drains the queue when its
 * active turn reaches a terminal state.
 */
export class PendingTurnQueue {
  private readonly items: PendingTurn[] = [];

  constructor(private readonly createTurnId: () => string) {}

  get size(): number {
    return this.items.length;
  }

  enqueue(prompt: AgentPromptInput, options?: AgentRunOptions): string {
    const turnId = this.createTurnId();
    this.items.push({ turnId, prompt, options });
    return turnId;
  }

  dequeue(): PendingTurn | undefined {
    return this.items.shift();
  }

  clear(): PendingTurn[] {
    return this.items.splice(0);
  }
}
