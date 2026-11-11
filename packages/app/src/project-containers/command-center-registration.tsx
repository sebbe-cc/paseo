import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { CommandCenterIconProps } from "@/command-center/contributions";
import { useCommandCenterActions } from "@/command-center/provider";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { buildProjectContainerContributions } from "./command-center";
import { useMergedProjectContainers } from "./index";

const ThemedFolder = withUnistyles(Folder, (theme) => ({ color: theme.colors.foregroundMuted }));

function FolderIcon({ size }: CommandCenterIconProps) {
  return <ThemedFolder size={size} strokeWidth={2.2} />;
}

export function ProjectContainerCommandCenterActions(): null {
  const { t } = useTranslation();
  const containers = useMergedProjectContainers();
  const toggle = useSidebarCollapsedSectionsStore((state) => state.toggleProjectContainerCollapsed);
  const actions = useMemo(
    () =>
      buildProjectContainerContributions({
        containers,
        labels: {
          section: t("shell.commandCenter.actions"),
          toggle: (name) => t("projectContainers.commandCenter.toggle", { name }),
        },
        icon: FolderIcon,
        toggle,
      }),
    [containers, t, toggle],
  );
  useCommandCenterActions({ sourceId: "project-containers", enabled: true, actions });
  return null;
}
