import { createHash } from "node:crypto";
import { lstat, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FakeRecorder } from "@spores/fake-recorder";
import {
  AgentAssertionSchema,
  AgentStepPayloadSchema,
  ArtifactRef,
  ArtifactRefSchema,
  BoundsSchema,
  CausalLinkSchema,
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
  ToolCallSchema,
  TraceAnchorSchema,
  TraceSpanSchema,
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

const TargetKindSchema = z.enum(["display", "window", "app", "region", "browser_tab", "fake"]);
const ConfidenceSchema = z.enum(["low", "medium", "high"]);

export const TargetSelectorInputSchema = z.object({
  targetId: z.string().describe("Snapshot-local target id from recorder_context_snapshot or recorder_target_select.").optional(),
  kind: TargetKindSchema.describe("Target category to match. Use region with bounds for explicit coordinates.").optional(),
  displayId: z.string().describe("Display id such as main or a helper-provided display ordinal.").optional(),
  app: z.string().describe("App name or bundle id substring to match.").optional(),
  bundleId: z.string().describe("Exact native app bundle id to match when known.").optional(),
  titleIncludes: z.string().describe("Window or tab title substring to match.").optional(),
  urlIncludes: z.string().describe("Browser tab URL substring to match when browser metadata is available.").optional(),
  origin: z.string().describe("Browser tab origin to match when browser metadata is available.").optional(),
  bounds: BoundsSchema.describe("Explicit screen coordinates for region capture.").optional(),
  prefer: z.enum(["frontmost", "largest", "exact"]).describe("How to rank multiple candidates when no exact targetId is supplied.").default("frontmost"),
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
  targetToken: z.string().optional(),
  requireFresh: z.boolean().default(true),
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
  rationale: z.string().max(8_000).optional(),
  intent: z.string().max(8_000).optional(),
  basis: z.string().max(8_000).optional(),
  expectedOutcome: z.string().max(8_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  anchors: z.array(TraceAnchorSchema).optional(),
  causedBy: z.array(CausalLinkSchema).optional(),
  span: TraceSpanSchema.optional(),
  toolCall: ToolCallSchema.optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  assertion: AgentAssertionSchema.optional(),
}).superRefine((input, context) => {
  if (input.kind === "assertion" && !input.assertion) {
    context.addIssue({
      code: "custom",
      path: ["assertion"],
      message: "assertion is required when kind is assertion",
    });
  }
  const reservedKeys = [
    "stepId",
    "kind",
    "summary",
    "rationale",
    "intent",
    "basis",
    "expectedOutcome",
    "confidence",
    "hiddenCotStored",
    "anchors",
    "causedBy",
    "span",
    "toolCall",
    "observation",
    "assertion",
    "custom",
  ];
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
  stepId: z.string().optional(),
  spanId: z.string().optional(),
  aroundEventId: z.string().optional(),
  anchorArtifactId: z.string().optional(),
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
  offset: z.number().int().min(0).default(0),
  length: z.number().int().min(1).max(1_000_000).optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).default(64_000),
  allowRaw: z.boolean().default(false),
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
      primaryFlow: ready
        ? [
            {
              step: "snapshot",
              tool: "recorder_context_snapshot",
              purpose: "List current displays, apps, windows, bounds, and snapshotId before choosing a target.",
            },
            {
              step: "select",
              tool: "recorder_target_select",
              purpose: "Resolve app/window/title/bounds selectors into one target with alternatives.",
            },
            {
              step: "validate",
              tool: "recorder_target_validate",
              purpose: "Check the selected target still exists and inspect the capture plan immediately before recording.",
            },
            {
              step: "capture",
              tool: "session_recording_capture",
              purpose: "Preferred fixed-duration capture path; use synthetic only for tests.",
            },
            {
              step: "review",
              tool: "session_recording_result",
              purpose: "Read bounded run summary, artifacts, timeline summaries, and replay anchors.",
            },
          ]
        : [
            {
              step: "diagnose",
              tool: doctor.helper.available ? "recorder_permissions_probe" : "spores_doctor",
              purpose: doctor.helper.available
                ? "Probe native permissions before recording."
                : "Repair helper setup before requesting permissions.",
            },
          ],
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
        sourceApi: targets.status.targetSource ?? "unknown",
        captureUnit: "screen_points",
      },
      displays: displays.map((target) => withTargetLease(target, snapshotId)),
      apps: apps.map((target) => withTargetLease(target, snapshotId)),
      windows: windows.map((target) => withTargetLease(target, snapshotId)),
      activeWindow: activeWindow ? withTargetLease(activeWindow, snapshotId) : undefined,
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
          : { targetId: selection.selected.targetId, targetToken: selection.selected.targetToken },
      },
    };
  }

  async validateTarget(input: z.infer<typeof TargetValidateInputSchema>) {
    const targets = await this.targetsForSnapshot(input.snapshotId);
    const cachedTarget = targets.targets.find((candidate) => candidate.targetId === input.targetId);
    const liveTargets = input.requireFresh ? await this.listTargets() : targets;
    const liveTarget = liveTargets.targets.find((candidate) => candidate.targetId === input.targetId);
    const target = liveTarget ?? cachedTarget;
    const invalidations: string[] = [];
    const warnings: string[] = [];
    if (!cachedTarget && input.snapshotId) {
      invalidations.push("snapshot_target_not_found");
    }
    if (!liveTarget) {
      invalidations.push("target_not_found");
    }
    if (cachedTarget && liveTarget) {
      invalidations.push(...targetFreshnessInvalidations(cachedTarget, liveTarget));
    }
    if (input.targetToken && liveTarget?.targetToken && input.targetToken !== liveTarget.targetToken) {
      invalidations.push("target_token_changed");
    }
    if (cachedTarget?.targetToken && liveTarget?.targetToken && cachedTarget.targetToken !== liveTarget.targetToken) {
      invalidations.push("target_token_changed");
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
      target: target ? withTargetLease(target, input.snapshotId) : undefined,
      cachedTarget: cachedTarget ? withTargetLease(cachedTarget, input.snapshotId) : undefined,
      liveTarget,
      invalidations: [...new Set(invalidations)],
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
    const custom = {
      ...input.details,
      ...input.custom,
    };
    const payload = AgentStepPayloadSchema.parse({
      stepId: input.stepId,
      kind: input.kind,
      summary: input.summary,
      rationale: input.rationale,
      intent: input.intent,
      basis: input.basis,
      expectedOutcome: input.expectedOutcome,
      confidence: input.confidence,
      anchors: input.anchors,
      causedBy: input.causedBy,
      span: input.span,
      toolCall: input.toolCall,
      observation: input.observation,
      assertion: input.assertion,
      custom: Object.keys(custom).length > 0 ? custom : undefined,
      hiddenCotStored: false,
    });
    return this.appendEvent({
      runId: input.runId,
      type: eventType,
      payload: {
        ...input.details,
        ...payload,
        ...(input.assertion ? { ...input.assertion } : {}),
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
    return this.readArtifact({
      ...input,
      contentMode: "text",
      offset: 0,
      maxBytes: 64_000,
      allowRaw: false,
    });
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
    const artifactPath = artifactPathForRead(manifest, artifact);
    const linkStat = await lstat(artifactPath);
    if (linkStat.isSymbolicLink()) {
      throw new SporesServiceError({
        code: "artifact_path_unsafe",
        message: `Artifact ${artifact.artifactId} points at a symbolic link, which is not readable through MCP.`,
        retriable: false,
        requiresUserAction: false,
        details: { artifact: artifactForAgent(manifest, artifact) },
      });
    }
    const artifactStat = await stat(artifactPath);
    if (!artifactStat.isFile()) {
      throw new SporesServiceError({
        code: "artifact_not_readable",
        message: `Artifact ${artifact.artifactId} is not a readable file.`,
        retriable: false,
        requiresUserAction: false,
        details: { artifactId: artifact.artifactId },
      });
    }
    if (input.contentMode === "metadata") {
      return {
        artifact: artifactForAgent(manifest, artifact),
        bytes: artifactStat.size,
        streamable: artifact.streamable ?? artifact.kind === "video",
        seekable: artifact.seekable ?? artifact.kind === "video",
      };
    }
    if ((artifact.redactionState === "raw" || artifact.redactionState === "quarantined" || artifact.redactionState === "failed") && !input.allowRaw) {
      throw new SporesServiceError({
        code: "artifact_requires_raw_access",
        message: `Artifact ${artifact.artifactId} is ${artifact.redactionState}; read metadata or pass allowRaw for explicit raw access.`,
        retriable: false,
        requiresUserAction: true,
        details: {
          artifact: artifactForAgent(manifest, artifact),
          recommendedContentMode: "metadata",
          recoverySteps: ["Read artifact metadata first.", "Request explicit raw artifact access only when needed."],
        },
      });
    }
    if (input.contentMode === "text" && !artifactIsText(artifact)) {
      throw new SporesServiceError({
        code: "artifact_not_text",
        message: `Artifact ${artifact.artifactId} is ${artifact.mediaType}; use metadata or base64 mode.`,
        retriable: false,
        requiresUserAction: false,
        details: {
          artifact: artifactForAgent(manifest, artifact),
          recommendedContentMode: "metadata",
        },
      });
    }
    if (input.offset > artifactStat.size) {
      throw new SporesServiceError({
        code: "artifact_range_not_satisfiable",
        message: `Artifact ${artifact.artifactId} has ${artifactStat.size} bytes; offset ${input.offset} is outside the artifact.`,
        retriable: false,
        requiresUserAction: false,
        details: {
          artifact: artifactForAgent(manifest, artifact),
          bytes: artifactStat.size,
          offset: input.offset,
        },
      });
    }

    const remainingBytes = Math.max(0, artifactStat.size - input.offset);
    const requestedBytes = Math.min(input.length ?? input.maxBytes, input.maxBytes, remainingBytes);
    if (artifactStat.size > input.maxBytes && input.length === undefined) {
      throw new SporesServiceError({
        code: "artifact_too_large",
        message: `Artifact ${artifact.artifactId} is ${artifactStat.size} bytes, which exceeds maxBytes=${input.maxBytes}.`,
        retriable: false,
        requiresUserAction: false,
        details: {
          artifact: artifactForAgent(manifest, artifact),
          bytes: artifactStat.size,
          maxBytes: input.maxBytes,
          recommendedContentMode: "metadata",
          nextTool: "session_recording_read_artifact",
          nextArguments: {
            runId: input.runId,
            artifactId: artifact.artifactId,
            contentMode: "metadata",
          },
        },
      });
    }
    const content = await readArtifactRange(artifactPath, input.offset, requestedBytes);
    const contentRange = {
      offset: input.offset,
      length: content.byteLength,
      totalBytes: artifactStat.size,
    };
    return input.contentMode === "base64"
      ? {
          artifact: artifactForAgent(manifest, artifact),
          contentBase64: content.toString("base64"),
          encoding: "base64",
          contentRange,
          nextOffset: input.offset + content.byteLength < artifactStat.size ? input.offset + content.byteLength : undefined,
          truncated: input.offset + content.byteLength < artifactStat.size,
        }
      : {
          artifact: artifactForAgent(manifest, artifact),
          content: content.toString("utf8"),
          encoding: "utf8",
          contentRange,
          nextOffset: input.offset + content.byteLength < artifactStat.size ? input.offset + content.byteLength : undefined,
          truncated: input.offset + content.byteLength < artifactStat.size,
        };
  }

  async recordingResult(input: z.infer<typeof RecordingResultInputSchema>) {
    const manifest = await this.store.readManifest(input.runId);
    const timeline = await this.store.readTimeline(input.runId);
    const artifacts = input.verifyArtifacts
      ? await Promise.all(manifest.artifacts.map((artifact) => verifyArtifact(artifact)))
      : manifest.artifacts.map((artifact) => ({ artifact, verified: undefined }));
    const primaryArtifact = primaryRecordingArtifact(manifest.artifacts);
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
      .filter((event) => !input.stepId || eventStepId(event) === input.stepId)
      .filter((event) => !input.spanId || eventSpanId(event) === input.spanId)
      .filter((event) => !input.aroundEventId || event.eventId === input.aroundEventId)
      .filter((event) => !input.anchorArtifactId || eventAnchors(event).some((anchor) => anchor.artifactId === input.anchorArtifactId))
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

  async listTargets(_input: z.infer<typeof HelperTargetsInputSchema> = {}) {
    const targets = await this.helper.listTargets();
    return {
      ...targets,
      targets: targets.targets.map((target) => withTargetLease(target, undefined)),
    };
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
    const artifact = primaryRecordingArtifact(stopped.artifacts);

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
      role: "recording_primary",
      label: "Composited recording",
      redactionState: "raw",
      timeRangeMs: nativeTimeRangeMs,
    }) ?? await recoverArtifact({
      path: path.join(manifest.paths.artifactsDir, "source-capture.mp4"),
      artifactIdPrefix: "art_native_source",
      kind: "video",
      mediaType: "video/mp4",
      role: "source_capture",
      label: "Source screen capture",
      redactionState: "raw",
      timeRangeMs: nativeTimeRangeMs,
    }) ?? await recoverArtifact({
      path: path.join(manifest.paths.artifactsDir, "capture.mov"),
      artifactIdPrefix: "art_native",
      kind: "video",
      mediaType: "video/quicktime",
      role: "source_capture",
      label: "Source screen capture",
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

    const targets = await this.listTargets();
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

    const requested = stripTargetMode(target);
    const invalidations = target && selected ? targetFreshnessInvalidations(requested as TargetRef, selected) : [];
    if (target?.targetToken && selected.targetToken && target.targetToken !== selected.targetToken) {
      invalidations.push("target_token_changed");
    }
    if (invalidations.length > 0 && target?.targetToken) {
      throw new SporesServiceError({
        code: "stale_target",
        message: `Target ${selected.targetId} changed since selection: ${[...new Set(invalidations)].join(", ")}`,
        retriable: true,
        requiresUserAction: false,
        details: {
          targetId: selected.targetId,
          invalidations: [...new Set(invalidations)],
          recommendedTools: ["recorder_context_snapshot", "recorder_target_select", "recorder_target_validate"],
        },
      });
    }

    return TargetRefSchema.parse({
      ...selected,
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
  role?: string;
  label?: string;
  redactionState: ArtifactRef["redactionState"];
  timeRangeMs: [number, number];
}): Promise<ArtifactRef | undefined> {
  const artifactPath = input.path;
  const artifactStat = await stat(artifactPath).catch(() => undefined);
  if (!artifactStat?.isFile()) {
    return undefined;
  }
  const sha256 = await hashFile(artifactPath);

  return ArtifactRefSchema.parse({
    artifactId: `${input.artifactIdPrefix}_${createHash("sha256").update(artifactPath).digest("hex").slice(0, 24)}`,
    kind: input.kind,
    path: artifactPath,
    relativePath: path.basename(artifactPath),
    role: input.role,
    label: input.label,
    streamable: input.kind === "video",
    seekable: input.kind === "video",
    durationMs: input.timeRangeMs[1] - input.timeRangeMs[0],
    mediaType: input.mediaType,
    sha256,
    bytes: artifactStat.size,
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

function primaryRecordingArtifact(artifacts: ArtifactRef[]): ArtifactRef | undefined {
  return artifacts.find((artifact) => artifact.role === "recording_primary")
    ?? artifacts.find((artifact) => artifact.kind === "video")
    ?? artifacts[0];
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

function withTargetLease(target: TargetRef, snapshotId: string | undefined): TargetRef {
  const observedAt = nowIso();
  return TargetRefSchema.parse({
    ...target,
    observedAt: target.observedAt ?? observedAt,
    expiresAt: target.expiresAt ?? new Date(Date.parse(observedAt) + 30_000).toISOString(),
    targetToken: target.targetToken ?? createHash("sha256").update(`${snapshotId ?? "live"}:${target.targetId}:${targetFingerprint(target)}`).digest("hex").slice(0, 24),
    nativeWindowId: target.nativeWindowId ?? target.window?.id,
    stableKey: target.stableKey ?? targetStableKey(target),
    identityConfidence: target.identityConfidence ?? (target.targetId.startsWith("display:") ? "high" : "medium"),
  });
}

function targetFreshnessInvalidations(cached: TargetRef, live: TargetRef): string[] {
  const invalidations: string[] = [];
  if (cached.kind !== live.kind) {
    invalidations.push("kind_changed");
  }
  if (cached.displayId !== live.displayId) {
    invalidations.push("display_changed");
  }
  if (cached.window?.title !== live.window?.title) {
    invalidations.push("title_changed");
  }
  if (!boundsEqual(cached.bounds ?? cached.window?.bounds, live.bounds ?? live.window?.bounds)) {
    invalidations.push("geometry_changed");
  }
  if ((cached.zOrder ?? 999_999) !== (live.zOrder ?? 999_999)) {
    invalidations.push("z_order_changed");
  }
  return invalidations;
}

function targetFingerprint(target: TargetRef): string {
  return JSON.stringify({
    kind: target.kind,
    displayId: target.displayId,
    app: target.app?.bundleId ?? target.app?.name,
    window: target.window?.id,
    title: target.window?.title,
    bounds: target.bounds ?? target.window?.bounds,
  });
}

function targetStableKey(target: TargetRef): string | undefined {
  if (target.kind === "display") {
    return `display:${target.displayId ?? target.targetId}`;
  }
  if (target.app?.bundleId && target.window?.title) {
    return `${target.app.bundleId}:${target.window.title}`;
  }
  if (target.app?.bundleId) {
    return target.app.bundleId;
  }
  return undefined;
}

function boundsEqual(
  left: z.infer<typeof BoundsSchema> | undefined,
  right: z.infer<typeof BoundsSchema> | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function isNumericWindowId(value: string | undefined): boolean {
  return Boolean(value && /^[1-9]\d*$/.test(value));
}

function artifactForAgent(manifest: RunManifest, artifact: ArtifactRef): ArtifactRef {
  const relativePath = safeArtifactRelativePath(manifest, artifact);
  return ArtifactRefSchema.parse({
    ...artifact,
    path: relativePath,
    relativePath,
  });
}

function safeArtifactRelativePath(manifest: RunManifest, artifact: ArtifactRef): string {
  if (artifact.relativePath && !path.isAbsolute(artifact.relativePath) && !artifact.relativePath.split(/[\\/]/).includes("..")) {
    return artifact.relativePath;
  }
  const relativePath = path.relative(path.resolve(manifest.paths.artifactsDir), path.resolve(artifact.path));
  return isPathInside(relativePath) ? relativePath : artifact.artifactId;
}

function artifactPathForRead(manifest: RunManifest, artifact: ArtifactRef): string {
  const artifactsRoot = path.resolve(manifest.paths.artifactsDir);
  const artifactPath = path.resolve(
    artifact.relativePath && !path.isAbsolute(artifact.relativePath)
      ? path.join(artifactsRoot, artifact.relativePath)
      : artifact.path,
  );
  const relativePath = path.relative(artifactsRoot, artifactPath);
  if (!isPathInside(relativePath)) {
    throw new SporesServiceError({
      code: "artifact_path_outside_run",
      message: `Artifact ${artifact.artifactId} is outside the run artifacts directory.`,
      retriable: false,
      requiresUserAction: false,
      details: {
        artifactId: artifact.artifactId,
        relativePath: artifact.relativePath,
      },
    });
  }
  return artifactPath;
}

function isPathInside(relativePath: string): boolean {
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function readArtifactRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function artifactIsText(artifact: ArtifactRef): boolean {
  return artifact.kind === "text" || artifact.mediaType.startsWith("text/");
}

function artifactIsSmallText(artifact: ArtifactRef): boolean {
  return artifactIsText(artifact) && artifact.bytes <= 64_000;
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
    const artifactStat = await stat(artifact.path);
    if (!artifactStat.isFile()) {
      throw new Error(`artifact is not a file: ${artifact.artifactId}`);
    }
    const sha256 = await hashFile(artifact.path);
    const checks = {
      exists: artifactStat.isFile(),
      bytesMatch: artifact.bytes === artifactStat.size,
      sha256Match: artifact.sha256 === sha256,
      nonEmpty: artifactStat.size > 0,
    };
    return {
      artifact,
      verified: Object.values(checks).every(Boolean),
      checks,
      actual: {
        bytes: artifactStat.size,
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
      relativePath: artifact.relativePath ?? path.basename(artifact.path),
      redactionState: artifact.redactionState,
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
          relativePath: artifact.relativePath ?? path.basename(artifact.path),
          redactionState: artifact.redactionState,
        }
      : undefined,
    replay: replayRefForEvent(event, frame, artifact),
  };
}

function replayRefForEvent(event: SporesEvent, frame: FrameRef | undefined, artifact: ArtifactRef | undefined) {
  const anchors = eventAnchors(event);
  return {
    eventUrl: `spores://runs/${event.runId}/events/${event.eventId}`,
    seek: frame
      ? {
          artifactId: frame.artifactId ?? artifact?.artifactId,
          videoTimeMs: frame.videoTimeMs,
          prerollMs: 350,
        }
      : undefined,
    anchors,
    causalLinks: eventCausalLinks(event),
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
  const safeParts = [
    event.type,
    event.source,
    eventSummary(event),
    eventStepId(event),
    eventSpanId(event),
    ...eventAnchors(event).map((anchor) => [anchor.label, anchor.artifactId, anchor.frameId].filter(Boolean).join(" ")),
  ];
  return safeParts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ").toLowerCase();
}

function eventStepId(event: SporesEvent): string | undefined {
  return typeof event.payload.stepId === "string" ? event.payload.stepId : undefined;
}

function eventSpanId(event: SporesEvent): string | undefined {
  const span = event.payload.span;
  return span && typeof span === "object" && "spanId" in span && typeof span.spanId === "string"
    ? span.spanId
    : undefined;
}

function eventAnchors(event: SporesEvent): Array<z.infer<typeof TraceAnchorSchema>> {
  const anchors = event.payload.anchors;
  if (!Array.isArray(anchors)) {
    return [];
  }
  return anchors.flatMap((anchor) => {
    const parsed = TraceAnchorSchema.safeParse(anchor);
    return parsed.success ? [parsed.data] : [];
  });
}

function eventCausalLinks(event: SporesEvent): Array<z.infer<typeof CausalLinkSchema>> {
  const links = event.payload.causedBy;
  if (!Array.isArray(links)) {
    return [];
  }
  return links.flatMap((link) => {
    const parsed = CausalLinkSchema.safeParse(link);
    return parsed.success ? [parsed.data] : [];
  });
}

function nearestFrameByVideoTime(videoTimeMs: number, frames: FrameRef[]): FrameRef | undefined {
  return [...frames].sort((left, right) => (
    Math.abs(left.videoTimeMs - videoTimeMs) - Math.abs(right.videoTimeMs - videoTimeMs)
  ))[0];
}

function nearestFrame(event: SporesEvent, frames: FrameRef[]): FrameRef | undefined {
  const payload = event.payload;
  const frameId = typeof payload.frameId === "string"
    ? payload.frameId
    : payload.frameRef && typeof payload.frameRef === "object" && "frameId" in payload.frameRef && typeof payload.frameRef.frameId === "string"
    ? payload.frameRef.frameId
    : undefined;
  if (frameId) {
    const exact = frames.find((frame) => frame.frameId === frameId);
    if (exact) {
      return exact;
    }
  }
  const anchors = eventAnchors(event);
  for (const anchor of anchors) {
    if (anchor.frameId) {
      const exact = frames.find((frame) => frame.frameId === anchor.frameId);
      if (exact) {
        return exact;
      }
    }
    if (anchor.videoTimeMs !== undefined) {
      return nearestFrameByVideoTime(anchor.videoTimeMs, frames);
    }
  }
  const videoTimeMs = typeof payload.videoTimeMs === "number" ? payload.videoTimeMs : undefined;
  if (videoTimeMs !== undefined) {
    return nearestFrameByVideoTime(videoTimeMs, frames);
  }
  return [...frames]
    .filter((frame) => frame.monotonicTimeNs <= event.monotonicTimeNs)
    .sort((left, right) => right.monotonicTimeNs - left.monotonicTimeNs)[0] ?? frames[0];
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
