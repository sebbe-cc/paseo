import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useProjects } from "@/hooks/use-projects";
import { openProjectSettings } from "@/navigation/settings-navigation";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { getProjectHostEntry, getProjectSummaryForHostProject } from "@/utils/projects";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface RepositoryRowModel {
  projectId: string;
  name: string;
  repoRoot: string;
}

function rowStyle({ pressed }: PressableStateCallbackType) {
  return pressed ? [styles.row, styles.pressed] : styles.row;
}

export function RepositoriesTab({
  serverId,
  projectIds,
}: {
  serverId: string;
  projectIds: readonly string[];
}): ReactElement {
  const { t } = useTranslation();
  const { projects } = useProjects();
  const rows = useMemo<RepositoryRowModel[]>(
    () =>
      projectIds.map((projectId) => {
        const summary = getProjectSummaryForHostProject(projects, serverId, projectId);
        const host = getProjectHostEntry(summary, serverId, projectId);
        return { projectId, name: host?.projectName ?? projectId, repoRoot: host?.repoRoot ?? "" };
      }),
    [projectIds, projects, serverId],
  );
  return (
    <SettingsSection
      title={t("projectContainers.files.repositories.section")}
      testID="project-repositories-section"
    >
      <View style={settingsStyles.card}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>{t("projectContainers.files.repositories.empty")}</Text>
        ) : (
          rows.map((row, index) => (
            <RepositoryRow key={row.projectId} row={row} serverId={serverId} first={index === 0} />
          ))
        )}
      </View>
    </SettingsSection>
  );
}

function RepositoryRow({
  row,
  serverId,
  first,
}: {
  row: RepositoryRowModel;
  serverId: string;
  first: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const handleOpen = useCallback(
    () => openProjectSettings(serverId, row.projectId),
    [row.projectId, serverId],
  );
  return (
    <View style={first ? null : settingsStyles.rowBorder}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("projectContainers.files.repositories.open", { name: row.name })}
        onPress={handleOpen}
        style={rowStyle}
        testID={`project-repository-row-${row.projectId}`}
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {row.name}
          </Text>
          {row.repoRoot ? (
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {row.repoRoot}
            </Text>
          ) : null}
        </View>
        <ThemedChevronRight size={16} uniProps={mutedMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  pressed: { opacity: 0.7 },
}));
