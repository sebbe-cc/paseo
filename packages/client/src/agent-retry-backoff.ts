/** Shared by timeline reads and explicit resumes, including callers outside the app. */
export class AgentRetryBackoff {
  private failures = new Map<string, { count: number; until: number; error: unknown }>();
  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.failures.get(key);
    const remaining = (previous?.until ?? 0) - this.now();
    if (remaining > 0) {
      throw Object.assign(
        new Error("Agent session retry is backing off", { cause: previous?.error }),
        {
          code: "AGENT_RETRY_BACKOFF",
          retryAfterMs: remaining,
        },
      );
    }
    try {
      const result = await action();
      this.failures.delete(key);
      return result;
    } catch (error) {
      const count = Math.min((previous?.count ?? 0) + 1, 10);
      const delay = Math.min(1000 * 2 ** (count - 1), 300_000);
      this.failures.delete(key);
      this.failures.set(key, { count, until: this.now() + delay, error });
      if (this.failures.size > 1024) this.failures.delete(this.failures.keys().next().value!);
      throw error;
    }
  }
}
