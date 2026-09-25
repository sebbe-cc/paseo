import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectNote } from "@getpaseo/protocol/project-container-files";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { NoteEditor } from "./note-editor";
import { moveId } from "./order";
import { RowActions, useReportFilesError, useRowHover } from "./row-actions";

interface NotesTabProps {
  client: DaemonClient;
  containerId: string;
  notes: ProjectNote[];
}

export function NotesTab({ client, containerId, notes }: NotesTabProps): ReactElement {
  const { t } = useTranslation();
  const reportError = useReportFilesError();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = notes.find((note) => note.id === selectedId) ?? notes[0] ?? null;
  const ids = useMemo(() => notes.map((note) => note.id), [notes]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const { note } = await client.createProjectNote({
        containerId,
        title: t("projectContainers.files.notes.untitled"),
        body: "",
        index: 0,
      });
      setSelectedId(note.id);
    } catch (cause) {
      reportError(cause);
    } finally {
      setCreating(false);
    }
  }, [client, containerId, reportError, t]);
  const handleCreatePress = useCallback(() => void handleCreate(), [handleCreate]);

  const handleMove = useCallback(
    (index: number, direction: -1 | 1) => {
      const noteIds = moveId(ids, index, direction);
      if (!noteIds) return;
      client.reorderProjectNotes({ containerId, noteIds }).catch(reportError);
    },
    [client, containerId, ids, reportError],
  );
  const handleDelete = useCallback(
    async (note: ProjectNote) => {
      const confirmed = await confirmDialog({
        title: t("projectContainers.files.notes.deleteTitle", { title: note.title }),
        message: t("projectContainers.files.notes.deleteMessage"),
        confirmLabel: t("projectContainers.files.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      await client.deleteProjectNote({ containerId, noteId: note.id }).catch(reportError);
    },
    [client, containerId, reportError, t],
  );
  const handleDeleteNote = useCallback(
    (note: ProjectNote) => void handleDelete(note),
    [handleDelete],
  );

  const newButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        loading={creating}
        onPress={handleCreatePress}
        testID="project-notes-new"
      >
        {t("projectContainers.files.notes.new")}
      </Button>
    ),
    [creating, handleCreatePress, t],
  );

  return (
    <View style={styles.tab}>
      <SettingsSection
        title={t("projectContainers.files.notes.section")}
        trailing={newButton}
        testID="project-notes-section"
      >
        <View style={settingsStyles.card}>
          {notes.length === 0 ? (
            <Text style={styles.empty}>{t("projectContainers.files.notes.empty")}</Text>
          ) : (
            notes.map((note, index) => (
              <NoteRow
                key={note.id}
                note={note}
                index={index}
                count={notes.length}
                selected={note.id === selected?.id}
                onSelect={setSelectedId}
                onMove={handleMove}
              />
            ))
          )}
        </View>
      </SettingsSection>
      {selected ? (
        <NoteEditor
          key={selected.id}
          client={client}
          containerId={containerId}
          note={selected}
          onDelete={handleDeleteNote}
        />
      ) : null}
    </View>
  );
}

function NoteRow({
  note,
  index,
  count,
  selected,
  onSelect,
  onMove,
}: {
  note: ProjectNote;
  index: number;
  count: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}): ReactElement {
  const { t } = useTranslation();
  const hover = useRowHover();
  const selectState = useMemo(() => ({ selected }), [selected]);
  const handleSelect = useCallback(() => onSelect(note.id), [note.id, onSelect]);
  const handleUp = useCallback(() => onMove(index, -1), [index, onMove]);
  const handleDown = useCallback(() => onMove(index, 1), [index, onMove]);
  const pressStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.rowPress, pressed && styles.pressed],
    [],
  );
  const updated = t("projectContainers.files.notes.updated", {
    time: formatTimeAgo(new Date(note.updatedAt)),
  });
  return (
    <View
      style={[styles.row, index > 0 && settingsStyles.rowBorder, selected && styles.selected]}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      testID={`project-note-row-${note.id}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={selectState}
        onPress={handleSelect}
        style={pressStyle}
      >
        <Text style={styles.title} numberOfLines={1}>
          {note.title}
        </Text>
        <Text style={styles.updated}>{updated}</Text>
      </Pressable>
      <RowActions
        revealed={hover.revealed || selected}
        canMoveUp={index > 0}
        canMoveDown={index < count - 1}
        onMoveUp={handleUp}
        onMoveDown={handleDown}
        testID={`project-note-row-${note.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tab: { gap: theme.spacing[2] },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[3],
  },
  selected: { backgroundColor: theme.colors.surface2 },
  rowPress: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[3],
    paddingLeft: theme.spacing[4],
    gap: theme.spacing[1],
  },
  pressed: { opacity: 0.7 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  updated: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
