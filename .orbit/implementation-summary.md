---
bead: pa-9aql
branch: wf/pa-9aql-3
tests:
  - run: env -C /home/seb/repos/paseo-fork/.desvio/build-tree/plugins npx vitest run muse-provider/test/provider.test.ts
    because: covers the four muse topics (pa-0ymw.10-1, pa-0ymw.2-2, pa-0ymw.3-1, pa-ai10-2) on the published desvio tree
  - run: env -C /home/seb/repos/paseo-fork/.desvio/build-tree/packages/server npx vitest run src/utils/checkout-git.commits.test.ts src/utils/checkout-git.test.ts src/utils/worktree.posix.test.ts src/server/agent/agent-manager.test.ts src/server/session/voice/voice-session.test.ts src/server/workspace-git-fetch.test.ts
    because: covers pa-9av7.1-5, pa-8ndi-1 and pa-9av7.2-1 server files on the published desvio tree
  - run: env -C /home/seb/repos/paseo-fork/.desvio/build-tree/packages/protocol npx vitest run src/messages.workspaces.test.ts
    because: covers the pa-9av7.1-5 protocol contract on the published desvio tree
  - run: env -C /home/seb/repos/paseo-fork/.desvio/build-tree/packages/client npx vitest run src/index.test.ts
    because: covers the pa-9av7.1-5 client surface on the published desvio tree
  - run: env -C /home/seb/repos/paseo-fork/.desvio/build-tree/packages/app npx vitest run --project unit src/runtime/replica-cache/index.test.ts
    because: covers the pa-9av7.1-5 app replica cache on the published desvio tree
---

# pa-9aql: fork rollout, 7 topics — implementation summary

Base `v0.15.0` (`8938fde3c`), integration branch `desvio` at
`55697e426929a10838381039f41943ea03cccdf4` (published to
`sebbe-cc/paseo`). All seven approved topics are in as manifest lines;
no topic branch needed a conflict fix.

## Manifest diff (fleet/paseo `fork/manifest.txt`, appended at the end)

```diff
+wf/pa-0ymw.10-1                   # Muse daemon mode inside the normal Muse provider (P0; replaces the muse-join wrapper path)
+wf/pa-9av7.1-5                    # one base resolver for all views: unify workspace comparison bases, persist fork points
+wf/pa-8ndi-1                      # a plugin reload does not break voice mode / restart agents: sessions survive reload, voice reconnects
+wf/pa-0ymw.2-2                    # muse: keep configured model on resume, re-select after drift
+wf/pa-0ymw.3-1                    # muse: mirror thinking level into the host session default
+wf/pa-ai10-2                      # muse: negotiate session.subsession + project workflows as subagents (generic plugin API)
+wf/pa-9av7.2-1                    # one fetch per repo at a time, prune-safe for stored bases
```

The manifest edit itself is uncommitted in the fleet checkout on branch
`wf/pa-9aql-1` (sibling lane owns the fleet MR); desvio built from that
working-tree manifest. Every topic branch was verified to descend from
`v0.15.0`, and all seven merged with zero conflicts, so per the rollout
rule there was nothing to resolve in the topic branches (and nothing was
committed on `desvio` by hand).

## Per-topic fork-only-generic-api note

| Topic           | Why it belongs in the fork                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wf/pa-0ymw.10-1 | Generic provider capability (`PASEO_MUSE_DAEMON=1` → `muse serve --join`, shared Session code, own-host fallback). Only fleet-specific part (muse-join wrapper removal) stays fleet-side. One added comment names Orbit's hook as an env-var consumer; the contract itself is generic. |
| wf/pa-9av7.1-5  | Core comparison-base logic for all views + `docs/data-model.md` contract text. No fleet references in added lines.                                                                                                                                                                     |
| wf/pa-8ndi-1    | Core agent/voice lifecycle fix (sessions survive plugin reload). Ships one `.orbit/review/round-2/fix.md` QA record; harmless, left as is.                                                                                                                                             |
| wf/pa-0ymw.2-2  | Generic resume-model behavior in the muse provider.                                                                                                                                                                                                                                    |
| wf/pa-0ymw.3-1  | Generic thinking-level mirroring in the muse provider.                                                                                                                                                                                                                                 |
| wf/pa-ai10-2    | Generic plugin-API extension (`packages/plugin/src/server/provider.ts`) + provider subsession negotiation.                                                                                                                                                                             |
| wf/pa-9av7.2-1  | Generic fetch serialization + prune-safe stored bases.                                                                                                                                                                                                                                 |

## Gate results

- Full `desvio build` ran 12:20–13:1x CET on this manifest. `build:server`,
  typecheck and lint passed (the run progressed into `topic_tests`; desvio
  stops at the first failing stage).
- Independently re-verified every test file the seven topics touch, on the
  published tree (`55697e4`), through the test ledger (all pass):
  - `plugins/muse-provider/test/provider.test.ts`: 143 total, 141 passed,
    0 failed, 2 pre-existing skips (ledger `3e2d658b6843782d065dd21c`)
  - server (6 files): 518 total, 517 passed, 0 failed, 1 skipped (ledger
    `a42f018ab677376da14b4642`)
  - `packages/protocol/.../messages.workspaces.test.ts`: pass (ledger
    `5797ef36066ac73c5af04b7f`)
  - `packages/client/src/index.test.ts`: pass (ledger `6afdad903a57c3a6b5c34495`)
  - `packages/app/.../replica-cache/index.test.ts` (`--project unit`): pass
    (ledger `5bf0a3460e53ad20e6155a83`)
- Heavy builds/smokes run in Gradient only per the rollout rule. No
  `paseo-fork` evaluation exists yet for `55697e4` (latest: fleet main
  `cb1afbc` Completed; previous origin/desvio `75d19dd6` Failed with
  errors=1 — superseded). A manual `start_evaluation` was rejected
  ("Commit not found in repository", mirror lag); the fleet lane re-checks
  for the automatic evaluation before pinning.

## Publish

`git -C ~/repos/paseo-fork push --force origin desvio`:
`75d19dd6c` → `55697e4269`. Verified via `git ls-remote`.

## PR sebbe-cc/paseo#1

Closed with a comment pointing at the `wf/pa-0ymw.10-1` manifest line and
the desvio sha, plus the fleet MR link:
https://github.com/sebbe-cc/paseo/pull/1#issuecomment-6657773538.
Anomaly: the API later reported `merged: true` at 13:17 CET by `sebb3`,
but server state shows no merge commit on `origin/desvio` (still
`55697e4`, tree identical to the desvio build). Delivery path is the
manifest as ordered; no action taken beyond reporting this.

## Fleet side (sibling lane, for the record)

- MR: https://gitlab.sebbe.cc/fleet/paseo/-/merge_requests/533
  ("pa-0ymw.10: drop the muse-join wrapper and command override", opened,
  no conflicts) — covers the wrapper/deletion + test/doc rework. The fork
  pin bump to `55697e4` and the manifest commit ride with the sibling's
  `wf/pa-9aql-1` branch (uncommitted at handoff).
- Deploy note for the mayor: deploy regenerates `~/.paseo/config.json`
  from `configFilter`, which no longer sets
  `agents.providers.muse.command`. Keep
  `agents.providers.muse.additionalModels` (contributor effort levels).
  The `paseo-muse-daemon` systemd unit stays.
