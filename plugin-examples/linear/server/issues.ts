import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { searchIssuesRpc } from "../shared/issues";
import { createLinearIssueSearch } from "./linear";

export async function searchIssues({
  query,
}: RpcInput<typeof searchIssuesRpc>): Promise<RpcOutput<typeof searchIssuesRpc>> {
  const linear = createLinearIssueSearch({ apiKey: process.env.LINEAR_API_KEY ?? "" });
  return linear.search(query);
}
