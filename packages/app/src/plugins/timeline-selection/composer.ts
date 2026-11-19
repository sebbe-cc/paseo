import type { PluginTimelineSelectionActionProps } from "@getpaseo/plugin/client";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  appendPluginResourceAttachment,
  createPluginResourceAttachment,
  type PluginResourceSourceIdentity,
} from "../attachments/model";

interface Draft {
  text: string;
  attachments: UserComposerAttachment[];
}

interface ComposerBinding {
  signal: AbortSignal;
  installationSignal: AbortSignal;
  isRegistered(): boolean;
  isConnected(): boolean;
  source: PluginResourceSourceIdentity;
  readDraft(): Draft | undefined;
  saveDraft(draft: Draft): void;
}

export function createTimelineSelectionComposer(
  binding: ComposerBinding,
): PluginTimelineSelectionActionProps["composer"] {
  return {
    addAttachment(item) {
      if (
        binding.signal.aborted ||
        binding.installationSignal.aborted ||
        !binding.isRegistered() ||
        !binding.isConnected()
      ) {
        throw new Error("This timeline selection is no longer active");
      }
      const draft = binding.readDraft() ?? { text: "", attachments: [] };
      const attachment = createPluginResourceAttachment(binding.source, item);
      const attachments = appendPluginResourceAttachment(draft.attachments, attachment);
      binding.saveDraft({ ...draft, attachments });
    },
  };
}
