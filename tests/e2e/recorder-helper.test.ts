import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { RecorderHelperStatusSchema, RecorderHelperTargetsSchema } from "@spores/schema";

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
        startSession: false,
        stopSession: false,
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
});

async function runHelperScript(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "recorder-helper", "--", ...args], {
    cwd: repoRoot(),
    env: childEnv(),
  });
  return stdout;
}

async function sendStdioRequest(request: { id: string; method: string }): Promise<unknown> {
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
