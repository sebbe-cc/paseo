### Fork: turn context and recomposable instructions

`agent.turn_prepare.before` contributes hidden `{ context }` for the next model
request without changing the saved user prompt. Contributions accumulate in
registration order, deduplicate, and cap at 8,000 characters; errors fail open.
`agent.create.before` also exposes read-only `labels` and `initialPrompt`.
`agent.open.before` supports `initialPrompt` and instruction recomposition via
`systemPrompt` and `daemonAppendSystemPrompt` on interactive opens; history opens
must preserve instructions. Legacy `before("agent.turn_prepare", ...)` works.
