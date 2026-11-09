import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Every worktree of a repository shares one ref store (the git common dir). Two pruning fetches
// at the same time collide on packed-refs.lock / packed-refs.new, so the fetches this process
// starts for one repository run one at a time, whichever worktree or service started them. The
// key is the canonical common dir, so a symlinked path to the same repository shares the queue.
const repoFetchTails = new Map<string, Promise<void>>();

export async function withRepoFetchLock<T>(
  gitCommonDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await canonicalRepoKey(gitCommonDir);
  const previous = repoFetchTails.get(key) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = settled(run);
  repoFetchTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (repoFetchTails.get(key) === tail) {
      repoFetchTails.delete(key);
    }
  }
}

async function settled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The caller of withRepoFetchLock sees the failure; the queue only waits for it to end.
  }
}

async function canonicalRepoKey(gitCommonDir: string): Promise<string> {
  try {
    return await realpath(gitCommonDir);
  } catch {
    return resolve(gitCommonDir);
  }
}
