import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  RunManifestSchema,
  SporesErrorSchema,
  TimelineSchema,
} from "@spores/schema";

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-mcp-e2e-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("sporesd MCP stdio e2e", () => {
  it("records, annotates, stops, reads timeline, and fetches artifacts through MCP stdio", async () => {
    const runId = "run_mcp_e2e_001";
    const runsRoot = path.join(tempDir, "runs");
    const client = new Client({ name: "spores-e2e-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: tsxBinaryPath(),
      args: ["apps/sporesd/src/index.ts"],
      cwd: repoRoot(),
      env: childEnv({ SPORES_RUNS_ROOT: runsRoot }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await client.connect(transport);

      expect(client.getServerVersion()).toMatchObject({ name: "sporesd", version: "0.1.0" });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "session_recording_append_event",
        "session_recording_get_artifact",
        "session_recording_get_timeline",
        "session_recording_start",
        "session_recording_status",
        "session_recording_stop",
        "spores_doctor",
      ]);

      const doctor = expectOk<{ ok: true; recorder: "fake"; nativeCapture: false; rootDir: string }>(
        await client.callTool({ name: "spores_doctor", arguments: {} }),
      );
      expect(doctor).toMatchObject({ ok: true, recorder: "fake", nativeCapture: false, rootDir: runsRoot });

      const started = RunManifestSchema.parse(
        expectOk(
          await client.callTool({
            name: "session_recording_start",
            arguments: {
              runId,
              purpose: "mcp stdio e2e",
              target: { mode: "fake", targetId: "target_mcp_e2e" },
            },
          }),
        ),
      );
      expect(started).toMatchObject({
        runId,
        status: "recording",
        target: { kind: "fake", targetId: "target_mcp_e2e" },
      });
      expect(started.paths.runDir).toBe(path.join(runsRoot, runId));

      const recordingStatus = RunManifestSchema.parse(
        expectOk(
          await client.callTool({
            name: "session_recording_status",
            arguments: { runId },
          }),
        ),
      );
      expect(recordingStatus).toMatchObject({ runId, status: "recording", eventCount: 7, frameCount: 1 });

      await client.callTool({
        name: "session_recording_append_event",
        arguments: {
          runId,
          type: "agent.decision",
          payload: { stepId: "step-1", reason: "open settings before checking state" },
        },
      });
      await client.callTool({
        name: "session_recording_append_event",
        arguments: {
          runId,
          type: "agent.action",
          payload: { stepId: "step-1", tool: "computer", action: "click", target: "Settings" },
        },
      });
      await client.callTool({
        name: "session_recording_append_event",
        arguments: {
          runId,
          type: "agent.assertion",
          payload: { stepId: "step-1", expected: "settings opened", actual: "settings opened", status: "passed" },
        },
      });

      const stopped = RunManifestSchema.parse(
        expectOk(
          await client.callTool({
            name: "session_recording_stop",
            arguments: { runId },
          }),
        ),
      );
      expect(stopped).toMatchObject({ runId, status: "complete", eventCount: 12, frameCount: 2 });
      expect(stopped.artifacts).toHaveLength(1);

      const timeline = TimelineSchema.parse(
        expectOk(
          await client.callTool({
            name: "session_recording_get_timeline",
            arguments: { runId },
          }),
        ),
      );
      expect(timeline.events.map((event) => event.type)).toEqual([
        "permission.snapshot",
        "recording.started",
        "target.selected",
        "app.focused",
        "window.changed",
        "accessibility.tree",
        "screen.frame",
        "agent.decision",
        "agent.action",
        "agent.assertion",
        "screen.frame",
        "recording.stopped",
      ]);
      expect(timeline.events.map((event) => event.sequence)).toEqual([...Array(12).keys()]);
      expect(timeline.frames.map((frame) => frame.sequence)).toEqual([0, 1]);
      expect(timeline.artifacts).toHaveLength(1);

      const artifact = ArtifactRefSchema.parse(timeline.artifacts[0]);
      const artifactRead = expectOk<{ artifact: unknown; content: string }>(
        await client.callTool({
          name: "session_recording_get_artifact",
          arguments: { runId, artifactId: artifact.artifactId },
        }),
      );
      expect(ArtifactRefSchema.parse(artifactRead.artifact)).toEqual(artifact);
      expect(artifactRead.content).toBe(`Spores fake capture for ${runId}\n`);

      const manifestStat = await stat(path.join(runsRoot, runId, "manifest.json"));
      expect(manifestStat.isFile()).toBe(true);

      const missingTimeline = await client.callTool({
        name: "session_recording_get_timeline",
        arguments: { runId: "run_missing_e2e" },
      });
      const error = SporesErrorSchema.parse(expectError(missingTimeline));
      expect(error).toMatchObject({ error: "internal_error", retriable: false, requiresUserAction: false });
      expect(error.message).toContain("manifest.json");
    } catch (error) {
      if (stderr.length > 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nsporesd stderr:\n${stderr}`);
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);
});

function expectOk<T>(result: ClientToolResult): T {
  if ("toolResult" in result) {
    throw new Error(`unexpected compatibility tool result: ${JSON.stringify(result.toolResult)}`);
  }
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

function expectError(result: ClientToolResult): unknown {
  if ("toolResult" in result) {
    throw new Error(`unexpected compatibility tool result: ${JSON.stringify(result.toolResult)}`);
  }
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent;
}

function repoRoot(): string {
  return process.cwd();
}

function tsxBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(repoRoot(), "node_modules", ".bin", binaryName);
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "SHELL"]) {
    const value = process.env[key];
    if (value) {
      inherited[key] = value;
    }
  }
  return { ...inherited, FORCE_COLOR: "0", ...overrides };
}
