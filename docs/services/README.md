# Service Plans

Each service has a separate plan file. Keep implementation aligned to these
boundaries unless the product shape changes.

Service plans distinguish current behavior from planned behavior. Do not move a
planned item into the current sections until the corresponding tool, bundle
format, or workflow is implemented and covered by the local verification gate.

## Services

1. [Spores MCP Host and `sporesd`](01-sporesd-control-plane.md)
2. [Spores Recorder Helper](02-recorder-helper.md)
3. [Permission Broker and Installer](03-permission-broker-installer.md)
4. [Session Recording MCP](04-session-recording-mcp.md)
5. [Recent Activity MCP](05-recent-activity-mcp.md)
6. [Agent Adapter SDK](06-agent-adapter-sdk.md)
7. [Review Viewer](07-review-viewer.md)
8. [Artifact Store and Indexer](08-artifact-store-indexer.md)

## Dependency Graph

```mermaid
flowchart TD
  recorder["Spores Recorder Helper"]
  broker["Permission Broker"]
  daemon["Spores MCP Host / sporesd"]
  replay["Session Recording MCP"]
  recent["Recent Activity MCP"]
  adapters["Agent Adapter SDK"]
  viewer["Review Viewer"]
  store["Artifact Store"]

  broker --> recorder
  recorder --> store
  daemon --> broker
  daemon --> recorder
  replay --> daemon
  recent --> daemon
  adapters --> daemon
  store --> viewer
  daemon --> viewer
```

## Implementation Rule

The native helper owns capture and OS permissions. The MCP host owns product
state, local APIs, and tool routing. Dedicated MCP surfaces should be thin
clients over the same internal protocol.

Agent-facing docs should prefer the current workflow:

1. `recorder_ready`
2. `recorder_context_snapshot`
3. `recorder_target_select`
4. `session_recording_capture` for known durations, or
   `session_recording_begin` plus `session_recording_stop` for unknown durations
5. `session_recording_result`, `session_recording_query_timeline`, and
   metadata-first `session_recording_read_artifact`
