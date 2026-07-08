#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import {
  ArtifactRefSchema,
  BoundsSchema,
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
const MACOS_TARGET_SNAPSHOT_SCRIPT = String.raw`
import AppKit
import CoreGraphics
import Foundation

func intValue(_ value: Any?) -> Int? {
  if let number = value as? NSNumber {
    return number.intValue
  }
  if let value = value as? Int {
    return value
  }
  if let value = value as? String {
    return Int(value)
  }
  return nil
}

func doubleValue(_ value: Any?) -> Double? {
  if let number = value as? NSNumber {
    return number.doubleValue
  }
  if let value = value as? Double {
    return value
  }
  if let value = value as? Int {
    return Double(value)
  }
  if let value = value as? String {
    return Double(value)
  }
  return nil
}

func stringValue(_ value: Any?) -> String? {
  if let value = value as? String, !value.isEmpty {
    return value
  }
  if let number = value as? NSNumber {
    return number.stringValue
  }
  return nil
}

func boundsPayload(x: Double, y: Double, width: Double, height: Double) -> [String: Any] {
  return [
    "x": x,
    "y": y,
    "width": max(0, width),
    "height": max(0, height),
  ]
}

func boundsPayload(_ raw: Any?) -> [String: Any]? {
  guard let dict = raw as? [String: Any],
    let x = doubleValue(dict["X"]),
    let y = doubleValue(dict["Y"]),
    let width = doubleValue(dict["Width"]),
    let height = doubleValue(dict["Height"]),
    width > 0,
    height > 0
  else {
    return nil
  }
  return boundsPayload(x: x, y: y, width: width, height: height)
}

let maxDisplays = 32
var displayIds = [CGDirectDisplayID](repeating: 0, count: maxDisplays)
var displayCount: UInt32 = 0
CGGetActiveDisplayList(UInt32(maxDisplays), &displayIds, &displayCount)
let mainDisplayId = CGMainDisplayID()
let activeDisplays = Array(displayIds.prefix(Int(displayCount))).sorted {
  if $0 == mainDisplayId {
    return true
  }
  if $1 == mainDisplayId {
    return false
  }
  return $0 < $1
}

var displays: [[String: Any]] = []
for (index, displayId) in activeDisplays.enumerated() {
  let rect = CGDisplayBounds(displayId)
  let publicDisplayId = displayId == mainDisplayId ? "main" : String(index + 1)
  displays.append([
    "targetId": displayId == mainDisplayId ? "display:main" : "display:\(index + 1)",
    "displayId": publicDisplayId,
    "bounds": boundsPayload(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height),
  ])
}

let windowOptions = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let rawWindows = CGWindowListCopyWindowInfo(windowOptions, kCGNullWindowID) as? [[String: Any]] ?? []
var windows: [[String: Any]] = []
var zOrder = 0

for window in rawWindows {
  let layer = intValue(window[kCGWindowLayer as String]) ?? -1
  if layer != 0 {
    continue
  }
  let alpha = doubleValue(window[kCGWindowAlpha as String]) ?? 1
  if alpha <= 0 {
    continue
  }
  guard let windowId = stringValue(window[kCGWindowNumber as String]),
    let bounds = boundsPayload(window[kCGWindowBounds as String])
  else {
    continue
  }

  let processId = intValue(window[kCGWindowOwnerPID as String])
  let runningApp = processId.flatMap { NSRunningApplication(processIdentifier: pid_t($0)) }
  let ownerName = stringValue(window[kCGWindowOwnerName as String])
  let appName = runningApp?.localizedName ?? ownerName ?? "Unknown App"

  var payload: [String: Any] = [
    "id": windowId,
    "appName": appName,
    "bounds": bounds,
    "zOrder": zOrder,
  ]
  if let title = stringValue(window[kCGWindowName as String]) {
    payload["title"] = title
  }
  if let processId = processId {
    payload["processId"] = processId
  }
  if let bundleId = runningApp?.bundleIdentifier, !bundleId.isEmpty {
    payload["bundleId"] = bundleId
  }
  windows.append(payload)
  zOrder += 1
}

let payload: [String: Any] = [
  "displays": displays,
  "windows": windows,
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`;

const HelperRequestSchema = z.object({
  id: z.string(),
  method: z.enum([
    "doctor",
    "list_targets",
    "permissions_status",
    "permissions_probe",
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
  capture: z
    .object({
      mode: z.enum(["synthetic", "native"]).default("synthetic"),
      maxDurationSeconds: z.number().int().min(1).max(30).default(2),
    })
    .default({ mode: "synthetic", maxDurationSeconds: 2 }),
});

const NativeCaptureStateSchema = z.object({
  mode: z.literal("native"),
  pid: z.number().int().positive(),
  outputPath: z.string(),
  startedAt: z.string().datetime(),
  expectedStopAt: z.string().datetime(),
  maxDurationSeconds: z.number().int().positive(),
  displayNumber: z.number().int().positive().optional(),
  windowId: z.string().optional(),
  region: BoundsSchema.optional(),
  captureArgs: z.array(z.string()).optional(),
});

const MacOSDisplayTargetSchema = z.object({
  targetId: z.string(),
  displayId: z.string(),
  bounds: BoundsSchema,
});

const MacOSWindowTargetSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  appName: z.string(),
  bundleId: z.string().optional(),
  processId: z.number().int().optional(),
  bounds: BoundsSchema,
  zOrder: z.number().int().nonnegative(),
});

const MacOSTargetSnapshotSchema = z.object({
  displays: z.array(MacOSDisplayTargetSchema),
  windows: z.array(MacOSWindowTargetSchema),
});

type TargetSnapshot = {
  targets: TargetRef[];
  targetSource: "macos" | "deterministic_fallback";
  targetDiscoveryError?: string;
};

type TargetDiscoveryMode = "native" | "deterministic";

export function createHelperStatus(targetCount: number, snapshot?: Pick<TargetSnapshot, "targetSource" | "targetDiscoveryError">) {
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
    targetSource: snapshot?.targetSource ?? "unknown",
    targetDiscoveryError: snapshot?.targetDiscoveryError,
    capabilities: {
      listTargets: true,
      startSession: true,
      stopSession: true,
      permissions: true,
      permissionsProbe: true,
    },
  };
}

export async function listTargets(): Promise<TargetRef[]> {
  return (await listTargetSnapshot()).targets;
}

async function listTargetSnapshot(): Promise<TargetSnapshot> {
  if (targetDiscoveryMode() === "deterministic") {
    return {
      targets: deterministicTargets(),
      targetSource: "deterministic_fallback",
    };
  }

  if (process.platform === "darwin") {
    let macOSError: unknown;
    const targets = await listMacOSTargets().catch((error) => {
      macOSError = error;
      return undefined;
    });
    if (targets && targets.length > 0) {
      return {
        targets,
        targetSource: "macos",
      };
    }
    return {
      targets: deterministicTargets(),
      targetSource: "deterministic_fallback",
      targetDiscoveryError: macOSError instanceof Error ? macOSError.message : String(macOSError ?? "macOS target discovery returned no targets"),
    };
  }

  return {
    targets: deterministicTargets(),
    targetSource: "deterministic_fallback",
  };
}

function targetDiscoveryMode(): TargetDiscoveryMode {
  return process.env.SPORES_TARGET_DISCOVERY_MODE?.trim().toLowerCase() === "deterministic"
    ? "deterministic"
    : "native";
}

function deterministicTargets(): TargetRef[] {
  return [
    TargetRefSchema.parse({
      targetId: "display:main",
      kind: "display",
      displayId: "main",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
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
      bounds: { x: 80, y: 80, width: 1024, height: 640 },
      zOrder: 0,
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

async function listMacOSTargets(): Promise<TargetRef[]> {
  const snapshot = MacOSTargetSnapshotSchema.parse(
    JSON.parse(await execFileUtf8("/usr/bin/swift", ["-e", MACOS_TARGET_SNAPSHOT_SCRIPT], 4_000)),
  );
  const targets: TargetRef[] = [];
  const seen = new Set<string>();

  for (const display of snapshot.displays) {
    const target = TargetRefSchema.parse({
      targetId: display.targetId,
      kind: "display",
      displayId: display.displayId,
      bounds: display.bounds,
      app: {
        name: "Desktop",
        bundleId: platformDesktopBundleId(),
      },
      window: {
        id: "desktop",
        title: display.displayId === "main" ? "Main Display" : `Display ${display.displayId}`,
        bounds: display.bounds,
      },
      safeToPersist: true,
    });
    targets.push(target);
    seen.add(target.targetId);
  }

  const appTargets = new Map<string, {
    targetId: string;
    appName: string;
    bundleId?: string;
    processId?: number;
    bounds: z.infer<typeof BoundsSchema>;
    zOrder: number;
  }>();
  for (const window of snapshot.windows) {
    const targetId = appTargetId(window);
    const existing = appTargets.get(targetId);
    if (!existing) {
      appTargets.set(targetId, {
        targetId,
        appName: window.appName,
        bundleId: window.bundleId,
        processId: window.processId,
        bounds: window.bounds,
        zOrder: window.zOrder,
      });
      continue;
    }
    existing.bounds = unionBounds(existing.bounds, window.bounds);
    existing.zOrder = Math.min(existing.zOrder, window.zOrder);
  }

  for (const app of [...appTargets.values()].sort((left, right) => left.zOrder - right.zOrder)) {
    if (seen.has(app.targetId)) {
      continue;
    }
    targets.push(TargetRefSchema.parse({
      targetId: app.targetId,
      kind: "app",
      displayId: displayIdForBounds(app.bounds, snapshot.displays),
      bounds: app.bounds,
      zOrder: app.zOrder,
      app: {
        name: app.appName,
        bundleId: app.bundleId,
        processId: app.processId,
      },
      safeToPersist: true,
    }));
    seen.add(app.targetId);
  }

  for (const window of snapshot.windows) {
    const targetId = `window:${window.id}`;
    if (seen.has(targetId)) {
      continue;
    }
    targets.push(TargetRefSchema.parse({
      targetId,
      kind: "window",
      displayId: displayIdForBounds(window.bounds, snapshot.displays),
      bounds: window.bounds,
      zOrder: window.zOrder,
      app: {
        name: window.appName,
        bundleId: window.bundleId,
        processId: window.processId,
      },
      window: {
        id: window.id,
        title: window.title,
        bounds: window.bounds,
      },
      safeToPersist: true,
    }));
    seen.add(targetId);
  }

  return targets;
}

function appTargetId(window: z.infer<typeof MacOSWindowTargetSchema>): string {
  if (window.bundleId) {
    return `app:${window.bundleId}`;
  }
  if (window.processId) {
    return `app:pid:${window.processId}`;
  }
  return `app:${slugifyTargetPart(window.appName)}`;
}

function slugifyTargetPart(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

function unionBounds(
  left: z.infer<typeof BoundsSchema>,
  right: z.infer<typeof BoundsSchema>,
): z.infer<typeof BoundsSchema> {
  const minX = Math.min(left.x, right.x);
  const minY = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return BoundsSchema.parse({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  });
}

function displayIdForBounds(
  bounds: z.infer<typeof BoundsSchema>,
  displays: Array<z.infer<typeof MacOSDisplayTargetSchema>>,
): string | undefined {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return displays.find((display) => (
    centerX >= display.bounds.x &&
    centerX <= display.bounds.x + display.bounds.width &&
    centerY >= display.bounds.y &&
    centerY <= display.bounds.y + display.bounds.height
  ))?.displayId;
}

function execFileUtf8(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end();
  });
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
  let requestId = "unknown";
  try {
    const raw = JSON.parse(line) as unknown;
    requestId = extractRequestId(raw);
    const request = HelperRequestSchema.parse(raw);
    try {
      return {
        id: request.id,
        ok: true as const,
        result: await handleParsedRequest(request),
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false as const,
        error: {
          code: error instanceof z.ZodError ? "invalid_request" : "handler_error",
          message: error instanceof Error ? error.message : String(error),
          retriable: !(error instanceof z.ZodError),
          requiresUserAction: false,
        },
      };
    }
  } catch (error) {
    return {
      id: requestId,
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

function extractRequestId(value: unknown): string {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string") {
      return id;
    }
  }
  return "unknown";
}

async function handleParsedRequest(request: HelperRequest) {
  switch (request.method) {
    case "doctor": {
      const snapshot = await listTargetSnapshot();
      return createHelperStatus(snapshot.targets.length, snapshot);
    }
    case "list_targets": {
      const snapshot = await listTargetSnapshot();
      return RecorderHelperTargetsSchema.parse({
        status: createHelperStatus(snapshot.targets.length, snapshot),
        targets: snapshot.targets,
      });
    }
    case "permissions_status":
      return createPermissionStatus();
    case "permissions_probe":
      return createPermissionProbeStatus();
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
  const nativeCapture = params.capture.mode === "native";
  const nativeState = nativeCapture ? await startNativeCapture(params) : undefined;
  const events = [
    createEvent(params, params.eventCount, "permission.snapshot", helperPermissionSnapshot()),
    createEvent(params, params.eventCount + 1, "recording.started", {
      purpose: params.purpose ?? (nativeCapture ? "helper-backed screen recording" : "helper-backed synthetic recording"),
      recorder: "recorder-helper",
      nativeCapture,
      captureBackend: nativeCapture ? "screencapture" : "synthetic",
      maxDurationSeconds: params.capture.maxDurationSeconds,
      artifactPath: nativeState?.outputPath,
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
  const nativeState = await readNativeCaptureState(params);
  const artifacts = stopped && nativeState ? await nativeCaptureArtifacts(nativeState) : [];
  return RecorderHelperSessionSchema.parse({
    runId: params.runId,
    sessionId: params.sessionId,
    status: stopped ? "complete" : "recording",
    eventCount: events.length,
    frameCount: frames.length,
    artifacts,
  });
}

async function stopSession(params: z.infer<typeof SessionParamsSchema>) {
  await mkdir(params.paths.artifactsDir, { recursive: true });
  const nativeState = await readNativeCaptureState(params);
  const artifacts = nativeState
    ? await waitForNativeCaptureArtifacts(nativeState)
    : [await writeCaptureArtifact(params)];
  const primaryArtifact = artifacts[0];
  const frame = createFrame(
    params,
    params.frameCount,
    nativeState ? nativeState.maxDurationSeconds * 1000 : 1000,
    primaryArtifact?.artifactId,
  );
  const events = [
    createEvent(params, params.eventCount, "screen.frame", {
      frameId: frame.frameId,
      videoTimeMs: frame.videoTimeMs,
      synthetic: nativeState === undefined,
      artifactId: primaryArtifact?.artifactId,
    }),
    createEvent(params, params.eventCount + 1, "recording.stopped", {
      reason: "requested",
      recorder: "recorder-helper",
      nativeCapture: nativeState !== undefined,
      captureBackend: nativeState ? "screencapture" : "synthetic",
    }),
  ];

  await appendFrame(params.paths.frames, frame);
  await appendEvents(params.paths.events, events);

  return RecorderHelperSessionSchema.parse({
    runId: params.runId,
    sessionId: params.sessionId,
    status: "complete",
    eventCount: params.eventCount + events.length,
    frameCount: params.frameCount + 1,
    artifacts,
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

function createFrame(
  params: z.infer<typeof SessionParamsSchema>,
  sequence: number,
  videoTimeMs: number,
  artifactId?: string,
) {
  return FrameRefSchema.parse({
    frameId: `${params.sessionId}:frame:${sequence}`,
    sessionId: params.sessionId,
    sequence,
    monotonicTimeNs: monotonicTimeNs(),
    videoTimeMs,
    artifactId,
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

async function startNativeCapture(params: z.infer<typeof SessionParamsSchema>) {
  if (process.platform !== "darwin") {
    throw new Error("native screen recording is currently only available on macOS");
  }

  const outputPath = path.join(params.paths.artifactsDir, "capture.mp4");
  const targetOptions = captureTargetOptions(params.target);
  const args = [
    "-x",
    "-v",
    `-V${params.capture.maxDurationSeconds}`,
    ...targetOptions.args,
    outputPath,
  ];
  const child = spawn("/usr/sbin/screencapture", args, {
    cwd: params.paths.runDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = new Date();
  const state = NativeCaptureStateSchema.parse({
    mode: "native",
    pid: child.pid,
    outputPath,
    startedAt: startedAt.toISOString(),
    expectedStopAt: new Date(startedAt.getTime() + params.capture.maxDurationSeconds * 1000).toISOString(),
    maxDurationSeconds: params.capture.maxDurationSeconds,
    displayNumber: targetOptions.displayNumber,
    windowId: targetOptions.windowId,
    region: targetOptions.region,
    captureArgs: args.slice(0, -1),
  });
  await writeFile(nativeCaptureStatePath(params), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function readNativeCaptureState(params: z.infer<typeof SessionParamsSchema>) {
  const raw = await readFile(nativeCaptureStatePath(params), "utf8").catch(() => undefined);
  return raw ? NativeCaptureStateSchema.parse(JSON.parse(raw)) : undefined;
}

async function waitForNativeCaptureArtifacts(state: z.infer<typeof NativeCaptureStateSchema>) {
  const deadlineMs = Date.now() + state.maxDurationSeconds * 1000 + 5_000;
  let lastError: unknown;

  while (Date.now() <= deadlineMs) {
    try {
      return await nativeCaptureArtifacts(state);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  throw new Error(`native screen recording did not finish: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function nativeCaptureArtifacts(state: z.infer<typeof NativeCaptureStateSchema>) {
  const bytes = await readFile(state.outputPath);
  const artifactStat = await stat(state.outputPath);
  if (!artifactStat.isFile() || bytes.byteLength === 0) {
    throw new Error(`native screen recording artifact is empty: ${state.outputPath}`);
  }

  return [
    ArtifactRefSchema.parse({
      artifactId: `art_native_${createHash("sha256").update(state.outputPath).digest("hex").slice(0, 24)}`,
      kind: "video",
      path: state.outputPath,
      mediaType: "video/mp4",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      createdAt: new Date(artifactStat.mtimeMs).toISOString(),
      timeRangeMs: [0, state.maxDurationSeconds * 1000],
      redactionState: "raw",
    }),
  ];
}

function nativeCaptureStatePath(params: z.infer<typeof SessionParamsSchema>) {
  return path.join(params.paths.runDir, "native-capture.json");
}

function captureTargetOptions(target: TargetRef): {
  args: string[];
  displayNumber?: number;
  windowId?: string;
  region?: z.infer<typeof BoundsSchema>;
} {
  const windowId = captureWindowId(target);
  if (windowId) {
    return {
      args: [`-l${windowId}`],
      windowId,
    };
  }

  const region = captureRegionBounds(target);
  if (region) {
    return {
      args: [`-R${formatScreenRect(region)}`],
      region,
    };
  }

  const displayNumber = captureDisplayNumber(target);
  if (displayNumber) {
    return {
      args: [`-D${displayNumber}`],
      displayNumber,
    };
  }

  return { args: [] };
}

function captureWindowId(target: TargetRef): string | undefined {
  if (target.kind !== "window") {
    return undefined;
  }
  const candidates = [
    target.window?.id,
    target.targetId.startsWith("window:") ? target.targetId.slice("window:".length) : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && /^[1-9]\d*$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function captureRegionBounds(target: TargetRef): z.infer<typeof BoundsSchema> | undefined {
  if (target.kind === "region") {
    return normalizedScreenRect(target.bounds ?? target.window?.bounds);
  }

  if ((target.kind === "window" || target.kind === "app") && !captureWindowId(target)) {
    return normalizedScreenRect(target.bounds ?? target.window?.bounds);
  }

  return undefined;
}

function captureDisplayNumber(target: TargetRef): number | undefined {
  if (target.kind !== "display" || !target.displayId) {
    return undefined;
  }
  if (target.displayId === "main") {
    return 1;
  }
  const parsed = Number.parseInt(target.displayId, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizedScreenRect(bounds: z.infer<typeof BoundsSchema> | undefined): z.infer<typeof BoundsSchema> | undefined {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }
  return BoundsSchema.parse({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  });
}

function formatScreenRect(bounds: z.infer<typeof BoundsSchema>): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function createPermissionProbeStatus() {
  const configured = createPermissionStatus();
  if (process.env.SPORES_PERMISSION_NATIVE_PROBE === "skip") {
    return PermissionBrokerStatusSchema.parse({
      ...configured,
      mode: "native_probe",
    });
  }
  if (process.platform !== "darwin") {
    return PermissionBrokerStatusSchema.parse({
      ...configured,
      mode: "native_probe",
    });
  }

  if (configured.requiresUserAction) {
    return PermissionBrokerStatusSchema.parse({
      ...configured,
      mode: "native_probe",
    });
  }

  const probeDir = await mkdtemp(path.join(os.tmpdir(), "spores-permission-probe-"));
  const probePath = path.join(probeDir, "probe.png");
  try {
    await execFileUtf8("/usr/sbin/screencapture", ["-x", "-R0,0,1,1", probePath], 4_000);
    const probeStat = await stat(probePath);
    if (!probeStat.isFile() || probeStat.size === 0) {
      throw new Error(`permission probe artifact is empty: ${probePath}`);
    }
    return PermissionBrokerStatusSchema.parse({
      ...configured,
      mode: "native_probe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const capabilities = configured.capabilities.map((capability) => (
      capability.permission === "screenRecording"
        ? {
            ...capability,
            status: "degraded" as const,
            reason: `Native screen recording probe failed: ${message}`,
          }
        : capability
    ));
    return PermissionBrokerStatusSchema.parse({
      platform: configured.platform,
      mode: "native_probe",
      snapshot: {
        ...configured.snapshot,
        screenRecording: "degraded",
        requiresUserAction: true,
      },
      capabilities,
      requiresUserAction: true,
      error: {
        code: "permission_probe_failed",
        message,
        retriable: true,
        requiresUserAction: true,
        details: {
          command: "/usr/sbin/screencapture",
          args: ["-x", "-R0,0,1,1", probePath],
          settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        },
      },
    });
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

function isDirectEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  try {
    return realpathSync(argvPath) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === pathToFileURL(argvPath).href;
  }
}

if (isDirectEntrypoint(process.argv[1])) {
  if (process.argv.includes("--stdio")) {
    process.exitCode = await runStdio();
  } else if (process.argv.includes("--list-targets")) {
    const snapshot = await listTargetSnapshot();
    process.stdout.write(`${JSON.stringify({ status: createHelperStatus(snapshot.targets.length, snapshot), targets: snapshot.targets }, null, 2)}\n`);
  } else {
    const snapshot = await listTargetSnapshot();
    process.stdout.write(`${JSON.stringify(createHelperStatus(snapshot.targets.length, snapshot), null, 2)}\n`);
  }
}
