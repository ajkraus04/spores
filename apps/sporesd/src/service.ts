import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { FakeRecorder } from "@spores/fake-recorder";
import {
  ArtifactRef,
  ArtifactRefSchema,
  PermissionBrokerStatus,
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
