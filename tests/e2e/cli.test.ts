import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecorderHelperTargetsSchema, RunManifestSchema, SporesErrorSchema } from "@spores/schema";
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
      recorder: "helper",
      nativeCapture: false,
      rootDir: runsRoot,
      helper: {
        available: true,
        command: bunCommand(),
        args: ["run", "--silent", "recorder-helper", "--", "--stdio"],
        targetCount: 3,
        capabilities: {
          listTargets: true,
          startSession: true,
          stopSession: true,
        },
      },
    });
    expect(JSON.parse(await runPackageScript("doctor", ["--json"], runsRoot))).toMatchObject({
      ok: true,
      helper: { available: true, targetCount: 3 },
    });

    const status = JSON.parse(await runSporesCli(["status", "--json"], runsRoot));
    expect(status).toEqual({ status: "idle" });
    expect(JSON.parse(await runPackageScript("status", ["--json"], runsRoot))).toEqual(status);

    const targets = RecorderHelperTargetsSchema.parse(JSON.parse(await runSporesCli(["targets", "--json"], runsRoot)));
    expect(targets.status).toMatchObject({ available: true, targetCount: 3 });
    expect(targets.status).toMatchObject({
      command: bunCommand(),
      args: ["run", "--silent", "recorder-helper", "--", "--stdio"],
    });
    expect(targets.targets.map((target) => target.targetId)).toEqual([
      "display:main",
      "app:spores-recorder-helper",
      "window:spores-recorder-helper:status",
    ]);
    expect(RecorderHelperTargetsSchema.parse(JSON.parse(await runPackageScript("targets", ["--json"], runsRoot))).targets).toHaveLength(3);
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

  it("recovers stale recording manifests across process boundaries", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const service = createSporesService({ rootDir: runsRoot });
    const started = await service.start({
      runId: "run_stale_cli_e2e_001",
      purpose: "stale recording recovery e2e",
    });

    expect(started).toMatchObject({ runId: "run_stale_cli_e2e_001", status: "recording" });

    const recovered = RunManifestSchema.parse(
      JSON.parse(await runSporesCli(["status", "--json", "--run-id", started.runId], runsRoot)),
    );
    expect(recovered).toMatchObject({
      runId: started.runId,
      status: "partial",
      eventCount: 7,
      frameCount: 1,
      error: {
        code: "stale_recording",
        retriable: false,
        requiresUserAction: false,
      },
    });

    expect(await service.store.readManifest(started.runId)).toMatchObject({
      status: "partial",
      error: { code: "stale_recording" },
    });
  });

  it("reports helper launch failures as machine-readable degraded status", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const env = {
      SPORES_RUNS_ROOT: runsRoot,
      SPORES_RECORDER_HELPER_COMMAND: path.join(tempDir, "missing-helper"),
    };

    const doctor = JSON.parse(await runSporesCli(["doctor", "--json"], runsRoot, env));
    expect(doctor).toMatchObject({
      ok: true,
      helper: {
        available: false,
        error: {
          code: "helper_unavailable",
          retriable: true,
        },
      },
    });

    const targets = RecorderHelperTargetsSchema.parse(
      JSON.parse(await runSporesCli(["targets", "--json"], runsRoot, env)),
    );
    expect(targets).toMatchObject({
      status: {
        available: false,
        error: { code: "helper_unavailable" },
      },
      targets: [],
    });
  });
});

async function runSporesCli(
  args: string[],
  runsRoot: string,
  env: Record<string, string> = { SPORES_RUNS_ROOT: runsRoot },
): Promise<string> {
  const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "spores", "--", ...args], {
    cwd: repoRoot(),
    env: childEnv(env),
  });
  return stdout;
}

async function runPackageScript(script: "doctor" | "status" | "targets", args: string[], runsRoot: string): Promise<string> {
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
