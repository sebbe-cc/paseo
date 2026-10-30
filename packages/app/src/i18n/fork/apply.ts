import type { i18n as I18n } from "i18next";
import { forkEn } from "./en";

// Shallow add: fork groups are new top-level keys, and a deep merge would mutate upstream modules.
export function applyForkResources(i18n: I18n): void {
  const locales = Object.keys(i18n.options.resources ?? {});
  for (const locale of locales) {
    i18n.addResourceBundle(locale, "translation", forkEn.groups, false, false);
  }
  for (const [key, value] of Object.entries(forkEn.overrides)) {
    i18n.addResource("en", "translation", key, value);
  }
}
