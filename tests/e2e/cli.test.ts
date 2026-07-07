import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionBrokerStatusSchema,
  PermissionRequestResultSchema,
  RecorderHelperTargetsSchema,
  RunManifestSchema,
  SporesErrorSchema,
} from "@spores/schema";
import { createSporesService } from "../../apps/sporesd/src/service.js";

const execFileAsync = promisify(execFile);
const CLI_E2E_TIMEOUT_MS = 20_000;

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
        capabilities: {
          listTargets: true,
          startSession: true,
          stopSession: true,
        },
      },
    });
    expect(doctor.helper.targetCount).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(await runPackageScript("doctor", ["--json"], runsRoot))).toMatchObject({
      ok: true,
      helper: { available: true },
    });

    const status = JSON.parse(await runSporesCli(["status", "--json"], runsRoot));
    expect(status).toEqual({ status: "idle" });
    expect(JSON.parse(await runPackageScript("status", ["--json"], runsRoot))).toEqual(status);

    const targets = RecorderHelperTargetsSchema.parse(JSON.parse(await runSporesCli(["targets", "--json"], runsRoot)));
    expect(targets.status).toMatchObject({ available: true, targetCount: targets.targets.length });
    expect(targets.status).toMatchObject({
      command: bunCommand(),
      args: ["run", "--silent", "recorder-helper", "--", "--stdio"],
    });
    expect(targets.targets.map((target) => target.targetId)).toContain("display:main");
    expect(targets.targets.some((target) => target.kind === "window")).toBe(true);
    for (const target of targets.targets.filter((target) => target.kind === "window")) {
      expect(target.bounds).toBeDefined();
      expect(target.window?.bounds).toEqual(target.bounds);
    }
    const packageTargets = RecorderHelperTargetsSchema.parse(JSON.parse(await runPackageScript("targets", ["--json"], runsRoot)));
    expect(packageTargets.targets.length).toBeGreaterThanOrEqual(1);
  }, CLI_E2E_TIMEOUT_MS);

  it("prints permission status and request guidance as JSON from an external CLI process", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const env = {
      SPORES_RUNS_ROOT: runsRoot,
      SPORES_PERMISSION_ACCESSIBILITY: "missing",
    };

    const status = PermissionBrokerStatusSchema.parse(
      JSON.parse(await runSporesCli(["permissions", "status", "--json"], runsRoot, env)),
    );
    expect(status).toMatchObject({
      mode: "deterministic",
      requiresUserAction: true,
      snapshot: {
        screenRecording: "granted",
        accessibility: "missing",
        requiresUserAction: true,
      },
    });
    expect(status.capabilities.find((capability) => capability.permission === "accessibility")).toMatchObject({
      required: true,
      status: "missing",
    });

    const request = PermissionRequestResultSchema.parse(
      JSON.parse(await runSporesCli(["permissions", "request", "--json"], runsRoot, env)),
    );
    expect(request).toMatchObject({
      opened: false,
      status: { requiresUserAction: true },
    });
    expect(request.actions.map((action) => action.permission)).toEqual(["accessibility"]);
  }, CLI_E2E_TIMEOUT_MS);

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
  }, CLI_E2E_TIMEOUT_MS);

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
  }, CLI_E2E_TIMEOUT_MS);

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
  }, CLI_E2E_TIMEOUT_MS);

  it("recovers completed bundles when helper stop finished before manifest sync", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const service = createSporesService({ rootDir: runsRoot });
    const started = await service.start({
      runId: "run_stop_recovery_cli_e2e_001",
      purpose: "completed recording recovery e2e",
    });

    await service.helper.stopSession({
      runId: started.runId,
      sessionId: started.sessionId,
      target: started.target,
      paths: started.paths,
      eventCount: started.eventCount,
      frameCount: started.frameCount,
    });

    const recovered = RunManifestSchema.parse(
      JSON.parse(await runSporesCli(["status", "--json", "--run-id", started.runId], runsRoot)),
    );

    expect(recovered).toMatchObject({
      runId: started.runId,
      status: "complete",
      eventCount: 9,
      frameCount: 2,
    });
    expect(recovered.error).toBeUndefined();
    expect(recovered.artifacts).toHaveLength(1);
    expect(await readFile(recovered.artifacts[0]!.path, "utf8")).toBe(
      `Spores helper synthetic capture for ${started.runId}\n`,
    );
    expect(await service.store.readManifest(started.runId)).toMatchObject({
      status: "complete",
      eventCount: 9,
      frameCount: 2,
    });
  }, CLI_E2E_TIMEOUT_MS);

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

    const permissions = PermissionBrokerStatusSchema.parse(
      JSON.parse(await runSporesCli(["permissions", "status", "--json"], runsRoot, env)),
    );
    expect(permissions).toMatchObject({
      requiresUserAction: true,
      error: {
        code: "helper_unavailable",
        retriable: true,
        requiresUserAction: false,
      },
      snapshot: {
        screenRecording: "degraded",
        accessibility: "degraded",
      },
    });

    const permissionRequest = PermissionRequestResultSchema.parse(
      JSON.parse(await runSporesCli(["permissions", "request", "--json"], runsRoot, env)),
    );
    expect(permissionRequest).toMatchObject({
      opened: false,
      status: { error: { code: "helper_unavailable" } },
      actions: [],
    });
  }, CLI_E2E_TIMEOUT_MS);
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
