import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  RecorderHelperSessionSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargetsSchema,
  TargetRefSchema,
} from "@spores/schema";

const execFileAsync = promisify(execFile);

describe("recorder helper process e2e", () => {
  it("prints helper status and deterministic targets through Bun scripts", async () => {
    const status = RecorderHelperStatusSchema.parse(
      JSON.parse(await runHelperScript([])),
    );
    expect(status).toMatchObject({
      available: true,
      targetCount: 3,
      capabilities: {
        listTargets: true,
        startSession: true,
        stopSession: true,
      },
    });

    const targets = RecorderHelperTargetsSchema.parse(
      JSON.parse(await runHelperScript(["--list-targets"])),
    );
    expect(targets.status).toMatchObject({ available: true, targetCount: 3 });
    expect(targets.targets.map((target) => target.targetId)).toEqual([
      "display:main",
      "app:spores-recorder-helper",
      "window:spores-recorder-helper:status",
    ]);
  });

  it("responds to doctor and list_targets over stdio", async () => {
    const doctor = RecorderHelperStatusSchema.parse(
      await sendStdioRequest({ id: "req_doctor", method: "doctor" }),
    );
    expect(doctor).toMatchObject({ available: true, targetCount: 3 });

    const targets = RecorderHelperTargetsSchema.parse(
      await sendStdioRequest({ id: "req_targets", method: "list_targets" }),
    );
    expect(targets.targets).toHaveLength(3);
    expect(targets.targets.map((target) => target.kind)).toEqual(["display", "app", "window"]);
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
  });
});

async function runHelperScript(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "recorder-helper", "--", ...args], {
    cwd: repoRoot(),
    env: childEnv(),
  });
  return stdout;
}

async function sendStdioRequest(request: { id: string; method: string; params?: unknown }): Promise<unknown> {
  const child = spawn(bunCommand(), ["run", "--silent", "recorder-helper", "--", "--stdio"], {
    cwd: repoRoot(),
    env: childEnv(),
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
  expect(response).toMatchObject({ id: request.id, ok: true });
  return response.result;
}

function repoRoot(): string {
  return process.cwd();
}

function bunCommand(): string {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: "0" };
}
