import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ArtifactKindSchema,
  ArtifactRefSchema,
  FrameRefSchema,
  PermissionBrokerStatusSchema,
  PermissionCapabilitySchema,
  PermissionRequestResultSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargetsSchema,
  RecordingStatusSchema,
  RunManifestSchema,
  SporesEventSchema,
  TargetRefSchema,
  TimelineSchema,
} from "@spores/schema";
import {
  AppendAgentStepInputSchema,
  AppendEventInputSchema,
  ArtifactReadInputSchema,
  ArtifactInputSchema,
  BeginRecordingInputSchema,
  ContextSnapshotInputSchema,
  HelperTargetsInputSchema,
  PermissionsRequestInputSchema,
  PermissionsStatusInputSchema,
  ReadyInputSchema,
  RecordActiveWindowInputSchema,
  RecordAppInputSchema,
  RecordCaptureInputSchema,
  RecordRegionInputSchema,
  RecordTargetInputSchema,
  RecordWindowInputSchema,
  RecordingResultInputSchema,
  ResolveTargetInputSchema,
  SporesServiceError,
  SporesService,
  StartRecordingInputSchema,
  StatusInputSchema,
  StopInputSchema,
  TargetSelectorInputSchema,
  TargetSelectInputSchema,
  TargetValidateInputSchema,
  TimelineInputSchema,
  TimelineQueryInputSchema,
} from "./service.js";

type JsonObject = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute(input: never): Promise<unknown>;
  role: "diagnostic" | "permissions" | "targeting" | "recording" | "annotation" | "timeline" | "artifact";
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
};

const BackendSchema = z.enum(["helper", "fake"]);
const ConfidenceSchema = z.enum(["low", "medium", "high"]);

const PathsSchema = RunManifestSchema.shape.paths;

const CompactEventRefSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: SporesEventSchema.shape.type,
  wallTime: z.string(),
  source: SporesEventSchema.shape.source,
}).passthrough();

const TimelineArtifactSummarySchema = z.object({
  artifactId: z.string(),
  kind: ArtifactKindSchema,
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  path: z.string().optional(),
  relativePath: z.string().optional(),
  redactionState: ArtifactRefSchema.shape.redactionState.optional(),
  timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
}).passthrough();

const TimelineSummarySchema = z.object({
  eventCount: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  eventCountsByType: z.record(z.string(), z.number().int().nonnegative()),
  lanes: z.record(z.string(), z.number().int().nonnegative()),
  firstEvent: CompactEventRefSchema.optional(),
  lastEvent: CompactEventRefSchema.optional(),
  artifacts: z.array(TimelineArtifactSummarySchema),
}).passthrough();

const EnrichedEventSchema = CompactEventRefSchema.extend({
  lane: z.enum(["recording", "permission", "target", "screen", "input", "accessibility", "agent", "privacy"]),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  nearestFrame: z.object({
    frameId: z.string(),
    sequence: z.number().int().nonnegative(),
    videoTimeMs: z.number().nonnegative(),
    artifactId: z.string().optional(),
  }).passthrough().optional(),
  artifact: z.object({
    artifactId: z.string(),
    kind: ArtifactKindSchema,
    mediaType: z.string(),
    path: z.string().optional(),
    relativePath: z.string().optional(),
    redactionState: ArtifactRefSchema.shape.redactionState.optional(),
  }).passthrough().optional(),
}).passthrough();

const TargetSelectionSchema = z.object({
  selected: TargetRefSchema,
  confidence: ConfidenceSchema,
  score: z.number(),
  ambiguous: z.boolean().optional(),
  requiredDisambiguators: z.array(z.string()).optional(),
  alternatives: z.array(z.object({
    target: TargetRefSchema,
    score: z.number(),
    reasons: z.array(z.string()),
  }).passthrough()),
  selector: TargetSelectorInputSchema,
}).passthrough();

const RecommendedRecordingTargetSchema = TargetRefSchema.partial().passthrough();

const ArtifactVerificationSchema = z.object({
  artifact: ArtifactRefSchema,
  verified: z.boolean().optional(),
  checks: z.record(z.string(), z.boolean()).optional(),
  actual: z.object({
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }).passthrough().optional(),
  error: z.string().optional(),
}).passthrough();

const RecordingResultOutputSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: RecordingStatusSchema,
  target: TargetRefSchema,
  paths: PathsSchema,
  primaryArtifact: ArtifactRefSchema.optional(),
  artifacts: z.array(ArtifactVerificationSchema),
  error: RunManifestSchema.shape.error.optional(),
  timeline: TimelineSummarySchema.extend({
    events: z.array(EnrichedEventSchema).optional(),
    nextAfterSequence: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  smallTextArtifacts: z.array(z.object({
    artifact: ArtifactRefSchema,
    content: z.string().optional(),
    skipped: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const RecordResolvedOutputSchema = z.object({
  runId: z.string(),
  status: RecordingStatusSchema,
  target: TargetRefSchema,
  selection: TargetSelectionSchema,
  artifact: ArtifactRefSchema.optional(),
  timeline: z.object({
    runId: z.string(),
    status: RecordingStatusSchema,
    eventCount: z.number().int().nonnegative(),
    frameCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    finalFrameArtifactId: z.string().optional(),
  }).passthrough(),
  paths: PathsSchema,
  timing: z.object({
    durationKnown: z.boolean(),
    requestedSeconds: z.number().int().positive(),
    timeRangeMs: z.tuple([z.number(), z.number()]).optional(),
  }).passthrough(),
}).passthrough();

const DoctorOutputSchema = z.object({
  ok: z.boolean(),
  recorder: BackendSchema,
  nativeCapture: z.boolean(),
  rootDir: z.string(),
  helper: RecorderHelperStatusSchema,
}).passthrough();

const ReadyOutputSchema = z.object({
  ready: z.boolean(),
  readinessLevel: z.enum(["native_recording", "diagnostic_only", "not_ready"]),
  nativeRecordingReady: z.boolean(),
  reasonCodes: z.array(z.string()),
  backend: BackendSchema,
  helper: RecorderHelperStatusSchema,
  permissions: PermissionBrokerStatusSchema,
  targetCount: z.number().int().nonnegative(),
  missingRequiredPermissions: z.array(PermissionCapabilitySchema),
  actions: z.array(z.object({
    kind: z.literal("grant_permission"),
    permission: PermissionCapabilitySchema.shape.permission,
    label: z.string(),
    settingsUrl: z.string().optional(),
  }).passthrough()),
  timing: z.object({
    defaultSeconds: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive(),
    unknownDurationMode: z.literal("start_with_safety_cap_then_stop"),
    currentNativeStopBehavior: z.string(),
    earlyStopSupported: z.boolean(),
    stopMode: z.string(),
  }).passthrough(),
  recommendedTools: z.array(z.string()),
}).passthrough();

const ContextSnapshotOutputSchema = z.object({
  snapshotId: z.string(),
  generatedAt: z.string(),
  status: RecorderHelperStatusSchema,
  coordinateSpace: z.object({
    unit: z.literal("screen_points"),
    origin: z.literal("global_display_space"),
  }).passthrough(),
  displays: z.array(TargetRefSchema),
  apps: z.array(TargetRefSchema),
  windows: z.array(TargetRefSchema),
  activeWindow: TargetRefSchema.optional(),
  counts: z.object({
    displays: z.number().int().nonnegative(),
    apps: z.number().int().nonnegative(),
    windows: z.number().int().nonnegative(),
    targets: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

const TargetSelectOutputSchema = TargetSelectionSchema.extend({
  snapshotId: z.string().optional(),
  ambiguous: z.boolean(),
  requiredDisambiguators: z.array(z.string()),
  recommendedRecordingArguments: z.object({
    target: RecommendedRecordingTargetSchema,
  }).passthrough(),
}).passthrough();

const TargetValidateOutputSchema = z.object({
  snapshotId: z.string().optional(),
  targetId: z.string(),
  valid: z.boolean(),
  target: TargetRefSchema.optional(),
  invalidations: z.array(z.string()),
  warnings: z.array(z.string()),
  capturePlan: z.object({
    mode: z.string(),
    backend: z.string(),
    outputFormat: z.string(),
    targetId: z.string(),
    args: z.array(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough();

const BeginRecordingOutputSchema = RunManifestSchema.extend({
  selection: TargetSelectionSchema,
  timing: z.object({
    durationKnown: z.literal(false),
    safetyCapSeconds: z.number().int().positive(),
    stopBehavior: z.string(),
  }).passthrough(),
}).passthrough();

const RecordCaptureOutputSchema = RecordResolvedOutputSchema.extend({
  result: RecordingResultOutputSchema,
}).passthrough();

const StatusOutputSchema = z.object({
  status: RecordingStatusSchema,
}).passthrough();

const QueryTimelineOutputSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: RecordingStatusSchema,
  events: z.array(EnrichedEventSchema),
  frames: z.array(FrameRefSchema).optional(),
  summary: TimelineSummarySchema,
  nextAfterSequence: z.number().int().nonnegative().optional(),
}).passthrough();

const ArtifactReadOutputSchema = z.object({
  artifact: ArtifactRefSchema,
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
}).passthrough();

export function createToolDefinitions(service: SporesService) {
  return [
    {
      name: "spores_doctor",
      title: "Spores Doctor",
      description: "Return local Spores health, recorder backend status, and recorder-helper status.",
      inputSchema: z.object({}),
      outputSchema: DoctorOutputSchema,
      role: "diagnostic",
      readOnly: true,
      execute: async () => service.doctor(),
    },
    {
      name: "recorder_ready",
      title: "Recorder Readiness",
      description: "Return whether the local recorder is ready for agents, including permissions, targets, and timing limitations.",
      inputSchema: ReadyInputSchema,
      outputSchema: ReadyOutputSchema,
      role: "diagnostic",
      readOnly: true,
      execute: async (input) => service.ready(input),
    },
    {
      name: "recorder_helper_status",
      title: "Recorder Helper Status",
      description: "Launch the recorder helper and return its availability and capability status.",
      inputSchema: z.object({}),
      outputSchema: RecorderHelperStatusSchema,
      role: "diagnostic",
      readOnly: true,
      execute: async () => service.helper.status(),
    },
    {
      name: "recorder_helper_list_targets",
      title: "List Recorder Targets",
      description: "Launch the recorder helper and return captureable displays, apps, and windows.",
      inputSchema: HelperTargetsInputSchema,
      outputSchema: RecorderHelperTargetsSchema,
      role: "targeting",
      readOnly: true,
      execute: async (input) => service.listTargets(input),
    },
    {
      name: "recorder_context_snapshot",
      title: "Recorder Context Snapshot",
      description: "Return a bounded snapshot of capturable displays, apps, windows, active window, and coordinate space.",
      inputSchema: ContextSnapshotInputSchema,
      outputSchema: ContextSnapshotOutputSchema,
      role: "targeting",
      readOnly: true,
      execute: async (input) => service.contextSnapshot(input),
    },
    {
      name: "recorder_target_resolve",
      title: "Resolve Recorder Target",
      description: "Resolve a fuzzy agent target selector into one capture target with scored alternatives.",
      inputSchema: ResolveTargetInputSchema,
      outputSchema: TargetSelectionSchema,
      role: "targeting",
      readOnly: true,
      execute: async (input) => service.resolveTarget(input),
    },
    {
      name: "recorder_target_select",
      title: "Select Recorder Target",
      description: "Resolve a target selector using an agent policy for confidence and ambiguity.",
      inputSchema: TargetSelectInputSchema,
      outputSchema: TargetSelectOutputSchema,
      role: "targeting",
      readOnly: true,
      execute: async (input) => service.selectTarget(input),
    },
    {
      name: "recorder_target_validate",
      title: "Validate Recorder Target",
      description: "Validate that a previously selected target still exists and return its capture plan.",
      inputSchema: TargetValidateInputSchema,
      outputSchema: TargetValidateOutputSchema,
      role: "targeting",
      readOnly: true,
      execute: async (input) => service.validateTarget(input),
    },
    {
      name: "recorder_permissions_status",
      title: "Recorder Permission Status",
      description: "Return required and optional local recording permission state.",
      inputSchema: PermissionsStatusInputSchema,
      outputSchema: PermissionBrokerStatusSchema,
      role: "permissions",
      readOnly: true,
      execute: async (input) => service.permissionsStatus(input),
    },
    {
      name: "recorder_permissions_probe",
      title: "Probe Recorder Permissions",
      description: "Run a native permission probe and return whether the current launcher can actually capture pixels.",
      inputSchema: PermissionsStatusInputSchema,
      outputSchema: PermissionBrokerStatusSchema,
      role: "permissions",
      readOnly: true,
      execute: async (input) => service.permissionsProbe(input),
    },
    {
      name: "recorder_permissions_request",
      title: "Request Recorder Permissions",
      description: "Return user-action instructions for granting missing recording permissions.",
      inputSchema: PermissionsRequestInputSchema,
      outputSchema: PermissionRequestResultSchema,
      role: "permissions",
      destructive: false,
      execute: async (input) => service.requestPermissions(input),
    },
    {
      name: "session_recording_begin",
      title: "Begin Recording Session",
      description: "Resolve a target selector and start a recording for unknown-duration tasks using a safety cap.",
      inputSchema: BeginRecordingInputSchema,
      outputSchema: BeginRecordingOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.begin(input),
    },
    {
      name: "session_recording_capture",
      title: "Capture Recording",
      description: "Preferred one-shot agent capture: select a target, record for a bounded duration, stop, and return result summary.",
      inputSchema: RecordCaptureInputSchema,
      outputSchema: RecordCaptureOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordCapture(input),
    },
    {
      name: "session_recording_record_target",
      title: "Record Target",
      description: "Resolve a target selector, record it for a fixed number of seconds, stop, and return the artifact summary.",
      inputSchema: RecordTargetInputSchema,
      outputSchema: RecordResolvedOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordTarget(input),
    },
    {
      name: "session_recording_record_window",
      title: "Record Window",
      description: "Record a matching window for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordWindowInputSchema,
      outputSchema: RecordResolvedOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordWindow(input),
    },
    {
      name: "session_recording_record_app",
      title: "Record App",
      description: "Record a matching app's visible bounds for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordAppInputSchema,
      outputSchema: RecordResolvedOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordApp(input),
    },
    {
      name: "session_recording_record_region",
      title: "Record Region",
      description: "Record explicit screen coordinates for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordRegionInputSchema,
      outputSchema: RecordResolvedOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordRegion(input),
    },
    {
      name: "session_recording_record_active_window",
      title: "Record Active Window",
      description: "Record the frontmost helper-listed window for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordActiveWindowInputSchema,
      outputSchema: RecordResolvedOutputSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.recordActiveWindow(input),
    },
    {
      name: "session_recording_start",
      title: "Start Recording Session",
      description: "Start a helper-backed recording session and create a run bundle.",
      inputSchema: StartRecordingInputSchema,
      outputSchema: RunManifestSchema,
      role: "recording",
      destructive: false,
      execute: async (input) => service.start(input),
    },
    {
      name: "session_recording_status",
      title: "Recording Status",
      description: "Return the active or requested recording status.",
      inputSchema: StatusInputSchema,
      outputSchema: StatusOutputSchema,
      role: "recording",
      readOnly: true,
      execute: async (input) => service.status(input),
    },
    {
      name: "session_recording_stop",
      title: "Stop Recording Session",
      description: "Stop the active or requested recording session.",
      inputSchema: StopInputSchema,
      outputSchema: RunManifestSchema,
      role: "recording",
      destructive: false,
      idempotent: true,
      execute: async (input) => service.stop(input),
    },
    {
      name: "session_recording_append_event",
      title: "Append Recording Event",
      description: "Append an agent event to the active run's event stream.",
      inputSchema: AppendEventInputSchema,
      outputSchema: SporesEventSchema,
      role: "annotation",
      destructive: false,
      execute: async (input) => service.appendEvent(input),
    },
    {
      name: "session_recording_append_agent_step",
      title: "Append Agent Step",
      description: "Append a structured agent decision, action, observation, or assertion event to a run.",
      inputSchema: AppendAgentStepInputSchema,
      outputSchema: SporesEventSchema,
      role: "annotation",
      destructive: false,
      execute: async (input) => service.appendAgentStep(input),
    },
    {
      name: "session_recording_get_timeline",
      title: "Get Recording Timeline",
      description: "Read the normalized timeline for a run bundle.",
      inputSchema: TimelineInputSchema,
      outputSchema: TimelineSchema,
      role: "timeline",
      readOnly: true,
      execute: async (input) => service.timeline(input),
    },
    {
      name: "session_recording_query_timeline",
      title: "Query Recording Timeline",
      description: "Page and search a run timeline with compact event summaries and optional payloads/frames.",
      inputSchema: TimelineQueryInputSchema,
      outputSchema: QueryTimelineOutputSchema,
      role: "timeline",
      readOnly: true,
      execute: async (input) => service.queryTimeline(input),
    },
    {
      name: "session_recording_result",
      title: "Recording Result",
      description: "Return a bounded run result with artifact verification and optional timeline details.",
      inputSchema: RecordingResultInputSchema,
      outputSchema: RecordingResultOutputSchema,
      role: "timeline",
      readOnly: true,
      execute: async (input) => service.recordingResult(input),
    },
    {
      name: "session_recording_get_artifact",
      title: "Get Recording Artifact",
      description: "Return artifact metadata and small text artifact content.",
      inputSchema: ArtifactInputSchema,
      outputSchema: ArtifactReadOutputSchema,
      role: "artifact",
      readOnly: true,
      execute: async (input) => service.artifact(input),
    },
    {
      name: "session_recording_read_artifact",
      title: "Read Recording Artifact",
      description: "Read an artifact as metadata, bounded text, or bounded base64 content.",
      inputSchema: ArtifactReadInputSchema,
      outputSchema: ArtifactReadOutputSchema,
      role: "artifact",
      readOnly: true,
      execute: async (input) => service.readArtifact(input),
    },
  ] satisfies ToolDefinition[];
}

export function mcpOk(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: toStructuredContent(value),
  };
}

export function mcpError(error: unknown): CallToolResult {
  const value = error instanceof SporesServiceError
    ? {
        error: error.code,
        message: error.message,
        retriable: error.retriable,
        requiresUserAction: error.requiresUserAction,
        details: error.details,
      }
    : error instanceof z.ZodError
    ? {
        error: "invalid_input",
        message: z.prettifyError(error),
        retriable: false,
        requiresUserAction: false,
        details: { issues: error.issues },
      }
    : error instanceof Error
    ? { error: "internal_error", message: error.message, retriable: false, requiresUserAction: false }
    : { error: "internal_error", message: String(error), retriable: false, requiresUserAction: false };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

function toStructuredContent(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return { value };
}
