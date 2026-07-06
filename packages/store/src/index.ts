import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactRef,
  ArtifactRefSchema,
  ClockCalibration,
  FrameRef,
  FrameRefSchema,
  PermissionSnapshot,
  RunManifest,
  RunManifestSchema,
  SporesEvent,
  SporesEventSchema,
  TargetRef,
  Timeline,
  TimelineSchema,
  createSporesId,
  monotonicTimeNs,
  nowIso,
} from "@spores/schema";

export type CreateRunInput = {
  runId?: string;
  sessionId?: string;
  target: TargetRef;
  permissionSnapshot?: PermissionSnapshot;
};

export type StorePaths = {
  runDir: string;
  manifest: string;
  events: string;
  frames: string;
  artifactsDir: string;
};

const defaultPermissionSnapshot: PermissionSnapshot = {
  platform: process.platform,
  screenRecording: "not_requested",
  accessibility: "not_requested",
  inputMonitoring: "not_requested",
  microphone: "not_requested",
  systemAudio: "not_requested",
  requiresUserAction: false,
};

export class RunStore {
  readonly rootDir: string;

  constructor(rootDir = path.resolve(".spores/runs")) {
    this.rootDir = rootDir;
  }

  pathsForRun(runId: string): StorePaths {
    const runDir = path.join(this.rootDir, runId);
    return {
      runDir,
      manifest: path.join(runDir, "manifest.json"),
      events: path.join(runDir, "events.ndjson"),
      frames: path.join(runDir, "frames.ndjson"),
      artifactsDir: path.join(runDir, "artifacts"),
    };
  }

  async createRun(input: CreateRunInput): Promise<RunManifest> {
    const runId = input.runId ?? createSporesId("run");
    const sessionId = input.sessionId ?? createSporesId("sess");
    const paths = this.pathsForRun(runId);
    const createdAt = nowIso();
    const clockCalibration: ClockCalibration = {
      wallTime: createdAt,
      monotonicTimeNs: monotonicTimeNs(),
    };

    await mkdir(paths.artifactsDir, { recursive: true });
    await writeFile(paths.events, "", { flag: "a" });
    await writeFile(paths.frames, "", { flag: "a" });

    const manifest = RunManifestSchema.parse({
      schemaVersion: 1,
      runId,
      sessionId,
      status: "recording",
      createdAt,
      updatedAt: createdAt,
      target: input.target,
      permissionSnapshot: input.permissionSnapshot ?? defaultPermissionSnapshot,
      clockCalibration,
      artifacts: [],
      eventCount: 0,
      frameCount: 0,
      paths,
    });

    await this.writeManifest(manifest);
    return manifest;
  }

  async readManifest(runId: string): Promise<RunManifest> {
    const paths = this.pathsForRun(runId);
    const raw = await readFile(paths.manifest, "utf8");
    return RunManifestSchema.parse(JSON.parse(raw));
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    await mkdir(manifest.paths.runDir, { recursive: true });
    await writeFile(manifest.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async updateManifest(runId: string, update: (manifest: RunManifest) => RunManifest): Promise<RunManifest> {
    const current = await this.readManifest(runId);
    const next = RunManifestSchema.parse({
      ...update(current),
      updatedAt: nowIso(),
    });
    await this.writeManifest(next);
    return next;
  }

  async appendEvent(event: SporesEvent): Promise<SporesEvent> {
    const parsed = SporesEventSchema.parse(event);
    const manifest = await this.readManifest(parsed.runId);
    await appendFile(manifest.paths.events, `${JSON.stringify(parsed)}\n`);
    await this.updateManifest(parsed.runId, (current) => ({
      ...current,
      eventCount: current.eventCount + 1,
    }));
    return parsed;
  }

  async appendFrame(frame: FrameRef): Promise<FrameRef> {
    const parsed = FrameRefSchema.parse(frame);
    const manifest = await this.readManifestBySession(parsed.sessionId);
    await appendFile(manifest.paths.frames, `${JSON.stringify(parsed)}\n`);
    await this.updateManifest(manifest.runId, (current) => ({
      ...current,
      frameCount: current.frameCount + 1,
    }));
    return parsed;
  }

  async writeArtifact(runId: string, relativePath: string, content: string | Buffer, options: {
    kind?: ArtifactRef["kind"];
    mediaType?: string;
    redactionState?: ArtifactRef["redactionState"];
    timeRangeMs?: [number, number];
  } = {}): Promise<ArtifactRef> {
    const manifest = await this.readManifest(runId);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const artifactPath = path.join(manifest.paths.artifactsDir, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);

    const artifact = ArtifactRefSchema.parse({
      artifactId: createSporesId("art"),
      kind: options.kind ?? "text",
      path: artifactPath,
      mediaType: options.mediaType ?? "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      createdAt: nowIso(),
      timeRangeMs: options.timeRangeMs,
      redactionState: options.redactionState ?? "not_required",
    });

    await this.updateManifest(runId, (current) => ({
      ...current,
      artifacts: [...current.artifacts, artifact],
    }));
    return artifact;
  }

  async readEvents(runId: string): Promise<SporesEvent[]> {
    const manifest = await this.readManifest(runId);
    return readNdjson(manifest.paths.events, SporesEventSchema.parse);
  }

  async readFrames(runId: string): Promise<FrameRef[]> {
    const manifest = await this.readManifest(runId);
    return readNdjson(manifest.paths.frames, FrameRefSchema.parse);
  }

  async readTimeline(runId: string): Promise<Timeline> {
    const manifest = await this.readManifest(runId);
    return TimelineSchema.parse({
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      status: manifest.status,
      events: await this.readEvents(runId),
      frames: await this.readFrames(runId),
      artifacts: manifest.artifacts,
    });
  }

  async readArtifact(runId: string, artifactId: string): Promise<{ artifact: ArtifactRef; content: string }> {
    const manifest = await this.readManifest(runId);
    const artifact = manifest.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${artifactId}`);
    }
    return {
      artifact,
      content: await readFile(artifact.path, "utf8"),
    };
  }

  private async readManifestBySession(sessionId: string): Promise<RunManifest> {
    const runIds = await safeReadDirNames(this.rootDir);
    for (const runId of runIds) {
      const manifest = await this.readManifest(runId).catch(() => undefined);
      if (manifest?.sessionId === sessionId) {
        return manifest;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}

async function readNdjson<T>(filePath: string, parse: (value: unknown) => T): Promise<T[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line)));
}

async function safeReadDirNames(dirPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dirPath).catch(() => []);
}
