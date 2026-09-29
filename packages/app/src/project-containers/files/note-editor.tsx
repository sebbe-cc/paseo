import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PROJECT_NOTE_TITLE_MAX_LENGTH,
  type ProjectNote,
} from "@getpaseo/protocol/project-container-files";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { settingsStyles } from "@/styles/settings";
import { useToast } from "@/contexts/toast-context";
import { useReportFilesError } from "./row-actions";

interface Draft {
  title: string;
  body: string;
}

// Edits one note against the version it was opened at. A change from elsewhere replaces an
// untouched draft; over local edits it shows a reload prompt and Save fails with a conflict.
export function NoteEditor({
  client,
  containerId,
  note,
  onDelete,
}: {
  client: DaemonClient;
  containerId: string;
  note: ProjectNote;
  onDelete: (note: ProjectNote) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const reportError = useReportFilesError();
  const [base, setBase] = useState(note);
  const [draft, setDraft] = useState<Draft>({ title: note.title, body: note.body });
  const [inputKey, setInputKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const dirty = draft.title !== base.title || draft.body !== base.body;
  const reset = useCallback((next: ProjectNote) => {
    setBase(next);
    setDraft({ title: next.title, body: next.body });
    setInputKey((key) => key + 1);
  }, []);
  if (!saving && !dirty && note.updatedAt !== base.updatedAt) reset(note);
  const stale = !saving && dirty && note.updatedAt !== base.updatedAt;

  const handleTitle = useCallback((title: string) => setDraft((d) => ({ ...d, title })), []);
  const handleBody = useCallback((body: string) => setDraft((d) => ({ ...d, body })), []);
  const handleReload = useCallback(() => reset(note), [note, reset]);
  const handleDelete = useCallback(() => onDelete(base), [base, onDelete]);
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const { note: saved } = await client.updateProjectNote({
        containerId,
        noteId: base.id,
        title: draft.title,
        body: draft.body,
        expectedUpdatedAt: base.updatedAt,
      });
      if (saved.title === draft.title && saved.body === draft.body) setBase(saved);
      else reset(saved);
      toast.show(t("projectContainers.files.saved"), { variant: "success" });
    } catch (cause) {
      reportError(cause);
    } finally {
      setSaving(false);
    }
  }, [base, client, containerId, draft, reportError, reset, t, toast]);
  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);

  return (
    <View style={styles.editor} testID="project-note-editor">
      {stale ? (
        <Alert
          variant="warning"
          title={t("projectContainers.files.changedElsewhere")}
          testID="project-note-stale"
        >
          <Button variant="outline" size="sm" onPress={handleReload} testID="project-note-reload">
            {t("projectContainers.files.reload")}
          </Button>
        </Alert>
      ) : null}
      <View style={settingsStyles.card}>
        <EditingTextInput
          key={`title-${inputKey}`}
          accessibilityLabel={t("projectContainers.files.notes.title")}
          initialValue={draft.title}
          onChangeText={handleTitle}
          maxLength={PROJECT_NOTE_TITLE_MAX_LENGTH}
          placeholder={t("projectContainers.files.notes.title")}
          placeholderTextColor={styles.placeholder.color}
          style={styles.titleInput}
          testID="project-note-title-input"
        />
      </View>
      <SettingsTextAreaCard
        key={`body-${inputKey}`}
        accessibilityLabel={t("projectContainers.files.notes.body")}
        value={draft.body}
        onChangeText={handleBody}
        placeholder={t("projectContainers.files.notes.bodyPlaceholder")}
        style={styles.bodyInput}
        testID="project-note-body-input"
      />
      <View style={styles.buttons}>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleDelete}
          testID="project-note-delete"
          textStyle={styles.destructiveText}
        >
          {t("projectContainers.files.delete")}
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={!dirty || draft.title.trim().length === 0}
          loading={saving}
          onPress={handleSavePress}
          testID="project-note-save"
        >
          {t("projectContainers.files.save")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  editor: { gap: theme.spacing[3] },
  titleInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  bodyInput: { minHeight: 280 },
  placeholder: { color: theme.colors.foregroundMuted },
  buttons: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  destructiveText: { color: theme.colors.destructive },
}));
