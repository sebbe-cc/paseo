import { useMemo, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useMergedProjectContainers } from "./index";
import { findRepositoryContainer, type LayoutRepository } from "./layout";
import {
  ProjectContainerPickerPage,
  useCanAssignProjectContainer,
  useProjectContainerCreatePages,
} from "./picker";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return pressed ? [styles.trigger, styles.triggerPressed] : styles.trigger;
}

// The repository settings row for its sidebar project. Absent when no host of the repository
// can hold projects, so an old daemon shows the screen as it was.
export function ProjectContainerSettingsSection({
  repository,
}: {
  repository: LayoutRepository;
}): ReactElement | null {
  const { t } = useTranslation();
  const enabled = useCanAssignProjectContainer(repository);
  const containers = useMergedProjectContainers();
  const current = findRepositoryContainer(repository, containers);
  const pages = useProjectContainerCreatePages(repository);
  const value = current?.name ?? t("projectContainers.none");
  const picker = useMemo(
    () => <ProjectContainerPickerPage repository={repository} />,
    [repository],
  );
  if (!enabled) return null;
  return (
    <SettingsSection
      title={t("projectContainers.settings.title")}
      testID="project-container-settings-section"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("projectContainers.settings.title")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("projectContainers.settings.description")}
            </Text>
          </View>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={triggerStyle}
              accessibilityRole="button"
              accessibilityLabel={`${t("projectContainers.settings.title")}: ${value}`}
              testID="project-container-settings-trigger"
            >
              <Text style={styles.triggerText} numberOfLines={1}>
                {value}
              </Text>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              width={220}
              pages={pages}
              sheetTitle={t("projectContainers.moveTo")}
              testID="project-container-settings-menu"
            >
              {picker}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 220,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: { opacity: 0.85 },
  triggerText: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
}));
