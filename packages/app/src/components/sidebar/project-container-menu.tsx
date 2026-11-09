import { useCallback, type ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react-native";
import {
  isValidProjectContainerName,
  normalizeProjectContainerName,
  PROJECT_CONTAINER_NAME_MAX_LENGTH,
} from "@getpaseo/protocol/project-containers";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-context";
import { deleteContainer, moveContainer, renameContainer } from "@/project-containers/actions";
import { projectContainerErrorMessage, type MergedProjectContainer } from "@/project-containers";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPencil = withUnistyles(Pencil);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedTrash2 = withUnistyles(Trash2);
const renameIcon = <ThemedPencil size={14} uniProps={mutedMapping} />;
const moveUpIcon = <ThemedArrowUp size={14} uniProps={mutedMapping} />;
const moveDownIcon = <ThemedArrowDown size={14} uniProps={mutedMapping} />;
const deleteIcon = <ThemedTrash2 size={14} uniProps={mutedMapping} />;

export function ProjectContainerMenuItems({
  container,
  containers,
  onRename,
}: {
  container: MergedProjectContainer;
  containers: readonly MergedProjectContainer[];
  onRename: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const index = containers.findIndex((candidate) => candidate.key === container.key);
  const reportError = useCallback(
    (cause: unknown) => toast.error(projectContainerErrorMessage(cause)),
    [toast],
  );
  const move = useCallback(
    (direction: -1 | 1) => {
      void moveContainer({ containers, key: container.key, direction }).catch(reportError);
    },
    [container.key, containers, reportError],
  );
  const handleMoveUp = useCallback(() => move(-1), [move]);
  const handleMoveDown = useCallback(() => move(1), [move]);
  const handleDelete = useCallback(() => {
    void confirmDialog({
      title: t("projectContainers.menu.deleteTitle", { name: container.name }),
      message: t("projectContainers.menu.deleteMessage"),
      confirmLabel: t("projectContainers.menu.delete"),
      destructive: true,
    })
      .then((confirmed) => (confirmed ? deleteContainer(container) : undefined))
      .catch(reportError);
  }, [container, reportError, t]);

  const testID = `sidebar-project-container-menu-${container.key}`;
  return (
    <>
      <ContextMenuItem leading={renameIcon} onSelect={onRename} testID={`${testID}-rename`}>
        {t("projectContainers.menu.rename")}
      </ContextMenuItem>
      <ContextMenuItem
        leading={moveUpIcon}
        disabled={index <= 0}
        onSelect={handleMoveUp}
        testID={`${testID}-move-up`}
      >
        {t("projectContainers.menu.moveUp")}
      </ContextMenuItem>
      <ContextMenuItem
        leading={moveDownIcon}
        disabled={index < 0 || index >= containers.length - 1}
        onSelect={handleMoveDown}
        testID={`${testID}-move-down`}
      >
        {t("projectContainers.menu.moveDown")}
      </ContextMenuItem>
      <ContextMenuItem
        leading={deleteIcon}
        destructive
        onSelect={handleDelete}
        testID={`${testID}-delete`}
      >
        {t("projectContainers.menu.delete")}
      </ContextMenuItem>
    </>
  );
}

export function ProjectContainerRenameModal({
  container,
  visible,
  onClose,
}: {
  container: MergedProjectContainer;
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const validate = useCallback(
    (value: string) =>
      isValidProjectContainerName(value) ? null : t("projectContainers.nameInvalid"),
    [t],
  );
  const handleSubmit = useCallback(
    async (value: string) => {
      const name = normalizeProjectContainerName(value);
      if (name === container.name) return;
      try {
        await renameContainer(container, name);
      } catch (cause) {
        throw new Error(projectContainerErrorMessage(cause), { cause });
      }
    },
    [container],
  );
  return (
    <AdaptiveRenameModal
      visible={visible}
      title={t("projectContainers.menu.renameTitle")}
      initialValue={container.name}
      placeholder={t("projectContainers.name")}
      maxLength={PROJECT_CONTAINER_NAME_MAX_LENGTH}
      validate={validate}
      onClose={onClose}
      onSubmit={handleSubmit}
      testID={`sidebar-project-container-rename-${container.key}`}
    />
  );
}
