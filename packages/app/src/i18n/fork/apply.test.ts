import { describe, expect, it } from "vitest";
import { i18n } from "../i18next";
import { en } from "../resources/en";
import { forkEn } from "./en";

describe("fork resources", () => {
  it("resolves fork keys in English and every other locale", async () => {
    expect(i18n.t("projectContainers.empty")).toBe("No repositories");
    expect(i18n.t("projectContainers.headerLabel", { name: "heads", count: 3 })).toBe(
      "heads project, 3 repositories",
    );
    await i18n.changeLanguage("fr");
    expect(i18n.t("projectContainers.menu.rename")).toBe("Rename");
    await i18n.changeLanguage("en");
  });

  it("keeps upstream keys intact and never shadows an upstream group", () => {
    expect(i18n.t("common.actions.cancel")).toBe(en.common.actions.cancel);
    for (const group of Object.keys(forkEn.groups)) {
      expect(Object.keys(en)).not.toContain(group);
    }
  });

  it("only overrides keys that exist upstream", () => {
    for (const key of Object.keys(forkEn.overrides)) {
      const value = key.split(".").reduce<unknown>((node, part) => {
        return node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined;
      }, en);
      expect(typeof value, key).toBe("string");
    }
  });
});
