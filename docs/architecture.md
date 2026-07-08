# Spores Architecture Plan

## Goal

Build an MCP-first native recording system for agents. Spores should record any
visible app or workflow on the computer, not just Playwright or browser tests,
then expose the recording as a structured evidence graph that MCP-compatible
agent clients can query.

The durable product boundary is:

```text
native capture plane
  -> event stream and artifact store
  -> MCP control plane
  -> review and replay plane
```

Video is evidence, not the source of truth. The event stream is the source of
truth because agents need machine-readable steps, app/window context, UI
elements, actions, observations, assertions, and decision summaries.

## Process Architecture

Spores uses separate processes for capture, MCP control, and review:

- A local daemon/MCP host for product state, tools, and local APIs.
- A minimal recorder helper bundle with its own OS permission identity.
- A service binary for native capture.
- Thin client commands for agents and automation.
- Separate MCP surfaces for explicit session recording and optional recent
  activity.
- A permission flow that requires Screen Recording and Accessibility on macOS.
- Event streams for structured replay rather than video-only recordings.

The critical boundary is that the native helper owns OS permissions and capture,
while the MCP host exposes controlled, auditable capabilities to agents. Spores
does not require a user-facing desktop app in v0.

## Service Boundaries

```text
Spores MCP Host / sporesd
  owns product state, MCP routing, local APIs, settings

Spores Recorder Helper
  owns native capture, app/window inventory, event stream capture, timestamps

Spores Permission Broker
  owns permission checks, onboarding, helper installation, capability status

Session Recording MCP
  exposes start/status/stop recording and returns event/artifact paths

Recent Activity MCP
  exposes optional rolling context capture with exclusions and retention

Agent Adapter SDK
  lets agents and tools add intent/action/assertion annotations

Review Viewer
  optionally renders video, event lanes, accessibility state, and replay plans

Artifact Store
  stores run bundles, event streams, frame indexes, video, and search indexes
```

## Platform Priorities

1. macOS first.
2. Cross-platform interfaces from day one.
3. Windows native capture second.
4. Linux capture third, with Wayland portal support before X11 shortcuts.

macOS v0 should use a signed helper bundle only where the OS requires a stable
permission identity. TCC permissions attach to bundle identities. A random CLI
launched from Terminal is the wrong permission owner, but that does not imply a
user-facing desktop product.

## Data Contract

Every recording creates a run bundle:

```text
.spores/runs/<run-id>/
  manifest.json
  events.ndjson
  frames.ndjson
  artifacts/
    capture.mp4
    source-capture.mp4
    screenshots/
    snapshots/
    accessibility/
  index.sqlite
```

Core object hierarchy:

```text
run
  session
    target
    permission_snapshot
    clock_calibration
    event_stream
    artifacts
```

Core event categories:

- `recording.started`
- `recording.stopped`
- `permission.snapshot`
- `target.selected`
- `app.focused`
- `window.changed`
- `screen.frame`
- `mouse.click`
- `mouse.drag`
- `keyboard.text_input`
- `keyboard.shortcut`
- `accessibility.tree`
- `accessibility.diff`
- `agent.decision`
- `agent.action`
- `agent.observation`
- `agent.assertion`
- `privacy.redaction`
- `capture.blocked`

## Security Model

Spores records sensitive desktop state. The defaults must be conservative:

- Explicit approval before recording starts.
- Visible recording controls while recording.
- App and website exclusion policy.
- Machine-readable permission state.
- Redaction at capture time where possible.
- Short default retention for raw captures.
- Separate raw forensic bundle from redacted share bundle.
- No locked-screen operation in v0.

## Versioned Delivery

### V0

- macOS helper bundle with Screen Recording and Accessibility onboarding.
- Manual target selection.
- Session Recording MCP tools.
- Event stream JSONL.
- MP4 capture artifact.
- Optional local viewer with timeline and video seek.
- SQLite index.

### V1

- Agent Adapter SDK.
- App/window exclusion editor.
- Accessibility tree diff viewer.
- Replay-plan generation.
- Search across event streams.
- Export bundles.

### V2

- Windows native helper.
- Recent Activity mode.
- Hosted artifact upload.
- Organization policies.
- Optional system-audio capture.
- Optional locked-use equivalent, only after a separate review.
