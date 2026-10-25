import type { PaseoApi } from "@getpaseo/client";

export async function findKing(paseo: PaseoApi): Promise<string> {
  const { entries, pageInfo } = await paseo.agents.list({
    includeBackground: true,
    filter: {
      labels: { "gc-session": "king" },
      statuses: ["initializing", "idle", "running", "error"],
      includeArchived: false,
    },
    page: { limit: 2 },
  });
  const live = entries.filter(({ agent }) => agent.status !== "closed");
  if (live.length !== 1 || pageInfo.hasMore)
    throw new Error(
      "Expected one active Gas City King. Check the King session in Gas City and try again.",
    );
  return live[0]!.agent.id;
}
