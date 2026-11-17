import { memo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { workspaceLabelKey, type WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { WorkspaceLabelChip } from "@/workspace-labels/chip";

/**
 * The sidebar workspace row's own label line, below the
 * branch/project/host/change-request line. Labels wrap onto more lines
 * instead of squeezing the line above, so a bead id or city name is never
 * cut off to keep a change request visible.
 */
export const WorkspaceLabelRow = memo(function WorkspaceLabelRow({
  labels,
}: {
  labels: readonly WorkspaceLabelDefinition[];
}) {
  if (labels.length === 0) return null;
  return (
    <View style={styles.row} testID="workspace-label-row">
      {labels.map((label) => (
        <WorkspaceLabelChip key={workspaceLabelKey(label.name)} label={label} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    minWidth: 0,
  },
}));
