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
  kind: z.enum(["display", "window", "app", "region", "fake"]),
  displayId: z.string().optional(),
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
  capabilities: z
    .object({
      listTargets: z.boolean(),
      startSession: z.boolean(),
      stopSession: z.boolean(),
      permissions: z.boolean().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
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
  mediaType: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
  redactionState: RedactionStateSchema.default("not_required"),
});

export const FrameRefSchema = z.object({
  frameId: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().nonnegative(),
  monotonicTimeNs: z.number().int().nonnegative(),
  videoTimeMs: z.number().nonnegative(),
  artifactId: z.string().optional(),
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

export function nowIso(): string {
  return new Date().toISOString();
}

export function monotonicTimeNs(): number {
  return Number(process.hrtime.bigint());
}

export function createSporesId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
