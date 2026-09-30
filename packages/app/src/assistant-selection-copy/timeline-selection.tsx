import { createContext, useContext, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import type { PluginTimelineSelection } from "@getpaseo/plugin/client";
import type { Rect } from "@/components/ui/menu";
import { isWeb } from "@/constants/platform";
import { NativeTimelineSelectionScope } from "./native-scope";

export interface TimelineSelectionContextValue {
  actions: readonly { id: string; title: string; icon: string }[];
  select(selection: PluginTimelineSelection, actionId: string, anchor?: Rect): void;
}

interface TimelineSelectionSourceIdentity {
  itemId: string;
  surfaceId: string;
}

const SOURCE_STYLE = { display: "contents" } as const;

const TimelineSelectionContext = createContext<TimelineSelectionContextValue | null>(null);
const TimelineSelectionSourceContext = createContext<TimelineSelectionSourceIdentity | null>(null);
export const TimelineSelectionProvider = TimelineSelectionContext.Provider;

export function useTimelineSelection() {
  return useContext(TimelineSelectionContext);
}

export function useTimelineSelectionSource() {
  return useContext(TimelineSelectionSourceContext);
}

export function TimelineSelectionSource({
  itemId,
  surfaceId,
  children,
}: TimelineSelectionSourceIdentity & { children: ReactNode }) {
  const identity = useMemo(() => ({ itemId, surfaceId }), [itemId, surfaceId]);
  const dataSet = useMemo(
    () => ({ timelineItemId: itemId, timelineSurfaceId: surfaceId }),
    [itemId, surfaceId],
  );
  const content = isWeb ? (
    <View dataSet={dataSet} style={SOURCE_STYLE}>
      {children}
    </View>
  ) : (
    <NativeTimelineSelectionScope>{children}</NativeTimelineSelectionScope>
  );
  return (
    <TimelineSelectionSourceContext.Provider value={identity}>
      {content}
    </TimelineSelectionSourceContext.Provider>
  );
}
