# Spores Recorder Helper Plan

## Purpose

The recorder helper is the native process that owns desktop capture. It records
screen/window/app content, cursor and input metadata, accessibility context, and
timestamped event streams. It is the only service that should require OS capture
permissions.

## Bundle Model

macOS v0 should ship a signed helper app:

```text
Spores Recorder.app
  Contents/MacOS/SporesRecorderService
  Contents/Info.plist
  Contents/Resources/
```

The helper needs a stable bundle ID because macOS TCC grants permissions to app
bundle identities. The CLI and MCP servers should talk to the helper instead of
requesting permissions themselves.

## Responsibilities

- Enumerate displays, apps, windows, and captureable targets.
- Start and stop target capture.
- Record frames and frame timestamps.
- Record cursor path and click metadata.
- Record keyboard metadata where permitted.
- Capture accessibility tree snapshots and diffs.
- Apply app/window/URL exclusion rules.
- Emit event JSONL.
- Write capture video and frame index artifacts.
- Report permission and capture errors without ambiguity.

## Non-Goals

- No agent reasoning logic.
- No hosted upload.
- No MCP protocol ownership.
- No long-term retention policy.
- No locked-screen operation in v0.

## macOS APIs

Primary APIs:

- ScreenCaptureKit for screen/window capture.
- AVFoundation or VideoToolbox for encoding, if needed.
- CoreGraphics for display/window metadata and event coordinates.
- ApplicationServices Accessibility APIs for UI trees and interactions.
- CGEvent taps only where required and explicitly permitted.

Start with ScreenCaptureKit plus ffmpeg sidecar encoding if native encoding
slows delivery. Move to VideoToolbox only after profiling.

## Target Model

```json
{
  "target_id": "window:12345",
  "kind": "window",
  "display_id": "1",
  "app": {
    "bundle_id": "com.example.App",
    "name": "Example App",
    "process_id": 1234
  },
  "window": {
    "id": 12345,
    "title": "Example",
    "bounds": { "x": 100, "y": 100, "width": 1280, "height": 800 }
  },
  "safe_to_persist": true
}
```

## Event Stream

The helper writes append-only NDJSON. Minimum events:

- `recording.started`
- `recording.stopped`
- `target.selected`
- `screen.frame`
- `mouse.move`
- `mouse.click`
- `mouse.drag`
- `keyboard.text_input`
- `keyboard.shortcut`
- `app.focused`
- `window.changed`
- `accessibility.snapshot`
- `accessibility.diff`
- `capture.blocked`
- `privacy.redaction`

Every event must include:

- `event_id`
- `run_id`
- `session_id`
- `sequence`
- `wall_time`
- `monotonic_time_ns`
- `source`
- `payload`

## Output Files

```text
capture.mp4
events.ndjson
frames.ndjson
accessibility.ndjson
metadata.json
```

`frames.ndjson` maps video timestamps to monotonic capture times. The viewer
uses this file to seek from an event to the right video frame.

## Privacy Filter

The helper should block or redact:

- Configured app bundle IDs.
- Configured website domains when browser URL can be inferred.
- Password fields and secure input contexts.
- Windows marked private or unsafe by policy.
- System permission dialogs.
- Known meeting apps by default unless explicitly allowed.

Blocked capture should emit `capture.blocked` rather than silently omitting data.

## Tests

- Unit test target serialization.
- Unit test event sequence monotonicity.
- Fixture test privacy filters.
- Manual macOS smoke test: list targets, record 10 seconds, stop.
- Permission-denied smoke test on a clean macOS user.

## MVP Milestones

1. List displays and windows.
2. Capture a selected display to MP4.
3. Emit frame index and recording metadata.
4. Add mouse click events.
5. Add accessibility snapshots.
6. Add app/window exclusion rules.

