# Artifact Store and Indexer Plan

## Purpose

The Artifact Store owns the on-disk bundle format and local search index. It
keeps large blobs as files and queryable metadata in SQLite.

## Responsibilities

- Create run directories.
- Allocate stable artifact IDs.
- Write manifests.
- Store event streams and frame indexes.
- Compute checksums.
- Index events and artifacts.
- Enforce retention policy.
- Produce export bundles.

## Non-Goals

- No capture.
- No MCP protocol ownership.
- No native permission checks.
- No hosted storage in v0.

## Bundle Layout

```text
.spores/runs/<run-id>/
  manifest.json
  events.ndjson
  frames.ndjson
  accessibility.ndjson
  artifacts/
    capture.mp4
    screenshots/
    snapshots/
    traces/
  index.sqlite
  exports/
```

## Manifest

```json
{
  "schema_version": 1,
  "run_id": "run_123",
  "status": "complete",
  "created_at": "2026-07-06T18:35:00Z",
  "session": {
    "session_id": "sess_123",
    "platform": "macos",
    "target": "window:12345"
  },
  "artifacts": [],
  "permission_snapshot": {},
  "privacy_policy_version": "v1"
}
```

## SQLite Tables

- `runs`
- `sessions`
- `events`
- `artifacts`
- `frames`
- `accessibility_nodes`
- `redactions`
- `search_documents`

Use SQLite FTS for local text search across safe summaries, event labels,
window/app names, assertion messages, and redacted observation text.

## Checksums

Every artifact should store:

- `artifact_id`
- `kind`
- `path`
- `media_type`
- `sha256`
- `bytes`
- `created_at`
- `time_range`
- `redaction_state`

## Retention

Default policy:

- Keep completed explicit recordings until user deletes them.
- Keep failed/partial manifests for debugging.
- Prune raw recent-activity segments quickly.
- Preserve summaries longer than raw segments.
- Never delete user-exported bundles automatically.

## Export Modes

- Full local bundle.
- Redacted share bundle.
- Single-step clip plus event context.
- Replay-plan Markdown.
- Agent-readable JSON manifest.

## Tests

- Bundle creation is idempotent by run ID.
- Index can be rebuilt from NDJSON.
- Checksum mismatch marks artifact corrupt.
- Partial recordings remain inspectable.
- Retention prunes only eligible files.

## MVP Milestones

1. Bundle writer.
2. Manifest writer.
3. NDJSON appenders.
4. SQLite indexer.
5. Export redacted bundle.
