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

    const doctor = JSON.parse(await runSporesCli(["doctor", "--json"], runsRoot));
    expect(doctor).toMatchObject({
      ok: true,
      recorder: "fake",
      nativeCapture: false,
      rootDir: runsRoot,
    });
    expect(JSON.parse(await runPackageScript("doctor", ["--json"], runsRoot))).toEqual(doctor);

    const status = JSON.parse(await runSporesCli(["status", "--json"], runsRoot));
    expect(status).toEqual({ status: "idle" });
    expect(JSON.parse(await runPackageScript("status", ["--json"], runsRoot))).toEqual(status);
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

    const latest = RunManifestSchema.parse(JSON.parse(await runSporesCli(["status", "--json"], runsRoot)));
    expect(latest).toMatchObject({
      runId: "run_cli_e2e_001",
      status: "complete",
      eventCount: 10,
      frameCount: 2,
    });

    const explicit = RunManifestSchema.parse(
      JSON.parse(await runSporesCli(["status", "--json", "--run-id", "run_cli_e2e_001"], runsRoot)),
    );
    expect(explicit).toEqual(latest);
    expect(
      RunManifestSchema.parse(
        JSON.parse(await runPackageScript("status", ["--json", "--run-id", "run_cli_e2e_001"], runsRoot)),
      ),
    ).toEqual(latest);
  });

  it("returns structured JSON errors for failed CLI commands", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const result = await runSporesCliExpectFailure(["status", "--json", "--run-id", "run_missing"], runsRoot);
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

async function runSporesCli(args: string[], runsRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "spores", "--", ...args], {
    cwd: repoRoot(),
    env: childEnv({ SPORES_RUNS_ROOT: runsRoot }),
  });
  return stdout;
}

async function runPackageScript(script: "doctor" | "status", args: string[], runsRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", script, ...args], {
    cwd: repoRoot(),
    env: childEnv({ SPORES_RUNS_ROOT: runsRoot }),
  });
  return stdout;
}

async function runSporesCliExpectFailure(args: string[], runsRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    await execFileAsync(bunCommand(), ["run", "--silent", "spores", "--", ...args], {
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

function bunCommand(): string {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: "0", ...overrides };
}
