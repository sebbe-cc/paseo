import { describe, expect, it } from "vitest";

import { sessionGrantedSkills } from "./options.js";

describe("sessionGrantedSkills (pa-uumx5v)", () => {
  it("returns the contract names when the session carries a usable list", () => {
    expect(
      sessionGrantedSkills({
        gascity_granted_skills: ["fleet-memory", "ticket-flow"],
      }),
    ).toEqual(["fleet-memory", "ticket-flow"]);
  });

  it("is undefined without a contract, so sessions behave as before", () => {
    expect(sessionGrantedSkills(undefined)).toBeUndefined();
    expect(sessionGrantedSkills({})).toBeUndefined();
    expect(sessionGrantedSkills({ gascity_granted_skills: true })).toBeUndefined();
    expect(sessionGrantedSkills({ gascity_granted_skills: "all" })).toBeUndefined();
    expect(sessionGrantedSkills({ gascity_granted_skills: [] })).toBeUndefined();
  });

  it("drops unusable entries and stays undefined when nothing usable remains", () => {
    expect(sessionGrantedSkills({ gascity_granted_skills: ["ok", 7, "", null] })).toEqual(["ok"]);
    expect(sessionGrantedSkills({ gascity_granted_skills: [7, ""] })).toBeUndefined();
  });
});
