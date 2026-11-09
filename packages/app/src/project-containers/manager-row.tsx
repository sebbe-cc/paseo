import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const EDIT_ICON_SIZE = 14;
const ThemedPencil = withUnistyles(Pencil);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ProjectContainerManagerRow({
  container,
  disabled,
  onEdit,
}: {
  container: ProjectContainer;
  disabled: boolean;
  onEdit: (container: ProjectContainer) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const edit = useCallback(() => onEdit(container), [container, onEdit]);
  const revealed = isHovered || isNative || isCompact;
  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`project-container-manager-row-${container.id}`}
    >
      <Text style={styles.name} numberOfLines={1}>
        {container.name}
      </Text>
      <Text style={styles.count}>
        {t("projectContainers.manage.count", { count: container.projectIds.length })}
      </Text>
      <ToolbarButton
        label={t("projectContainers.manage.editLabel", { name: container.name })}
        disabled={disabled}
        onPress={edit}
        style={revealed ? undefined : styles.editHidden}
        testID={`project-container-manager-edit-${container.id}`}
      >
        <ThemedPencil size={EDIT_ICON_SIZE} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  name: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  editHidden: { opacity: 0 },
}));
