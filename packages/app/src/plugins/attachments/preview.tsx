import { useMemo } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { PluginResourceComposerAttachment } from "./model";

interface PluginResourcePreviewProps {
  attachment: PluginResourceComposerAttachment | null;
  onClose(): void;
}

export function PluginResourcePreview({ attachment, onClose }: PluginResourcePreviewProps) {
  const header = useMemo(() => ({ title: attachment?.item.title ?? "" }), [attachment]);
  if (!attachment) return null;
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header}>
      <Text selectable style={styles.text}>
        {attachment.item.text}
      </Text>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
}));
