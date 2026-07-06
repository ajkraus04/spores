# Review Viewer Plan

## Purpose

The Review Viewer turns a Spores run bundle into a usable debugging surface. It
should open at the failure or most relevant event, not at the beginning of a
long video.

## Responsibilities

- Render synchronized video and event timeline.
- Show app/window and accessibility context.
- Show agent decisions, actions, observations, and assertions.
- Seek from events to video frames.
- Expose artifact metadata and raw event references.
- Draft replay plans and export summaries.

## Non-Goals

- No capture logic.
- No permission prompts.
- No direct mutation of recordings.
- No hidden AI rewriting of evidence.

## Main Views

### Run Overview

- Run status.
- Started and ended timestamps.
- Duration.
- Target summary.
- Permission snapshot.
- Artifact completeness.
- Errors and warnings.

### Timeline

Lanes:

- Video.
- Native input events.
- App/window changes.
- Accessibility snapshots/diffs.
- Agent decisions.
- Agent actions.
- Assertions.
- Capture blocked/redaction events.

### Event Detail

- Event payload.
- Linked artifacts.
- Nearby screenshots or frames.
- Accessibility element context.
- Redaction metadata.

### Replay Plan

- Minimal reliable sequence.
- Recommended integration per step.
- Verification strategy.
- Missing context.

## UX Requirements

- Opening a failed run should land on the failure event.
- Every event should have a stable deep link.
- The video player should seek with 250-500 ms preroll.
- Redacted or blocked capture regions must be visible in the timeline.
- The viewer should never imply that omitted data was never present.

## Local Serving

The viewer should be a Vite/React app served by `sporesd` in local mode.
Artifacts should be range-served so videos can seek efficiently.

## Tests

- Fixture run renders without a live recorder.
- Event click seeks video to expected timestamp.
- Redaction event displays clearly.
- Missing artifact shows degraded state, not a blank page.
- Large event streams paginate or virtualize.

## MVP Milestones

1. Static fixture viewer.
2. Video plus timeline sync.
3. Event detail panel.
4. Agent annotation lane.
5. Replay-plan draft panel.

