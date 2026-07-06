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
npm run typecheck
npm test
npm run smoke
```

Start the MCP server over stdio:

```bash
npm run mcp
```
