import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { projectContainerErrorMessage } from "@/project-containers";
import type { Theme } from "@/styles/theme";

const ACTION_ICON_SIZE = 14;
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedTrash2 = withUnistyles(Trash2);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function useReportFilesError(): (cause: unknown) => void {
  const toast = useToast();
  return useCallback((cause: unknown) => toast.error(projectContainerErrorMessage(cause)), [toast]);
}

function ActionButton({
  label,
  icon,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}): ReactElement {
  return (
    <ToolbarButton label={label} disabled={disabled} onPress={onPress} testID={testID}>
      {icon}
    </ToolbarButton>
  );
}

const upIcon = <ThemedArrowUp size={ACTION_ICON_SIZE} uniProps={mutedMapping} />;
const downIcon = <ThemedArrowDown size={ACTION_ICON_SIZE} uniProps={mutedMapping} />;
const deleteIcon = <ThemedTrash2 size={ACTION_ICON_SIZE} uniProps={mutedMapping} />;

/** Up, down and delete for a list row; shown on hover on web and always on touch layouts. */
export function RowActions({
  revealed,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  testID,
}: {
  revealed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete?: () => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={revealed ? styles.actions : [styles.actions, styles.hidden]}>
      <ActionButton
        label={t("projectContainers.files.moveUp")}
        icon={upIcon}
        disabled={!canMoveUp}
        onPress={onMoveUp}
        testID={`${testID}-up`}
      />
      <ActionButton
        label={t("projectContainers.files.moveDown")}
        icon={downIcon}
        disabled={!canMoveDown}
        onPress={onMoveDown}
        testID={`${testID}-down`}
      />
      {onDelete ? (
        <ActionButton
          label={t("projectContainers.files.delete")}
          icon={deleteIcon}
          onPress={onDelete}
          testID={`${testID}-delete`}
        />
      ) : null}
    </View>
  );
}

/** The canonical hover pattern: a plain View tracks the pointer, inner Pressables handle presses. */
export function useRowHover() {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const onPointerEnter = useCallback(() => setIsHovered(true), []);
  const onPointerLeave = useCallback(() => setIsHovered(false), []);
  return { revealed: isHovered || isNative || isCompact, onPointerEnter, onPointerLeave };
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  hidden: { opacity: 0 },
}));
