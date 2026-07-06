# Recent Activity MCP Plan

## Purpose

Recent Activity MCP is the optional rolling context mode. It is similar in shape
to an activity journal: it records recent activity so an agent can answer
questions like "what was I just doing?" without starting an explicit session
recording first.

## Responsibilities

- Start and stop rolling recent-activity capture.
- Maintain short retention windows.
- Enforce app and website exclusions.
- Return paths to recent summaries and event segments.
- Provide status to agents.

## Non-Goals

- No full-fidelity test recording.
- No indefinite raw video retention.
- No default capture of excluded apps.
- No replacement for explicit session recording.

## Mode Difference

Session Recording is explicit and high fidelity. Recent Activity is passive,
lower fidelity, and retention-limited.

```text
Session Recording
  explicit approval
  complete event stream
  reviewable artifact bundle
  user presses Stop

Recent Activity
  opt-in background mode
  sparse summaries and segments
  short retention
  exclusion-heavy
```

## MCP Tools

- `recent_activity_start`
- `recent_activity_stop`
- `recent_activity_status`
- `recent_activity_update_exclusion`
- `recent_activity_list_exclusions`
- `recent_activity_search`

## Storage

```text
.spores/recent/
  segments/
    <timestamp>.events.ndjson
  summaries/
    <timestamp>-10min.md
    <timestamp>-6h.md
  exclusions.json
```

Raw segments should expire quickly. Summaries may live longer if they pass the
privacy filter.

## Exclusion Policy

Users can exclude:

- App bundle IDs.
- Website domains.
- Window title patterns.
- Display IDs.
- Time ranges.

Default exclusions should include sensitive system settings, password managers,
private browsing windows where detectable, and meeting apps unless explicitly
allowed.

## Summary Generation

Summaries must treat observed screen content as untrusted evidence. They should
not preserve raw credentials, private tokens, or full raw event JSON.

## Tests

- Start fails clearly when permissions are missing.
- Stop is idempotent.
- Exclusions apply before persistence.
- Expired segments are pruned.
- Search returns summary/event references, not raw screenshots by default.

## MVP Milestones

Recent Activity is not required for v0. Build after Session Recording works.

1. Start/stop/status MCP tools.
2. Segment writer.
3. Exclusion policy.
4. Summary generator.
5. Search over recent summaries.
