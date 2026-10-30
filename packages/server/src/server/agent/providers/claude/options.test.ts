import { describe, expect, test } from "vitest";

import {
	ClaudeProviderOptionsSchema,
	claudeInboxAccept,
} from "./options.js";

describe("Claude cross-session inbox options (pa-4ixw6.4)", () => {
	test("settings accept crossSessionInbound accept/hold/refuse", () => {
		for (const value of ["accept", "hold", "refuse"] as const) {
			const parsed = ClaudeProviderOptionsSchema.safeParse({
				settings: { crossSessionInbound: value },
			});
			expect(parsed.success).toBe(true);
			if (parsed.success)
				expect(parsed.data.settings).toMatchObject({ crossSessionInbound: value });
		}
	});

	test("settings still reject unknown keys", () => {
		const parsed = ClaudeProviderOptionsSchema.safeParse({
			settings: { nope: true },
		});
		expect(parsed.success).toBe(false);
	});

	test("claudeInboxAccept reads only an explicit true flag", () => {
		expect(claudeInboxAccept(undefined)).toBe(false);
		expect(claudeInboxAccept({})).toBe(false);
		expect(claudeInboxAccept({ claude_inbox_accept: false })).toBe(false);
		expect(claudeInboxAccept({ claude_inbox_accept: "yes" })).toBe(false);
		expect(claudeInboxAccept({ claude_inbox_accept: true })).toBe(true);
	});
});
