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

Native recordings return a composed `artifacts/capture.mp4` as the primary
agent-facing artifact. The unmodified screen recording is retained separately as
`artifacts/source-capture.mp4` when native capture is used.

Bundled recording background:

```text
assets/recording-backgrounds/hypha-dark.png
assets/recording-backgrounds/manifest.json
```
