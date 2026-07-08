# Spores

Spores is an MCP-first desktop recording system for agents.

Run setup checks without cloning the repository:

```bash
npx @ajkraus04/spores setup --json
bunx @ajkraus04/spores setup --json
```

Start the MCP server over stdio:

```bash
npx --yes @ajkraus04/spores mcp
bunx @ajkraus04/spores mcp
```

Use `SPORES_RUNS_ROOT` to choose where local run bundles are written.
