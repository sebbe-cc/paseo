import { Command } from "commander";
import type { CommandOptions, ListResult, SingleResult } from "../../../output/index.js";
import { withOutput } from "../../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../../utils/command-options.js";
import { createProjectContextCommand, createProjectNoteCommand } from "./notes.js";
import {
  containerSchema,
  loadCatalog,
  resolveContainer,
  resolveRepository,
  toContainerRow,
  withContainerClient,
  type ContainerRow,
} from "./shared.js";
import { createProjectTodoCommand } from "./todos.js";

type Single = Promise<SingleResult<ContainerRow>>;
type List = Promise<ListResult<ContainerRow>>;

export function runContainerLs(options: CommandOptions, _command?: Command): List {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    return {
      type: "list",
      data: catalog.containers.map((container) => toContainerRow(catalog, container)),
      schema: containerSchema,
    };
  });
}

export function runContainerCreate(
  name: string,
  options: CommandOptions,
  _command?: Command,
): Single {
  return withContainerClient(options, async (client) => {
    const { container } = await client.createProjectContainer({ name });
    return single(toContainerRow(await loadCatalog(client), container));
  });
}

export function runContainerRename(
  ref: string,
  name: string,
  options: CommandOptions,
  _command?: Command,
): Single {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    const { container } = await client.renameProjectContainer({
      containerId: resolveContainer(catalog, ref).id,
      name,
    });
    return single(toContainerRow(catalog, container));
  });
}

export function runContainerDelete(
  ref: string,
  options: CommandOptions,
  _command?: Command,
): Single {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    const container = resolveContainer(catalog, ref);
    await client.deleteProjectContainer({ containerId: container.id });
    return single(toContainerRow(catalog, container));
  });
}

export function runContainerAdd(
  ref: string,
  repositories: string[],
  options: CommandOptions,
  _command?: Command,
): Single {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    const container = resolveContainer(catalog, ref);
    await client.assignProjectContainer({
      projectIds: repositories.map((repository) => resolveRepository(catalog, repository)),
      containerId: container.id,
    });
    const next = await loadCatalog(client);
    return single(toContainerRow(next, resolveContainer(next, container.id)));
  });
}

export function runContainerRemove(
  repositories: string[],
  options: CommandOptions,
  _command?: Command,
): List {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    await client.assignProjectContainer({
      projectIds: repositories.map((repository) => resolveRepository(catalog, repository)),
      containerId: null,
    });
    const next = await loadCatalog(client);
    return {
      type: "list",
      data: next.containers.map((container) => toContainerRow(next, container)),
      schema: containerSchema,
    };
  });
}

/** Moves the named projects to the top in the given order; unnamed ones keep their relative order. */
export function runContainerOrder(
  refs: string[],
  options: CommandOptions,
  _command?: Command,
): List {
  return withContainerClient(options, async (client) => {
    const catalog = await loadCatalog(client);
    const first = [...new Set(refs.map((ref) => resolveContainer(catalog, ref).id))];
    const rest = catalog.containers.map((c) => c.id).filter((id) => !first.includes(id));
    await client.reorderProjectContainers({ containerIds: [...first, ...rest] });
    const next = await loadCatalog(client);
    return {
      type: "list",
      data: next.containers.map((container) => toContainerRow(next, container)),
      schema: containerSchema,
    };
  });
}

function single(row: ContainerRow): SingleResult<ContainerRow> {
  return { type: "single", data: row, schema: containerSchema };
}

export function createProjectContainerCommand(): Command {
  const container = new Command("container").description(
    "Manage projects: named groups of repositories shown as folders in the sidebar",
  );
  const add = addJsonAndDaemonHostOptions;
  add(container.command("ls").description("List projects and their repositories")).action(
    withOutput(runContainerLs),
  );
  add(
    container.command("create").description("Create a project").argument("<name>", "Project name"),
  ).action(withOutput(runContainerCreate));
  add(
    container
      .command("rename")
      .description("Rename a project")
      .argument("<project>", "Project id or name")
      .argument("<name>", "New name"),
  ).action(withOutput(runContainerRename));
  add(
    container
      .command("delete")
      .description("Delete a project; its repositories become ungrouped")
      .argument("<project>", "Project id or name"),
  ).action(withOutput(runContainerDelete));
  add(
    container
      .command("add")
      .description("Move repositories into a project")
      .argument("<project>", "Project id or name")
      .argument("<repository...>", "Repository ids or names"),
  ).action(withOutput(runContainerAdd));
  add(
    container
      .command("remove")
      .description("Take repositories out of their project")
      .argument("<repository...>", "Repository ids or names"),
  ).action(withOutput(runContainerRemove));
  add(
    container
      .command("order")
      .description("Put projects first, in this order")
      .argument("<project...>", "Project ids or names"),
  ).action(withOutput(runContainerOrder));
  container.addCommand(createProjectNoteCommand());
  container.addCommand(createProjectTodoCommand());
  container.addCommand(createProjectContextCommand());
  return container;
}
