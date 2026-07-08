# Session Recording MCP Plan

## Purpose

Session Recording MCP is the primary agent-facing recording surface. It exposes
tools to start, inspect, stop, and summarize an explicit recording session.

## Responsibilities

- Start bounded recording sessions through `sporesd`.
- Resolve and validate capture targets before native recording.
- Return run bundle paths, status, timeline summaries, and artifact metadata.
- Stop or recover active helper-backed sessions.
- Let agents append structured decision, action, observation, and assertion
  events.
- Keep large artifacts behind bounded read APIs.

## Non-Goals

- No direct capture inside the MCP layer; native capture stays in the recorder
  helper.
- No persistent background recording.
- No hidden recording.
- No raw credential extraction from event streams.
- No unbounded video or artifact reads through MCP.

## MCP Tools

### Preferred: `session_recording_capture`

Selects a target, records for a fixed duration, stops, verifies artifacts, and
returns a bounded result summary. Agents should use this for most tasks.

Input:

```json
{
  "target": {
    "kind": "window",
    "bundleId": "com.google.Chrome",
    "titleIncludes": "Checkout"
  },
  "seconds": 5,
  "targetPolicy": {
    "minConfidence": "medium",
    "failOnAmbiguous": true,
    "maxAlternatives": 5
  },
  "result": {
    "includeTimeline": "summary",
    "verifyArtifacts": true
  }
}
```

Output:

```json
{
  "runId": "run_123",
  "status": "complete",
  "artifact": {
    "kind": "video",
    "path": ".spores/runs/run_123/artifacts/capture.mp4",
    "role": "recording_primary",
    "mediaType": "video/mp4"
  },
  "result": {
    "runId": "run_123",
    "status": "complete",
    "timeline": { "eventCount": 8, "frameCount": 2, "artifactCount": 2 }
  }
}
```

`seconds` is an integer from 1 to 30 and defaults to 5.

### Unknown Duration: `session_recording_begin`

Starts a recording with a safety cap when the agent cannot know the duration up
front.

Input:

```json
{
  "target": {
    "kind": "window",
    "bundleId": "com.google.Chrome"
  },
  "safetyCapSeconds": 30
}
```

`safetyCapSeconds` is an integer from 1 to 30 and defaults to 30. The agent
should call `session_recording_stop` when the task is done, but current native
macOS capture uses timed `screencapture` and may wait for the capped MP4 to
finish. Synthetic capture can stop immediately. True arbitrary early-stop
native capture is planned for a future encoder backend.

### Compatibility: `session_recording_start`

Starts a lower-level helper-backed recording and creates a run bundle. This tool
remains available for compatibility and service-level flows. Prefer
`session_recording_capture` or `session_recording_begin` in agent workflows.

Input:

```json
{
  "target": { "mode": "picker" },
  "purpose": "Record the end-to-end test flow.",
  "capture": {
    "mode": "native",
    "maxDurationSeconds": 5
  }
}
```

`capture.maxDurationSeconds` is capped to 1 through 30 seconds.

### `session_recording_status`

Returns current or most recent recording state.

### `session_recording_stop`

Stops the active recording and returns final paths.

### `session_recording_append_agent_step`

Appends a structured agent event to a run:

```json
{
  "runId": "run_123",
  "stepId": "verify-checkout-total",
  "kind": "assertion",
  "summary": "Verified the checkout total matched the expected value.",
  "assertion": {
    "expected": "$42.00",
    "actual": "$42.00",
    "status": "passed"
  }
}
```

### `session_recording_result`

Returns a bounded result summary with optional timeline details and artifact
verification.

### `session_recording_query_timeline`

Pages and searches timeline events. Current search scans the run bundle event
stream. Durable SQLite indexing is planned in the Artifact Store.

### `session_recording_read_artifact`

Reads artifact metadata, bounded text, or bounded base64 content. Agents should
use `contentMode: "metadata"` for MP4 artifacts unless they explicitly need
bounded base64 content.

## Planned MCP Tools

Replay-plan and skill drafting are planned, not implemented in this checkout.
They should be built on top of recorded events, agent annotations, target
metadata, and artifact references.

### Planned: `session_recording_draft_plan`

Reads the event stream and drafts a practical replay plan. It should prefer
stable integrations over replaying every mouse movement.

### Planned: `session_recording_create_skill`

Creates a draft reusable skill from the recording.

## Approval Flow

Current recording is explicit because the agent must call a recording tool and
the helper reports permission state before native capture. A stronger native
approval gate is planned. The planned prompt should be clear about the target,
duration cap, and recorded data:

```text
Allow Spores to record your actions on this Mac?

Spores will record mouse clicks, text you type, and content in windows you
interact with until you press Stop or the time limit is reached.
```

Agents must receive `approval_pending`, `approval_denied`, or `recording`
states once that gate exists. They should never assume a recording started.

## Time Limit

Current fixed recordings use `seconds` with a default of 5 and a maximum of 30.
Unknown-duration recordings use `safetyCapSeconds` with a default and maximum of
30. Long recordings should be split into segments with agent annotations between
segments.

## Video Artifact Behavior

Native macOS capture uses `/usr/sbin/screencapture` through the recorder helper.
It writes the raw source movie to `artifacts/source-capture.mp4`, composes that
movie over the bundled recording background, and returns
`artifacts/capture.mp4` as the primary `video/mp4` artifact with
`role: "recording_primary"`. For native capture, stop waits for the timed file
and composed MP4 to become available when necessary. `native-capture.json` is
retained in the run directory for recovery and debugging.

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

## Agent Workflow

1. Call `recorder_ready` and inspect `recommendedTools`, permissions, and timing
   limits.
2. Call `recorder_context_snapshot` when coordinates or window state matter.
3. Call `recorder_target_select` with `failOnAmbiguous: true` for window and app
   targets.
4. Use `session_recording_capture` for known durations or
   `session_recording_begin` plus `session_recording_stop` for unknown
   durations.
5. Add `session_recording_append_agent_step` events for decisions, actions,
   observations, and assertions that are not visible in the native event stream.
6. Read the result with `session_recording_result`; use metadata-first artifact
   reads for MP4 video.

## Tests

- Capture enforces the 1 to 30 second limit.
- Begin enforces the 1 to 30 second safety cap.
- Native capture returns composed `artifacts/capture.mp4` with
  `role: "recording_primary"` and `mediaType: "video/mp4"`.
- Stop recovers completed helper artifacts when the active helper session is no
  longer attached.
- Status returns output paths while recording.
- Query/result APIs return bounded timeline and artifact summaries.

## MVP Milestones

1. Done: MCP server with helper-backed `sporesd`.
2. Done: start/status/stop and preferred one-shot capture.
3. Done: native MP4 artifacts and recoverable bundle metadata.
4. Done: agent annotations and bounded timeline/artifact reads.
5. Planned: native approval prompt.
6. Planned: durable artifact indexer and redacted exports.
7. Planned: draft replay plans from event streams.
