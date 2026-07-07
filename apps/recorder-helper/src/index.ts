#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  ArtifactRefSchema,
  FrameRefSchema,
  PermissionBrokerStatusSchema,
  PermissionCapability,
  PermissionRequestResultSchema,
  PermissionState,
  PermissionStateSchema,
  PermissionSnapshotSchema,
  RecorderHelperSessionSchema,
  RecorderHelperTargetsSchema,
  SporesEvent,
  SporesEventSchema,
  TargetRef,
  TargetRefSchema,
  createSporesId,
  monotonicTimeNs,
  nowIso,
} from "@spores/schema";

const VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;

const HelperRequestSchema = z.object({
  id: z.string(),
  method: z.enum([
    "doctor",
    "list_targets",
    "permissions_status",
    "permissions_request",
    "start_session",
    "get_status",
    "stop_session",
    "shutdown",
  ]),
  params: z.unknown().optional(),
});

type HelperRequest = z.infer<typeof HelperRequestSchema>;

const StorePathsSchema = z.object({
  runDir: z.string(),
  manifest: z.string(),
  events: z.string(),
  frames: z.string(),
  artifactsDir: z.string(),
});

const SessionParamsSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  target: TargetRefSchema,
  paths: StorePathsSchema,
  purpose: z.string().optional(),
  eventCount: z.number().int().nonnegative().default(0),
  frameCount: z.number().int().nonnegative().default(0),
});

export function createHelperStatus(targetCount: number) {
  return {
    configured: true,
    available: true,
    mode: "stdio" as const,
    command: "spores-recorder-helper",
    args: ["--stdio"],
    pid: process.pid,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    targetCount,
    capabilities: {
      listTargets: true,
      startSession: true,
      stopSession: true,
      permissions: true,
    },
  };
}

export function listTargets(): TargetRef[] {
  return [
    TargetRefSchema.parse({
      targetId: "display:main",
      kind: "display",
      displayId: "main",
      app: {
        name: "Desktop",
        bundleId: platformDesktopBundleId(),
      },
      window: {
        id: "desktop",
        title: "Main Display",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      },
      safeToPersist: true,
    }),
    TargetRefSchema.parse({
      targetId: "app:spores-recorder-helper",
      kind: "app",
      app: {
        name: "Spores Recorder Helper",
        bundleId: "dev.spores.recorder-helper",
        processId: process.pid,
      },
      safeToPersist: true,
    }),
    TargetRefSchema.parse({
      targetId: "window:spores-recorder-helper:status",
      kind: "window",
      displayId: "main",
      app: {
        name: "Spores Recorder Helper",
        bundleId: "dev.spores.recorder-helper",
        processId: process.pid,
      },
      window: {
        id: "spores-recorder-helper:status",
        title: "Spores Recorder Helper",
        bounds: { x: 80, y: 80, width: 1024, height: 640 },
      },
      safeToPersist: true,
    }),
  ];
}

export async function runStdio(): Promise<number> {
  const readline = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of readline) {
    if (line.trim().length === 0) {
      continue;
    }
    const response = await handleRequest(line);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (isShutdownResult(response.result)) {
      break;
    }
  }

  return 0;
}

async function handleRequest(line: string) {
  try {
    const request = HelperRequestSchema.parse(JSON.parse(line));
    return {
      id: request.id,
      ok: true as const,
      result: await handleParsedRequest(request),
    };
  } catch (error) {
    return {
      id: "unknown",
      ok: false as const,
      error: {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        retriable: false,
        requiresUserAction: false,
      },
    };
  }
}

async function handleParsedRequest(request: HelperRequest) {
  const targets = listTargets();
  switch (request.method) {
    case "doctor":
      return createHelperStatus(targets.length);
    case "list_targets":
      return RecorderHelperTargetsSchema.parse({
        status: createHelperStatus(targets.length),
        targets,
      });
    case "permissions_status":
      return createPermissionStatus();
    case "permissions_request":
      return createPermissionRequestResult();
    case "start_session":
      return startSession(SessionParamsSchema.parse(request.params));
    case "get_status":
      return getSessionStatus(SessionParamsSchema.parse(request.params));
    case "stop_session":
      return stopSession(SessionParamsSchema.parse(request.params));
    case "shutdown":
      return { shutdown: true };
  }
}

async function startSession(params: z.infer<typeof SessionParamsSchema>) {
  await mkdir(params.paths.artifactsDir, { recursive: true });
  const events = [
    createEvent(params, params.eventCount, "permission.snapshot", helperPermissionSnapshot()),
    createEvent(params, params.eventCount + 1, "recording.started", {
      purpose: params.purpose ?? "helper-backed synthetic recording",
      recorder: "recorder-helper",
      nativeCapture: false,
    }),
    createEvent(params, params.eventCount + 2, "target.selected", { target: params.target }),
    createEvent(params, params.eventCount + 3, "app.focused", {
      bundleId: params.target.app?.bundleId,
      name: params.target.app?.name,
      processId: params.target.app?.processId,
    }),
    createEvent(params, params.eventCount + 4, "window.changed", {
      windowId: params.target.window?.id,
      title: params.target.window?.title,
      bounds: params.target.window?.bounds,
    }),
    createEvent(params, params.eventCount + 5, "accessibility.tree", {
      snapshotId: `${params.sessionId}:ax:0`,
      root: {
        role: params.target.window ? "window" : params.target.kind,
        label: params.target.window?.title ?? params.target.app?.name ?? params.target.targetId,
      },
      synthetic: true,
    }),
  ];
  const frame = createFrame(params, params.frameCount, 0);
  events.push(createEvent(params, params.eventCount + 6, "screen.frame", {
    frameId: frame.frameId,
    videoTimeMs: frame.videoTimeMs,
    synthetic: true,
  }));

  await appendEvents(params.paths.events, events);
  await appendFrame(params.paths.frames, frame);

  return RecorderHelperSessionSchema.parse({
    runId: params.runId,
    sessionId: params.sessionId,
    status: "recording",
    eventCount: params.eventCount + events.length,
    frameCount: params.frameCount + 1,
    artifacts: [],
  });
}

async function getSessionStatus(params: z.infer<typeof SessionParamsSchema>) {
  const events = await readNdjson(params.paths.events, SporesEventSchema.parse);
  const frames = await readNdjson(params.paths.frames, FrameRefSchema.parse);
  const stopped = events.some((event) => event.type === "recording.stopped");
  return RecorderHelperSessionSchema.parse({
    runId: params.runId,
    sessionId: params.sessionId,
    status: stopped ? "complete" : "recording",
    eventCount: events.length,
    frameCount: frames.length,
    artifacts: [],
  });
}

async function stopSession(params: z.infer<typeof SessionParamsSchema>) {
  await mkdir(params.paths.artifactsDir, { recursive: true });
  const frame = createFrame(params, params.frameCount, 1000);
  const events = [
    createEvent(params, params.eventCount, "screen.frame", {
      frameId: frame.frameId,
      videoTimeMs: frame.videoTimeMs,
      synthetic: true,
    }),
    createEvent(params, params.eventCount + 1, "recording.stopped", {
      reason: "requested",
      recorder: "recorder-helper",
      nativeCapture: false,
    }),
  ];
  const artifact = await writeCaptureArtifact(params);

  await appendFrame(params.paths.frames, frame);
  await appendEvents(params.paths.events, events);

  return RecorderHelperSessionSchema.parse({
    runId: params.runId,
    sessionId: params.sessionId,
    status: "complete",
    eventCount: params.eventCount + events.length,
    frameCount: params.frameCount + 1,
    artifacts: [artifact],
  });
}

function createEvent(
  params: z.infer<typeof SessionParamsSchema>,
  sequence: number,
  type: SporesEvent["type"],
  payload: Record<string, unknown>,
): SporesEvent {
  return SporesEventSchema.parse({
    schemaVersion: 1,
    eventId: createSporesId("evt"),
    runId: params.runId,
    sessionId: params.sessionId,
    sequence,
    type,
    wallTime: nowIso(),
    monotonicTimeNs: monotonicTimeNs(),
    source: "recorder-helper",
    payload,
  });
}

function createFrame(params: z.infer<typeof SessionParamsSchema>, sequence: number, videoTimeMs: number) {
  return FrameRefSchema.parse({
    frameId: `${params.sessionId}:frame:${sequence}`,
    sessionId: params.sessionId,
    sequence,
    monotonicTimeNs: monotonicTimeNs(),
    videoTimeMs,
  });
}

async function writeCaptureArtifact(params: z.infer<typeof SessionParamsSchema>) {
  const content = Buffer.from(`Spores helper synthetic capture for ${params.runId}\n`);
  const artifactPath = path.join(params.paths.artifactsDir, "helper-capture.txt");
  await writeFile(artifactPath, content);
  return ArtifactRefSchema.parse({
    artifactId: createSporesId("art"),
    kind: "text",
    path: artifactPath,
    mediaType: "text/plain",
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    createdAt: nowIso(),
    timeRangeMs: [0, 1000],
    redactionState: "not_required",
  });
}

async function appendEvents(filePath: string, events: SporesEvent[]) {
  await appendFile(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function appendFrame(filePath: string, frame: z.infer<typeof FrameRefSchema>) {
  await appendFile(filePath, `${JSON.stringify(frame)}\n`);
}

async function readNdjson<T>(filePath: string, parse: (value: unknown) => T): Promise<T[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line)));
}

function helperPermissionSnapshot() {
  return createPermissionStatus().snapshot;
}

function createPermissionStatus() {
  const snapshot = PermissionSnapshotSchema.parse({
    platform: process.platform,
    screenRecording: readPermissionState("SCREEN_RECORDING", "granted"),
    accessibility: readPermissionState("ACCESSIBILITY", "granted"),
    inputMonitoring: readPermissionState("INPUT_MONITORING", "not_requested"),
    microphone: readPermissionState("MICROPHONE", "not_requested"),
    systemAudio: readPermissionState("SYSTEM_AUDIO", "not_requested"),
    requiresUserAction: false,
  });
  const capabilities: PermissionCapability[] = [
    {
      permission: "screenRecording",
      label: "Screen Recording",
      status: snapshot.screenRecording,
      required: true,
      canRequest: process.platform === "darwin",
      reason: "Required to capture pixels from displays, windows, and apps.",
      settingsUrl: process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        : undefined,
    },
    {
      permission: "accessibility",
      label: "Accessibility",
      status: snapshot.accessibility,
      required: true,
      canRequest: process.platform === "darwin",
      reason: "Required to capture UI structure and correlate actions with interface elements.",
      settingsUrl: process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        : undefined,
    },
    {
      permission: "inputMonitoring",
      label: "Input Monitoring",
      status: snapshot.inputMonitoring,
      required: false,
      canRequest: process.platform === "darwin",
      reason: "Optional richer keyboard metadata for future native capture.",
      settingsUrl: process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        : undefined,
    },
    {
      permission: "microphone",
      label: "Microphone",
      status: snapshot.microphone,
      required: false,
      canRequest: process.platform === "darwin",
      reason: "Optional narration capture; not used by the current helper-backed lifecycle.",
    },
    {
      permission: "systemAudio",
      label: "System Audio",
      status: snapshot.systemAudio,
      required: false,
      canRequest: false,
      reason: "Optional future system-audio capture.",
    },
  ];
  const requiresUserAction = capabilities.some((capability) => (
    capability.required && capability.status !== "granted"
  ));

  return PermissionBrokerStatusSchema.parse({
    platform: process.platform,
    mode: "deterministic",
    snapshot: {
      ...snapshot,
      requiresUserAction,
    },
    capabilities,
    requiresUserAction,
  });
}

function createPermissionRequestResult() {
  const status = createPermissionStatus();
  const actions = status.capabilities.filter((capability) => (
    capability.required && capability.status !== "granted"
  ));
  return PermissionRequestResultSchema.parse({
    status,
    opened: false,
    message: actions.length === 0
      ? "All required permissions are already granted."
      : "Open the listed system settings panes and rerun permissions status after granting access.",
    actions,
  });
}

function readPermissionState(name: string, fallback: PermissionState): PermissionState {
  const value = process.env[`SPORES_PERMISSION_${name}`];
  const parsed = PermissionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function isShutdownResult(value: unknown): value is { shutdown: true } {
  return Boolean(value && typeof value === "object" && "shutdown" in value && value.shutdown === true);
}

function platformDesktopBundleId(): string {
  switch (process.platform) {
    case "darwin":
      return "com.apple.WindowServer";
    case "win32":
      return "explorer.exe";
    default:
      return "desktop";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--stdio")) {
    process.exitCode = await runStdio();
  } else if (process.argv.includes("--list-targets")) {
    const targets = listTargets();
    process.stdout.write(`${JSON.stringify({ status: createHelperStatus(targets.length), targets }, null, 2)}\n`);
  } else {
    const targets = listTargets();
    process.stdout.write(`${JSON.stringify(createHelperStatus(targets.length), null, 2)}\n`);
  }
}
