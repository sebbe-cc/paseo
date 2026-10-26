import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ArrowLeft, Folder } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useProjectContainerHost } from "@/project-containers";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ContextTab } from "./context-tab";
import { NotesTab } from "./notes-tab";
import { RepositoriesTab } from "./repositories-tab";
import { TodosTab } from "./todos-tab";
import { useProjectFiles, type ProjectFilesState } from "./use-project-files";

type Tab = "notes" | "todos" | "context" | "repositories";
const FILE_TABS: readonly Tab[] = ["notes", "todos", "context"];
const ThemedFolder = withUnistyles(Folder);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ProjectContainerSettingsScreenProps {
  serverId: string;
  containerId: string;
  onBack: () => void;
  showBack: boolean;
}

// Settings for a project (a container of repositories) on one host. Hosts without
// `projectContainerFiles` only get the Repositories tab and an update hint.
export function ProjectContainerSettingsScreen({
  serverId,
  containerId,
  onBack,
  showBack,
}: ProjectContainerSettingsScreenProps): ReactElement {
  const { t } = useTranslation();
  const host = useProjectContainerHost(serverId);
  const container = host?.containers.find((candidate) => candidate.id === containerId);
  const client = useHostRuntimeClient(serverId);
  const supportsFiles = useHostFeature(serverId, "projectContainerFiles");
  const back = showBack ? (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={ArrowLeft}
      onPress={onBack}
      style={styles.back}
      testID="project-container-settings-back"
    >
      {t("settings.project.backToProjects")}
    </Button>
  ) : null;

  if (!container || !client) {
    return (
      <View style={styles.body} testID="project-container-settings-missing">
        {back}
        <Text style={styles.muted}>{t("projectContainers.files.notFound")}</Text>
      </View>
    );
  }
  return (
    <View role="main" style={styles.body} testID="project-container-settings">
      {back}
      <View style={styles.titleRow}>
        <ThemedFolder size={18} uniProps={mutedMapping} />
        <Text style={styles.title} numberOfLines={1}>
          {container.name}
        </Text>
      </View>
      <ContainerTabs
        serverId={serverId}
        client={client}
        container={container}
        supportsFiles={supportsFiles}
      />
    </View>
  );
}

function ContainerTabs({
  serverId,
  client,
  container,
  supportsFiles,
}: {
  serverId: string;
  client: DaemonClient;
  container: ProjectContainer;
  supportsFiles: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(supportsFiles ? "notes" : "repositories");
  const files = useProjectFiles(supportsFiles ? client : null, container.id);
  const options = useMemo(
    () =>
      [...(supportsFiles ? FILE_TABS : []), "repositories" as const].map((value) => ({
        value,
        label: t(`projectContainers.files.tabs.${value}`),
        testID: `project-container-tab-${value}`,
      })),
    [supportsFiles, t],
  );
  const current = supportsFiles || tab === "repositories" ? tab : "repositories";
  return (
    <View style={styles.tabs}>
      <SegmentedControl
        size="sm"
        options={options}
        value={current}
        onValueChange={setTab}
        style={styles.segmented}
        testID="project-container-tabs"
      />
      {supportsFiles ? null : (
        <Alert variant="info" title={t("projectContainers.files.updateHost")} />
      )}
      {current === "repositories" ? (
        <RepositoriesTab serverId={serverId} projectIds={container.projectIds} />
      ) : (
        <FilesTab tab={current} state={files} client={client} containerId={container.id} />
      )}
    </View>
  );
}

function FilesTab({
  tab,
  state,
  client,
  containerId,
}: {
  tab: Exclude<Tab, "repositories">;
  state: ProjectFilesState;
  client: DaemonClient;
  containerId: string;
}): ReactNode {
  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner color={styles.spinner.color} />
      </View>
    );
  }
  if (state.status === "error") {
    return <Alert variant="error" title={state.message} testID="project-files-error" />;
  }
  const { files } = state;
  if (tab === "notes") {
    return <NotesTab client={client} containerId={containerId} notes={files.notes} />;
  }
  if (tab === "todos") {
    return <TodosTab client={client} containerId={containerId} todos={files.todos} />;
  }
  return (
    <ContextTab
      client={client}
      containerId={containerId}
      context={files.context}
      contextUpdatedAt={files.contextUpdatedAt}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[2] },
  back: { alignSelf: "flex-start", paddingHorizontal: 0 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  tabs: { gap: theme.spacing[4] },
  segmented: { alignSelf: "flex-start" },
  centered: { alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  spinner: { color: theme.colors.foregroundMuted },
}));
