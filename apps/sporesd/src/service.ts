import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FakeRecorder } from "@spores/fake-recorder";
import {
  ArtifactRef,
  ArtifactRefSchema,
  BoundsSchema,
  PermissionBrokerStatus,
  RecorderHelperTargets,
  RecorderHelperSession,
  RunManifest,
  SporesEventSchema,
  TargetRef,
  TargetRefSchema,
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

export const TimelineInputSchema = z.object({
  runId: z.string(),
});

export const ArtifactInputSchema = z.object({
  runId: z.string(),
  artifactId: z.string(),
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
      this.permissionsStatus(),
      this.listTargets(),
    ]);
    const missingRequiredPermissions = permissions.capabilities.filter((capability) => (
      capability.required && capability.status !== "granted"
    ));
    const ready = doctor.helper.available && !permissions.requiresUserAction && targets.targets.length > 0;

    return {
      ready,
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
      },
      recommendedTools: ready
        ? [
          "recorder_target_resolve",
          "session_recording_record_window",
          "session_recording_record_region",
          "session_recording_begin",
          "session_recording_stop",
        ]
        : ["recorder_permissions_request"],
    };
  }

  async resolveTarget(input: z.infer<typeof ResolveTargetInputSchema>) {
    return this.resolveTargetSelection(input);
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
      selection: resolved,
    });
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
      selection: resolved,
    });
  }

  async start(input: z.infer<typeof StartRecordingInputSchema>) {
    if (this.backend === "fake") {
      return this.recorder.start(input);
    }

    const permissions = await this.ensureRequiredPermissions();
    const target = await this.resolveHelperTarget(input.target);
    const manifest = await this.store.createRun({
      runId: input.runId,
      target,
      permissionSnapshot: permissions.snapshot,
    });

    try {
      const result = await this.helper.startSession(this.toHelperSessionInput(manifest, {
        purpose: input.purpose,
        capture: input.capture,
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

  appendEvent(input: z.infer<typeof AppendEventInputSchema>) {
    return this.recorder.appendEvent(input);
  }

  timeline(input: z.infer<typeof TimelineInputSchema>) {
    return this.store.readTimeline(input.runId);
  }

  artifact(input: z.infer<typeof ArtifactInputSchema>) {
    return this.store.readArtifact(input.runId, input.artifactId);
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

  private async recordResolvedTarget(input: {
    runId?: string;
    purpose: string;
    target: TargetRef;
    seconds: number;
    selection: TargetSelection;
  }) {
    const started = await this.start({
      runId: input.runId,
      purpose: input.purpose,
      target: input.target,
      capture: {
        mode: "native",
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

    const targets = await this.listTargets();
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
      alternatives: ranked.slice(1, 6),
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

  private async ensureRequiredPermissions(): Promise<PermissionBrokerStatus> {
    const status = await this.permissionsStatus();
    if (status.error) {
      throw new SporesServiceError({
        code: status.error.code,
        message: status.error.message,
        retriable: status.error.retriable,
        requiresUserAction: status.error.requiresUserAction,
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

    const targets = await this.helper.listTargets();
    const selected = targets.targets.find((candidate) => candidate.targetId === target?.targetId) ?? targets.targets[0];
    if (!selected) {
      throw new Error("recorder helper returned no capture targets");
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
