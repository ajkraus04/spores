import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-mcp-doctor-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("spores MCP doctor e2e", () => {
  it("validates the checked-in MCP server config and agent tools", async () => {
    const { stdout } = await execFileAsync(bunCommand(), ["run", "--silent", "mcp:doctor", "--", "--json"], {
      cwd: repoRoot(),
      env: childEnv({
        SPORES_RUNS_ROOT: path.join(tempDir, "runs"),
        SPORES_PERMISSION_NATIVE_PROBE: "skip",
      }),
      timeout: 30_000,
    });
    const result = JSON.parse(stdout) as {
      ok: boolean;
      toolCount: number;
      tools: string[];
      missingTools: string[];
      doctor: { helper: { available: boolean } };
      ready: { ready: boolean; recommendedTools: string[] };
    };

    expect(result).toMatchObject({
      ok: true,
      toolCount: 28,
      missingTools: [],
      doctor: { helper: { available: true } },
      ready: { ready: true },
    });
    expect(result.tools).toEqual(expect.arrayContaining([
      "recorder_context_snapshot",
      "recorder_target_select",
      "recorder_permissions_probe",
      "session_recording_capture",
      "session_recording_append_agent_step",
      "session_recording_query_timeline",
      "session_recording_result",
      "session_recording_read_artifact",
    ]));
    expect(result.ready.recommendedTools.every((tool) => result.tools.includes(tool))).toBe(true);
  }, 45_000);
});

function repoRoot(): string {
  return process.cwd();
}

function bunCommand(): string {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: "0", ...overrides };
}
