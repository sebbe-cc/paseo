// Fork-only English strings, merged into every locale at startup by `apply.ts`. Upstream's
// `resources/*` stay untouched so their key-parity tests keep gating upstream strings only.
export const forkEn = {
  groups: {
    projectContainers: {
      title: "Projects",
      headerLabel_one: "{{name}} project, {{count}} repository",
      headerLabel_other: "{{name}} project, {{count}} repositories",
      empty: "No repositories",
      none: "None",
      name: "Project name",
      nameInvalid: "Project name must be 1-64 characters",
      create: "New project…",
      createTitle: "New project",
      createConfirm: "Create",
      creating: "Creating…",
      moveTo: "Move to project",
      updateHost: "Update this host to use projects",
      offline: "This host is offline",
      errors: {
        load: "Unable to load projects",
        update: "Unable to update project",
      },
      menu: {
        title: "Project actions",
        rename: "Rename",
        renameTitle: "Rename project",
        moveUp: "Move up",
        moveDown: "Move down",
        delete: "Delete",
        deleteTitle: "Delete {{name}}?",
        deleteMessage: "Its repositories stay in the sidebar, outside any project.",
      },
      manage: {
        open: "Projects…",
        title: "Projects",
        empty: "No projects yet. Create one to group repositories in the sidebar.",
        count_one: "{{count}} repository",
        count_other: "{{count}} repositories",
        edit: "Edit project",
        editLabel: "Edit {{name}}",
        save: "Save",
      },
      settings: {
        section: "Sidebar",
        title: "Project",
        description: "Group this repository with others in the sidebar",
      },
      commandCenter: {
        toggle: "Toggle project: {{name}}",
      },
    },
  },
  /** Upstream dotted keys whose English value the fork replaces; keys themselves never change. */
  overrides: {} as Record<string, string>,
};

export type ForkResourceGroups = typeof forkEn.groups;
