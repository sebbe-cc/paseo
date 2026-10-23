import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished } from "vitest";
import { admissionBoundary } from "./admission-boundary.js";
import { HostInventoryClock } from "./host-inventory-clock.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "admission-boundary-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return new HostInventoryClock(path.join(root, "inventory"));
}

test("a hook may take the host fence and dispatch its original effect only once", async () => {
  const clock = await fixture();
  const validate = await admissionBoundary(clock, async () => ({
    operation: "original",
    binding: 1,
  }));
  expect(clock.fence().watermark.activeWriters).toBe(0);
  const dispatch = await validate();
  let effects = 0;
  expect(dispatch(() => ++effects)).toBe(1);
  expect(() => dispatch(() => ++effects)).toThrowError(/retry/);
  expect(effects).toBe(1);
});

test("changed original record or post-validation sequence prevents an effect", async () => {
  const clock = await fixture();
  let record = { operation: "original", binding: 1 };
  let validate = await admissionBoundary(clock, async () => record);
  record = { ...record, operation: "replaced" };
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  validate = await admissionBoundary(clock, async () => record);
  record = { ...record, binding: 2 };
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  validate = await admissionBoundary(clock, async () => record);

  const dispatch = await validate();
  clock.run("admissions", () => {});
  let effects = 0;
  expect(() => dispatch(() => ++effects)).toThrow();
  expect(effects).toBe(0);
});

test("hook writes unrelated to the original operation and binding do not invalidate admission", async () => {
  const clock = await fixture();
  const record = { operation: "original", binding: 1 };
  const validate = await admissionBoundary(clock, async () => record);
  clock.run("agent-records", () => {});
  clock.run("admissions", () => {});
  const dispatch = await validate();
  let effects = 0;
  dispatch(() => ++effects);
  expect(effects).toBe(1);
});

test("a writer during the final observation cannot produce a dispatch permit", async () => {
  const clock = await fixture();
  let readingFinal = false;
  const validate = await admissionBoundary(clock, async () => {
    if (readingFinal) clock.run("agent-records", () => {});
    return { operation: "original", binding: 1 };
  });
  readingFinal = true;
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
});
