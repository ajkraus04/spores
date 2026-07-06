# Spores MCP Host and `sporesd` Plan

## Purpose

`sporesd` is the local MCP host and control daemon. It coordinates recording
sessions, permissions, storage, MCP tools, agent annotations, and optional viewer
access. It should not perform native screen capture directly.

## Responsibilities

- Maintain run/session lifecycle.
- Start and stop the recorder helper.
- Route MCP tool calls to internal services.
- Serve local APIs for the viewer and SDK clients.
- Own settings, exclusion policy, retention policy, and feature flags.
- Write stable run IDs and session IDs before capture begins.
- Aggregate final manifests after recording stops.
- Provide machine-readable errors for agents.

## Non-Goals

- No direct ScreenCaptureKit or Accessibility capture.
- No direct global input hooks.
- No privileged installer behavior.
- No locked-screen unlock flow in v0.

## Process Model

```text
MCP-compatible agent client
  launches or connects to sporesd

sporesd
  launches/contacts Spores Recorder Helper
  exposes MCP tools
  serves optional viewer API
  writes run metadata
```

The daemon should run as the current user and should be launchable as an MCP
server without a user-facing desktop app. It should communicate with the
recorder helper over XPC on macOS. A Unix domain socket is acceptable for early
internal prototypes, but the service contract should be transport-neutral.

## Public Interfaces

### REST

REST is optional support for local viewers and SDKs. MCP is the primary agent
interface.

- `POST /v1/runs`
- `POST /v1/recordings/start`
- `GET /v1/recordings/:id/status`
- `POST /v1/recordings/:id/stop`
- `GET /v1/runs/:id/manifest`
- `GET /v1/runs/:id/timeline`
- `POST /v1/events`
- `GET /v1/artifacts/:id`

### Local CLI

- `spores status`
- `spores doctor`
- `spores record`
- `spores replay`
- `spores viewer`
- `spores mcp`

### Internal RPC

- `Recorder.ListTargets`
- `Recorder.StartSession`
- `Recorder.StopSession`
- `Recorder.GetStatus`
- `Recorder.UpdateExclusions`
- `Permission.GetStatus`
- `Permission.OpenOnboarding`

## Session Lifecycle

1. Receive start request.
2. Create run directory and `manifest.pending.json`.
3. Ask Permission Broker for capability snapshot.
4. If required permissions are missing, return `missing_permission`.
5. Request user recording approval when needed.
6. Start recorder helper with target and output paths.
7. Stream status and events to subscribers.
8. Stop helper.
9. Validate artifacts and checksums.
10. Write final `manifest.json`.
11. Index events into SQLite.

## Error Contract

All agent-visible failures should follow:

```json
{
  "error": "missing_permission",
  "message": "Screen Recording permission is required.",
  "platform": "macos",
  "retriable": true,
  "requires_user_action": true,
  "details": {
    "permission": "screen_recording"
  }
}
```

## Technology Recommendation

- TypeScript for the daemon and API.
- Fastify for optional local HTTP APIs.
- Zod or TypeBox for shared schemas.
- SQLite for local indexes.
- MCP TypeScript SDK for MCP surfaces.

## Tests

- Unit test lifecycle state transitions.
- Contract test every REST and RPC schema.
- Integration test start/stop against a fake recorder helper.
- Integration test missing-permission errors.
- Verify that failed recordings leave a readable partial manifest.

## MVP Milestones

1. Fake-recorder integration with real manifests.
2. MCP server and CLI status.
3. Real recorder helper launch on macOS.
4. MCP start/status/stop integration.
5. Optional viewer launch from completed run.
