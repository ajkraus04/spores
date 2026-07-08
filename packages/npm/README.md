# Spores

Spores is an MCP-first desktop recording system for agents.

Run setup checks without cloning the repository:

```bash
npx spores setup --json
bunx spores setup --json
```

Start the MCP server over stdio:

```bash
npx --yes spores mcp
bunx spores mcp
```

Use `SPORES_RUNS_ROOT` to choose where local run bundles are written.
