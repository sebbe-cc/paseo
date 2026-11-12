import { ActivityIndicator, View } from "react-native";
import { Mic, MicOff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarHeaderRow } from "./sidebar-header-row";
import { useGlobalVoice } from "@/contexts/global-voice-context";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { Theme } from "@/styles/theme";

const Spinner = withUnistyles(ActivityIndicator);
const spinnerTheme = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SidebarGlobalVoice() {
  const voice = useGlobalVoice();
  const keys = useShortcutKeys("global-voice-toggle");
  if (!voice) return null;
  let trailing;
  if (voice.active)
    trailing = <View testID="global-voice-active-indicator" style={styles.activeDot} />;
  if (voice.busy) trailing = <Spinner size="small" uniProps={spinnerTheme} />;
  return (
    <SidebarHeaderRow
      testID="sidebar-global-voice"
      variant="compact"
      icon={voice.active && !voice.muted ? Mic : MicOff}
      label={voice.label}
      isActive={voice.active}
      disabled={voice.busy || (!voice.hasTarget && !voice.active)}
      onPress={voice.toggle}
      shortcutKeys={keys}
      trailing={trailing}
    />
  );
}
const styles = StyleSheet.create((theme) => ({
  activeDot: {
    width: 7,
    height: 7,
    marginRight: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusSuccess,
  },
}));
