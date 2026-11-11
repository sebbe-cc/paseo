export {
  classifyAssistantFileLink,
  normalizeInlinePathTarget,
  parseAssistantFileCandidatePath,
  type InlinePathTarget,
} from "./parse";
export {
  AssistantFileLinkResolverProvider,
  useAssistantFileLinkEnvironment,
  useAssistantFileLinkEnvironmentBridge,
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverProviderProps,
} from "./provider";
export type { AssistantFileLinkSource } from "./resolver";
export { classifyForBatch, type AssistantFileBatchClassification } from "./resolver";
export { useAssistantFileLinkActions, useAssistantFileBatch, useFileLink } from "./use-file-link";
export { assistantFileQueryKey, ASSISTANT_FILE_STALE_MS, ASSISTANT_FILE_GC_MS } from "./queries";

export { createInlinePathOpener } from "./path-open";
