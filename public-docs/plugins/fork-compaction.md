### Fork: compaction interception

`server.addHook("agent.compact.before", async ({ request }) => ...)` receives
`agentId`, `provider`, `reason`, `source`, `usage` and `skip`. Only `skip` may
change; returning `{ ...request, skip: true }` replaces compaction. The legacy
`server.before("agent.compact", ...)` registration remains supported.
