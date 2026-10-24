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
  const validate = await admissionBoundary(clock, () => ({
    value: { operation: "original", binding: 1 },
    busy: false,
  }));
  expect(clock.fence().watermark.activeWriters).toBe(0);
  const dispatch = await validate();
  let effects = 0;
  expect(dispatch(() => ++effects)).toBe(1);
  expect(() => dispatch(() => ++effects)).toThrowError(/retry/);
  expect(effects).toBe(1);
});

test("changed original operation or binding prevents an effect, including after validation", async () => {
  const clock = await fixture();
  let record = { operation: "original", binding: 1 };
  let validate = await admissionBoundary(clock, () => ({ value: record, busy: false }));
  record = { ...record, operation: "replaced" };
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  validate = await admissionBoundary(clock, () => ({ value: record, busy: false }));
  record = { ...record, binding: 2 };
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  validate = await admissionBoundary(clock, () => ({ value: record, busy: false }));

  const dispatch = await validate();
  record = { ...record, binding: 3 };
  let effects = 0;
  expect(() => dispatch(() => ++effects)).toThrow();
  expect(effects).toBe(0);
});

test("hook writes unrelated to the original operation and binding do not invalidate admission", async () => {
  const clock = await fixture();
  const record = { operation: "original", binding: 1 };
  const validate = await admissionBoundary(clock, () => ({ value: record, busy: false }));
  clock.run("agent-records", () => {});
  clock.run("admissions", () => {});
  const dispatch = await validate();
  let effects = 0;
  dispatch(() => ++effects);
  expect(effects).toBe(1);
});

test("unrelated writers may remain in flight through concurrent admission dispatch", async () => {
  const clock = await fixture();
  const finish = clock.begin("admissions");
  try {
    const validations = await Promise.all(
      Array.from({ length: 24 }, (_, id) =>
        admissionBoundary(clock, () => ({ value: { operation: id, binding: 1 }, busy: false })),
      ),
    );
    const permits = await Promise.all(validations.map((validate) => validate()));
    let effects = 0;
    for (const permit of permits) {
      clock.run("live-history", () => {});
      permit(() => ++effects);
    }
    expect(effects).toBe(24);
  } finally {
    finish();
  }
});

test("a pending mutation of the original authority blocks final validation and dispatch", async () => {
  const clock = await fixture();
  let busy = false;
  const validate = await admissionBoundary(clock, () => ({
    value: { operation: "original", binding: 1 },
    busy,
  }));
  const permit = await validate();
  busy = true;
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  let effects = 0;
  expect(() => permit(() => ++effects)).toThrowError(/retry/);
  expect(effects).toBe(0);
});
