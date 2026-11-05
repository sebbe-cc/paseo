import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export const PANE_FOCUS_RING_TEST_ID = "pane-focus-ring";

/** The focused pane shows its ring only while its workspace route is focused. */
export function resolvePaneFocusRingVisible(input: {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
}): boolean {
  return input.isWorkspaceFocused && input.isPaneFocused;
}

/**
 * Indigo frame marking the keyboard/interaction-focused panel (chat,
 * explorer/workspace panel, plugin screens, shared views).
 *
 * Absolute overlay, so it never moves layout, and with no animation there is
 * nothing for prefers-reduced-motion to disable. Color comes from the
 * `focusRing` theme token (indigo in both themes).
 */
export function PaneFocusRing({
  visible,
  testID = PANE_FOCUS_RING_TEST_ID,
}: {
  visible: boolean;
  testID?: string;
}) {
  if (!visible) {
    return null;
  }
  return <View pointerEvents="none" accessible={false} testID={testID} style={styles.ring} />;
}

const styles = StyleSheet.create((theme) => ({
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.focusRing,
    borderRadius: theme.borderRadius.none,
  },
}));
