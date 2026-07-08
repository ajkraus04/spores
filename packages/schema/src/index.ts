import { randomUUID } from "node:crypto";
import { z } from "zod";

export const RecordingStatusSchema = z.enum([
  "idle",
  "recording",
  "stopping",
  "stopped",
  "complete",
  "failed",
  "partial",
]);

export const ArtifactKindSchema = z.enum([
  "video",
  "screenshot",
  "snapshot",
  "trace",
  "event_stream",
  "frame_index",
  "metadata",
  "text",
]);

export const RedactionStateSchema = z.enum([
  "raw",
  "redacted",
  "quarantined",
  "failed",
  "not_required",
]);

export const PermissionStateSchema = z.enum([
  "granted",
  "missing",
  "pending",
  "denied",
  "unsupported",
  "not_requested",
  "degraded",
]);

export const PermissionNameSchema = z.enum([
  "screenRecording",
  "accessibility",
  "inputMonitoring",
  "microphone",
  "systemAudio",
]);

export const EventTypeSchema = z.enum([
  "recording.started",
  "recording.stopped",
  "permission.snapshot",
  "target.selected",
  "app.focused",
  "window.changed",
  "screen.frame",
  "mouse.click",
  "mouse.drag",
  "keyboard.text_input",
  "keyboard.shortcut",
  "accessibility.tree",
  "accessibility.diff",
  "agent.decision",
  "agent.action",
  "agent.observation",
  "agent.assertion",
  "privacy.redaction",
  "capture.blocked",
]);

export const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const TargetRefSchema = z.object({
  targetId: z.string(),
  kind: z.enum(["display", "window", "app", "region", "browser_tab", "fake"]),
  displayId: z.string().optional(),
  nativeDisplayId: z.string().optional(),
  nativeWindowId: z.string().optional(),
  stableKey: z.string().optional(),
  identityConfidence: z.enum(["low", "medium", "high"]).optional(),
  observedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  targetToken: z.string().optional(),
  bounds: BoundsSchema.optional(),
  zOrder: z.number().int().nonnegative().optional(),
  app: z
    .object({
      bundleId: z.string().optional(),
      name: z.string(),
      processId: z.number().int().optional(),
    })
    .optional(),
  window: z
    .object({
      id: z.string(),
      title: z.string().optional(),
      bounds: BoundsSchema.optional(),
    })
    .optional(),
  browser: z
    .object({
      provider: z.enum(["chrome_extension", "cdp", "native_inferred"]).optional(),
      browserName: z.string().optional(),
      browserBundleId: z.string().optional(),
      profileId: z.string().optional(),
      windowId: z.string().optional(),
      tabId: z.string().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
      origin: z.string().optional(),
      active: z.boolean().optional(),
      incognito: z.boolean().optional(),
    })
    .optional(),
  safeToPersist: z.boolean().default(true),
});

export const PermissionSnapshotSchema = z.object({
  platform: z.string(),
  screenRecording: PermissionStateSchema,
  accessibility: PermissionStateSchema,
  inputMonitoring: PermissionStateSchema,
  microphone: PermissionStateSchema,
  systemAudio: PermissionStateSchema,
  requiresUserAction: z.boolean(),
});

export const PermissionCapabilitySchema = z.object({
  permission: PermissionNameSchema,
  label: z.string(),
  status: PermissionStateSchema,
  required: z.boolean(),
  canRequest: z.boolean(),
  reason: z.string(),
  settingsUrl: z.string().optional(),
});

export const PermissionBrokerStatusSchema = z.object({
  platform: z.string(),
  mode: z.enum(["deterministic", "native_probe"]),
  snapshot: PermissionSnapshotSchema,
  capabilities: z.array(PermissionCapabilitySchema),
  requiresUserAction: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const PermissionRequestResultSchema = z.object({
  status: PermissionBrokerStatusSchema,
  opened: z.boolean(),
  message: z.string(),
  actions: z.array(PermissionCapabilitySchema),
});

export const RecorderHelperStatusSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  mode: z.enum(["stdio"]),
  command: z.string(),
  args: z.array(z.string()),
  pid: z.number().int().positive().optional(),
  version: z.string().optional(),
  protocolVersion: z.literal(1).optional(),
  platform: z.string().optional(),
  targetCount: z.number().int().nonnegative().optional(),
  targetSource: z.enum(["macos", "deterministic_fallback", "unknown"]).optional(),
  targetDiscoveryError: z.string().optional(),
  capabilities: z
    .object({
      listTargets: z.boolean(),
      startSession: z.boolean(),
      stopSession: z.boolean(),
      permissions: z.boolean().optional(),
      permissionsProbe: z.boolean().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const RecorderHelperTargetsSchema = z.object({
  status: RecorderHelperStatusSchema,
  targets: z.array(TargetRefSchema),
});

export const ClockCalibrationSchema = z.object({
  wallTime: z.string().datetime(),
  monotonicTimeNs: z.number().int().nonnegative(),
});

export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string(),
  relativePath: z.string().optional(),
  state: z.enum(["writing", "complete", "failed"]).default("complete"),
  streamable: z.boolean().optional(),
  seekable: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  sourceEventId: z.string().optional(),
  mediaType: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
  redactionState: RedactionStateSchema.default("not_required"),
});

export const FrameRefSchema = z.object({
  frameId: z.string(),
  runId: z.string().optional(),
  sessionId: z.string(),
  segmentId: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  wallTime: z.string().datetime().optional(),
  monotonicTimeNs: z.number().int().nonnegative(),
  videoTimeMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  accuracy: z.enum(["actual", "sampled", "coarse"]).default("actual"),
  mediaTimeRangeMs: z.tuple([z.number(), z.number()]).optional(),
  artifactId: z.string().optional(),
});

export const TraceAnchorSchema = z.object({
  kind: z.enum(["event", "frame", "artifact", "video_time", "screenshot", "target", "accessibility_node"]),
  eventId: z.string().optional(),
  frameId: z.string().optional(),
  artifactId: z.string().optional(),
  videoTimeMs: z.number().nonnegative().optional(),
  timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
  uri: z.string().optional(),
  label: z.string().optional(),
});

export const CausalLinkSchema = z.object({
  relation: z.enum(["caused_by", "observed_in", "asserts", "follows", "blocks", "supports"]),
  eventId: z.string().optional(),
  stepId: z.string().optional(),
  spanId: z.string().optional(),
  anchor: TraceAnchorSchema.optional(),
});

export const TraceSpanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.enum(["task", "tool_call", "navigation", "assertion", "capture"]),
  status: z.enum(["pending", "running", "passed", "failed", "unknown"]).optional(),
  startedAtEventId: z.string().optional(),
  endedAtEventId: z.string().optional(),
  timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
});

export const ToolCallSchema = z.object({
  toolCallId: z.string().optional(),
  toolName: z.string(),
  providerRequestId: z.string().optional(),
  argumentsSummary: z.string().optional(),
  redactedArguments: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "unknown"]).default("unknown"),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  latencyMs: z.number().nonnegative().optional(),
  inputAnchors: z.array(TraceAnchorSchema).optional(),
  outputAnchors: z.array(TraceAnchorSchema).optional(),
});

export const AgentAssertionSchema = z.object({
  expected: z.string().max(8_000),
  actual: z.string().max(8_000),
  status: z.enum(["passed", "failed", "unknown"]),
});

export const AgentStepPayloadSchema = z.object({
  stepId: z.string().min(1).max(200),
  kind: z.enum(["decision", "action", "observation", "assertion"]),
  summary: z.string().min(1).max(4_000),
  rationale: z.string().max(8_000).optional(),
  intent: z.string().max(8_000).optional(),
  basis: z.string().max(8_000).optional(),
  expectedOutcome: z.string().max(8_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  hiddenCotStored: z.literal(false).default(false),
  anchors: z.array(TraceAnchorSchema).optional(),
  causedBy: z.array(CausalLinkSchema).optional(),
  span: TraceSpanSchema.optional(),
  toolCall: ToolCallSchema.optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
  assertion: AgentAssertionSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export const RecorderHelperSessionSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: RecordingStatusSchema,
  eventCount: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactRefSchema).default([]),
});

export const SporesEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: EventTypeSchema,
  wallTime: z.string().datetime(),
  monotonicTimeNs: z.number().int().nonnegative(),
  source: z.enum(["sporesd", "fake-recorder", "recorder-helper", "agent", "sdk", "test"]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const RunManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  sessionId: z.string(),
  status: RecordingStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  target: TargetRefSchema,
  permissionSnapshot: PermissionSnapshotSchema,
  clockCalibration: ClockCalibrationSchema,
  artifacts: z.array(ArtifactRefSchema),
  eventCount: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(),
  paths: z.object({
    runDir: z.string(),
    manifest: z.string(),
    events: z.string(),
    frames: z.string(),
    artifactsDir: z.string(),
  }),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const TimelineSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: RecordingStatusSchema,
  events: z.array(SporesEventSchema),
  frames: z.array(FrameRefSchema),
  artifacts: z.array(ArtifactRefSchema),
});

export const SporesErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retriable: z.boolean(),
  requiresUserAction: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type AgentStepPayload = z.infer<typeof AgentStepPayloadSchema>;
export type CausalLink = z.infer<typeof CausalLinkSchema>;
export type ClockCalibration = z.infer<typeof ClockCalibrationSchema>;
export type FrameRef = z.infer<typeof FrameRefSchema>;
export type PermissionBrokerStatus = z.infer<typeof PermissionBrokerStatusSchema>;
export type PermissionCapability = z.infer<typeof PermissionCapabilitySchema>;
export type PermissionName = z.infer<typeof PermissionNameSchema>;
export type PermissionRequestResult = z.infer<typeof PermissionRequestResultSchema>;
export type PermissionSnapshot = z.infer<typeof PermissionSnapshotSchema>;
export type PermissionState = z.infer<typeof PermissionStateSchema>;
export type RecorderHelperStatus = z.infer<typeof RecorderHelperStatusSchema>;
export type RecorderHelperTargets = z.infer<typeof RecorderHelperTargetsSchema>;
export type RecorderHelperSession = z.infer<typeof RecorderHelperSessionSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type SporesError = z.infer<typeof SporesErrorSchema>;
export type SporesEvent = z.infer<typeof SporesEventSchema>;
export type TargetRef = z.infer<typeof TargetRefSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type TraceAnchor = z.infer<typeof TraceAnchorSchema>;
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function monotonicTimeNs(): number {
  return Number(process.hrtime.bigint());
}

export function createSporesId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
