import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunManifestSchema, SporesErrorSchema } from "@spores/schema";
import { createSporesService } from "../../apps/sporesd/src/service.js";

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-cli-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("spores CLI e2e", () => {
  it("prints doctor and idle status as JSON from an external CLI process", async () => {
    const runsRoot = path.join(tempDir, "runs");

    const doctor = JSON.parse(await runCli(["doctor", "--json"], runsRoot));
    expect(doctor).toMatchObject({
      ok: true,
      recorder: "fake",
      nativeCapture: false,
      rootDir: runsRoot,
    });

    const status = JSON.parse(await runCli(["status", "--json"], runsRoot));
    expect(status).toEqual({ status: "idle" });
  });

  it("returns the latest persisted run status across CLI processes", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const service = createSporesService({ rootDir: runsRoot });

    const started = await service.start({
      runId: "run_cli_e2e_001",
      purpose: "cli status e2e",
    });
    await service.appendEvent({
      runId: started.runId,
      type: "agent.decision",
      payload: { reason: "validate persisted status lookup" },
    });
    await service.stop({ runId: started.runId });

    const latest = RunManifestSchema.parse(JSON.parse(await runCli(["status", "--json"], runsRoot)));
    expect(latest).toMatchObject({
      runId: "run_cli_e2e_001",
      status: "complete",
      eventCount: 10,
      frameCount: 2,
    });

    const explicit = RunManifestSchema.parse(
      JSON.parse(await runCli(["status", "--json", "--run-id", "run_cli_e2e_001"], runsRoot)),
    );
    expect(explicit).toEqual(latest);
  });

  it("returns structured JSON errors for failed CLI commands", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const result = await runCliExpectFailure(["status", "--json", "--run-id", "run_missing"], runsRoot);
    const error = SporesErrorSchema.parse(JSON.parse(result.stdout));

    expect(result.code).toBe(1);
    expect(error).toMatchObject({
      error: "cli_error",
      retriable: false,
      requiresUserAction: false,
    });
    expect(error.message).toContain("manifest.json");
  });
});

async function runCli(args: string[], runsRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(tsxBinaryPath(), ["apps/sporesd/src/cli.ts", ...args], {
    cwd: repoRoot(),
    env: childEnv({ SPORES_RUNS_ROOT: runsRoot }),
  });
  return stdout;
}

async function runCliExpectFailure(args: string[], runsRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    await execFileAsync(tsxBinaryPath(), ["apps/sporesd/src/cli.ts", ...args], {
      cwd: repoRoot(),
      env: childEnv({ SPORES_RUNS_ROOT: runsRoot }),
    });
    throw new Error("expected CLI command to fail");
  } catch (error) {
    if (isExecError(error)) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
    throw error;
  }
}

function isExecError(error: unknown): error is Error & { code?: number; stdout: string; stderr: string } {
  return error instanceof Error && "stdout" in error && "stderr" in error;
}

function repoRoot(): string {
  return process.cwd();
}

function tsxBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(repoRoot(), "node_modules", ".bin", binaryName);
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: "0", ...overrides };
}
