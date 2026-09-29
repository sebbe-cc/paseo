import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Square, SquareCheck } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  PROJECT_TODO_TEXT_MAX_LENGTH,
  type ProjectTodo,
} from "@getpaseo/protocol/project-container-files";
import { EditingTextInput } from "@/components/ui/text-input";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { RowActions, useRowHover } from "./row-actions";

const CHECK_SIZE = 18;
const ThemedSquare = withUnistyles(Square);
const ThemedSquareCheck = withUnistyles(SquareCheck);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentMapping = (theme: Theme) => ({ color: theme.colors.accent });
const openIcon = <ThemedSquare size={CHECK_SIZE} uniProps={mutedMapping} />;
const doneIcon = <ThemedSquareCheck size={CHECK_SIZE} uniProps={accentMapping} />;

export interface TodoRowHandlers {
  onToggle: (todo: ProjectTodo) => void;
  onRename: (todo: ProjectTodo, text: string) => void;
  onDelete: (todo: ProjectTodo) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}

export function TodoRow({
  todo,
  index,
  count,
  handlers,
}: {
  todo: ProjectTodo;
  index: number;
  count: number;
  handlers: TodoRowHandlers;
}): ReactElement {
  const { t } = useTranslation();
  const hover = useRowHover();
  const [editing, setEditing] = useState(false);
  const textRef = useRef(todo.text);
  const { onToggle, onRename, onDelete, onMove } = handlers;
  const checkState = useMemo(() => ({ checked: todo.done }), [todo.done]);
  const handleToggle = useCallback(() => onToggle(todo), [onToggle, todo]);
  const handleDelete = useCallback(() => onDelete(todo), [onDelete, todo]);
  const handleUp = useCallback(() => onMove(index, -1), [index, onMove]);
  const handleDown = useCallback(() => onMove(index, 1), [index, onMove]);
  const handleEdit = useCallback(() => {
    textRef.current = todo.text;
    setEditing(true);
  }, [todo.text]);
  const handleChange = useCallback((text: string) => {
    textRef.current = text;
  }, []);
  const handleCommit = useCallback(() => {
    setEditing(false);
    const text = textRef.current.trim();
    if (text.length > 0 && text !== todo.text) onRename(todo, text);
  }, [onRename, todo]);

  return (
    <View
      style={[styles.row, index > 0 && settingsStyles.rowBorder]}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      testID={`project-todo-row-${todo.id}`}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={checkState}
        accessibilityLabel={t("projectContainers.files.todos.toggle", { text: todo.text })}
        hitSlop={8}
        onPress={handleToggle}
        testID={`project-todo-toggle-${todo.id}`}
      >
        {todo.done ? doneIcon : openIcon}
      </Pressable>
      {editing ? (
        <EditingTextInput
          autoFocus
          accessibilityLabel={t("projectContainers.files.todos.edit", { text: todo.text })}
          initialValue={todo.text}
          maxLength={PROJECT_TODO_TEXT_MAX_LENGTH}
          onChangeText={handleChange}
          onSubmitEditing={handleCommit}
          onBlur={handleCommit}
          returnKeyType="done"
          style={styles.input}
          testID={`project-todo-input-${todo.id}`}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("projectContainers.files.todos.edit", { text: todo.text })}
          onPress={handleEdit}
          style={styles.textPress}
          testID={`project-todo-text-${todo.id}`}
        >
          <Text style={todo.done ? [styles.text, styles.doneText] : styles.text}>{todo.text}</Text>
        </Pressable>
      )}
      <RowActions
        revealed={hover.revealed}
        canMoveUp={index > 0}
        canMoveDown={index < count - 1}
        onMoveUp={handleUp}
        onMoveDown={handleDown}
        onDelete={handleDelete}
        testID={`project-todo-row-${todo.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    minHeight: 44,
  },
  textPress: { flex: 1, minWidth: 0, paddingVertical: theme.spacing[1] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  doneText: { color: theme.colors.foregroundMuted, textDecorationLine: "line-through" },
  input: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
  },
}));
