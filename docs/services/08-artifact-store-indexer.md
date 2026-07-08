# Artifact Store and Indexer Plan

## Purpose

The Artifact Store owns the on-disk bundle format and local search index. It
keeps large blobs as files and will keep queryable metadata in SQLite. The
bundle writer exists today; the durable SQLite indexer, retention engine, and
export pipeline are planned.

## Current Responsibilities

- Create run directories.
- Allocate stable artifact IDs.
- Write manifests.
- Store event streams and frame references as NDJSON.
- Compute checksums.
- Preserve native MP4 artifact metadata.

## Planned Responsibilities

- Index events and artifacts.
- Enforce retention policy.
- Produce export bundles.
- Rebuild indexes from manifests and NDJSON.
- Report checksum drift and missing artifact files.

## Non-Goals

- No capture.
- No MCP protocol ownership.
- No native permission checks.
- No hosted storage in v0.

## Current Bundle Layout

Current runs are written under `SPORES_RUNS_ROOT` or `.spores/runs`:

```text
.spores/runs/<run-id>/
  manifest.json
  events.ndjson
  frames.ndjson
  artifacts/
    capture.mp4          # composed native sessions
    source-capture.mp4   # raw native source capture
    helper-capture.txt   # synthetic sessions
  native-capture.json    # native sessions
```

`capture.mp4` is the primary agent-facing MP4 for native macOS recordings and
is composed over the bundled recording background. `source-capture.mp4` retains
the raw `screencapture` output when present. `helper-capture.txt` is used by
synthetic/helper tests. `native-capture.json` records the macOS `screencapture`
state needed for recovery and debugging.

## Planned Indexed Layout

The planned indexer can add derived files without changing the core bundle
contract:

```text
.spores/runs/<run-id>/
  manifest.json
  events.ndjson
  frames.ndjson
  artifacts/
    capture.mp4
  index.sqlite
  exports/
```

## Manifest

```json
{
  "schemaVersion": 1,
  "runId": "run_123",
  "sessionId": "sess_123",
  "status": "complete",
  "createdAt": "2026-07-06T18:35:00Z",
  "updatedAt": "2026-07-06T18:35:05Z",
  "target": { "targetId": "window:12345", "kind": "window" },
  "permissionSnapshot": { "platform": "darwin" },
  "artifacts": [
    {
      "artifactId": "art_native_abc",
      "kind": "video",
      "path": ".spores/runs/run_123/artifacts/capture.mp4",
      "role": "recording_primary",
      "mediaType": "video/mp4",
      "sha256": "...",
      "bytes": 102400,
      "createdAt": "2026-07-06T18:35:05Z",
      "timeRangeMs": [0, 5000],
      "redactionState": "raw"
    }
  ],
  "eventCount": 8,
  "frameCount": 2
}
```

The sample omits some required nested fields for readability. Field names in
code are camelCase. Exported manifests may add snake_case views if a future
export format requires them.

## SQLite Tables

Planned tables:

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

Every current artifact stores:

- `artifactId`
- `kind`
- `path`
- `mediaType`
- `sha256`
- `bytes`
- `createdAt`
- `timeRangeMs`
- `redactionState`

Current MCP reads are intentionally bounded. `session_recording_read_artifact`
can return metadata, bounded text, or bounded base64. MP4 artifacts should be
read as metadata by default.

## Retention

Planned default policy:

- Keep completed explicit recordings until user deletes them.
- Keep failed/partial manifests for debugging.
- Prune raw recent-activity segments quickly.
- Preserve summaries longer than raw segments.
- Never delete user-exported bundles automatically.

## Export Modes

Planned export modes:

- Full local bundle.
- Redacted share bundle.
- Single-step clip plus event context.
- Replay-plan Markdown.
- Agent-readable JSON manifest.

Exports must be derived from the manifest, NDJSON streams, artifact metadata,
and indexer state. They must not require hidden hosted services.

## Agent Workflow

- Use `session_recording_result` for a compact run summary and artifact
  verification.
- Use `session_recording_query_timeline` for paged event search. Today this
  reads NDJSON; the planned SQLite indexer should preserve the same MCP shape.
- Use `session_recording_read_artifact` with `contentMode: "metadata"` for
  video artifacts.
- Treat missing or corrupt artifacts as degraded evidence, not as permission to
  fabricate replay details.

## Tests

- Current: bundle creation writes manifest, event stream, frame stream, and
  artifact directory for a run ID.
- Current: native MP4 artifacts include byte length, SHA-256, media type, and
  time range.
- Current: completed helper artifacts can be recovered into the manifest.
- Planned: index can be rebuilt from NDJSON.
- Planned: checksum mismatch marks artifact corrupt.
- Planned: partial recordings remain inspectable.
- Planned: retention prunes only eligible files.

## MVP Milestones

1. Done: bundle writer.
2. Done: manifest writer.
3. Done: NDJSON appenders.
4. Done: native MP4 artifact metadata.
5. Planned: SQLite indexer.
6. Planned: export redacted bundle.
