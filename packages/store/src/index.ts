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
    this.rootDir = path.resolve(rootDir);
  }

  pathsForRun(runId: string): StorePaths {
    const safeRunId = validateRunId(runId);
    const runDir = containedPath(this.rootDir, path.resolve(this.rootDir, safeRunId), "run directory");
    return {
      runDir,
      manifest: path.join(runDir, "manifest.json"),
      events: path.join(runDir, "events.ndjson"),
      frames: path.join(runDir, "frames.ndjson"),
      artifactsDir: path.join(runDir, "artifacts"),
    };
  }

  async createRun(input: CreateRunInput): Promise<RunManifest> {
    const runId = validateRunId(input.runId ?? createSporesId("run"));
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
    const manifest = RunManifestSchema.parse(JSON.parse(raw));
    return this.normalizeManifest(manifest, validateRunId(runId));
  }

  async listRunIds(): Promise<string[]> {
    return (await safeReadDirNames(this.rootDir)).filter(isValidRunId);
  }

  async listManifests(): Promise<RunManifest[]> {
    const runIds = await this.listRunIds();
    const manifests = await Promise.all(
      runIds.map((runId) => this.readManifest(runId).catch(() => undefined)),
    );
    return manifests.filter((manifest): manifest is RunManifest => manifest !== undefined);
  }

  async readLatestManifest(): Promise<RunManifest | undefined> {
    const manifests = await this.listManifests();
    return manifests.sort((left, right) => {
      const rightTime = Date.parse(right.updatedAt);
      const leftTime = Date.parse(left.updatedAt);
      return rightTime - leftTime;
    })[0];
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    const safeManifest = this.normalizeManifest(manifest);
    await mkdir(safeManifest.paths.runDir, { recursive: true });
    await writeFile(safeManifest.paths.manifest, `${JSON.stringify(safeManifest, null, 2)}\n`);
  }

  async updateManifest(runId: string, update: (manifest: RunManifest) => RunManifest): Promise<RunManifest> {
    const safeRunId = validateRunId(runId);
    const current = await this.readManifest(safeRunId);
    const next = RunManifestSchema.parse({
      ...update(current),
      updatedAt: nowIso(),
    });
    const safeNext = this.normalizeManifest(next, safeRunId);
    await this.writeManifest(safeNext);
    return safeNext;
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
    const artifactPath = artifactPathForRelativePath(manifest.paths.artifactsDir, relativePath);
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
      if (!isValidRunId(runId)) {
        continue;
      }
      const manifest = await this.readManifest(runId).catch(() => undefined);
      if (manifest?.sessionId === sessionId) {
        return manifest;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }

  private normalizeManifest(manifest: RunManifest, expectedRunId?: string): RunManifest {
    const runId = validateRunId(manifest.runId);
    if (expectedRunId !== undefined && runId !== expectedRunId) {
      throw new Error(`manifest runId mismatch: expected ${expectedRunId}, received ${runId}`);
    }

    const paths = this.pathsForRun(runId);
    assertCanonicalManifestPaths(manifest.paths, paths);
    const artifacts = manifest.artifacts.map((artifact) => normalizeArtifactPath(artifact, paths.artifactsDir));
    return RunManifestSchema.parse({
      ...manifest,
      runId,
      paths,
      artifacts,
    });
  }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === ".." || runId.includes("\0")) {
    throw new Error(`invalid runId: ${runId}`);
  }
  return runId;
}

function isValidRunId(runId: string): boolean {
  try {
    validateRunId(runId);
    return true;
  } catch {
    return false;
  }
}

function assertCanonicalManifestPaths(actual: StorePaths, expected: StorePaths): void {
  assertSamePath(actual.runDir, expected.runDir, "manifest paths.runDir");
  assertSamePath(actual.manifest, expected.manifest, "manifest paths.manifest");
  assertSamePath(actual.events, expected.events, "manifest paths.events");
  assertSamePath(actual.frames, expected.frames, "manifest paths.frames");
  assertSamePath(actual.artifactsDir, expected.artifactsDir, "manifest paths.artifactsDir");
}

function assertSamePath(actual: string, expected: string, label: string): void {
  const resolvedActual = containedPath(path.dirname(expected), actual, label);
  const resolvedExpected = path.resolve(expected);
  if (resolvedActual !== resolvedExpected) {
    throw new Error(`${label} must be ${resolvedExpected}, received ${resolvedActual}`);
  }
}

function normalizeArtifactPath(artifact: ArtifactRef, artifactsDir: string): ArtifactRef {
  return ArtifactRefSchema.parse({
    ...artifact,
    path: resolveArtifactPath(artifactsDir, artifact.path),
  });
}

function artifactPathForRelativePath(artifactsDir: string, relativePath: string): string {
  const safeRelativePath = validateArtifactRelativePath(relativePath);
  return containedPath(artifactsDir, path.resolve(artifactsDir, safeRelativePath), "artifact path", {
    allowRoot: false,
  });
}

function resolveArtifactPath(artifactsDir: string, artifactPath: string): string {
  if (artifactPath.length === 0 || artifactPath.includes("\0")) {
    throw new Error("artifact path must be non-empty");
  }
  if (path.win32.isAbsolute(artifactPath) && !path.isAbsolute(artifactPath)) {
    throw new Error(`artifact path uses an unsupported absolute path format: ${artifactPath}`);
  }
  if (path.isAbsolute(artifactPath)) {
    return containedPath(artifactsDir, artifactPath, "artifact path", { allowRoot: false });
  }
  return artifactPathForRelativePath(artifactsDir, artifactPath);
}

function validateArtifactRelativePath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("artifact relative path must be non-empty");
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`artifact relative path must not be absolute: ${relativePath}`);
  }

  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`artifact relative path contains an unsafe segment: ${relativePath}`);
  }
  return segments.join(path.sep);
}

function containedPath(
  rootPath: string,
  candidatePath: string,
  label: string,
  options: { allowRoot?: boolean } = {},
): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  const insideRoot = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!insideRoot || (relative === "" && options.allowRoot === false)) {
    throw new Error(`${label} escapes its allowed root: ${candidate}`);
  }
  return candidate;
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
