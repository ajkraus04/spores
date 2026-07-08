import {
  FrameRef,
  RunManifest,
  SporesEvent,
  TargetRef,
  createSporesId,
  monotonicTimeNs,
  nowIso,
} from "@spores/schema";
import { RunStore } from "@spores/store";

export type StartRecordingInput = {
  purpose?: string;
  runId?: string;
  target?: Partial<TargetRef> & { mode?: "fake" | "picker" };
};

export type AppendEventInput = {
  runId: string;
  type: SporesEvent["type"];
  source?: SporesEvent["source"];
  payload?: Record<string, unknown>;
};

export class FakeRecorder {
  private activeRunId: string | undefined;

  constructor(readonly store: RunStore) {}

  async doctor(): Promise<{
    ok: true;
    recorder: "fake";
    nativeCapture: false;
    rootDir: string;
  }> {
    return {
      ok: true,
      recorder: "fake",
      nativeCapture: false,
      rootDir: this.store.rootDir,
    };
  }

  async start(input: StartRecordingInput = {}): Promise<RunManifest> {
    if (this.activeRunId) {
      return this.store.readManifest(this.activeRunId);
    }

    const target = createFakeTarget(input.target);
    const manifest = await this.store.createRun({
      runId: input.runId,
      target,
      permissionSnapshot: {
        platform: process.platform,
        screenRecording: "granted",
        accessibility: "granted",
        inputMonitoring: "not_requested",
        microphone: "not_requested",
        systemAudio: "not_requested",
        requiresUserAction: false,
      },
    });
    this.activeRunId = manifest.runId;

    await this.emit(manifest, "permission.snapshot", {
      platform: process.platform,
      screenRecording: "granted",
      accessibility: "granted",
      inputMonitoring: "not_requested",
      microphone: "not_requested",
      systemAudio: "not_requested",
      requiresUserAction: false,
      fake: true,
    });
    await this.emit(manifest, "recording.started", {
      purpose: input.purpose ?? "milestone-1 fake recording",
      recorder: "fake",
    });
    await this.emit(manifest, "target.selected", { target });
    await this.emit(manifest, "app.focused", {
      bundleId: target.app?.bundleId,
      name: target.app?.name,
      processId: target.app?.processId,
    });
    await this.emit(manifest, "window.changed", {
      windowId: target.window?.id,
      title: target.window?.title,
      bounds: target.window?.bounds,
    });
    await this.emit(manifest, "accessibility.tree", {
      snapshotId: `${manifest.sessionId}:ax:0`,
      root: {
        role: "window",
        label: target.window?.title ?? "Spores Fake Recording",
      },
      synthetic: true,
    });
    await this.appendFrame(manifest, 0);
    await this.emit(manifest, "screen.frame", {
      frameId: `${manifest.sessionId}:frame:0`,
      videoTimeMs: 0,
      synthetic: true,
    });

    return this.store.readManifest(manifest.runId);
  }

  async status(runId?: string): Promise<RunManifest | { status: "idle"; activeRunId?: undefined }> {
    const selectedRunId = runId ?? this.activeRunId;
    if (!selectedRunId) {
      return { status: "idle" };
    }
    return this.store.readManifest(selectedRunId);
  }

  async appendEvent(input: AppendEventInput): Promise<SporesEvent> {
    const manifest = await this.store.readManifest(input.runId);
    return this.emit(manifest, input.type, input.payload ?? {}, input.source ?? "agent");
  }

  async stop(runId?: string): Promise<RunManifest> {
    const selectedRunId = runId ?? this.activeRunId;
    if (!selectedRunId) {
      throw new Error("no active recording");
    }

    const manifest = await this.store.readManifest(selectedRunId);
    if (manifest.status === "complete" || manifest.status === "stopped") {
      return manifest;
    }

    await this.appendFrame(manifest, 1000);
    await this.emit(manifest, "screen.frame", {
      frameId: `${manifest.sessionId}:frame:1`,
      videoTimeMs: 1000,
      synthetic: true,
    });
    await this.emit(manifest, "recording.stopped", {
      reason: "requested",
      recorder: "fake",
    });
    await this.store.writeArtifact(
      manifest.runId,
      "fake-capture.txt",
      `Spores fake capture for ${manifest.runId}\n`,
      {
        kind: "text",
        mediaType: "text/plain",
        timeRangeMs: [0, 1000],
      },
    );

    const updated = await this.store.updateManifest(manifest.runId, (current) => ({
      ...current,
      status: "complete",
    }));

    if (this.activeRunId === selectedRunId) {
      this.activeRunId = undefined;
    }
    return updated;
  }

  private async emit(
    manifest: RunManifest,
    type: SporesEvent["type"],
    payload: Record<string, unknown>,
    source: SporesEvent["source"] = "fake-recorder",
  ): Promise<SporesEvent> {
    const latest = await this.store.readManifest(manifest.runId);
    const event: SporesEvent = {
      schemaVersion: 1,
      eventId: createSporesId("evt"),
      runId: latest.runId,
      sessionId: latest.sessionId,
      sequence: latest.eventCount,
      type,
      wallTime: nowIso(),
      monotonicTimeNs: monotonicTimeNs(),
      source,
      payload,
    };
    return this.store.appendEvent(event);
  }

  private async appendFrame(manifest: RunManifest, videoTimeMs: number): Promise<FrameRef> {
    const latest = await this.store.readManifest(manifest.runId);
    return this.store.appendFrame({
      frameId: `${latest.sessionId}:frame:${latest.frameCount}`,
      sessionId: latest.sessionId,
      sequence: latest.frameCount,
      monotonicTimeNs: monotonicTimeNs(),
      videoTimeMs,
      accuracy: "actual",
    });
  }
}

function createFakeTarget(target?: StartRecordingInput["target"]): TargetRef {
  return {
    targetId: target?.targetId ?? createSporesId("target"),
    kind: "fake",
    displayId: target?.displayId ?? "fake-display",
    app: target?.app ?? {
      name: "Fake App",
      bundleId: "dev.spores.fake",
      processId: process.pid,
    },
    window: target?.window ?? {
      id: "fake-window",
      title: "Spores Fake Recording",
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
    },
    safeToPersist: target?.safeToPersist ?? true,
  };
}
