# Spores

Spores is an MCP-first desktop recording and replay system for agents. It
records what happened on a computer, captures enough structured event data to
explain how it happened, and exposes the result through MCP tools and local
APIs.

The product is intentionally not tied to Playwright or any one automation
framework. Browser automation, native app testing, shell-driven workflows,
desktop-control agents, and human-guided recordings should all produce the
same evidence bundle shape.

## Planning Status

This repository currently contains the service architecture plan. Implementation
should follow the service boundaries in `docs/services/` rather than starting
with a single all-purpose recorder.

Start here:

- [System architecture](docs/architecture.md)
- [Service index](docs/services/README.md)

## Milestone 1

The first vertical slice is implemented as an MCP host with a fake recorder
backend. It proves the agent-facing contract and local run bundle format before
native capture is introduced.

Run the checks:

```bash
bun run typecheck
bun run test
bun run test:e2e
bun run smoke
```

Or run the full local gate:

```bash
bun run verify
```

Start the MCP server over stdio:

```bash
bun run --silent mcp
```

## Milestone 2

The next slice adds a CLI for local health and status checks while preserving
MCP as the primary agent interface.

Run local diagnostics:

```bash
bun run --silent spores -- doctor --json
bun run --silent spores -- status --json
bun run --silent spores -- targets --json
```

Launch the MCP server over clean stdio:

```bash
bun run --silent mcp
```

## Milestone 3

The next slice adds the recorder-helper launch boundary. The helper runs as a
separate stdio process and exposes deterministic health and target-listing
responses while native capture is still out of scope.

Run the helper directly:

```bash
bun run --silent recorder-helper
bun run --silent recorder-helper -- --list-targets
```

Inspect helper launch through `sporesd`:

```bash
bun run --silent spores -- doctor --json
bun run --silent spores -- targets --json
```

## Milestone 4

The recording lifecycle now runs through the recorder-helper boundary by
default. The helper writes deterministic lifecycle events, frame rows, and a
synthetic capture artifact into the run bundle. The fake recorder remains
available only when explicitly configured with `SPORES_RECORDER_BACKEND=fake`.

Run the helper-backed verification gate:

```bash
bun run verify
```

## Milestone 5

The helper now exposes a deterministic permission broker over the same stdio
boundary used for recording. Agents can inspect required and optional capture
permissions before starting, request user-action guidance, and receive
machine-readable `missing_permission` errors instead of silent degraded
recordings.

Inspect permission state:

```bash
bun run --silent spores -- permissions status --json
bun run --silent spores -- permissions request --json
```

Simulate a missing permission for tests:

```bash
SPORES_PERMISSION_SCREEN_RECORDING=missing bun run --silent spores -- permissions status --json
```
