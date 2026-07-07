# Spores

Spores is an MCP-first desktop recording system for agents. It records what
happened on a computer, captures structured event data explaining the run, and
writes a local evidence bundle with timelines, frames, permissions, target
metadata, and video artifacts.

Spores is intentionally automation-framework agnostic. It can be used by
browser agents, native desktop agents, shell-driven workflows, and human-guided
test runs. Playwright is not required.

## Requirements

- Bun `1.3.12`
- macOS for native screen recording
- Screen Recording and Accessibility permissions for the terminal/app that
  launches Spores

Install dependencies:

```bash
bun install
```

Run the full local gate:

```bash
bun run verify
```

## Start The MCP Server

Agents should use Spores through MCP over stdio:

```bash
bun run --silent mcp
```

Example MCP server config:

```json
{
  "mcpServers": {
    "spores": {
      "command": "bun",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/spores"
    }
  }
}
```

Use `SPORES_RUNS_ROOT` to choose where run bundles are written:

```bash
SPORES_RUNS_ROOT=/tmp/spores-runs bun run --silent mcp
```

## Recommended Agent Flow

Check local readiness first:

```json
{
  "name": "recorder_ready",
  "arguments": {}
}
```

Resolve a target when the agent needs to inspect what will be captured:

```json
{
  "name": "recorder_target_resolve",
  "arguments": {
    "kind": "window",
    "bundleId": "com.google.Chrome",
    "titleIncludes": "Calendar"
  }
}
```

For most tasks, use a one-shot recording tool. It resolves the target, records,
stops, and returns the artifact and timeline summary in one response.

## Common Recording Calls

Record the frontmost matching Chrome window:

```json
{
  "name": "session_recording_record_window",
  "arguments": {
    "bundleId": "com.google.Chrome",
    "seconds": 5
  }
}
```

Record a window by title:

```json
{
  "name": "session_recording_record_window",
  "arguments": {
    "app": "Chrome",
    "titleIncludes": "FOX Sports",
    "seconds": 5
  }
}
```

Record an app's visible bounds:

```json
{
  "name": "session_recording_record_app",
  "arguments": {
    "bundleId": "com.google.Chrome",
    "seconds": 10
  }
}
```

Record explicit screen coordinates:

```json
{
  "name": "session_recording_record_region",
  "arguments": {
    "bounds": { "x": 0, "y": 0, "width": 1280, "height": 720 },
    "seconds": 5
  }
}
```

Record the frontmost helper-listed window:

```json
{
  "name": "session_recording_record_active_window",
  "arguments": {
    "seconds": 5
  }
}
```

## Unknown Duration Recordings

If the agent does not know the duration up front, start with a safety cap:

```json
{
  "name": "session_recording_begin",
  "arguments": {
    "target": {
      "kind": "window",
      "bundleId": "com.google.Chrome"
    },
    "safetyCapSeconds": 30
  }
}
```

Then stop when the task is done:

```json
{
  "name": "session_recording_stop",
  "arguments": {
    "runId": "run_id_from_begin"
  }
}
```

Current native capture uses macOS `screencapture`, which finalizes timed video
when the safety cap completes. `session_recording_stop` is still the right agent
API, but for native recordings it may wait for the capped artifact to finish.
True arbitrary early-stop native recording will require a different encoder
backend.

## Target Discovery

List capturable displays, apps, and windows:

```json
{
  "name": "recorder_helper_list_targets",
  "arguments": {}
}
```

Targets include screen coordinates:

```json
{
  "targetId": "window:480794",
  "kind": "window",
  "bounds": { "x": -203, "y": -1060, "width": 930, "height": 1040 },
  "zOrder": 2,
  "app": {
    "bundleId": "com.google.Chrome",
    "name": "Google Chrome"
  },
  "window": {
    "id": "480794",
    "title": "Example tab title",
    "bounds": { "x": -203, "y": -1060, "width": 930, "height": 1040 }
  }
}
```

macOS exposes windows, not browser tabs, as native capture targets. For browser
tabs, select the Chrome window by title, URL-derived title text, or bundle ID.

## Output

Each recording writes a run bundle under `SPORES_RUNS_ROOT` or the default local
run directory. A bundle contains:

- `manifest.json`: run metadata, selected target, permissions, artifact refs
- `events.ndjson`: ordered recording and agent events
- `frames.ndjson`: frame references and video-time linkage
- `artifacts/capture.mp4`: native video artifact
- `native-capture.json`: native capture backend state for recovery/debugging

Video artifacts include file path, media type, bytes, SHA-256, time range, and
redaction state. The final frame links to the video artifact ID.

## Permissions

Inspect permission state:

```bash
bun run --silent spores -- permissions status --json
```

Get user-action guidance for missing permissions:

```bash
bun run --silent spores -- permissions request --json
```

The MCP equivalents are:

```json
{ "name": "recorder_permissions_status", "arguments": {} }
```

```json
{ "name": "recorder_permissions_request", "arguments": {} }
```

For tests, permission states can be simulated:

```bash
SPORES_PERMISSION_SCREEN_RECORDING=missing bun run --silent spores -- permissions status --json
```

## CLI

The CLI is useful for local diagnostics:

```bash
bun run --silent spores -- doctor --json
bun run --silent spores -- status --json
bun run --silent spores -- targets --json
bun run --silent spores -- permissions status --json
```

Run the recorder helper directly:

```bash
bun run --silent recorder-helper
bun run --silent recorder-helper -- --list-targets
```

## Development

Run focused checks:

```bash
bun run typecheck
bun run test
bun run test:e2e
bun run smoke
```

Run everything:

```bash
bun run verify
```

Service design notes live in [`docs/services/`](docs/services/).
