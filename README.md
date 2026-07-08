# Spores

Spores is an MCP-first desktop recording system for agents. It records what
happened on a computer, captures structured event data explaining the run, and
writes a local evidence bundle with timelines, frames, permissions, target
metadata, and video artifacts.

Spores is intentionally automation-framework agnostic. It can be used by
browser agents, native desktop agents, shell-driven workflows, and human-guided
test runs. Playwright is not required.

## Agent Readiness Roadmap

The Spores 15-agent readiness pass is captured as 15 implementation tracks.
Items marked current are available in this checkout. Items marked planned are
design targets and should not be treated as implemented behavior.

1. Current: MCP-first startup through `bun run --silent mcp`, with
   `spores_doctor`, `mcp:doctor`, and explicit tool discovery guidance.
2. Current: local readiness checks through `recorder_ready`, including native
   permission probes, timing limits, target counts, and recommended tools.
3. Current: capturable target discovery through `recorder_context_snapshot` and
   helper-listed displays, apps, windows, and screen bounds.
4. Current: agent-safe target selection through `recorder_target_select`,
   confidence scoring, ambiguity handling, alternatives, and snapshot-bound
   validation.
5. Current: one-shot recording through `session_recording_capture`, which
   selects, records, stops, verifies artifacts, and returns a bounded result.
6. Current: compatibility recording tools for target, window, app, region, and
   active-window captures, all using bounded `seconds` input.
7. Current: unknown-duration recording through `session_recording_begin` with a
   bounded `safetyCapSeconds`, followed by `session_recording_stop`.
8. Current: native macOS MP4 capture to `artifacts/capture.mp4`, with artifact
   metadata for media type, bytes, SHA-256, time range, and redaction state.
9. Current: recoverable local run bundles with `manifest.json`, `events.ndjson`,
   `frames.ndjson`, artifacts, and `native-capture.json` for native sessions.
10. Current: agent-authored event annotations through
    `session_recording_append_agent_step` and queryable timelines through
    `session_recording_query_timeline`.
11. Current: bounded artifact reads through `session_recording_read_artifact`,
    with metadata-first access for large video artifacts.
12. Planned: a durable SQLite artifact/indexer layer for fast local search,
    rebuilt indexes, retention decisions, and corruption reporting.
13. Planned: redacted exports, share bundles, single-step clips, and
    agent-readable JSON manifests produced from the local run bundle.
14. Planned: replay-plan and reusable-skill drafting from event streams, with
    stable integration recommendations instead of raw pointer replay.
15. Planned: richer review and cross-platform workflows, including a review
    viewer, better approval controls, app exclusion policy, and future Windows
    and Linux helpers.

## Requirements

- Bun `1.3.12`
- macOS for native screen recording
- Screen Recording and Accessibility permissions for the terminal/app that
  launches Spores

## Run Without Cloning

Use the installable package when an agent or MCP client should start Spores
without a local checkout:

```bash
npx spores setup --json
bunx spores setup --json
```

Start the MCP server from the package:

```bash
npx --yes spores mcp
bunx spores mcp
```

Recommended MCP server config using `npx`:

```json
{
  "mcpServers": {
    "spores": {
      "command": "npx",
      "args": ["--yes", "spores", "mcp"]
    }
  }
}
```

Equivalent config using `bunx`:

```json
{
  "mcpServers": {
    "spores": {
      "command": "bunx",
      "args": ["spores", "mcp"]
    }
  }
}
```

Use `SPORES_RUNS_ROOT` in the MCP config `env` field to choose where local run
bundles are written.

For package release validation from this checkout:

```bash
bun run build:npm
bun run pack:npm
```

The published package exposes these executables:

```text
spores
sporesd
spores-recorder-helper
```

`npx spores@setup` is not the intended interface. That would require a mutable
npm dist-tag named `setup`; use the stable `spores setup` subcommand instead.

## Source Checkout

Install dependencies:

```bash
bun install
```

Run the deterministic local gate:

```bash
bun run verify
```

Live macOS capture tests are opt-in because they depend on current windows,
display state, and TCC permissions:

```bash
SPORES_TEST_NATIVE_CAPTURE=1 bun run test:native
```

## Start The MCP Server

From a source checkout, agents should use Spores through MCP over stdio:

```bash
bun run --silent mcp
```

The checked-in `.mcp.json` uses that command directly. If your MCP client does
not read repo-local MCP config, add this server entry to the client's MCP
configuration:

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

The `mcp`, `spores`, `recorder-helper`, and `smoke` package scripts launch TSX
through Node. This keeps `bun run --silent mcp` as the package-manager entrypoint
while avoiding Bun/TSX resolver failures in embedded agent runtimes. If a client
cannot execute package scripts, use the equivalent direct command:

```bash
node node_modules/tsx/dist/cli.mjs apps/sporesd/src/index.ts
```

Use `SPORES_RUNS_ROOT` to choose where run bundles are written:

```bash
SPORES_RUNS_ROOT=/tmp/spores-runs bun run --silent mcp
```

Verify the server from the same shell or agent runtime that will launch it:

```bash
bun run --silent mcp:doctor -- --json
bun run --silent spores -- doctor --json
bun run --silent spores -- permissions status --json
bun run --silent spores -- targets --json
```

An MCP client should see these tools after reconnecting:

```text
spores_doctor
recorder_ready
recorder_helper_status
recorder_helper_list_targets
recorder_context_snapshot
recorder_target_resolve
recorder_target_select
recorder_target_validate
recorder_permissions_status
recorder_permissions_probe
recorder_permissions_request
session_recording_begin
session_recording_capture
session_recording_record_target
session_recording_record_window
session_recording_record_app
session_recording_record_region
session_recording_record_active_window
session_recording_start
session_recording_status
session_recording_stop
session_recording_append_event
session_recording_append_agent_step
session_recording_get_timeline
session_recording_query_timeline
session_recording_result
session_recording_get_artifact
session_recording_read_artifact
```

If a client only shows some of these tools, stop and restart that MCP server
connection. Tool discovery is done when the client connects, so stale client
sessions can keep an old partial tool list.

## Recommended Agent Flow

Check local readiness first. `recorder_ready` runs the native permission probe
and returns `recommendedTools`; only use recommended tools that are present in
the MCP tool list.

```json
{
  "name": "recorder_ready",
  "arguments": {}
}
```

Take a context snapshot when the agent needs current display/window coordinates.
Pass the returned `snapshotId` into target selection if the agent wants the
selection bound to that inspected window set.

```json
{
  "name": "recorder_context_snapshot",
  "arguments": {}
}
```

Select and validate a target before recording:

```json
{
  "name": "recorder_target_select",
  "arguments": {
    "snapshotId": "snap_id_from_context_snapshot",
    "selector": {
      "kind": "window",
      "bundleId": "com.google.Chrome",
      "titleIncludes": "Calendar"
    },
    "targetPolicy": {
      "minConfidence": "medium",
      "failOnAmbiguous": true,
      "maxAlternatives": 5
    }
  }
}
```

For most tasks, use `session_recording_capture`. It selects a target, records,
stops, verifies artifacts, and returns a bounded result summary in one response.
Use `seconds` for fixed-duration recordings. It is an integer from 1 to 30 and
defaults to 5.

## Common Recording Calls

Record the frontmost matching Chrome window:

```json
{
  "name": "session_recording_capture",
  "arguments": {
    "target": {
      "kind": "window",
      "bundleId": "com.google.Chrome"
    },
    "seconds": 5
  }
}
```

Record a window by title:

```json
{
  "name": "session_recording_capture",
  "arguments": {
    "target": {
      "kind": "window",
      "app": "Chrome",
      "titleIncludes": "FOX Sports"
    },
    "seconds": 5
  }
}
```

Record an app's visible bounds:

```json
{
  "name": "session_recording_capture",
  "arguments": {
    "target": {
      "kind": "app",
      "bundleId": "com.google.Chrome"
    },
    "seconds": 10
  }
}
```

Record explicit screen coordinates:

```json
{
  "name": "session_recording_capture",
  "arguments": {
    "target": {
      "kind": "region",
      "bounds": { "x": 0, "y": 0, "width": 1280, "height": 720 }
    },
    "seconds": 5
  }
}
```

The older `session_recording_record_window`, `session_recording_record_app`,
`session_recording_record_region`, and `session_recording_record_active_window`
tools remain available for compatibility.

Record the frontmost helper-listed window with the compatibility tool:

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

`safetyCapSeconds` is an integer from 1 to 30 and defaults to 30. Longer
workflows should be split into multiple bounded recordings with agent step
annotations between segments.

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
  "name": "recorder_context_snapshot",
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

Validate a target if it came from an earlier snapshot:

```json
{
  "name": "recorder_target_validate",
  "arguments": {
    "snapshotId": "snap_id_from_context_snapshot",
    "targetId": "window:480794"
  }
}
```

Native capture is conservative. A target must be addressable as a display, a
numeric native window, or explicit bounds. If a target is stale or lacks bounds,
Spores returns a structured error instead of silently recording the wrong area.

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

Read result summaries and artifacts through bounded tools:

```json
{
  "name": "session_recording_result",
  "arguments": {
    "runId": "run_id",
    "includeTimeline": "summary"
  }
}
```

```json
{
  "name": "session_recording_query_timeline",
  "arguments": {
    "runId": "run_id",
    "query": "checkout",
    "limit": 50,
    "includePayloads": false
  }
}
```

```json
{
  "name": "session_recording_read_artifact",
  "arguments": {
    "runId": "run_id",
    "artifactId": "artifact_id",
    "contentMode": "metadata"
  }
}
```

`session_recording_get_artifact` is a legacy small-text reader. Use
`session_recording_read_artifact` for video artifacts and for all agent-facing
artifact reads.

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
{ "name": "recorder_permissions_probe", "arguments": {} }
```

```json
{ "name": "recorder_permissions_request", "arguments": {} }
```

On macOS, grant Screen Recording to the process that launches Spores. Depending
on how the MCP client starts the server, System Settings may show the agent app,
Terminal/iTerm, Node, Bun, or another bundled runtime. The permission flow is:

1. Run `recorder_permissions_probe` or `bun run --silent mcp:doctor -- --json`.
2. If `requiresUserAction` is true, run `recorder_permissions_request` for the
   exact missing permissions and settings pane hints.
3. Grant Screen Recording to the launching process in System Settings.
4. Fully restart the launching app or terminal, then reconnect the MCP server.
5. Run `recorder_ready` before recording.

Accessibility is reported because it is needed for richer future app metadata,
but current video capture requires Screen Recording. Optional permissions such
as Input Monitoring, Microphone, and System Audio are reported as
`not_requested` unless a future backend needs them.

For tests, permission states can be simulated:

```bash
SPORES_PERMISSION_SCREEN_RECORDING=missing bun run --silent spores -- permissions status --json
```

## Troubleshooting Agent Recording

Use this sequence when an agent cannot record:

```bash
bun run --silent mcp:doctor -- --json
```

```json
{ "name": "spores_doctor", "arguments": {} }
```

```json
{ "name": "recorder_ready", "arguments": {} }
```

```json
{ "name": "recorder_context_snapshot", "arguments": {} }
```

`recorder_context_snapshot` should return displays and windows with absolute
screen coordinates. If target discovery works but recording fails, try a small
known region first:

```json
{
  "name": "session_recording_record_region",
  "arguments": {
    "bounds": { "x": 0, "y": 0, "width": 320, "height": 240 },
    "seconds": 1
  }
}
```

Successful native recordings write `artifacts/capture.mp4` and return a video
artifact with `mediaType: "video/mp4"`.

## CLI

The CLI is useful for local diagnostics:

```bash
bun run --silent spores -- doctor --json
bun run --silent spores -- status --json
bun run --silent spores -- targets --json
bun run --silent spores -- permissions status --json
bun run --silent mcp:doctor -- --json
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
bun run test:native
bun run smoke
```

Run the deterministic full gate:

```bash
bun run verify
```

Service design notes live in [`docs/services/`](docs/services/).
