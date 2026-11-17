import type { CommandCenterContribution, CommandCenterIcon } from "@/command-center/contributions";
import type { MergedProjectContainer } from "./index";

export interface ProjectContainerCommandSource {
  containers: readonly MergedProjectContainer[];
  labels: { section: string; toggle: (name: string) => string };
  icon?: CommandCenterIcon;
  toggle(containerKey: string): void;
}

/** One "Toggle project: <name>" action per sidebar project, in sidebar order. */
export function buildProjectContainerContributions(
  source: ProjectContainerCommandSource,
): CommandCenterContribution[] {
  return source.containers.map((container, index) => ({
    id: `project-container-toggle:${container.key}`,
    group: "actions",
    groupRank: 0,
    rank: 20 + index,
    keywords: ["toggle", "project", "collapse", "expand", "sidebar", container.name],
    visibility: "query",
    run: () => source.toggle(container.key),
    presentation: {
      kind: "action",
      title: source.labels.toggle(container.name),
      sectionTitle: source.labels.section,
      icon: source.icon,
    },
  }));
}
