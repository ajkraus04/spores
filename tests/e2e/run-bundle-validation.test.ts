import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FrameRefSchema,
  RunManifestSchema,
  SporesEventSchema,
  TimelineSchema,
} from "@spores/schema";
import { createSporesService } from "../../apps/sporesd/src/service.js";

let tempDir: string;
const itIfNativeScreenCapture = process.platform === "darwin" && existsSync("/usr/sbin/screencapture") ? it : it.skip;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-bundle-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("run bundle e2e validation", () => {
  it("selects helper-listed target ids without requiring picker mode", async () => {
    const runId = "run_helper_target_e2e_001";
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });

    const started = await service.start({
      runId,
      purpose: "validate helper target id selection",
      target: { targetId: "display:main" },
    });
    await service.stop({ runId });

    const manifest = RunManifestSchema.parse(JSON.parse(await readFile(service.store.pathsForRun(runId).manifest, "utf8")));
    expect(started.target).toMatchObject({
      targetId: "display:main",
      kind: "display",
      displayId: "main",
      app: { name: "Desktop" },
      window: { id: "desktop", title: "Main Display" },
    });
    expect(manifest.target).toEqual(started.target);
    expect(manifest.target.kind).not.toBe("fake");
  }, 20_000);

  itIfNativeScreenCapture("persists a real timed screen recording movie artifact", async () => {
    const runId = "run_native_capture_e2e_001";
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });

    const started = await service.start({
      runId,
      purpose: "validate native timed screen recording",
      target: { targetId: "display:main" },
      capture: { mode: "native", maxDurationSeconds: 1 },
    });
    expect(started).toMatchObject({
      runId,
      status: "recording",
      eventCount: 7,
      frameCount: 1,
      target: {
        kind: "display",
        targetId: "display:main",
      },
    });

    const stopped = await service.stop({ runId });
    const paths = service.store.pathsForRun(runId);
    const manifest = RunManifestSchema.parse(JSON.parse(await readFile(paths.manifest, "utf8")));
    const events = parseNdjson(await readFile(paths.events, "utf8"), SporesEventSchema.parse);
    const frames = parseNdjson(await readFile(paths.frames, "utf8"), FrameRefSchema.parse);
    const timeline = TimelineSchema.parse(await service.timeline({ runId }));

    expect(stopped).toMatchObject({
      runId,
      status: "complete",
      eventCount: 9,
      frameCount: 2,
    });
    expect(manifest).toEqual(stopped);
    expect(events.map((event) => event.type)).toEqual([
      "permission.snapshot",
      "recording.started",
      "target.selected",
      "app.focused",
      "window.changed",
      "accessibility.tree",
      "screen.frame",
      "screen.frame",
      "recording.stopped",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([...Array(events.length).keys()]);
    expect(events[1]!.payload).toMatchObject({
      nativeCapture: true,
      captureBackend: "screencapture",
      maxDurationSeconds: 1,
    });
    expect(events[8]!.payload).toMatchObject({
      nativeCapture: true,
      captureBackend: "screencapture",
    });
    expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
    expect(frames[1]!.videoTimeMs).toBe(1000);

    const artifact = manifest.artifacts[0];
    expect(artifact).toMatchObject({
      kind: "video",
      mediaType: "video/mp4",
      redactionState: "raw",
      timeRangeMs: [0, 1000],
    });
    expect(frames[1]!.artifactId).toBe(artifact!.artifactId);
    expect(timeline.artifacts).toEqual(manifest.artifacts);

    const artifactBytes = await readFile(artifact!.path);
    const artifactStat = await stat(artifact!.path);
    expect(path.basename(artifact!.path)).toBe("capture.mp4");
    expect(artifactStat.isFile()).toBe(true);
    expect(artifactBytes.byteLength).toBeGreaterThan(1024);
    expect(artifact!.bytes).toBe(artifactBytes.byteLength);
    expect(artifact!.sha256).toBe(createHash("sha256").update(artifactBytes).digest("hex"));

    const nativeState = JSON.parse(await readFile(path.join(paths.runDir, "native-capture.json"), "utf8"));
    expect(nativeState).toMatchObject({
      mode: "native",
      outputPath: artifact!.path,
      maxDurationSeconds: 1,
    });
  }, 20_000);

  itIfNativeScreenCapture("persists a native screen recording for a requested region", async () => {
    const runId = "run_native_region_capture_e2e_001";
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const bounds = { x: 0, y: 0, width: 320, height: 240 };

    const started = await service.start({
      runId,
      purpose: "validate native region screen recording",
      target: { targetId: "region:e2e:top-left", kind: "region", bounds },
      capture: { mode: "native", maxDurationSeconds: 1 },
    });
    expect(started).toMatchObject({
      runId,
      status: "recording",
      target: {
        kind: "region",
        targetId: "region:e2e:top-left",
        bounds,
      },
    });

    const stopped = await service.stop({ runId });
    expect(stopped).toMatchObject({ runId, status: "complete", eventCount: 9, frameCount: 2 });
    expect(stopped.artifacts[0]).toMatchObject({
      kind: "video",
      mediaType: "video/mp4",
      redactionState: "raw",
    });

    const artifact = stopped.artifacts[0]!;
    const bytes = await readFile(artifact.path);
    expect(bytes.byteLength).toBeGreaterThan(1024);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const nativeState = JSON.parse(await readFile(path.join(stopped.paths.runDir, "native-capture.json"), "utf8"));
    expect(nativeState).toMatchObject({
      mode: "native",
      outputPath: artifact.path,
      region: bounds,
    });
    expect(nativeState.captureArgs).toContain("-R0,0,320,240");
  }, 20_000);

  itIfNativeScreenCapture("persists a native screen recording for a real helper-listed window", async () => {
    const runId = "run_native_window_capture_e2e_001";
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const targets = await service.listTargets();
    const windowTarget = targets.targets.find((target) => (
      target.kind === "window" && /^[1-9]\d*$/.test(target.window?.id ?? "")
    ));
    if (!windowTarget) {
      return;
    }

    const started = await service.start({
      runId,
      purpose: "validate native window screen recording",
      target: { targetId: windowTarget.targetId },
      capture: { mode: "native", maxDurationSeconds: 1 },
    });
    expect(started.target).toMatchObject({
      kind: "window",
      targetId: windowTarget.targetId,
      bounds: windowTarget.bounds,
      window: {
        id: windowTarget.window!.id,
        bounds: windowTarget.window!.bounds,
      },
    });

    const stopped = await service.stop({ runId });
    expect(stopped).toMatchObject({ runId, status: "complete", eventCount: 9, frameCount: 2 });
    const artifact = stopped.artifacts[0]!;
    expect(artifact).toMatchObject({
      kind: "video",
      mediaType: "video/mp4",
      redactionState: "raw",
    });
    const bytes = await readFile(artifact.path);
    expect(bytes.byteLength).toBeGreaterThan(1024);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const nativeState = JSON.parse(await readFile(path.join(stopped.paths.runDir, "native-capture.json"), "utf8"));
    expect(nativeState).toMatchObject({
      mode: "native",
      outputPath: artifact.path,
      windowId: windowTarget.window!.id,
    });
    expect(nativeState.captureArgs).toContain(`-l${windowTarget.window!.id}`);
  }, 20_000);

  it("persists a complete schema-valid bundle with contiguous streams and verifiable artifact bytes", async () => {
    const runId = "run_bundle_e2e_001";
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });

    await service.start({
      runId,
      purpose: "validate persisted bundle",
      target: {
        mode: "fake",
        targetId: "target_bundle_e2e",
        app: { name: "Bundle E2E App", bundleId: "dev.spores.bundle-e2e", processId: process.pid },
        window: {
          id: "window_bundle_e2e",
          title: "Bundle E2E",
          bounds: { x: 10, y: 20, width: 1024, height: 768 },
        },
      },
    });
    await service.appendEvent({
      runId,
      type: "agent.decision",
      payload: { stepId: "step-1", reason: "need the canonical timeline before replay" },
    });
    await service.appendEvent({
      runId,
      type: "agent.observation",
      payload: { stepId: "step-1", text: "timeline shows selected target" },
    });
    await service.appendEvent({
      runId,
      type: "agent.assertion",
      payload: { stepId: "step-1", expected: "target_bundle_e2e", actual: "target_bundle_e2e", status: "passed" },
    });
    await service.stop({ runId });

    const paths = service.store.pathsForRun(runId);
    const manifest = RunManifestSchema.parse(JSON.parse(await readFile(paths.manifest, "utf8")));
    const events = parseNdjson(await readFile(paths.events, "utf8"), SporesEventSchema.parse);
    const frames = parseNdjson(await readFile(paths.frames, "utf8"), FrameRefSchema.parse);
    const timeline = TimelineSchema.parse(await service.timeline({ runId }));

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runId,
      status: "complete",
      target: {
        kind: "fake",
        targetId: "target_bundle_e2e",
        app: { name: "Bundle E2E App", bundleId: "dev.spores.bundle-e2e" },
        window: { id: "window_bundle_e2e", title: "Bundle E2E" },
      },
      permissionSnapshot: {
        screenRecording: "granted",
        accessibility: "granted",
        requiresUserAction: false,
      },
      eventCount: 12,
      frameCount: 2,
    });

    expect(events).toHaveLength(manifest.eventCount);
    expect(frames).toHaveLength(manifest.frameCount);
    expect(timeline).toMatchObject({
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      status: "complete",
    });
    expect(timeline.events).toHaveLength(events.length);
    expect(timeline.frames).toHaveLength(frames.length);
    expect(timeline.artifacts).toHaveLength(1);

    expect(events.map((event) => event.sequence)).toEqual([...Array(events.length).keys()]);
    expect(frames.map((frame) => frame.sequence)).toEqual([...Array(frames.length).keys()]);
    expect(events.every((event) => event.runId === manifest.runId && event.sessionId === manifest.sessionId)).toBe(true);
    expect(frames.every((frame) => frame.sessionId === manifest.sessionId)).toBe(true);
    expect(events.filter((event) => event.source === "agent").map((event) => event.type)).toEqual([
      "agent.decision",
      "agent.observation",
      "agent.assertion",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "permission.snapshot",
      "recording.started",
      "target.selected",
      "app.focused",
      "window.changed",
      "accessibility.tree",
      "screen.frame",
      "agent.decision",
      "agent.observation",
      "agent.assertion",
      "screen.frame",
      "recording.stopped",
    ]);

    for (const event of events) {
      expect(event.monotonicTimeNs).toBeGreaterThanOrEqual(manifest.clockCalibration.monotonicTimeNs);
      expect(Date.parse(event.wallTime)).toBeGreaterThanOrEqual(Date.parse(manifest.createdAt));
    }
    for (const frame of frames) {
      expect(frame.monotonicTimeNs).toBeGreaterThanOrEqual(manifest.clockCalibration.monotonicTimeNs);
    }

    const artifact = manifest.artifacts[0];
    expect(artifact).toBeDefined();
    const artifactPath = artifact!.path;
    const artifactRelativePath = path.relative(manifest.paths.artifactsDir, artifactPath);
    expect(artifactRelativePath.startsWith("..")).toBe(false);
    expect(path.isAbsolute(artifactRelativePath)).toBe(false);

    const artifactBytes = await readFile(artifactPath);
    const artifactStat = await stat(artifactPath);
    expect(artifactStat.isFile()).toBe(true);
    expect(artifact!.bytes).toBe(artifactBytes.byteLength);
    expect(artifact!.sha256).toBe(createHash("sha256").update(artifactBytes).digest("hex"));
    expect(artifactBytes.toString("utf8")).toBe(`Spores helper synthetic capture for ${runId}\n`);
  });
});

function parseNdjson<T>(raw: string, parse: (value: unknown) => T): T[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line)));
}
