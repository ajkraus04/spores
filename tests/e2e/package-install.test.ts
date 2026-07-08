import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_INSTALL_TIMEOUT_MS = 120_000;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-package-install-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("installable spores package e2e", () => {
  it("runs setup through npx and bunx from the npm tarball", async () => {
    const tarball = await packNpmPackage(tempDir);

    const npxSetup = await runSetupVia("npx", tarball, path.join(tempDir, "npx-runs"));
    expect(npxSetup).toMatchObject({
      ready: true,
      backend: "helper",
      helper: { available: true },
      permissions: { requiresUserAction: false },
    });
    expect(npxSetup.helper.args[0]).toContain("node_modules/spores/dist/spores-recorder-helper.js");
    expect(npxSetup.recommendedTools).toContain("session_recording_capture");

    const bunxSetup = await runSetupVia("bunx", tarball, path.join(tempDir, "bunx-runs"));
    expect(bunxSetup).toMatchObject({
      ready: true,
      backend: "helper",
      helper: { available: true },
      permissions: { requiresUserAction: false },
    });
    expect(bunxSetup.helper.args[0]).toContain("node_modules/spores/dist/spores-recorder-helper.js");
    expect(bunxSetup.recommendedTools).toContain("session_recording_capture");
  }, PACKAGE_INSTALL_TIMEOUT_MS);

  it("starts the installed MCP server through npx", async () => {
    const tarball = await packNpmPackage(tempDir);
    const runsRoot = path.join(tempDir, "mcp-runs");
    const client = new Client({ name: "spores-package-install-e2e", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", "--package", tarball, "--", "spores", "mcp"],
      cwd: tempDir,
      env: childEnv({
        SPORES_RUNS_ROOT: runsRoot,
        SPORES_TARGET_DISCOVERY_MODE: "deterministic",
        SPORES_PERMISSION_NATIVE_PROBE: "skip",
      }),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "sporesd", version: "0.1.0" });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "recorder_ready",
        "session_recording_capture",
        "session_recording_begin",
        "session_recording_stop",
      ]));

      const ready = expectStructured<{
        ready: boolean;
        helper: { available: boolean; args: string[] };
        recommendedTools: string[];
      }>(await client.callTool({ name: "recorder_ready", arguments: {} }));
      expect(ready.ready).toBe(true);
      expect(ready.helper.available).toBe(true);
      expect(ready.helper.args[0]).toContain("node_modules/spores/dist/spores-recorder-helper.js");
      expect(ready.recommendedTools).toContain("session_recording_capture");
    } finally {
      await client.close().catch(() => undefined);
    }
  }, PACKAGE_INSTALL_TIMEOUT_MS);
});

async function runSetupVia(command: "npx" | "bunx", tarball: string, runsRoot: string): Promise<{
  ready: boolean;
  backend: string;
  helper: { available: boolean; args: string[] };
  permissions: { requiresUserAction: boolean };
  recommendedTools: string[];
}> {
  const args = command === "npx"
    ? ["--yes", "--package", tarball, "--", "spores", "setup", "--json"]
    : ["--package", tarball, "spores", "setup", "--json"];
  const { stdout } = await execFileAsync(command, args, {
    cwd: tempDir,
    env: childEnv({
      SPORES_RUNS_ROOT: runsRoot,
      SPORES_TARGET_DISCOVERY_MODE: "deterministic",
      SPORES_PERMISSION_NATIVE_PROBE: "skip",
    }),
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function packNpmPackage(packDestination: string): Promise<string> {
  const { stdout } = await execFileAsync("npm", [
    "pack",
    path.join(repoRoot(), "packages", "npm"),
    "--pack-destination",
    packDestination,
    "--json",
  ], {
    cwd: repoRoot(),
    env: childEnv({}),
    maxBuffer: 10 * 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout) as Array<{ filename: string }>;
  if (!packed) {
    throw new Error("npm pack did not return a package result");
  }
  return path.join(packDestination, packed.filename);
}

function expectStructured<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  if (result.isError) {
    throw new Error(JSON.stringify(result.content));
  }
  if (result.structuredContent) {
    return result.structuredContent as T;
  }
  const content = Array.isArray(result.content)
    ? result.content as Array<{ type: string; text?: string }>
    : [];
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("tool result did not include structured content or text content");
  }
  return JSON.parse(text) as T;
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SHELL",
    "USER",
    "LOGNAME",
    "npm_config_cache",
  ]) {
    const value = process.env[name];
    if (value) {
      inherited[name] = value;
    }
  }
  return { ...inherited, FORCE_COLOR: "0", ...overrides };
}

function repoRoot(): string {
  return process.cwd();
}
