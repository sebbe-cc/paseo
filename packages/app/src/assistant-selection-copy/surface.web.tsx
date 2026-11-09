import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { PluginTimelineSelection } from "@getpaseo/plugin/client";
import { MenuRoot, MenuSurface, MenuItem, useMenuContext, type Rect } from "@/components/ui/menu";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Icon } from "@/plugins/icons";
import { createAssistantSelectionClipboardContent } from "./content.web";
import { snapshotTimelineSelection } from "./selection.web";
import { useTimelineSelection, type TimelineSelectionContextValue } from "./timeline-selection";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

interface SelectedRange {
  selection: PluginTimelineSelection;
  anchor: Rect;
}

const ThemedIcon = withUnistyles(Icon);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

function SelectionActions({
  selected,
  context,
}: {
  selected: SelectedRange;
  context: TimelineSelectionContextValue;
}) {
  const { setAnchorRect } = useMenuContext("TimelineSelectionActions");
  useEffect(() => {
    setAnchorRect(selected.anchor);
  }, [setAnchorRect, selected]);
  return (
    <MenuSurface autoFocus={false} side="bottom" minWidth={160} maxWidth={280}>
      {context.actions.map((action) => (
        <SelectionAction key={action.id} action={action} selected={selected} context={context} />
      ))}
    </MenuSurface>
  );
}

function SelectionAction({
  action,
  selected,
  context,
}: {
  action: TimelineSelectionContextValue["actions"][number];
  selected: SelectedRange;
  context: TimelineSelectionContextValue;
}) {
  const select = useCallback(
    () => context.select(selected.selection, action.id, selected.anchor),
    [context, selected, action.id],
  );
  const leading = useMemo(
    () => <ThemedIcon name={action.icon} size={16} uniProps={iconMapping} />,
    [action.icon],
  );
  return (
    <MenuItem leading={leading} onSelect={select}>
      {action.title}
    </MenuItem>
  );
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  const root = useRef<HTMLDivElement>(null);
  const context = useTimelineSelection();
  const [selected, setSelected] = useState<SelectedRange | null>(null);
  useEffect(() => {
    if (!context?.actions.length) setSelected(null);
  }, [context?.actions.length]);
  const capture = useCallback(() => {
    if (!root.current || !context?.actions.length) return;
    const native = window.getSelection();
    const selection = snapshotTimelineSelection(native, root.current);
    if (!selection || !native) {
      setSelected(null);
      return;
    }
    const rect = native.getRangeAt(0).getBoundingClientRect();
    setSelected({
      selection,
      anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }, [context]);
  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") capture();
    },
    [capture],
  );
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) setSelected(null);
  }, []);
  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);
  return (
    <>
      <div
        ref={root}
        data-timeline-selection-root=""
        onCopy={handleCopy}
        onMouseUp={capture}
        onKeyUp={handleKeyUp}
        style={DISPLAY_CONTENTS}
      >
        <View style={style}>{children}</View>
      </div>
      {selected && context?.actions.length ? (
        <MenuRoot dismissKeyboardOnOpen={false} open onOpenChange={onOpenChange}>
          <SelectionActions selected={selected} context={context} />
        </MenuRoot>
      ) : null}
    </>
  );
}
