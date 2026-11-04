import { describe, expect, it, vi } from "vitest";
import { reportSkillsMaintenanceFailure, SkillTargetReadOnlyError } from "./index";

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("reportSkillsMaintenanceFailure", () => {
  it("logs read-only skill targets at info level, not error", () => {
    const logger = fakeLogger();

    reportSkillsMaintenanceFailure(
      logger,
      new SkillTargetReadOnlyError([
        {
          skillName: "paseo-plugin",
          targetDir: "/home/seb/.agents/skills/paseo-plugin",
        },
      ]),
    );

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info.mock.calls[0]![1]).toMatch(
      "Skipping orchestration skills maintenance",
    );
  });

  it("keeps the startup error for anything else", () => {
    const logger = fakeLogger();

    reportSkillsMaintenanceFailure(logger, new Error("boom"));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error.mock.calls[0]![1]).toBe(
      "Failed to maintain orchestration skills at startup",
    );
  });
});
