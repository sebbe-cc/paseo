import type { ProjectTodo } from "@getpaseo/protocol/project-container-files";

/** Swaps `ids[index]` with its neighbour; null when the move would leave the list. */
export function moveId(ids: readonly string[], index: number, direction: -1 | 1): string[] | null {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Open todos in stored order, then done ones; done ones only when `showDone`. */
export function visibleTodos(todos: readonly ProjectTodo[], showDone: boolean): ProjectTodo[] {
  const open = todos.filter((todo) => !todo.done);
  return showDone ? [...open, ...todos.filter((todo) => todo.done)] : open;
}

/** Full todo order after moving within the visible rows; hidden todos keep trailing. */
export function reorderVisibleTodos(
  todos: readonly ProjectTodo[],
  visible: readonly ProjectTodo[],
  index: number,
  direction: -1 | 1,
): string[] | null {
  const shown = moveId(
    visible.map((todo) => todo.id),
    index,
    direction,
  );
  if (!shown) return null;
  const hidden = todos.filter((todo) => !shown.includes(todo.id)).map((todo) => todo.id);
  return [...shown, ...hidden];
}
