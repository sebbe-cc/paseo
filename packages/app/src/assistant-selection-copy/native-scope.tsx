import { supportsNativeTimelineSelection } from "./native-capability";
import { useCallback, type ReactNode } from "react";
import { requireNativeViewManager } from "expo-modules-core";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useTimelineSelection, useTimelineSelectionSource } from "./timeline-selection";

interface NativeSelection {
  actionId: string;
  surfaceId: string;
  text: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

interface NativeScopeProps extends ViewProps {
  actions: readonly { id: string; title: string }[];
  onSelect(event: NativeSyntheticEvent<NativeSelection>): void;
}

const SelectionScope = requireNativeViewManager<NativeScopeProps>("PaseoTextSelection");

export function NativeTimelineSelectionScope({ children }: { children: ReactNode }) {
  const context = useTimelineSelection();
  const source = useTimelineSelectionSource();
  const onSelect = useCallback(
    ({
      nativeEvent: { actionId, surfaceId, ...selection },
    }: NativeSyntheticEvent<NativeSelection>) => {
      if (!context || !source) return;
      context.select(
        {
          text: selection.text,
          segments: [
            { ...selection, itemId: source.itemId, surfaceId: `${source.surfaceId}/${surfaceId}` },
          ],
        },
        actionId,
      );
    },
    [context, source],
  );
  if (!supportsNativeTimelineSelection || !context || !source || context.actions.length === 0)
    return children;

  return (
    <SelectionScope actions={context.actions} onSelect={onSelect}>
      {children}
    </SelectionScope>
  );
}
