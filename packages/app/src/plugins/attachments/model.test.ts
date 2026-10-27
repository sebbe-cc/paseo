import { describe, expect, it } from "vitest";
import {
  appendPluginResourceAttachment,
  createPluginResourceAttachment,
  PluginResourceComposerAttachmentSchema,
  pluginResourceAttachmentToAgentAttachment,
  togglePluginResourceAttachment,
} from "./model";
import { CanonicalDraftInputSchema } from "@/stores/draft-store/state";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";

const source = {
  pluginId: "linear",
  sourceId: "issues",
  sourceTitle: "Linear issue",
  sourceIcon: "CircleDot",
};

const item = {
  id: "issue-uuid",
  identifier: "ENG-123",
  title: "Plugin attachments",
  subtitle: "In progress · Mohamed",
  url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
  text: "Linear issue ENG-123: Plugin attachments\nStatus: In progress",
  resourceType: "issue",
};

describe("plugin resource attachments", () => {
  it("creates a draft-safe composer attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(PluginResourceComposerAttachmentSchema.parse(attachment)).toEqual({
      kind: "plugin_resource",
      ...source,
      item,
    });
  });

  it("toggles one resource by plugin, source, and stable item id", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(togglePluginResourceAttachment([], attachment)).toEqual([attachment]);
    expect(togglePluginResourceAttachment([attachment], attachment)).toEqual([]);
  });

  it("submits through the backward-compatible text attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    const agentAttachment = pluginResourceAttachmentToAgentAttachment(attachment);
    expect(agentAttachment).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "ENG-123 Plugin attachments",
      text: item.text,
      externalResource: {
        provider: "linear",
        providerLabel: "Linear issue",
        resourceType: "issue",
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        url: item.url,
      },
    });
    expect(splitComposerAttachmentsForSubmit([attachment])).toEqual({
      images: [],
      attachments: [agentAttachment],
    });
  });
});

const localItem = {
  id: "note-1",
  identifier: "",
  title: "Clarify this",
  text: "Exact quote and comment",
  resourceType: "note",
};

describe("local plugin resources", () => {
  it("restores a self-contained snapshot and submits without external metadata", () => {
    const original = createPluginResourceAttachment(source, localItem);
    const persisted = CanonicalDraftInputSchema.parse(
      JSON.parse(JSON.stringify({ text: "Keep text", attachments: [original] })),
    );
    expect(persisted).toEqual({ text: "Keep text", attachments: [original] });
    const restored = PluginResourceComposerAttachmentSchema.parse(
      JSON.parse(JSON.stringify(original)),
    );
    expect(restored).toEqual(original);
    expect(pluginResourceAttachmentToAgentAttachment(restored)).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: localItem.title,
      text: localItem.text,
    });
    expect(splitComposerAttachmentsForSubmit([restored]).attachments).toEqual([
      pluginResourceAttachmentToAgentAttachment(restored),
    ]);
  });

  it("keeps the original snapshot on duplicate append and preserves existing resources", () => {
    const original = createPluginResourceAttachment(source, localItem);
    const changed = createPluginResourceAttachment(source, { ...localItem, text: "modified" });
    const external = createPluginResourceAttachment(source, item);
    const current = [external, original];
    expect(appendPluginResourceAttachment(current, changed)).toBe(current);
    expect(current[1].item.text).toBe(localItem.text);
    const second = createPluginResourceAttachment(source, { ...localItem, id: "note-2" });
    expect(appendPluginResourceAttachment(current, second)).toEqual([...current, second]);
    expect(togglePluginResourceAttachment(current, original)).toEqual([external]);
  });

  it("isolates identical ids by plugin and source and copies incoming data", () => {
    const itemCopy = { ...localItem };
    const first = createPluginResourceAttachment(source, itemCopy);
    itemCopy.text = "changed after append";
    expect(first.item.text).toBe(localItem.text);
    const second = createPluginResourceAttachment({ ...source, pluginId: "other" }, localItem);
    const third = createPluginResourceAttachment({ ...source, sourceId: "other" }, localItem);
    expect(
      appendPluginResourceAttachment(appendPluginResourceAttachment([first], second), third),
    ).toEqual([first, second, third]);
  });

  it("still rejects malformed external URLs", () => {
    expect(() =>
      createPluginResourceAttachment(source, { ...localItem, url: "not a URL" }),
    ).toThrow();
  });
});
