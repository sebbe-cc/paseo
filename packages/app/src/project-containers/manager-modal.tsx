import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  isValidProjectContainerName,
  normalizeProjectContainerName,
  PROJECT_CONTAINER_NAME_MAX_LENGTH,
  type ProjectContainer,
} from "@getpaseo/protocol/project-containers";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  projectContainerErrorMessage,
  projectContainers,
  useProjectContainerHost,
  type ProjectContainerHostSnapshot,
} from "./index";
import { ProjectContainerManagerRow } from "./manager-row";

type Draft = { mode: "create" } | { mode: "edit"; container: ProjectContainer };

const hostOptionTestID = (serverId: string) => `project-container-manager-host-${serverId}`;

// One host's catalog at a time, like the label manager: each daemon owns its own projects,
// and the sidebar merges same-name projects across hosts.
export function ProjectContainerManagerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const isCompact = useIsCompactFormFactor();
  const [serverId, setServerId] = useState(() => hosts[0]?.serverId ?? "");
  const host = useProjectContainerHost(serverId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setDraft(null);
      setError(null);
      return;
    }
    if (!hosts.some((candidate) => candidate.serverId === serverId)) {
      setServerId(hosts[0]?.serverId ?? "");
    }
  }, [hosts, serverId, visible]);

  const online = host?.status === "online";
  const disabled = !online || pending;
  const valid = isValidProjectContainerName(name);
  const dirty =
    draft?.mode === "create" || normalizeProjectContainerName(name) !== draftName(draft);

  const startCreate = useCallback(() => {
    setDraft({ mode: "create" });
    setName("");
    setError(null);
  }, []);
  const startEdit = useCallback((container: ProjectContainer) => {
    setDraft({ mode: "edit", container });
    setName(container.name);
    setError(null);
  }, []);
  const cancel = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      setDraft(null);
    } catch (cause) {
      setError(projectContainerErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }, []);
  const save = useCallback(() => {
    if (!draft || pending) return;
    if (!isValidProjectContainerName(name)) {
      setError(t("projectContainers.nameInvalid"));
      return;
    }
    const normalized = normalizeProjectContainerName(name);
    void run(() =>
      draft.mode === "create"
        ? projectContainers.create({ serverId, name: normalized })
        : projectContainers.rename({ serverId, containerId: draft.container.id, name: normalized }),
    );
  }, [draft, name, pending, run, serverId, t]);
  const remove = useCallback(() => {
    if (draft?.mode !== "edit") return;
    const { container } = draft;
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("projectContainers.menu.deleteTitle", { name: container.name }),
        message: t("projectContainers.menu.deleteMessage"),
        confirmLabel: t("projectContainers.menu.delete"),
        destructive: true,
      });
      if (confirmed)
        await run(() => projectContainers.delete({ serverId, containerId: container.id }));
    })();
  }, [draft, run, serverId, t]);

  const header = useMemo<SheetHeader>(() => {
    if (!draft) return { title: t("projectContainers.manage.title") };
    const title =
      draft.mode === "create"
        ? t("projectContainers.createTitle")
        : t("projectContainers.manage.edit");
    return { title, back: { onPress: cancel } };
  }, [cancel, draft, t]);

  const footer = useMemo(() => {
    if (!draft) {
      return (
        <View style={styles.footerEnd}>
          <Button
            size="md"
            disabled={!online}
            onPress={startCreate}
            testID="project-container-manager-create"
          >
            {t("projectContainers.create")}
          </Button>
        </View>
      );
    }
    return (
      <View style={styles.footer}>
        {draft.mode === "edit" ? (
          <Button
            // Red belongs to the confirm dialog, not to the surface that opens it — docs/design.md.
            variant="outline"
            size="md"
            disabled={disabled}
            onPress={remove}
            testID="project-container-manager-delete"
          >
            {t("projectContainers.menu.delete")}
          </Button>
        ) : (
          <View />
        )}
        <Button
          size="md"
          style={styles.saveButton}
          disabled={disabled || !valid || !dirty}
          loading={pending}
          onPress={save}
          testID="project-container-manager-save"
        >
          {draft.mode === "create"
            ? t("projectContainers.createConfirm")
            : t("projectContainers.manage.save")}
        </Button>
      </View>
    );
  }, [dirty, disabled, draft, online, pending, remove, save, startCreate, t, valid]);

  const errorText = error ?? host?.error ?? null;
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      sizeContentToCurrentSnapPoint
      testID="project-container-manager"
    >
      {draft ? (
        <Field label={t("projectContainers.name")}>
          <FormTextInput
            size={isCompact ? "md" : "sm"}
            initialValue={draftName(draft)}
            resetKey={draft.mode === "edit" ? draft.container.id : "create"}
            onChangeText={setName}
            onSubmitEditing={save}
            editable={!disabled}
            maxLength={PROJECT_CONTAINER_NAME_MAX_LENGTH}
            autoFocus
            autoCorrect={false}
            accessibilityLabel={t("projectContainers.name")}
            testID="project-container-manager-name"
          />
        </Field>
      ) : (
        <>
          {hosts.length > 1 ? (
            <HostFilter
              hosts={hosts}
              selectedHost={serverId}
              onSelectHost={setServerId}
              includeAllHost={false}
              triggerTestID="project-container-manager-host"
              hostOptionTestID={hostOptionTestID}
            />
          ) : null}
          <ProjectContainerManagerList host={host} disabled={disabled} onEdit={startEdit} />
        </>
      )}
      {errorText ? (
        <Text style={styles.error} testID="project-container-manager-error">
          {errorText}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function ProjectContainerManagerList({
  host,
  disabled,
  onEdit,
}: {
  host: ProjectContainerHostSnapshot | undefined;
  disabled: boolean;
  onEdit: (container: ProjectContainer) => void;
}): ReactElement {
  const { t } = useTranslation();
  const containers = host?.containers ?? [];
  return (
    <>
      <View style={styles.list}>
        {containers.map((container) => (
          <ProjectContainerManagerRow
            key={container.id}
            container={container}
            disabled={disabled}
            onEdit={onEdit}
          />
        ))}
        {host?.status === "online" && containers.length === 0 ? (
          <Text style={styles.muted}>{t("projectContainers.manage.empty")}</Text>
        ) : null}
      </View>
      {!host || host.status === "offline" ? (
        <Text style={styles.muted}>{t("projectContainers.offline")}</Text>
      ) : null}
      {host?.status === "unsupported" ? (
        <Text style={styles.muted}>{t("projectContainers.updateHost")}</Text>
      ) : null}
    </>
  );
}

function draftName(draft: Draft | null): string {
  return draft?.mode === "edit" ? draft.container.name : "";
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[1] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  footerEnd: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  saveButton: { minWidth: 112 },
}));
