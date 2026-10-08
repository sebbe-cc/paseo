import { supportsNativeTimelineSelection } from "@/assistant-selection-copy/native-capability";
import { useMemo } from "react";
import { Text, type TextProps } from "react-native";
import { useTimelineSelection } from "@/assistant-selection-copy/timeline-selection";
import { UITextView } from "react-native-uitextview";
import { resolvePlainMarkdownTextStyle } from "./markdown-text-style";

export function SelectableText({ style, ...props }: TextProps) {
  const plainStyle = useMemo(() => resolvePlainMarkdownTextStyle(style), [style]);
  const selection = useTimelineSelection();
  if (!supportsNativeTimelineSelection || !selection?.actions.length)
    return <Text {...props} selectable style={style} />;
  return <UITextView {...props} uiTextView selectable style={plainStyle} />;
}
