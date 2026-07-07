import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  PermissionBrokerStatusSchema,
  PermissionRequestResultSchema,
  RecorderHelperSessionSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargetsSchema,
  TargetRefSchema,
} from "@spores/schema";

const execFileAsync = promisify(execFile);

describe("recorder helper process e2e", () => {
  it("prints helper status and capture targets with screen coordinates through Bun scripts", async () => {
    const status = RecorderHelperStatusSchema.parse(
      JSON.parse(await runHelperScript([])),
    );
    expect(status).toMatchObject({
      available: true,
      capabilities: {
        listTargets: true,
        startSession: true,
        stopSession: true,
      },
    });
    expect(status.targetCount).toBeGreaterThanOrEqual(1);

    const targets = RecorderHelperTargetsSchema.parse(
      JSON.parse(await runHelperScript(["--list-targets"])),
    );
    expect(targets.status).toMatchObject({ available: true, targetCount: targets.targets.length });
    expect(targets.targets.map((target) => target.targetId)).toContain("display:main");
    expect(targets.targets.find((target) => target.targetId === "display:main")).toMatchObject({
      kind: "display",
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    });
    expect(new Set(targets.targets.map((target) => target.targetId)).size).toBe(targets.targets.length);

    const windowTargets = targets.targets.filter((target) => target.kind === "window");
    expect(windowTargets.length).toBeGreaterThan(0);
    for (const target of windowTargets) {
      expect(target).toMatchObject({
        targetId: expect.stringMatching(/^window:/),
        bounds: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        window: {
          id: expect.any(String),
          bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
        },
      });
      expect(target.bounds!.width).toBeGreaterThan(0);
      expect(target.bounds!.height).toBeGreaterThan(0);
    }
  });

  it("responds to doctor and list_targets over stdio", async () => {
    const doctor = RecorderHelperStatusSchema.parse(
      await sendStdioRequest({ id: "req_doctor", method: "doctor" }),
    );
    expect(doctor).toMatchObject({ available: true });
    expect(doctor.targetCount).toBeGreaterThanOrEqual(1);

    const targets = RecorderHelperTargetsSchema.parse(
      await sendStdioRequest({ id: "req_targets", method: "list_targets" }),
    );
    expect(targets.status.targetCount).toBe(targets.targets.length);
    expect(targets.targets.some((target) => target.kind === "display")).toBe(true);
    expect(targets.targets.some((target) => target.kind === "window")).toBe(true);
  });

  it("reports permission status and request guidance over stdio", async () => {
    const status = PermissionBrokerStatusSchema.parse(
      await sendStdioRequest(
        { id: "req_permissions_status", method: "permissions_status" },
        { SPORES_PERMISSION_SCREEN_RECORDING: "missing" },
      ),
    );
    expect(status).toMatchObject({
      mode: "deterministic",
      requiresUserAction: true,
      snapshot: {
        screenRecording: "missing",
        accessibility: "granted",
        requiresUserAction: true,
      },
    });
    expect(status.capabilities.find((capability) => capability.permission === "screenRecording")).toMatchObject({
      required: true,
      status: "missing",
      canRequest: process.platform === "darwin",
    });

    const request = PermissionRequestResultSchema.parse(
      await sendStdioRequest(
        { id: "req_permissions_request", method: "permissions_request" },
        { SPORES_PERMISSION_SCREEN_RECORDING: "missing" },
      ),
    );
    expect(request).toMatchObject({
      opened: false,
      status: { requiresUserAction: true },
    });
    expect(request.actions.map((action) => action.permission)).toEqual(["screenRecording"]);
  });

  it("preserves the request id on stdio handler errors", async () => {
    const response = await sendRawStdioRequest({
      id: "req_invalid_stop",
      method: "stop_session",
      params: {},
    });

    expect(response).toMatchObject({
      id: "req_invalid_stop",
      ok: false,
      error: {
        code: "invalid_request",
        retriable: false,
        requiresUserAction: false,
      },
    });
    if (response.ok) {
      throw new Error("expected invalid stop_session request to fail");
    }
    expect(response.error.message).toContain("runId");
  });

  it("writes lifecycle events, frames, and artifacts over stdio", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-helper-lifecycle-"));
    try {
      const paths = {
        runDir: path.join(tempDir, "run_helper_lifecycle_001"),
        manifest: path.join(tempDir, "run_helper_lifecycle_001", "manifest.json"),
        events: path.join(tempDir, "run_helper_lifecycle_001", "events.ndjson"),
        frames: path.join(tempDir, "run_helper_lifecycle_001", "frames.ndjson"),
        artifactsDir: path.join(tempDir, "run_helper_lifecycle_001", "artifacts"),
      };
      await mkdir(paths.artifactsDir, { recursive: true });
      const params = {
        runId: "run_helper_lifecycle_001",
        sessionId: "sess_helper_lifecycle_001",
        target: TargetRefSchema.parse({
          targetId: "display:main",
          kind: "display",
          displayId: "main",
          safeToPersist: true,
        }),
        paths,
        purpose: "helper lifecycle e2e",
        eventCount: 0,
        frameCount: 0,
      };

      const started = RecorderHelperSessionSchema.parse(
        await sendStdioRequest({ id: "req_start", method: "start_session", params }),
      );
      expect(started).toMatchObject({ status: "recording", eventCount: 7, frameCount: 1, artifacts: [] });

      const recording = RecorderHelperSessionSchema.parse(
        await sendStdioRequest({
          id: "req_status",
          method: "get_status",
          params: { ...params, eventCount: started.eventCount, frameCount: started.frameCount },
        }),
      );
      expect(recording).toMatchObject({ status: "recording", eventCount: 7, frameCount: 1 });

      const stopped = RecorderHelperSessionSchema.parse(
        await sendStdioRequest({
          id: "req_stop",
          method: "stop_session",
          params: { ...params, eventCount: started.eventCount, frameCount: started.frameCount },
        }),
      );
      expect(stopped).toMatchObject({ status: "complete", eventCount: 9, frameCount: 2 });
      expect(stopped.artifacts).toHaveLength(1);

      const events = (await readFile(paths.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const frames = (await readFile(paths.frames, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
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
      expect(events.map((event) => event.sequence)).toEqual([...Array(9).keys()]);
      expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
      expect(await readFile(stopped.artifacts[0]!.path, "utf8")).toBe("Spores helper synthetic capture for run_helper_lifecycle_001\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

async function runHelperScript(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "recorder-helper", "--", ...args], {
    cwd: repoRoot(),
    env: childEnv(),
  });
  return stdout;
}

async function sendStdioRequest(
  request: { id: string; method: string; params?: unknown },
  env: Record<string, string> = {},
): Promise<unknown> {
  const response = await sendRawStdioRequest(request, env);
  expect(response).toMatchObject({ id: request.id, ok: true });
  if (!response.ok) {
    throw new Error(`expected successful helper response: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}

type RawStdioResponse =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retriable: boolean;
        requiresUserAction: boolean;
      };
    };

async function sendRawStdioRequest(
  request: { id: string; method: string; params?: unknown },
  env: Record<string, string> = {},
): Promise<RawStdioResponse> {
  const child = spawn(bunCommand(), ["run", "--silent", "recorder-helper", "--", "--stdio"], {
    cwd: repoRoot(),
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);

  const [code] = await once(child, "close") as [number | null];
  if (code !== 0) {
    throw new Error(`helper exited with ${code ?? "unknown"}: ${stderr}`);
  }

  const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
  expect(firstLine).toBeDefined();
  const response = JSON.parse(firstLine!);
  expect(response).toHaveProperty("id");
  expect(response).toHaveProperty("ok");
  return response;
}

function repoRoot(): string {
  return process.cwd();
}

function bunCommand(): string {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: "0", ...overrides };
}
