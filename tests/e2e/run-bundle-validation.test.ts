import { createHash } from "node:crypto";
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

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-bundle-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("run bundle e2e validation", () => {
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
