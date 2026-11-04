import { expect, test } from "vitest";
import { subscriptionUsageSchema, usageSchema } from "../server/wire.js";

const valid = {
  observedAtMs: 1700000000000,
  tier: "Pro",
  window: { usedPercent: 75, resetsAtMs: 1700018000000, windowDurationMins: 300 },
  weekly: { usedPercent: 105, resetsAtMs: 1700604800000 },
};

test("usage/changed params are SubscriptionUsage directly, not wrapped", () => {
  expect(subscriptionUsageSchema.safeParse(valid).success).toBe(true);
  expect(subscriptionUsageSchema.safeParse({ usage: valid }).success).toBe(false);
});

test("usage/changed rejects empty and invalid observations instead of zero-filling", () => {
  for (const params of [
    {},
    { ...valid, tier: "" },
    { ...valid, observedAtMs: Number.NaN },
    { ...valid, observedAtMs: -1 },
    { ...valid, window: { ...valid.window, usedPercent: -5 } },
    { ...valid, window: { ...valid.window, windowDurationMins: 0 } },
    { ...valid, weekly: { ...valid.weekly, usedPercent: Number.POSITIVE_INFINITY } },
    { ...valid, weekly: undefined },
  ]) {
    expect(subscriptionUsageSchema.safeParse(params).success).toBe(false);
  }
});

test("usage/changed accepts over-quota percentages verbatim", () => {
  const parsed = subscriptionUsageSchema.safeParse({
    ...valid,
    window: { ...valid.window, usedPercent: 250 },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.window.usedPercent).toBe(250);
});

test("usage/read keeps its {usage?} envelope with truthful absence", () => {
  expect(usageSchema.safeParse({}).success).toBe(true);
  expect(usageSchema.safeParse({ usage: valid }).success).toBe(true);
});
