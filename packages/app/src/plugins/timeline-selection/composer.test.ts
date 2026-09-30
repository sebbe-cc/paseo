import { describe, expect, it, vi } from "vitest";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { createTimelineSelectionComposer } from "./composer";
import type { UserComposerAttachment } from "@/attachments/types";

const item: PluginAttachmentItem = {
  id: "comment-1",
  identifier: "Annotation",
  title: "Check this",
  text: "quote and comment",
  resourceType: "annotation",
};

function fixture() {
  const lifetime = new AbortController();
  const installation = new AbortController();
  const state = { registered: true, connected: true };
  const drafts = new Map<string, { text: string; attachments: UserComposerAttachment[] }>();
  const origin = "host-1/agent-1";
  drafts.set(origin, { text: "existing composer text", attachments: [] });
  const save = vi.fn((draft: { text: string; attachments: UserComposerAttachment[] }) => {
    drafts.set(origin, draft);
  });
  const composer = createTimelineSelectionComposer({
    signal: lifetime.signal,
    installationSignal: installation.signal,
    isRegistered: () => state.registered,
    isConnected: () => state.connected,
    source: {
      pluginId: "annotate",
      sourceId: "annotate",
      sourceTitle: "Annotate",
      sourceIcon: "MessageSquare",
    },
    readDraft: () => drafts.get(origin),
    saveDraft: save,
  });
  return { composer, lifetime, installation, state, drafts, save, origin };
}

describe("timeline selection composer capability", () => {
  it("retains origin draft and existing text when another host/agent draft is active", () => {
    const f = fixture();
    const other = "host-2/agent-2";
    f.drafts.set(other, { text: "other agent", attachments: [] });
    f.composer.addAttachment(item);
    expect(f.drafts.get(f.origin)?.text).toBe("existing composer text");
    expect(f.drafts.get(f.origin)?.attachments).toHaveLength(1);
    expect(f.drafts.get(other)).toEqual({ text: "other agent", attachments: [] });
  });

  it("adds repeated IDs once but retains separate comments", () => {
    const f = fixture();
    f.composer.addAttachment(item);
    f.composer.addAttachment(item);
    f.composer.addAttachment({ ...item, id: "comment-2" });
    expect(f.drafts.get(f.origin)?.attachments).toHaveLength(2);
  });

  it.each(["closed-or-inactive", "unregistered", "disconnected", "plugin-stopped"])(
    "rejects an old capability after %s without modifying or focusing any composer",
    (reason) => {
      const f = fixture();
      if (reason === "closed-or-inactive") f.lifetime.abort();
      if (reason === "unregistered") f.state.registered = false;
      if (reason === "disconnected") f.state.connected = false;
      if (reason === "plugin-stopped") f.installation.abort();
      expect(() => f.composer.addAttachment(item)).toThrow("no longer active");
      expect(f.save).not.toHaveBeenCalled();
      expect(f.drafts.get(f.origin)?.attachments).toEqual([]);
    },
  );

  it("a replacement session never revives a closed handle", () => {
    const previous = fixture();
    previous.lifetime.abort();
    const replacement = fixture();
    replacement.composer.addAttachment(item);
    expect(() => previous.composer.addAttachment(item)).toThrow("no longer active");
    expect(previous.save).not.toHaveBeenCalled();
  });
});
