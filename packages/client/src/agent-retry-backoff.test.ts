import { expect, test } from "vitest";
import { AgentRetryBackoff } from "./agent-retry-backoff.js";

test("failure backoff is exponential, capped, isolated and reset after recovery", async () => {
  let now = 0;
  let attempts = 0;
  const backoff = new AgentRetryBackoff(() => now);
  const failing = async () => {
    attempts++;
    throw new Error("provider unavailable");
  };
  for (const delay of [
    1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000,
  ]) {
    await expect(backoff.run("broken", failing)).rejects.toThrow("provider unavailable");
    const before = attempts;
    await expect(backoff.run("broken", failing)).rejects.toMatchObject({
      code: "AGENT_RETRY_BACKOFF",
      retryAfterMs: delay,
    });
    expect(attempts).toBe(before);
    await expect(backoff.run("healthy", async () => "ok")).resolves.toBe("ok");
    now += delay;
  }
  await expect(backoff.run("broken", async () => "recovered")).resolves.toBe("recovered");
  await expect(backoff.run("broken", failing)).rejects.toThrow("provider unavailable");
  await expect(backoff.run("broken", failing)).rejects.toMatchObject({ retryAfterMs: 1000 });
});
