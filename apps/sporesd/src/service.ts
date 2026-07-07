import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FakeRecorder } from "@spores/fake-recorder";
import {
  ArtifactRef,
  ArtifactRefSchema,
  BoundsSchema,
  EventTypeSchema,
  FrameRef,
  PermissionBrokerStatus,
  RecorderHelperTargets,
  RecorderHelperSession,
  RunManifest,
  SporesEvent,
  SporesEventSchema,
  TargetRef,
  TargetRefSchema,
  createSporesId,
  monotonicTimeNs,
  nowIso,
} from "@spores/schema";
import { RunStore } from "@spores/store";
import { createRecorderHelperClient, RecorderHelperClient, RecorderHelperSessionInput } from "./recorderHelper.js";

const TargetInputSchema = TargetRefSchema.partial().extend({
  mode: z.enum(["fake", "picker"]).optional(),
});

const CaptureInputSchema = z.object({
  mode: z.enum(["synthetic", "native"]).default("synthetic"),
  maxDurationSeconds: z.number().int().min(1).max(30).default(2),
});

const TargetKindSchema = z.enum(["display", "window", "app", "region", "fake"]);
const ConfidenceSchema = z.enum(["low", "medium", "high"]);

export const TargetSelectorInputSchema = z.object({
  targetId: z.string().optional(),
  kind: TargetKindSchema.optional(),
  displayId: z.string().optional(),
  app: z.string().optional(),
  bundleId: z.string().optional(),
  titleIncludes: z.string().optional(),
  bounds: BoundsSchema.optional(),
  prefer: z.enum(["frontmost", "largest", "exact"]).default("frontmost"),
});

const OneShotTimingInputSchema = z.object({
  seconds: z.number().int().min(1).max(30).default(5),
});

export const ReadyInputSchema = z.object({});

export const ResolveTargetInputSchema = TargetSelectorInputSchema;

const TargetPolicyInputSchema = z.object({
  minConfidence: ConfidenceSchema.default("medium"),
  failOnAmbiguous: z.boolean().default(true),
  ambiguityMargin: z.number().int().min(0).max(100).default(10),
  maxAlternatives: z.number().int().min(0).max(20).default(5),
});

export const TargetSelectInputSchema = z.object({
  snapshotId: z.string().optional(),
  selector: TargetSelectorInputSchema.optional(),
  targetPolicy: TargetPolicyInputSchema.optional(),
});

export const TargetValidateInputSchema = z.object({
  snapshotId: z.string().optional(),
  targetId: z.string(),
});

export const ContextSnapshotInputSchema = z.object({});

export const BeginRecordingInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  target: TargetSelectorInputSchema.optional(),
  safetyCapSeconds: z.number().int().min(1).max(30).default(30),
  captureMode: z.enum(["synthetic", "native"]).default("native"),
});

export const RecordTargetInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  target: TargetSelectorInputSchema.optional(),
}).merge(OneShotTimingInputSchema);

export const RecordCaptureInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  snapshotId: z.string().optional(),
  target: TargetSelectorInputSchema.optional(),
  captureMode: z.enum(["synthetic", "native"]).default("native"),
  targetPolicy: TargetPolicyInputSchema.optional(),
  result: z.object({
    includeTimeline: z.enum(["none", "summary", "events"]).default("summary"),
    verifyArtifacts: z.boolean().default(true),
  }).optional(),
}).merge(OneShotTimingInputSchema);

export const RecordWindowInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  targetId: z.string().optional(),
  app: z.string().optional(),
  bundleId: z.string().optional(),
  titleIncludes: z.string().optional(),
  displayId: z.string().optional(),
  prefer: z.enum(["frontmost", "largest", "exact"]).default("frontmost"),
}).merge(OneShotTimingInputSchema);

export const RecordAppInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  targetId: z.string().optional(),
  app: z.string().optional(),
  bundleId: z.string().optional(),
  displayId: z.string().optional(),
  prefer: z.enum(["frontmost", "largest", "exact"]).default("frontmost"),
}).merge(OneShotTimingInputSchema);

export const RecordRegionInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  targetId: z.string().optional(),
  bounds: BoundsSchema,
}).merge(OneShotTimingInputSchema);

export const RecordActiveWindowInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
}).merge(OneShotTimingInputSchema);

export const StartRecordingInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  target: TargetInputSchema.optional(),
  capture: CaptureInputSchema.optional(),
});

export const StatusInputSchema = z.object({
  runId: z.string().optional(),
});

export const StopInputSchema = z.object({
  runId: z.string().optional(),
});

export const AppendEventInputSchema = z.object({
  runId: z.string(),
  type: SporesEventSchema.shape.type,
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const AppendAgentStepInputSchema = z.object({
  runId: z.string(),
  stepId: z.string().min(1).max(200),
  kind: z.enum(["decision", "action", "observation", "assertion"]),
  summary: z.string().min(1).max(4_000),
  details: z.record(z.string(), z.unknown()).default({}),
  assertion: z.object({
    expected: z.string().max(8_000),
    actual: z.string().max(8_000),
    status: z.enum(["passed", "failed", "unknown"]),
  }).optional(),
}).superRefine((input, context) => {
  if (input.kind === "assertion" && !input.assertion) {
    context.addIssue({
      code: "custom",
      path: ["assertion"],
      message: "assertion is required when kind is assertion",
    });
  }
  const reservedKeys = ["stepId", "kind", "summary", "assertion"];
  for (const key of reservedKeys) {
    if (Object.hasOwn(input.details, key)) {
      context.addIssue({
        code: "custom",
        path: ["details", key],
        message: `details.${key} is reserved`,
      });
    }
  }
  const encoded = JSON.stringify(input.details);
  if (encoded.length > 64_000) {
    context.addIssue({
      code: "custom",
      path: ["details"],
      message: "details must be 64000 JSON characters or less",
    });
  }
});

export const TimelineInputSchema = z.object({
  runId: z.string(),
});

export const ArtifactInputSchema = z.object({
  runId: z.string(),
  artifactId: z.string(),
});

export const RecordingResultInputSchema = z.object({
  runId: z.string(),
  includeTimeline: z.enum(["none", "summary", "events"]).default("summary"),
  eventTypes: z.array(EventTypeSchema).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  includePayloads: z.boolean().default(false),
  verifyArtifacts: z.boolean().default(true),
  includeSmallTextArtifacts: z.boolean().default(false),
});

export const TimelineQueryInputSchema = z.object({
  runId: z.string(),
  afterSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  eventTypes: z.array(EventTypeSchema).optional(),
  query: z.string().optional(),
  includePayloads: z.boolean().default(false),
  includeFrames: z.boolean().default(false),
  frameLimit: z.number().int().min(1).max(500).default(100),
});

export const ArtifactReadInputSchema = z.object({
  runId: z.string(),
  artifactId: z.string(),
  contentMode: z.enum(["metadata", "text", "base64"]).default("metadata"),
  maxBytes: z.number().int().min(1).max(1_000_000).default(64_000),
});

export const HelperTargetsInputSchema = z.object({});

export const PermissionsStatusInputSchema = z.object({});

export const PermissionsRequestInputSchema = z.object({});

export type RecorderBackend = "helper" | "fake";

export type SporesServiceOptions = {
  rootDir?: string;
  helper?: RecorderHelperClient;
  backend?: RecorderBackend;
};

type TargetSelection = {
  selected: TargetRef;
  confidence: "high" | "medium" | "low";
  score: number;
  ambiguous?: boolean;
  requiredDisambiguators?: string[];
  alternatives: Array<{
    target: TargetRef;
    score: number;
    reasons: string[];
  }>;
  selector: z.infer<typeof TargetSelectorInputSchema>;
};

export class SporesServiceError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly requiresUserAction: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(input: {
    code: string;
    message: string;
    retriable: boolean;
    requiresUserAction: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "SporesServiceError";
    this.code = input.code;
    this.retriable = input.retriable;
    this.requiresUserAction = input.requiresUserAction;
    this.details = input.details;
  }
}

export class SporesService {
  readonly store: RunStore;
  readonly recorder: FakeRecorder;
  readonly helper: RecorderHelperClient;
  readonly backend: RecorderBackend;
  private activeHelperRunId: string | undefined;
  private readonly targetSnapshots = new Map<string, RecorderHelperTargets>();

  constructor(options: SporesServiceOptions = {}) {
    this.store = new RunStore(options.rootDir);
    this.recorder = new FakeRecorder(this.store);
    this.helper = options.helper ?? createRecorderHelperClient();
    this.backend = options.backend ?? parseRecorderBackend(process.env.SPORES_RECORDER_BACKEND);
  }

  async doctor() {
    const recorder = await this.recorder.doctor();
    const helper = await this.helper.status();
    return {
      ...recorder,
      recorder: this.backend,
      helper,
    };
  }

  async ready(_input: z.infer<typeof ReadyInputSchema> = {}) {
    const [doctor, permissions, targets] = await Promise.all([
      this.doctor(),
      this.permissionsProbe(),
      this.listTargets(),
    ]);
    const missingRequiredPermissions = permissions.capabilities.filter((capability) => (
      capability.required && capability.status !== "granted"
    ));
    const ready = doctor.helper.available && !permissions.requiresUserAction && targets.targets.length > 0;

    return {
      ready,
      readinessLevel: ready ? (permissions.mode === "native_probe" ? "native_recording" : "diagnostic_only") : "not_ready",
      nativeRecordingReady: ready && permissions.mode === "native_probe",
      reasonCodes: readinessReasonCodes({
        helperAvailable: doctor.helper.available,
        permissionRequiresUserAction: permissions.requiresUserAction,
        targetCount: targets.targets.length,
        permissionsMode: permissions.mode,
      }),
      backend: this.backend,
      helper: doctor.helper,
      permissions,
      targetCount: targets.targets.length,
      missingRequiredPermissions,
      actions: missingRequiredPermissions.map((capability) => ({
        kind: "grant_permission",
        permission: capability.permission,
        label: capability.label,
        settingsUrl: capability.settingsUrl,
      })),
      timing: {
        defaultSeconds: 5,
        maxDurationSeconds: 30,
        unknownDurationMode: "start_with_safety_cap_then_stop",
        currentNativeStopBehavior: "macos_screencapture_finalizes_at_the_safety_cap; stop waits for the artifact",
        earlyStopSupported: false,
        stopMode: "timed_cap",
      },
      recommendedTools: ready
        ? [
          "recorder_context_snapshot",
          "recorder_target_select",
          "session_recording_capture",
          "session_recording_record_region",
          "session_recording_begin",
          "session_recording_stop",
        ]
        : ["recorder_permissions_probe", "recorder_permissions_request"],
    };
  }

  async resolveTarget(input: z.infer<typeof ResolveTargetInputSchema>) {
    return this.resolveTargetSelection(input);
  }

  async contextSnapshot(_input: z.infer<typeof ContextSnapshotInputSchema> = {}) {
    const targets = await this.listTargets();
    const snapshotId = createSporesId("snap");
    this.rememberTargetSnapshot(snapshotId, targets);
    const displays = targets.targets.filter((target) => target.kind === "display");
    const apps = targets.targets.filter((target) => target.kind === "app");
    const windows = targets.targets.filter((target) => target.kind === "window");
    const activeWindow = [...windows].sort((left, right) => (
      (left.zOrder ?? 999_999) - (right.zOrder ?? 999_999)
    ))[0];

    return {
      snapshotId,
      generatedAt: nowIso(),
      status: targets.status,
      coordinateSpace: {
        unit: "screen_points",
        origin: "global_display_space",
      },
      displays,
      apps,
      windows,
      activeWindow,
      counts: {
        displays: displays.length,
        apps: apps.length,
        windows: windows.length,
        targets: targets.targets.length,
      },
    };
  }

  async selectTarget(input: z.infer<typeof TargetSelectInputSchema>) {
    const selector = TargetSelectorInputSchema.parse(input.selector ?? {});
    const policy = TargetPolicyInputSchema.parse(input.targetPolicy ?? {});
    const selection = await this.resolveTargetSelection(selector, policy.maxAlternatives, input.snapshotId);
    const policyResult = evaluateTargetPolicy(selection, policy);

    if (!policyResult.ok) {
      throw new SporesServiceError({
        code: policyResult.code,
        message: policyResult.message,
        retriable: true,
        requiresUserAction: false,
        details: {
          selector,
          selected: selection.selected,
          confidence: selection.confidence,
          score: selection.score,
          ambiguous: policyResult.ambiguous,
          alternatives: selection.alternatives,
          requiredDisambiguators: policyResult.requiredDisambiguators,
        },
      });
    }

    return {
      ...selection,
      snapshotId: input.snapshotId,
      ambiguous: policyResult.ambiguous,
      requiredDisambiguators: policyResult.requiredDisambiguators,
      recommendedRecordingArguments: {
        target: selector.kind === "region" || selector.bounds
          ? selector
          : { targetId: selection.selected.targetId },
      },
    };
  }

  async validateTarget(input: z.infer<typeof TargetValidateInputSchema>) {
    const targets = await this.targetsForSnapshot(input.snapshotId);
    const target = targets.targets.find((candidate) => candidate.targetId === input.targetId);
    const invalidations: string[] = [];
    const warnings: string[] = [];
    if (!target) {
      invalidations.push("target_not_found");
    }
    if (target) {
      invalidations.push(...nativeCaptureBlockers(target));
    }
    if (target?.kind === "app" && !target.window?.id && invalidations.length === 0) {
      warnings.push("app_region_capture_may_include_overlapping_windows");
    }

    return {
      snapshotId: input.snapshotId,
      targetId: input.targetId,
      valid: invalidations.length === 0,
      target,
      invalidations,
      warnings,
      capturePlan: target ? capturePlanForTarget(target) : undefined,
    };
  }

  async begin(input: z.infer<typeof BeginRecordingInputSchema>) {
    const resolved = await this.resolveTargetSelection(TargetSelectorInputSchema.parse(input.target ?? {}));
    const manifest = await this.start({
      runId: input.runId,
      purpose: input.purpose ?? `agent recording: ${targetLabel(resolved.selected)}`,
      target: resolved.selected,
      capture: {
        mode: input.captureMode,
        maxDurationSeconds: input.safetyCapSeconds,
      },
    });

    return {
      ...manifest,
      selection: resolved,
      timing: {
        durationKnown: false,
        safetyCapSeconds: input.safetyCapSeconds,
        stopBehavior: "stop finalizes immediately for synthetic capture; current macOS native capture waits until the safety cap file is complete",
      },
    };
  }

  async recordTarget(input: z.infer<typeof RecordTargetInputSchema>) {
    const resolved = await this.resolveTargetSelection(TargetSelectorInputSchema.parse(input.target ?? {}));
    return this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent one-shot recording: ${targetLabel(resolved.selected)}`,
      target: resolved.selected,
      seconds: input.seconds,
      captureMode: "native",
      selection: resolved,
    });
  }

  async recordCapture(input: z.infer<typeof RecordCaptureInputSchema>) {
    const selection = await this.selectTarget({
      selector: input.target,
      snapshotId: input.snapshotId,
      targetPolicy: input.targetPolicy,
    });
    const recorded = await this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent capture: ${targetLabel(selection.selected)}`,
      target: selection.selected,
      seconds: input.seconds,
      captureMode: input.captureMode,
      selection,
    });
    const resultOptions = input.result ?? {
      includeTimeline: "summary" as const,
      verifyArtifacts: true,
    };
    const result = await this.recordingResult({
      runId: recorded.runId,
      includeTimeline: resultOptions.includeTimeline,
      verifyArtifacts: resultOptions.verifyArtifacts,
      includeSmallTextArtifacts: false,
      limit: 100,
      includePayloads: false,
    });
    return {
      ...recorded,
      result,
    };
  }

  async recordWindow(input: z.infer<typeof RecordWindowInputSchema>) {
    const resolved = await this.resolveTargetSelection({
      targetId: input.targetId,
      kind: "window",
      app: input.app,
      bundleId: input.bundleId,
      titleIncludes: input.titleIncludes,
      displayId: input.displayId,
      prefer: input.prefer,
    });
    return this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent window recording: ${targetLabel(resolved.selected)}`,
      target: resolved.selected,
      seconds: input.seconds,
      captureMode: "native",
      selection: resolved,
    });
  }

  async recordApp(input: z.infer<typeof RecordAppInputSchema>) {
    const resolved = await this.resolveTargetSelection({
      targetId: input.targetId,
      kind: "app",
      app: input.app,
      bundleId: input.bundleId,
      displayId: input.displayId,
      prefer: input.prefer,
    });
    return this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent app recording: ${targetLabel(resolved.selected)}`,
      target: resolved.selected,
      seconds: input.seconds,
      captureMode: "native",
      selection: resolved,
    });
  }

  async recordRegion(input: z.infer<typeof RecordRegionInputSchema>) {
    const target = TargetRefSchema.parse({
      targetId: input.targetId ?? `region:${input.bounds.x},${input.bounds.y},${input.bounds.width},${input.bounds.height}`,
      kind: "region",
      bounds: input.bounds,
      safeToPersist: true,
    });
    return this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent region recording: ${formatBounds(input.bounds)}`,
      target,
      seconds: input.seconds,
      captureMode: "native",
      selection: {
        selected: target,
        confidence: "high" as const,
        score: 100,
        alternatives: [],
        selector: {
          kind: "region" as const,
          bounds: input.bounds,
          prefer: "exact" as const,
        },
      },
    });
  }

  async recordActiveWindow(input: z.infer<typeof RecordActiveWindowInputSchema>) {
    const resolved = await this.resolveTargetSelection({
      kind: "window",
      prefer: "frontmost",
    });
    return this.recordResolvedTarget({
      runId: input.runId,
      purpose: input.purpose ?? `agent active-window recording: ${targetLabel(resolved.selected)}`,
      target: resolved.selected,
      seconds: input.seconds,
      captureMode: "native",
      selection: resolved,
    });
  }

  async start(input: z.infer<typeof StartRecordingInputSchema>) {
    if (this.backend === "fake") {
      return this.recorder.start(input);
    }

    const capture = input.capture ? CaptureInputSchema.parse(input.capture) : undefined;
    const permissions = await this.ensureRequiredPermissions(capture?.mode === "native");
    const target = await this.resolveHelperTarget(input.target);
    if (capture?.mode === "native") {
      this.ensureNativeCaptureTarget(target);
    }
    const manifest = await this.store.createRun({
      runId: input.runId,
      target,
      permissionSnapshot: permissions.snapshot,
    });

    try {
      const result = await this.helper.startSession(this.toHelperSessionInput(manifest, {
        purpose: input.purpose,
        capture,
      }));
      this.activeHelperRunId = manifest.runId;
      return this.syncManifestFromBundle(manifest.runId, result);
    } catch (error) {
      await this.markRunFailed(manifest.runId, error);
      throw error;
    }
  }

  async status(input: z.infer<typeof StatusInputSchema>) {
    if (this.backend === "fake") {
      if (input.runId) {
        return this.store.readManifest(input.runId);
      }
      const active = await this.recorder.status();
      if (active.status !== "idle") {
        return active;
      }
      return (await this.store.readLatestManifest()) ?? active;
    }

    if (input.runId) {
      return this.readRecoverableManifest(input.runId);
    }

    if (this.activeHelperRunId) {
      return this.readRecoverableManifest(this.activeHelperRunId);
    }

    const latest = await this.store.readLatestManifest();
    if (!latest) {
      return { status: "idle" as const };
    }
    return this.readRecoverableManifest(latest.runId);
  }

  async stop(input: z.infer<typeof StopInputSchema>) {
    if (this.backend === "fake") {
      return this.recorder.stop(input.runId);
    }

    const runId = input.runId ?? this.activeHelperRunId;
    if (!runId) {
      throw new Error("no active recording");
    }

    const manifest = await this.store.readManifest(runId);
    if (manifest.status === "complete" || manifest.status === "stopped") {
      return manifest;
    }
    if (manifest.status !== "recording") {
      return manifest;
    }
    if (this.activeHelperRunId !== runId) {
      return this.recoverPersistedRecording(runId);
    }

    const result = await this.helper.stopSession(this.toHelperSessionInput(manifest));
    this.activeHelperRunId = undefined;
    return this.syncManifestFromBundle(runId, result);
  }

  async appendEvent(input: z.infer<typeof AppendEventInputSchema>) {
    const manifest = await this.store.readManifest(input.runId);
    return this.store.appendEvent(SporesEventSchema.parse({
      schemaVersion: 1,
      eventId: createSporesId("evt"),
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      sequence: manifest.eventCount,
      type: input.type,
      wallTime: nowIso(),
      monotonicTimeNs: monotonicTimeNs(),
      source: "agent",
      payload: input.payload,
    }));
  }

  appendAgentStep(input: z.infer<typeof AppendAgentStepInputSchema>) {
    const eventType = {
      decision: "agent.decision",
      action: "agent.action",
      observation: "agent.observation",
      assertion: "agent.assertion",
    }[input.kind] as SporesEvent["type"];
    return this.appendEvent({
      runId: input.runId,
      type: eventType,
      payload: {
        ...input.details,
        stepId: input.stepId,
        summary: input.summary,
        ...(input.assertion ? { assertion: input.assertion, ...input.assertion } : {}),
      },
    });
  }

  timeline(input: z.infer<typeof TimelineInputSchema>) {
    return this.store.readTimeline(input.runId);
  }

  async artifact(input: z.infer<typeof ArtifactInputSchema>) {
    const manifest = await this.store.readManifest(input.runId);
    const artifact = manifest.artifacts.find((candidate) => candidate.artifactId === input.artifactId);
    if (artifact && !artifactIsSmallText(artifact)) {
      throw new SporesServiceError({
        code: "artifact_not_text",
        message: `Artifact ${artifact.artifactId} is ${artifact.mediaType}; use session_recording_read_artifact with contentMode=metadata or base64.`,
        retriable: false,
        requiresUserAction: false,
        details: {
          artifact,
          recommendedTool: "session_recording_read_artifact",
          recommendedContentMode: "metadata",
        },
      });
    }
    return this.readArtifact({ ...input, contentMode: "text", maxBytes: 64_000 });
  }

  async readArtifact(input: z.infer<typeof ArtifactReadInputSchema>) {
    const manifest = await this.store.readManifest(input.runId);
    const artifact = manifest.artifacts.find((candidate) => candidate.artifactId === input.artifactId);
    if (!artifact) {
      throw new SporesServiceError({
        code: "artifact_not_found",
        message: `Artifact not found: ${input.artifactId}`,
        retriable: false,
        requiresUserAction: false,
      });
    }
    if (input.contentMode === "metadata") {
      return { artifact };
    }

    const content = await readFile(artifact.path);
    if (content.byteLength > input.maxBytes) {
      throw new SporesServiceError({
        code: "artifact_too_large",
        message: `Artifact ${artifact.artifactId} is ${content.byteLength} bytes, which exceeds maxBytes=${input.maxBytes}.`,
        retriable: false,
        requiresUserAction: false,
        details: {
          artifact,
          bytes: content.byteLength,
          maxBytes: input.maxBytes,
          recommendedContentMode: "metadata",
        },
      });
    }
    return input.contentMode === "base64"
      ? { artifact, contentBase64: content.toString("base64"), encoding: "base64" }
      : { artifact, content: content.toString("utf8"), encoding: "utf8" };
  }

  async recordingResult(input: z.infer<typeof RecordingResultInputSchema>) {
    const manifest = await this.store.readManifest(input.runId);
    const timeline = await this.store.readTimeline(input.runId);
    const artifacts = input.verifyArtifacts
      ? await Promise.all(manifest.artifacts.map((artifact) => verifyArtifact(artifact)))
      : manifest.artifacts.map((artifact) => ({ artifact, verified: undefined }));
    const primaryArtifact = manifest.artifacts.find((artifact) => artifact.kind === "video") ?? manifest.artifacts[0];
    const filteredEvents = input.eventTypes
      ? timeline.events.filter((event) => input.eventTypes!.includes(event.type))
      : timeline.events;
    const limitedEvents = filteredEvents.slice(0, input.limit);

    return {
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      status: manifest.status,
      target: manifest.target,
      paths: manifest.paths,
      primaryArtifact,
      artifacts,
      error: manifest.error,
      timeline: input.includeTimeline === "none"
        ? undefined
        : input.includeTimeline === "events"
        ? {
            ...summarizeTimeline(filteredEvents, timeline.frames, timeline.artifacts),
            events: limitedEvents.map((event) => enrichEvent(event, timeline.frames, timeline.artifacts, {
              includePayload: input.includePayloads,
            })),
            nextAfterSequence: filteredEvents.length > limitedEvents.length ? limitedEvents.at(-1)?.sequence : undefined,
          }
        : summarizeTimeline(filteredEvents, timeline.frames, timeline.artifacts),
      smallTextArtifacts: input.includeSmallTextArtifacts
        ? await readSmallTextArtifacts(manifest.artifacts)
        : undefined,
    };
  }

  async queryTimeline(input: z.infer<typeof TimelineQueryInputSchema>) {
    const timeline = await this.store.readTimeline(input.runId);
    const normalizedQuery = input.query?.trim().toLowerCase();
    const filtered = timeline.events
      .filter((event) => input.afterSequence === undefined || event.sequence > input.afterSequence)
      .filter((event) => !input.eventTypes || input.eventTypes.includes(event.type))
      .filter((event) => !normalizedQuery || eventSearchText(event).includes(normalizedQuery));
    const events = filtered.slice(0, input.limit);
    const next = filtered.length > input.limit ? events.at(-1)?.sequence : undefined;

    return {
      runId: timeline.runId,
      sessionId: timeline.sessionId,
      status: timeline.status,
      events: events.map((event) => enrichEvent(event, timeline.frames, timeline.artifacts, {
        includePayload: input.includePayloads,
      })),
      frames: input.includeFrames ? timeline.frames.slice(0, input.frameLimit) : undefined,
      summary: summarizeTimeline(filtered, timeline.frames, timeline.artifacts),
      nextAfterSequence: next,
    };
  }

  listTargets(_input: z.infer<typeof HelperTargetsInputSchema> = {}) {
    return this.helper.listTargets();
  }

  permissionsStatus(_input: z.infer<typeof PermissionsStatusInputSchema> = {}) {
    return this.helper.permissionsStatus();
  }

  requestPermissions(_input: z.infer<typeof PermissionsRequestInputSchema> = {}) {
    return this.helper.requestPermissions();
  }

  permissionsProbe(_input: z.infer<typeof PermissionsStatusInputSchema> = {}) {
    return this.helper.permissionsProbe();
  }

  private async recordResolvedTarget(input: {
    runId?: string;
    purpose: string;
    target: TargetRef;
    seconds: number;
    captureMode: "synthetic" | "native";
    selection: TargetSelection;
  }) {
    const started = await this.start({
      runId: input.runId,
      purpose: input.purpose,
      target: input.target,
      capture: {
        mode: input.captureMode,
        maxDurationSeconds: input.seconds,
      },
    });
    const stopped = await this.stop({ runId: started.runId });
    const timeline = await this.timeline({ runId: started.runId });
    const artifact = stopped.artifacts.find((candidate) => candidate.kind === "video") ?? stopped.artifacts[0];

    return {
      runId: stopped.runId,
      status: stopped.status,
      target: stopped.target,
      selection: input.selection,
      artifact,
      timeline: {
        runId: timeline.runId,
        status: timeline.status,
        eventCount: timeline.events.length,
        frameCount: timeline.frames.length,
        artifactCount: timeline.artifacts.length,
        finalFrameArtifactId: timeline.frames.at(-1)?.artifactId,
      },
      paths: stopped.paths,
      timing: {
        durationKnown: true,
        requestedSeconds: input.seconds,
        timeRangeMs: artifact?.timeRangeMs,
      },
    };
  }

  private async resolveTargetSelection(
    selector: z.infer<typeof TargetSelectorInputSchema>,
    maxAlternatives = 5,
    snapshotId?: string,
  ): Promise<TargetSelection> {
    if (selector.kind === "region" || selector.bounds) {
      const bounds = selector.bounds;
      if (!bounds) {
        throw new SporesServiceError({
          code: "invalid_target_selector",
          message: "Region target selectors require bounds.",
          retriable: false,
          requiresUserAction: false,
        });
      }
      const selected = TargetRefSchema.parse({
        targetId: selector.targetId ?? `region:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
        kind: "region",
        displayId: selector.displayId,
        bounds,
        safeToPersist: true,
      });
      return {
        selected,
        confidence: "high",
        score: 100,
        alternatives: [],
        selector: { ...selector, kind: "region", prefer: selector.prefer ?? "exact" },
      };
    }

    const targets = await this.targetsForSnapshot(snapshotId);
    const ranked = rankTargets(targets, selector);
    const best = ranked[0];
    if (!best) {
      throw new SporesServiceError({
        code: "target_not_found",
        message: "No capture target matched the selector.",
        retriable: true,
        requiresUserAction: false,
        details: { selector, targetCount: targets.targets.length },
      });
    }

    return {
      selected: best.target,
      confidence: targetConfidence(best.score, selector),
      score: best.score,
      ambiguous: targetAmbiguous(best.score, ranked[1]?.score),
      requiredDisambiguators: requiredTargetDisambiguators(selector),
      alternatives: ranked.slice(1, maxAlternatives + 1),
      selector,
    };
  }

  private async readRecoverableManifest(runId: string): Promise<RunManifest> {
    const manifest = await this.store.readManifest(runId);
    if (manifest.status !== "recording") {
      return manifest;
    }
    if (this.activeHelperRunId !== runId) {
      return this.recoverPersistedRecording(runId);
    }

    const result = await this.helper.getSessionStatus(this.toHelperSessionInput(manifest));
    return this.syncManifestFromBundle(runId, result);
  }

  private async syncManifestFromBundle(runId: string, result: RecorderHelperSession): Promise<RunManifest> {
    const [events, frames] = await Promise.all([
      this.store.readEvents(runId),
      this.store.readFrames(runId),
    ]);
    return this.store.updateManifest(runId, (current) => ({
      ...current,
      status: result.status,
      eventCount: events.length,
      frameCount: frames.length,
      artifacts: mergeArtifacts(current.artifacts, result.artifacts),
      error: undefined,
    }));
  }

  private async recoverPersistedRecording(runId: string): Promise<RunManifest> {
    const [events, frames] = await Promise.all([
      this.store.readEvents(runId),
      this.store.readFrames(runId),
    ]);
    const stopped = events.some((event) => event.type === "recording.stopped");
    if (stopped) {
      const artifacts = await this.recoverHelperArtifacts(runId);
      return this.store.updateManifest(runId, (current) => ({
        ...current,
        status: "complete",
        eventCount: events.length,
        frameCount: frames.length,
        artifacts: mergeArtifacts(current.artifacts, artifacts),
        error: undefined,
      }));
    }

    return this.store.updateManifest(runId, (current) => ({
      ...current,
      status: "partial",
      eventCount: events.length,
      frameCount: frames.length,
      error: {
        code: "stale_recording",
        message: "Recording was left active without a live helper session and was marked partial.",
        retriable: false,
        requiresUserAction: false,
      },
    }));
  }

  private async recoverHelperArtifacts(runId: string): Promise<ArtifactRef[]> {
    const manifest = await this.store.readManifest(runId);
    const existing = manifest.artifacts.filter((artifact) => artifact.path.length > 0);
    if (existing.length > 0) {
      return existing;
    }

    const nativeTimeRangeMs: [number, number] = [
      0,
      await recoverNativeCaptureDurationMs(manifest.paths.runDir),
    ];
    const nativeArtifact = await recoverArtifact({
      path: path.join(manifest.paths.artifactsDir, "capture.mp4"),
      artifactIdPrefix: "art_native",
      kind: "video",
      mediaType: "video/mp4",
      redactionState: "raw",
      timeRangeMs: nativeTimeRangeMs,
    }) ?? await recoverArtifact({
      path: path.join(manifest.paths.artifactsDir, "capture.mov"),
      artifactIdPrefix: "art_native",
      kind: "video",
      mediaType: "video/quicktime",
      redactionState: "raw",
      timeRangeMs: nativeTimeRangeMs,
    });
    if (nativeArtifact) {
      return [nativeArtifact];
    }

    const syntheticArtifact = await recoverArtifact({
      path: path.join(manifest.paths.artifactsDir, "helper-capture.txt"),
      artifactIdPrefix: "art_recovered",
      kind: "text",
      mediaType: "text/plain",
      redactionState: "not_required",
      timeRangeMs: [0, 1000],
    });
    return syntheticArtifact ? [syntheticArtifact] : [];
  }

  private async ensureRequiredPermissions(useNativeProbe = false): Promise<PermissionBrokerStatus> {
    const status = useNativeProbe ? await this.permissionsProbe() : await this.permissionsStatus();
    if (status.error) {
      throw new SporesServiceError({
        code: status.error.code,
        message: status.error.message,
        retriable: status.error.retriable,
        requiresUserAction: status.error.requiresUserAction,
        details: status.error.details,
      });
    }
    if (!status.requiresUserAction) {
      return status;
    }

    const missing = status.capabilities.filter((capability) => (
      capability.required && capability.status !== "granted"
    ));
    throw new SporesServiceError({
      code: "missing_permission",
      message: `Required recording permissions are not granted: ${missing.map((capability) => capability.label).join(", ")}`,
      retriable: true,
      requiresUserAction: true,
      details: {
        permissions: missing.map((capability) => ({
          permission: capability.permission,
          label: capability.label,
          status: capability.status,
          settingsUrl: capability.settingsUrl,
        })),
      },
    });
  }

  private async markRunFailed(runId: string, error: unknown): Promise<RunManifest> {
    return this.store.updateManifest(runId, (current) => ({
      ...current,
      status: "failed",
      error: {
        code: "helper_start_failed",
        message: error instanceof Error ? error.message : String(error),
        retriable: true,
        requiresUserAction: false,
      },
    }));
  }

  private async resolveHelperTarget(target?: z.infer<typeof TargetInputSchema>): Promise<TargetRef> {
    if (target?.mode === "fake" || target?.kind === "fake") {
      return TargetRefSchema.parse({
        targetId: target.targetId ?? "target:helper-synthetic",
        kind: "fake",
        displayId: target.displayId ?? "helper-display",
        app: target.app ?? {
          name: "Spores Helper Synthetic App",
          bundleId: "dev.spores.helper.synthetic",
        },
        window: target.window ?? {
          id: "helper-synthetic-window",
          title: "Spores Helper Synthetic Recording",
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
        },
        safeToPersist: target.safeToPersist ?? true,
      });
    }

    if (target?.kind === "region" && target.bounds) {
      return TargetRefSchema.parse({
        ...stripTargetMode(target),
        targetId: target.targetId ?? `region:${formatBounds(target.bounds)}`,
        kind: "region",
        bounds: target.bounds,
        safeToPersist: target.safeToPersist ?? true,
      });
    }

    const targets = await this.helper.listTargets();
    const selected = target?.targetId
      ? targets.targets.find((candidate) => candidate.targetId === target.targetId)
      : targets.targets[0];
    if (!selected) {
      throw new SporesServiceError({
        code: target?.targetId ? "target_not_found" : "no_capture_targets",
        message: target?.targetId
          ? `Recorder helper did not return targetId ${target.targetId}. Refresh recorder_context_snapshot and select again.`
          : "Recorder helper returned no capture targets.",
        retriable: true,
        requiresUserAction: false,
        details: target?.targetId ? { targetId: target.targetId } : undefined,
      });
    }

    return TargetRefSchema.parse({
      ...selected,
      ...stripTargetMode(target),
      targetId: target?.targetId ?? selected.targetId,
      kind: target?.kind ?? selected.kind,
      app: target?.app ?? selected.app,
      window: target?.window ?? selected.window,
      safeToPersist: target?.safeToPersist ?? selected.safeToPersist,
    });
  }

  private toHelperSessionInput(
    manifest: RunManifest,
    options: {
      purpose?: string;
      capture?: z.infer<typeof CaptureInputSchema>;
    } = {},
  ): RecorderHelperSessionInput {
    return {
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      target: manifest.target,
      paths: manifest.paths,
      purpose: options.purpose,
      capture: options.capture,
      eventCount: manifest.eventCount,
      frameCount: manifest.frameCount,
    };
  }

  private rememberTargetSnapshot(snapshotId: string, targets: RecorderHelperTargets): void {
    this.targetSnapshots.set(snapshotId, targets);
    while (this.targetSnapshots.size > 20) {
      const oldest = this.targetSnapshots.keys().next().value;
      if (!oldest) {
        break;
      }
      this.targetSnapshots.delete(oldest);
    }
  }

  private async targetsForSnapshot(snapshotId: string | undefined): Promise<RecorderHelperTargets> {
    if (!snapshotId) {
      return this.listTargets();
    }
    const snapshot = this.targetSnapshots.get(snapshotId);
    if (!snapshot) {
      throw new SporesServiceError({
        code: "stale_target_snapshot",
        message: `Target snapshot ${snapshotId} is not available in this recorder session. Refresh recorder_context_snapshot and retry.`,
        retriable: true,
        requiresUserAction: false,
        details: { snapshotId },
      });
    }
    return snapshot;
  }

  private ensureNativeCaptureTarget(target: TargetRef): void {
    const blockers = nativeCaptureBlockers(target);
    if (blockers.length === 0) {
      return;
    }
    throw new SporesServiceError({
      code: "invalid_capture_target",
      message: `Native capture target is not addressable: ${blockers.join(", ")}`,
      retriable: true,
      requiresUserAction: false,
      details: {
        target,
        blockers,
        recommendedTools: ["recorder_context_snapshot", "recorder_target_select", "recorder_target_validate"],
      },
    });
  }
}

export function createSporesService(options: SporesServiceOptions = {}) {
  return new SporesService(options);
}

function parseRecorderBackend(value: string | undefined): RecorderBackend {
  return value === "fake" ? "fake" : "helper";
}

function rankTargets(
  targets: RecorderHelperTargets,
  selector: z.infer<typeof TargetSelectorInputSchema>,
): Array<{ target: TargetRef; score: number; reasons: string[] }> {
  const ranked = targets.targets
    .map((target) => scoreTarget(target, selector))
    .filter((candidate) => candidate.score > Number.NEGATIVE_INFINITY);

  return ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const prefer = selector.prefer ?? "frontmost";
    if (prefer === "largest") {
      return targetArea(right.target) - targetArea(left.target);
    }
    return (left.target.zOrder ?? 999_999) - (right.target.zOrder ?? 999_999);
  });
}

function scoreTarget(
  target: TargetRef,
  selector: z.infer<typeof TargetSelectorInputSchema>,
): { target: TargetRef; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (selector.targetId) {
    if (target.targetId !== selector.targetId) {
      return rejectedTarget(target);
    }
    score += 200;
    reasons.push("targetId exact match");
  }

  if (selector.kind) {
    if (target.kind !== selector.kind) {
      return rejectedTarget(target);
    }
    score += 30;
    reasons.push(`kind=${selector.kind}`);
  }

  if (selector.displayId) {
    if (target.displayId !== selector.displayId) {
      return rejectedTarget(target);
    }
    score += 20;
    reasons.push(`displayId=${selector.displayId}`);
  }

  if (selector.bundleId) {
    if (target.app?.bundleId !== selector.bundleId) {
      return rejectedTarget(target);
    }
    score += 80;
    reasons.push(`bundleId=${selector.bundleId}`);
  }

  if (selector.app) {
    if (!matchesText(target.app?.name, selector.app) && !matchesText(target.app?.bundleId, selector.app)) {
      return rejectedTarget(target);
    }
    score += 50;
    reasons.push(`app contains "${selector.app}"`);
  }

  if (selector.titleIncludes) {
    if (!matchesText(target.window?.title, selector.titleIncludes)) {
      return rejectedTarget(target);
    }
    score += 60;
    reasons.push(`title contains "${selector.titleIncludes}"`);
  }

  if (!hasAnySelectorField(selector)) {
    score += target.kind === "window" ? 20 : 10;
    reasons.push("default target candidate");
  }

  if ((selector.prefer ?? "frontmost") === "frontmost") {
    const zOrder = target.zOrder ?? 999_999;
    score += Math.max(0, 30 - Math.min(zOrder, 30));
    reasons.push(`frontmost rank ${zOrder}`);
  }

  if (selector.prefer === "largest") {
    const area = targetArea(target);
    score += Math.min(30, Math.floor(area / 100_000));
    reasons.push(`area ${area}`);
  }

  return { target, score, reasons };
}

function rejectedTarget(target: TargetRef): { target: TargetRef; score: number; reasons: string[] } {
  return { target, score: Number.NEGATIVE_INFINITY, reasons: [] };
}

function targetConfidence(
  score: number,
  selector: z.infer<typeof TargetSelectorInputSchema>,
): "high" | "medium" | "low" {
  if (selector.targetId || score >= 100) {
    return "high";
  }
  if (score >= 50) {
    return "medium";
  }
  return "low";
}

function hasAnySelectorField(selector: z.infer<typeof TargetSelectorInputSchema>): boolean {
  return Boolean(
    selector.targetId ||
      selector.kind ||
      selector.displayId ||
      selector.app ||
      selector.bundleId ||
      selector.titleIncludes ||
      selector.bounds,
  );
}

function matchesText(value: string | undefined, query: string): boolean {
  return normalizeSearchText(value).includes(normalizeSearchText(query));
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function targetArea(target: TargetRef): number {
  const bounds = target.bounds ?? target.window?.bounds;
  return bounds ? bounds.width * bounds.height : 0;
}

function targetLabel(target: TargetRef): string {
  return target.window?.title ?? target.app?.name ?? target.displayId ?? target.targetId;
}

function formatBounds(bounds: z.infer<typeof BoundsSchema>): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

async function recoverArtifact(input: {
  path: string;
  artifactIdPrefix: string;
  kind: ArtifactRef["kind"];
  mediaType: string;
  redactionState: ArtifactRef["redactionState"];
  timeRangeMs: [number, number];
}): Promise<ArtifactRef | undefined> {
  const artifactPath = input.path;
  const [content, artifactStat] = await Promise.all([
    readFile(artifactPath).catch(() => undefined),
    stat(artifactPath).catch(() => undefined),
  ]);
  if (!content || !artifactStat?.isFile()) {
    return undefined;
  }

  return ArtifactRefSchema.parse({
    artifactId: `${input.artifactIdPrefix}_${createHash("sha256").update(artifactPath).digest("hex").slice(0, 24)}`,
    kind: input.kind,
    path: artifactPath,
    mediaType: input.mediaType,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    createdAt: new Date(artifactStat.mtimeMs).toISOString(),
    timeRangeMs: input.timeRangeMs,
    redactionState: input.redactionState,
  });
}

async function recoverNativeCaptureDurationMs(runDir: string): Promise<number> {
  const raw = await readFile(path.join(runDir, "native-capture.json"), "utf8").catch(() => undefined);
  if (!raw) {
    return 1000;
  }

  try {
    const parsed = JSON.parse(raw) as { maxDurationSeconds?: unknown };
    return typeof parsed.maxDurationSeconds === "number" && Number.isFinite(parsed.maxDurationSeconds)
      ? Math.max(1, parsed.maxDurationSeconds) * 1000
      : 1000;
  } catch {
    return 1000;
  }
}

function stripTargetMode(target: z.infer<typeof TargetInputSchema> | undefined): Partial<TargetRef> {
  if (!target) {
    return {};
  }
  const { mode: _mode, ...rest } = target;
  return rest;
}

function mergeArtifacts(existing: ArtifactRef[], incoming: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set(existing.map((artifact) => artifact.artifactId));
  return [
    ...existing,
    ...incoming.filter((artifact) => {
      if (seen.has(artifact.artifactId)) {
        return false;
      }
      seen.add(artifact.artifactId);
      return true;
    }),
  ];
}

function readinessReasonCodes(input: {
  helperAvailable: boolean;
  permissionRequiresUserAction: boolean;
  targetCount: number;
  permissionsMode: PermissionBrokerStatus["mode"];
}): string[] {
  const codes: string[] = [];
  if (!input.helperAvailable) {
    codes.push("helper_unavailable");
  }
  if (input.permissionRequiresUserAction) {
    codes.push("permissions_require_user_action");
  }
  if (input.targetCount === 0) {
    codes.push("no_targets");
  }
  if (input.permissionsMode !== "native_probe") {
    codes.push("native_probe_not_run");
  }
  return codes;
}

function evaluateTargetPolicy(
  selection: TargetSelection,
  policy: z.infer<typeof TargetPolicyInputSchema>,
): {
  ok: true;
  ambiguous: boolean;
  requiredDisambiguators: string[];
} | {
  ok: false;
  code: string;
  message: string;
  ambiguous: boolean;
  requiredDisambiguators: string[];
} {
  const ambiguous = targetAmbiguous(selection.score, selection.alternatives[0]?.score, policy.ambiguityMargin);
  const requiredDisambiguators = ambiguous ? requiredTargetDisambiguators(selection.selector) : [];
  if (confidenceRank(selection.confidence) < confidenceRank(policy.minConfidence)) {
    return {
      ok: false,
      code: "target_confidence_too_low",
      message: `Target confidence ${selection.confidence} is below required minimum ${policy.minConfidence}.`,
      ambiguous,
      requiredDisambiguators: requiredDisambiguators.length > 0 ? requiredDisambiguators : ["targetId"],
    };
  }
  if (policy.failOnAmbiguous && ambiguous) {
    return {
      ok: false,
      code: "ambiguous_target",
      message: "Target selector matched multiple similar candidates. Add targetId or more disambiguating fields.",
      ambiguous,
      requiredDisambiguators,
    };
  }
  return {
    ok: true,
    ambiguous,
    requiredDisambiguators,
  };
}

function confidenceRank(confidence: "low" | "medium" | "high"): number {
  return {
    low: 0,
    medium: 1,
    high: 2,
  }[confidence];
}

function targetAmbiguous(bestScore: number, nextScore: number | undefined, margin = 10): boolean {
  return nextScore !== undefined && bestScore - nextScore <= margin;
}

function requiredTargetDisambiguators(selector: z.infer<typeof TargetSelectorInputSchema>): string[] {
  if (selector.targetId) {
    return [];
  }
  const disambiguators: string[] = [];
  if (!selector.kind) {
    disambiguators.push("kind");
  }
  if (!selector.displayId) {
    disambiguators.push("displayId");
  }
  if (!selector.bundleId && !selector.app) {
    disambiguators.push("bundleId", "app");
  }
  if (selector.kind === "window" && !selector.titleIncludes) {
    disambiguators.push("titleIncludes");
  }
  disambiguators.push("targetId");
  return [...new Set(disambiguators)];
}

function capturePlanForTarget(target: TargetRef): Record<string, unknown> {
  const bounds = target.bounds ?? target.window?.bounds;
  const windowId = target.window?.id;
  if (target.kind === "window" && isNumericWindowId(windowId)) {
    return {
      mode: "window",
      backend: "macos_screencapture",
      outputFormat: "mp4",
      targetId: target.targetId,
      windowId,
      args: [`-l${windowId}`],
    };
  }
  if ((target.kind === "window" || target.kind === "app" || target.kind === "region") && bounds) {
    return {
      mode: "region",
      backend: "macos_screencapture",
      outputFormat: "mp4",
      targetId: target.targetId,
      bounds,
      args: [`-R${formatBounds(bounds)}`],
    };
  }
  if (target.kind === "display") {
    const displayNumber = target.displayId === "main" ? 1 : Number.parseInt(target.displayId ?? "", 10);
    return {
      mode: "display",
      backend: "macos_screencapture",
      outputFormat: "mp4",
      targetId: target.targetId,
      displayId: target.displayId,
      args: Number.isInteger(displayNumber) && displayNumber > 0 ? [`-D${displayNumber}`] : [],
    };
  }
  return {
    mode: "synthetic_or_default",
    backend: "recorder_helper",
    outputFormat: "mp4_when_native",
    targetId: target.targetId,
  };
}

function nativeCaptureBlockers(target: TargetRef): string[] {
  const bounds = target.bounds ?? target.window?.bounds;
  if (target.kind === "fake") {
    return ["fake_target_requires_synthetic_capture"];
  }
  if (target.kind === "region") {
    return bounds ? [] : ["missing_bounds"];
  }
  if (target.kind === "window") {
    return isNumericWindowId(target.window?.id) || bounds ? [] : ["missing_window_id_or_bounds"];
  }
  if (target.kind === "app") {
    return bounds ? [] : ["missing_bounds"];
  }
  if (target.kind === "display") {
    return target.displayId || bounds ? [] : ["missing_display_id_or_bounds"];
  }
  return ["unsupported_target_kind"];
}

function isNumericWindowId(value: string | undefined): boolean {
  return Boolean(value && /^[1-9]\d*$/.test(value));
}

function artifactIsSmallText(artifact: ArtifactRef): boolean {
  return (artifact.kind === "text" || artifact.mediaType.startsWith("text/")) && artifact.bytes <= 64_000;
}

async function verifyArtifact(artifact: ArtifactRef): Promise<{
  artifact: ArtifactRef;
  verified: boolean;
  checks: Record<string, boolean>;
  actual?: {
    bytes: number;
    sha256: string;
  };
  error?: string;
}> {
  try {
    const [content, artifactStat] = await Promise.all([
      readFile(artifact.path),
      stat(artifact.path),
    ]);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const checks = {
      exists: artifactStat.isFile(),
      bytesMatch: artifact.bytes === content.byteLength,
      sha256Match: artifact.sha256 === sha256,
      nonEmpty: content.byteLength > 0,
    };
    return {
      artifact,
      verified: Object.values(checks).every(Boolean),
      checks,
      actual: {
        bytes: content.byteLength,
        sha256,
      },
    };
  } catch (error) {
    return {
      artifact,
      verified: false,
      checks: {
        exists: false,
        bytesMatch: false,
        sha256Match: false,
        nonEmpty: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeTimeline(events: SporesEvent[], frames: FrameRef[], artifacts: ArtifactRef[]) {
  const eventCountsByType: Record<string, number> = {};
  const lanes: Record<string, number> = {};
  for (const event of events) {
    eventCountsByType[event.type] = (eventCountsByType[event.type] ?? 0) + 1;
    const lane = eventLane(event);
    lanes[lane] = (lanes[lane] ?? 0) + 1;
  }
  return {
    eventCount: events.length,
    frameCount: frames.length,
    artifactCount: artifacts.length,
    eventCountsByType,
    lanes,
    firstEvent: events[0] ? compactEventRef(events[0]) : undefined,
    lastEvent: events.at(-1) ? compactEventRef(events.at(-1)!) : undefined,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      path: artifact.path,
      timeRangeMs: artifact.timeRangeMs,
    })),
  };
}

function enrichEvent(
  event: SporesEvent,
  frames: FrameRef[],
  artifacts: ArtifactRef[],
  options: { includePayload: boolean },
) {
  const frame = nearestFrame(event, frames);
  const artifact = frame?.artifactId
    ? artifacts.find((candidate) => candidate.artifactId === frame.artifactId)
    : undefined;
  return {
    ...compactEventRef(event),
    lane: eventLane(event),
    summary: eventSummary(event),
    payload: options.includePayload ? event.payload : undefined,
    nearestFrame: frame
      ? {
          frameId: frame.frameId,
          sequence: frame.sequence,
          videoTimeMs: frame.videoTimeMs,
          artifactId: frame.artifactId,
        }
      : undefined,
    artifact: artifact
      ? {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          path: artifact.path,
        }
      : undefined,
  };
}

function compactEventRef(event: SporesEvent) {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    wallTime: event.wallTime,
    source: event.source,
  };
}

function eventLane(event: SporesEvent): "recording" | "permission" | "target" | "screen" | "input" | "accessibility" | "agent" | "privacy" {
  if (event.type.startsWith("recording.")) {
    return "recording";
  }
  if (event.type.startsWith("permission.") || event.type === "capture.blocked") {
    return "permission";
  }
  if (event.type === "target.selected" || event.type === "app.focused" || event.type === "window.changed") {
    return "target";
  }
  if (event.type === "screen.frame") {
    return "screen";
  }
  if (event.type.startsWith("mouse.") || event.type.startsWith("keyboard.")) {
    return "input";
  }
  if (event.type.startsWith("accessibility.")) {
    return "accessibility";
  }
  if (event.type.startsWith("agent.")) {
    return "agent";
  }
  return "privacy";
}

function eventSummary(event: SporesEvent): string {
  const payload = event.payload;
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  if (summary) {
    return summary;
  }
  switch (event.type) {
    case "recording.started":
      return `Recording started${typeof payload.purpose === "string" ? `: ${payload.purpose}` : ""}`;
    case "recording.stopped":
      return "Recording stopped";
    case "target.selected": {
      const target = TargetRefSchema.safeParse(payload.target);
      return target.success ? `Selected ${targetLabel(target.data)}` : "Target selected";
    }
    case "app.focused":
      return `Focused ${String(payload.name ?? payload.bundleId ?? "app")}`;
    case "window.changed":
      return `Window ${String(payload.title ?? payload.windowId ?? "changed")}`;
    case "screen.frame":
      return `Screen frame at ${String(payload.videoTimeMs ?? 0)}ms`;
    case "agent.decision":
      return `Agent decision${typeof payload.reason === "string" ? `: ${payload.reason}` : ""}`;
    case "agent.action":
      return `Agent action${typeof payload.action === "string" ? `: ${payload.action}` : ""}`;
    case "agent.observation":
      return `Agent observation${typeof payload.text === "string" ? `: ${payload.text}` : ""}`;
    case "agent.assertion":
      return `Agent assertion ${String(payload.status ?? "unknown")}`;
    default:
      return event.type;
  }
}

function eventSearchText(event: SporesEvent): string {
  return `${event.type} ${event.source} ${eventSummary(event)} ${JSON.stringify(event.payload)}`.toLowerCase();
}

function nearestFrame(event: SporesEvent, frames: FrameRef[]): FrameRef | undefined {
  return [...frames]
    .filter((frame) => frame.sequence <= event.sequence)
    .sort((left, right) => right.sequence - left.sequence)[0] ?? frames[0];
}

async function readSmallTextArtifacts(artifacts: ArtifactRef[]): Promise<Array<{
  artifact: ArtifactRef;
  content?: string;
  skipped?: string;
}>> {
  return Promise.all(artifacts.map(async (artifact) => {
    if (!artifact.mediaType.startsWith("text/") && artifact.kind !== "text") {
      return { artifact, skipped: "not_text" };
    }
    if (artifact.bytes > 64_000) {
      return { artifact, skipped: "too_large" };
    }
    return {
      artifact,
      content: await readFile(artifact.path, "utf8"),
    };
  }));
}
