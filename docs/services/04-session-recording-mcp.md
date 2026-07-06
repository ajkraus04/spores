# Session Recording MCP Plan

## Purpose

Session Recording MCP is the primary agent-facing recording surface. It exposes
tools to start, inspect, stop, and summarize an explicit recording session.

## Responsibilities

- Ask for explicit user approval before recording.
- Start a session through `sporesd`.
- Return session status and output paths.
- Stop a session.
- Provide event stream metadata to agents.
- Support replay-plan generation from recorded events.

## Non-Goals

- No direct native capture.
- No persistent background recording.
- No hidden recording.
- No raw credential extraction from event streams.

## MCP Tools

### `session_recording_start`

Starts recording for up to a configured maximum duration.

Input:

```json
{
  "target": { "mode": "picker" },
  "purpose": "Record the end-to-end test flow.",
  "max_duration_seconds": 1800
}
```

Output:

```json
{
  "session_id": "sess_123",
  "status": "recording",
  "run_dir": ".spores/runs/run_123",
  "events_path": ".spores/runs/run_123/events.ndjson",
  "metadata_path": ".spores/runs/run_123/metadata.json"
}
```

### `session_recording_status`

Returns current or most recent recording state.

### `session_recording_stop`

Stops the active recording and returns final paths.

### `session_recording_draft_plan`

Reads the event stream and drafts a practical replay plan. It should prefer
stable integrations over replaying every mouse movement.

### `session_recording_create_skill`

Creates a draft reusable skill from the recording. This is a v1 feature.

## Approval Flow

Before recording starts, show a native prompt:

```text
Allow Spores to record your actions on this Mac?

Spores will record mouse clicks, text you type, and content in windows you
interact with until you press Stop or the time limit is reached.
```

Agents must receive `approval_pending`, `approval_denied`, or `recording`
states. They should never assume a recording started.

## Time Limit

Default maximum duration: 30 minutes. Long recordings should be split into
segments.

## Event Stream Use

Agents may read:

- App names and bundle IDs.
- Window titles where safe.
- UI element roles and labels.
- Mouse and keyboard action summaries.
- Agent annotations.
- Redacted text ranges.
- Artifact references.

Agents should not receive:

- Raw password values.
- Tokens.
- Full unredacted text dumps by default.
- Raw screenshots embedded as base64.

## Tests

- Start returns approval pending when user approval is required.
- Start returns missing permission when permission is absent.
- Stop is idempotent.
- Status returns output paths while recording.
- Draft plan refuses to speculate when the event stream is too sparse.

## MVP Milestones

1. MCP server with fake `sporesd` backend.
2. Start/status/stop with real `sporesd`.
3. Native approval prompt.
4. Event stream path return.
5. Draft replay plan from event stream.
