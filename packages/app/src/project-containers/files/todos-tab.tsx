import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PROJECT_TODO_TEXT_MAX_LENGTH,
  type ProjectTodo,
} from "@getpaseo/protocol/project-container-files";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { reorderVisibleTodos, visibleTodos } from "./order";
import { useReportFilesError } from "./row-actions";
import { TodoRow, type TodoRowHandlers } from "./todo-row";

const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TodosTabProps {
  client: DaemonClient;
  containerId: string;
  todos: ProjectTodo[];
}

export function TodosTab({ client, containerId, todos }: TodosTabProps): ReactElement {
  const { t } = useTranslation();
  const reportError = useReportFilesError();
  const [showDone, setShowDone] = useState(false);
  const visible = useMemo(() => visibleTodos(todos, showDone), [showDone, todos]);
  const addRef = useRef<EditingTextInputHandle>(null);

  const handleAdd = useCallback(() => {
    const text = addRef.current?.getText().trim() ?? "";
    if (!text) return;
    addRef.current?.reset();
    client.createProjectTodo({ containerId, text }).catch(reportError);
  }, [client, containerId, reportError]);

  // Moves within what is shown; hidden done todos keep their place after the open ones.
  const handleMove = useCallback(
    (index: number, direction: -1 | 1) => {
      const todoIds = reorderVisibleTodos(todos, visible, index, direction);
      if (!todoIds) return;
      client.reorderProjectTodos({ containerId, todoIds }).catch(reportError);
    },
    [client, containerId, reportError, todos, visible],
  );
  const handlers = useMemo<TodoRowHandlers>(
    () => ({
      onToggle: (todo) => {
        client
          .updateProjectTodo({ containerId, todoId: todo.id, done: !todo.done })
          .catch(reportError);
      },
      onRename: (todo, text) => {
        client
          .updateProjectTodo({
            containerId,
            todoId: todo.id,
            text,
            expectedUpdatedAt: todo.updatedAt,
          })
          .catch(reportError);
      },
      onDelete: (todo) => {
        client.deleteProjectTodo({ containerId, todoId: todo.id }).catch(reportError);
      },
      onMove: handleMove,
    }),
    [client, containerId, handleMove, reportError],
  );

  const doneCount = todos.length - todos.filter((todo) => !todo.done).length;
  const showDoneToggle = useMemo(
    () => (
      <View style={styles.toggle}>
        <Text style={styles.toggleLabel}>
          {t("projectContainers.files.todos.showDone")} ({doneCount})
        </Text>
        <Switch
          value={showDone}
          onValueChange={setShowDone}
          accessibilityLabel={t("projectContainers.files.todos.showDone")}
          testID="project-todos-show-done"
        />
      </View>
    ),
    [doneCount, showDone, t],
  );

  return (
    <SettingsSection
      title={t("projectContainers.files.todos.section")}
      trailing={showDoneToggle}
      testID="project-todos-section"
    >
      <View style={settingsStyles.card}>
        {visible.length === 0 ? (
          <Text style={styles.empty}>{t("projectContainers.files.todos.empty")}</Text>
        ) : (
          visible.map((todo, index) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              index={index}
              count={visible.length}
              handlers={handlers}
            />
          ))
        )}
        <View style={[styles.addRow, settingsStyles.rowBorder]}>
          <ThemedPlus size={18} uniProps={mutedMapping} />
          <EditingTextInput
            ref={addRef}
            accessibilityLabel={t("projectContainers.files.todos.add")}
            placeholder={t("projectContainers.files.todos.add")}
            placeholderTextColor={styles.placeholder.color}
            maxLength={PROJECT_TODO_TEXT_MAX_LENGTH}
            onSubmitEditing={handleAdd}
            submitBehavior="submit"
            returnKeyType="done"
            style={styles.addInput}
            testID="project-todo-add-input"
          />
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  toggle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  toggleLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    minHeight: 44,
  },
  addInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
  },
  placeholder: { color: theme.colors.foregroundMuted },
}));
