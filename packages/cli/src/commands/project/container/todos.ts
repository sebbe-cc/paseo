import { Command } from "commander";
import type { ProjectTodo } from "@getpaseo/protocol/project-container-files";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../../output/index.js";
import { withOutput } from "../../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../../utils/command-options.js";
import { resolveTodo, withProjectFiles, type ProjectFilesScope } from "./files-shared.js";

interface TodoLsOptions extends CommandOptions {
  all?: boolean;
}

function todoSchema(todos: ProjectTodo[]): OutputSchema<ProjectTodo> {
  return {
    idField: "id",
    columns: [
      { header: "#", field: (todo) => todos.indexOf(todo) + 1, width: 4 },
      { header: "ID", field: "id", width: 18 },
      { header: "DONE", field: (todo) => (todo.done ? "x" : ""), width: 5 },
      { header: "TEXT", field: "text", width: 70 },
    ],
  };
}

function list(todos: ProjectTodo[], all = true): ListResult<ProjectTodo> {
  return {
    type: "list",
    data: all ? todos : todos.filter((todo) => !todo.done),
    schema: todoSchema(todos),
  };
}

function single(todo: ProjectTodo): SingleResult<ProjectTodo> {
  return { type: "single", data: todo, schema: todoSchema([todo]) };
}

export function runTodoLs(ref: string, options: TodoLsOptions, _command?: Command) {
  return withProjectFiles(options, ref, async ({ files }) =>
    list(files.todos, options.all === true),
  );
}

export function runTodoAdd(
  ref: string,
  text: string[],
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container }) => {
    const { todo } = await client.createProjectTodo({
      containerId: container.id,
      text: text.join(" "),
    });
    return single(todo);
  });
}

function setDone(done: boolean) {
  return (ref: string, todoRef: string, options: CommandOptions, _command?: Command) =>
    withProjectFiles(options, ref, async ({ client, container, files }) => {
      const { todo } = await client.updateProjectTodo({
        containerId: container.id,
        todoId: resolveTodo(files, todoRef).id,
        done,
      });
      return single(todo);
    });
}

export const runTodoDone = setDone(true);
export const runTodoUndone = setDone(false);

export function runTodoUpdate(
  ref: string,
  todoRef: string,
  text: string[],
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container, files }) => {
    const current = resolveTodo(files, todoRef);
    const { todo } = await client.updateProjectTodo({
      containerId: container.id,
      todoId: current.id,
      text: text.join(" "),
      expectedUpdatedAt: current.updatedAt,
    });
    return single(todo);
  });
}

export function runTodoDelete(
  ref: string,
  todoRef: string,
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container, files }) => {
    const todo = resolveTodo(files, todoRef);
    await client.deleteProjectTodo({ containerId: container.id, todoId: todo.id });
    return single(todo);
  });
}

/** Moves the named todos to the top in the given order; the rest keep their relative order. */
export function runTodoOrder(
  ref: string,
  todoRefs: string[],
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async (scope: ProjectFilesScope) => {
    const { client, container, files } = scope;
    const first = [...new Set(todoRefs.map((todoRef) => resolveTodo(files, todoRef).id))];
    if (first.length === 0) {
      throw { code: "MISSING_TODOS", message: "Name at least one todo" } satisfies CommandError;
    }
    const rest = files.todos.map((todo) => todo.id).filter((id) => !first.includes(id));
    await client.reorderProjectTodos({ containerId: container.id, todoIds: [...first, ...rest] });
    const next = await client.getProjectContainerFiles({ containerId: container.id });
    return list(next.todos);
  });
}

const PROJECT_ARG = ["<project>", "Project id or name"] as const;
const TODO_ARG = ["<todo>", "Todo id or # from `todo ls`"] as const;

export function createProjectTodoCommand(): Command {
  const todo = new Command("todo").description("Read and write a project's shared checklist");
  const add = addJsonAndDaemonHostOptions;
  add(
    todo
      .command("ls")
      .description("List open todos in order")
      .argument(...PROJECT_ARG)
      .option("-a, --all", "Include done todos"),
  ).action(withOutput(runTodoLs));
  add(
    todo
      .command("add")
      .description("Add a todo at the end")
      .argument(...PROJECT_ARG)
      .argument("<text...>", "Todo text"),
  ).action(withOutput(runTodoAdd));
  add(
    todo
      .command("done")
      .description("Mark done")
      .argument(...PROJECT_ARG)
      .argument(...TODO_ARG),
  ).action(withOutput(runTodoDone));
  add(
    todo
      .command("undone")
      .description("Mark not done")
      .argument(...PROJECT_ARG)
      .argument(...TODO_ARG),
  ).action(withOutput(runTodoUndone));
  add(
    todo
      .command("update")
      .description("Replace a todo's text")
      .argument(...PROJECT_ARG)
      .argument(...TODO_ARG)
      .argument("<text...>", "New text"),
  ).action(withOutput(runTodoUpdate));
  add(
    todo
      .command("delete")
      .description("Delete a todo")
      .argument(...PROJECT_ARG)
      .argument(...TODO_ARG),
  ).action(withOutput(runTodoDelete));
  add(
    todo
      .command("order")
      .description("Put todos first, in this order")
      .argument(...PROJECT_ARG)
      .argument("<todo...>", "Todo ids or positions"),
  ).action(withOutput(runTodoOrder));
  return todo;
}
