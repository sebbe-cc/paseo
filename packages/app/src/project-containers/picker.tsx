import { useCallback, useMemo, useState, type ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import {
  isValidProjectContainerName,
  normalizeProjectContainerName,
} from "@getpaseo/protocol/project-containers";
import {
  MenuHint,
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  MenuTextField,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { assignRepository, createForRepository } from "./actions";
import {
  projectContainerErrorMessage,
  useMergedProjectContainers,
  useProjectContainers,
  type MergedProjectContainer,
} from "./index";
import { findRepositoryContainer, type LayoutRepository } from "./layout";

export const PROJECT_CONTAINER_PAGE_ID = "projectContainers";
const PROJECT_CONTAINER_CREATE_PAGE_ID = "projectContainersCreate";

const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const CREATE_LEADING = <ThemedPlus size={14} uniProps={mutedMapping} />;
const NO_PAGES: readonly MenuPageDefinition[] = [];

/** True when any host the repository lives on can hold projects right now. */
export function useCanAssignProjectContainer(repository: LayoutRepository | null): boolean {
  return useProjectContainers((state) =>
    Boolean(repository?.hosts.some((host) => state.hosts[host.serverId]?.status === "online")),
  );
}

/** The "Move to project" pages for a repository's kebab and context menus. */
export function useProjectContainerMenuPages(
  repository: LayoutRepository | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const enabled = useCanAssignProjectContainer(repository);
  return useMemo(() => {
    if (!repository || !enabled) return NO_PAGES;
    return [
      {
        id: PROJECT_CONTAINER_PAGE_ID,
        title: t("projectContainers.moveTo"),
        content: <ProjectContainerPickerPage repository={repository} />,
      },
      {
        id: PROJECT_CONTAINER_CREATE_PAGE_ID,
        title: t("projectContainers.createTitle"),
        hoverIntent: false,
        content: <ProjectContainerCreatePage repository={repository} />,
      },
    ];
  }, [enabled, repository, t]);
}

/** The "New project…" page for a menu whose root is the picker, like the settings row. */
export function useProjectContainerCreatePages(
  repository: LayoutRepository | null,
): readonly MenuPageDefinition[] {
  const pages = useProjectContainerMenuPages(repository);
  return useMemo(
    () => pages.filter((page) => page.id === PROJECT_CONTAINER_CREATE_PAGE_ID),
    [pages],
  );
}

export function ProjectContainerMenuTrigger({
  repository,
}: {
  repository: LayoutRepository;
}): ReactElement | null {
  const { t } = useTranslation();
  const enabled = useCanAssignProjectContainer(repository);
  const containers = useMergedProjectContainers();
  const current = findRepositoryContainer(repository, containers);
  if (!enabled) return null;
  return (
    <MenuSubTrigger
      id={PROJECT_CONTAINER_PAGE_ID}
      value={current?.name ?? t("projectContainers.none")}
      testID={`sidebar-project-menu-move-to-container-${repository.viewKey}`}
    >
      {t("projectContainers.moveTo")}
    </MenuSubTrigger>
  );
}

export function ProjectContainerPickerPage({
  repository,
}: {
  repository: LayoutRepository;
}): ReactElement {
  const { t } = useTranslation();
  const containers = useMergedProjectContainers();
  const current = findRepositoryContainer(repository, containers);
  const [error, setError] = useState<string | null>(null);
  const select = useCallback(
    (container: MergedProjectContainer | null) => {
      setError(null);
      void assignRepository({ repository, container }).catch((cause: unknown) =>
        setError(projectContainerErrorMessage(cause)),
      );
    },
    [repository],
  );
  const selectNone = useCallback(() => select(null), [select]);

  return (
    <>
      <MenuItem
        selected={current === null}
        onSelect={selectNone}
        testID="project-container-picker-none"
      >
        {t("projectContainers.none")}
      </MenuItem>
      {containers.map((container) => (
        <ProjectContainerPickerRow
          key={container.key}
          container={container}
          selected={current?.key === container.key}
          onSelect={select}
        />
      ))}
      <MenuSeparator />
      <MenuSubTrigger
        id={PROJECT_CONTAINER_CREATE_PAGE_ID}
        leading={CREATE_LEADING}
        testID="project-container-picker-create"
      >
        {t("projectContainers.create")}
      </MenuSubTrigger>
      {error ? <MenuHint testID="project-container-picker-error">{error}</MenuHint> : null}
    </>
  );
}

function ProjectContainerPickerRow({
  container,
  selected,
  onSelect,
}: {
  container: MergedProjectContainer;
  selected: boolean;
  onSelect: (container: MergedProjectContainer) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(container), [container, onSelect]);
  return (
    <MenuItem
      selected={selected}
      onSelect={handleSelect}
      testID={`project-container-picker-row-${container.key}`}
    >
      {container.name}
    </MenuItem>
  );
}

function ProjectContainerCreatePage({
  repository,
}: {
  repository: LayoutRepository;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("ProjectContainerCreatePage");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isValidProjectContainerName(name);

  const submit = useCallback(() => {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    createForRepository({ repository, name: normalizeProjectContainerName(name) })
      .then(() => menu.setOpen(false))
      .catch((cause: unknown) => setError(projectContainerErrorMessage(cause)))
      .finally(() => setPending(false));
  }, [menu, name, pending, repository, valid]);

  return (
    <>
      <MenuTextField
        onChangeText={setName}
        placeholder={t("projectContainers.name")}
        autoFocus
        editable={!pending}
        onSubmitEditing={submit}
        testID="project-container-picker-create-name"
      />
      <MenuSeparator />
      <MenuItem
        disabled={!valid}
        status={pending ? "pending" : "idle"}
        pendingLabel={t("projectContainers.creating")}
        closeOnSelect={false}
        onSelect={submit}
        testID="project-container-picker-create-submit"
      >
        {t("projectContainers.createConfirm")}
      </MenuItem>
      {error ? <MenuHint testID="project-container-picker-error">{error}</MenuHint> : null}
    </>
  );
}
