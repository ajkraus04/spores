import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  PermissionBrokerStatusSchema,
  PermissionRequestResultSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargetsSchema,
  RunManifestSchema,
  SporesErrorSchema,
  TimelineSchema,
} from "@spores/schema";

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

let tempDir: string;
const itIfNativeScreenCapture = process.env.SPORES_TEST_NATIVE_CAPTURE === "1" &&
  process.platform === "darwin" &&
  existsSync("/usr/sbin/screencapture")
  ? it
  : it.skip;
const EXPECTED_TOOL_NAMES = [
  "recorder_context_snapshot",
  "recorder_helper_list_targets",
  "recorder_helper_status",
  "recorder_permissions_probe",
  "recorder_permissions_request",
  "recorder_permissions_status",
  "recorder_ready",
  "recorder_target_resolve",
  "recorder_target_select",
  "recorder_target_validate",
  "session_recording_append_agent_step",
  "session_recording_append_event",
  "session_recording_begin",
  "session_recording_capture",
  "session_recording_get_artifact",
  "session_recording_get_timeline",
  "session_recording_query_timeline",
  "session_recording_read_artifact",
  "session_recording_record_active_window",
  "session_recording_record_app",
  "session_recording_record_region",
  "session_recording_record_target",
  "session_recording_record_window",
  "session_recording_result",
  "session_recording_start",
  "session_recording_status",
  "session_recording_stop",
  "spores_doctor",
];

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
    const expectedTargetSource = expectedHelperTargetSource();
    const client = new Client({ name: "spores-e2e-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: bunCommand(),
      args: ["run", "--silent", "mcp"],
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
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
      const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      expectToolContract(toolByName, "recorder_ready", {
        title: "Recorder Readiness",
        role: "diagnostic",
        readOnly: true,
        idempotent: true,
        properties: ["ready", "readinessLevel", "permissions", "recommendedTools"],
      });
      expectToolContract(toolByName, "recorder_target_select", {
        title: "Select Recorder Target",
        role: "targeting",
        readOnly: true,
        idempotent: true,
        properties: ["selected", "confidence", "ambiguous", "recommendedRecordingArguments"],
      });
      expectToolContract(toolByName, "session_recording_capture", {
        title: "Capture Recording",
        role: "recording",
        readOnly: false,
        idempotent: false,
        properties: ["runId", "status", "target", "artifact", "timeline", "result"],
      });
      expectToolContract(toolByName, "session_recording_stop", {
        title: "Stop Recording Session",
        role: "recording",
        readOnly: false,
        idempotent: true,
        properties: ["runId", "sessionId", "status", "artifacts"],
      });

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("spores://recording/guide");
      const guide = await client.readResource({ uri: "spores://recording/guide" });
      expect(resourceText(guide)).toContain("recorder_ready");
      expect(resourceText(guide)).toContain("session_recording_capture");

      const resourceTemplates = await client.listResourceTemplates();
      expect(resourceTemplates.resourceTemplates.map((template) => template.uriTemplate)).toContain("spores://runs/{runId}/result");

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("spores_recording_workflow");
      const workflowPrompt = await client.getPrompt({
        name: "spores_recording_workflow",
        arguments: {
          objective: "record the checkout flow",
          targetHint: "Chrome",
          durationMode: "known",
        },
      });
      expect(promptText(workflowPrompt)).toContain("recorder_context_snapshot");
      expect(promptText(workflowPrompt)).toContain("session_recording_capture");

      const doctor = expectOk<{
        ok: true;
        recorder: "helper";
        nativeCapture: false;
        rootDir: string;
        helper: { available: boolean; targetCount?: number };
      }>(
        await client.callTool({ name: "spores_doctor", arguments: {} }),
      );
      expect(doctor).toMatchObject({ ok: true, recorder: "helper", nativeCapture: false, rootDir: runsRoot });
      expect(doctor).toMatchObject({
        helper: {
          available: true,
          capabilities: { permissionsProbe: true },
          targetSource: expectedTargetSource,
        },
      });
      expect(doctor.helper.targetCount).toBeGreaterThanOrEqual(1);

      const helperStatus = RecorderHelperStatusSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_helper_status",
            arguments: {},
          }),
        ),
      );
      expect(helperStatus).toMatchObject({
        available: true,
        command: bunCommand(),
        args: ["run", "--silent", "recorder-helper", "--", "--stdio"],
        capabilities: {
          listTargets: true,
          startSession: true,
          stopSession: true,
        },
        targetSource: expectedTargetSource,
      });
      expect(helperStatus.targetCount).toBeGreaterThanOrEqual(1);

      const helperTargets = RecorderHelperTargetsSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_helper_list_targets",
            arguments: {},
          }),
        ),
      );
      expect(helperTargets.status).toMatchObject({ available: true, targetCount: helperTargets.targets.length });
      expect(helperTargets.targets.some((target) => target.kind === "display")).toBe(true);
      expect(helperTargets.targets.some((target) => target.kind === "window")).toBe(true);
      expect(helperTargets.targets.find((target) => target.targetId === "display:main")).toMatchObject({
        bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
      });
      for (const target of helperTargets.targets.filter((target) => target.kind === "window")) {
        expect(target.window?.bounds).toBeDefined();
        expect(target.bounds).toEqual(target.window!.bounds);
      }

      const ready = expectOk<{
        ready: boolean;
        targetCount: number;
        timing: { unknownDurationMode: string; maxDurationSeconds: number };
        recommendedTools: string[];
      }>(
        await client.callTool({
          name: "recorder_ready",
          arguments: {},
        }),
      );
      expect(ready).toMatchObject({
        ready: true,
        timing: {
          unknownDurationMode: "start_with_safety_cap_then_stop",
          maxDurationSeconds: 30,
        },
      });
      expect(ready.targetCount).toBeGreaterThanOrEqual(1);
      expect(ready.recommendedTools.every((tool) => toolNames.includes(tool))).toBe(true);

      const snapshot = expectOk<{
        coordinateSpace: { unit: string; origin: string };
        displays: unknown[];
        windows: unknown[];
        counts: { targets: number };
      }>(
        await client.callTool({
          name: "recorder_context_snapshot",
          arguments: {},
        }),
      );
      expect(snapshot).toMatchObject({
        coordinateSpace: { unit: "screen_points", origin: "global_display_space" },
      });
      expect(snapshot.counts.targets).toBeGreaterThanOrEqual(1);
      expect(snapshot.displays.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.windows.length).toBeGreaterThanOrEqual(1);

      const resolvedDisplay = expectOk<{
        selected: { targetId: string; kind: string };
        confidence: string;
        score: number;
      }>(
        await client.callTool({
          name: "recorder_target_resolve",
          arguments: { targetId: "display:main" },
        }),
      );
      expect(resolvedDisplay).toMatchObject({
        selected: { targetId: "display:main", kind: "display" },
        confidence: "high",
      });

      const selectedDisplay = expectOk<{
        selected: { targetId: string; kind: string };
        confidence: string;
        recommendedRecordingArguments: unknown;
      }>(
        await client.callTool({
          name: "recorder_target_select",
          arguments: { selector: { targetId: "display:main" } },
        }),
      );
      expect(selectedDisplay).toMatchObject({
        selected: { targetId: "display:main", kind: "display" },
        confidence: "high",
        recommendedRecordingArguments: { target: { targetId: "display:main" } },
      });

      const validatedDisplay = expectOk<{
        valid: boolean;
        capturePlan: { outputFormat: string; targetId: string };
      }>(
        await client.callTool({
          name: "recorder_target_validate",
          arguments: { targetId: "display:main" },
        }),
      );
      expect(validatedDisplay).toMatchObject({
        valid: true,
        capturePlan: { outputFormat: "mp4", targetId: "display:main" },
      });

      const permissions = PermissionBrokerStatusSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_permissions_status",
            arguments: {},
          }),
        ),
      );
      expect(permissions).toMatchObject({
        requiresUserAction: false,
        snapshot: {
          screenRecording: "granted",
          accessibility: "granted",
        },
      });

      const permissionProbe = PermissionBrokerStatusSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_permissions_probe",
            arguments: {},
          }),
        ),
      );
      expect(permissionProbe.mode).toBe("native_probe");
      expect(permissionProbe.capabilities.map((capability) => capability.permission)).toContain("screenRecording");

      const permissionRequest = PermissionRequestResultSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_permissions_request",
            arguments: {},
          }),
        ),
      );
      expect(permissionRequest).toMatchObject({
        opened: false,
        message: "All required permissions are already granted.",
        actions: [],
      });

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
      await client.callTool({
        name: "session_recording_append_agent_step",
        arguments: {
          runId,
          stepId: "step-2",
          kind: "observation",
          summary: "recording contains the expected settings action",
          details: { source: "mcp e2e" },
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
      expect(stopped).toMatchObject({ runId, status: "complete", eventCount: 13, frameCount: 2 });
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
        "agent.observation",
        "screen.frame",
        "recording.stopped",
      ]);
      expect(timeline.events.map((event) => event.sequence)).toEqual([...Array(13).keys()]);
      expect(timeline.frames.map((frame) => frame.sequence)).toEqual([0, 1]);
      expect(timeline.artifacts).toHaveLength(1);

      const artifact = ArtifactRefSchema.parse(timeline.artifacts[0]);
      const queriedTimeline = expectOk<{
        events: Array<{ type: string; summary: string; payload?: unknown }>;
        summary: { eventCount: number; lanes: Record<string, number> };
      }>(
        await client.callTool({
          name: "session_recording_query_timeline",
          arguments: {
            runId,
            query: "settings action",
            includePayloads: true,
          },
        }),
      );
      expect(queriedTimeline).toMatchObject({
        events: [
          {
            type: "agent.observation",
            summary: "recording contains the expected settings action",
            payload: { source: "mcp e2e" },
          },
        ],
        summary: { lanes: { agent: 1 } },
      });

      const recordingResult = expectOk<{
        primaryArtifact: unknown;
        artifacts: Array<{ verified: boolean }>;
        timeline: { eventCount: number; artifactCount: number };
      }>(
        await client.callTool({
          name: "session_recording_result",
          arguments: { runId, includeTimeline: "summary" },
        }),
      );
      expect(recordingResult).toMatchObject({
        primaryArtifact: { artifactId: artifact.artifactId },
        artifacts: [{ verified: true }],
        timeline: { eventCount: 13, artifactCount: 1 },
      });

      const artifactRead = expectOk<{ artifact: unknown; content: string }>(
        await client.callTool({
          name: "session_recording_get_artifact",
          arguments: { runId, artifactId: artifact.artifactId },
        }),
      );
      expect(ArtifactRefSchema.parse(artifactRead.artifact)).toMatchObject({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      });
      expect(artifactRead.content).toBe(`Spores helper synthetic capture for ${runId}\n`);

      const artifactMetadata = expectOk<{ artifact: unknown; content?: string }>(
        await client.callTool({
          name: "session_recording_read_artifact",
          arguments: { runId, artifactId: artifact.artifactId, contentMode: "metadata" },
        }),
      );
      expect(ArtifactRefSchema.parse(artifactMetadata.artifact)).toMatchObject({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      });
      expect(artifactMetadata.content).toBeUndefined();

      const artifactText = expectOk<{ artifact: unknown; content: string; encoding: string }>(
        await client.callTool({
          name: "session_recording_read_artifact",
          arguments: { runId, artifactId: artifact.artifactId, contentMode: "text" },
        }),
      );
      expect(artifactText).toMatchObject({
        content: `Spores helper synthetic capture for ${runId}\n`,
        encoding: "utf8",
      });

      const artifactBase64 = expectOk<{ artifact: unknown; contentBase64: string; encoding: string }>(
        await client.callTool({
          name: "session_recording_read_artifact",
          arguments: { runId, artifactId: artifact.artifactId, contentMode: "base64" },
        }),
      );
      expect(Buffer.from(artifactBase64.contentBase64, "base64").toString("utf8")).toBe(`Spores helper synthetic capture for ${runId}\n`);
      expect(artifactBase64.encoding).toBe("base64");

      const tooLargeRead = await client.callTool({
        name: "session_recording_read_artifact",
        arguments: { runId, artifactId: artifact.artifactId, contentMode: "text", maxBytes: 1 },
      });
      expect(SporesErrorSchema.parse(expectError(tooLargeRead))).toMatchObject({
        error: "artifact_too_large",
        details: { recommendedContentMode: "metadata" },
      });

      const missingArtifactRead = await client.callTool({
        name: "session_recording_read_artifact",
        arguments: { runId, artifactId: "art_missing", contentMode: "metadata" },
      });
      expect(SporesErrorSchema.parse(expectError(missingArtifactRead))).toMatchObject({
        error: "artifact_not_found",
        retriable: false,
      });

      const captured = expectOk<{
        runId: string;
        status: string;
        result: { artifacts: Array<{ verified: boolean }>; timeline: { eventCount: number } };
      }>(
        await client.callTool({
          name: "session_recording_capture",
          arguments: {
            runId: "run_mcp_capture_preferred_001",
            target: { targetId: "display:main" },
            captureMode: "synthetic",
            seconds: 1,
          },
        }),
      );
      expect(captured).toMatchObject({
        runId: "run_mcp_capture_preferred_001",
        status: "complete",
        result: {
          artifacts: [{ verified: true }],
          timeline: { eventCount: 9 },
        },
      });
      const runResource = await client.readResource({ uri: `spores://runs/${captured.runId}/result` });
      expect(JSON.parse(resourceText(runResource))).toMatchObject({
        runId: captured.runId,
        status: "complete",
        timeline: { eventCount: 9 },
      });

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
  }, 45_000);

  itIfNativeScreenCapture("records a native region screen movie through MCP stdio", async () => {
    const runId = "run_mcp_native_capture_e2e_001";
    const runsRoot = path.join(tempDir, "runs");
    const bounds = { x: 0, y: 0, width: 320, height: 240 };
    const client = new Client({ name: "spores-native-capture-e2e-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: bunCommand(),
      args: ["run", "--silent", "mcp"],
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

      const recorded = expectOk<{
        runId: string;
        status: string;
        target: unknown;
        artifact: unknown;
        timeline: { eventCount: number; frameCount: number; finalFrameArtifactId?: string };
        timing: { requestedSeconds: number; durationKnown: boolean };
      }>(
        await client.callTool({
          name: "session_recording_record_region",
          arguments: {
            runId,
            purpose: "mcp native region capture e2e",
            targetId: "region:mcp:e2e",
            bounds,
            seconds: 1,
          },
        }),
      );
      expect(recorded).toMatchObject({
        runId,
        status: "complete",
        target: { kind: "region", targetId: "region:mcp:e2e", bounds },
        timing: { requestedSeconds: 1, durationKnown: true },
        timeline: { eventCount: 9, frameCount: 2 },
      });

      const artifact = ArtifactRefSchema.parse(recorded.artifact);
      expect(artifact).toMatchObject({
        kind: "video",
        role: "recording_primary",
        relativePath: "capture.mp4",
        mediaType: "video/mp4",
        redactionState: "raw",
      });
      const bytes = await readFile(artifact.path);
      expect(bytes.byteLength).toBeGreaterThan(1024);
      expect(artifact.bytes).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

      const timeline = TimelineSchema.parse(
        expectOk(
          await client.callTool({
            name: "session_recording_get_timeline",
            arguments: { runId },
          }),
        ),
      );
      expect(timeline.frames[1]!.artifactId).toBe(artifact.artifactId);
      expect(timeline.artifacts.find((candidate) => candidate.role === "source_capture")).toMatchObject({
        kind: "video",
        mediaType: "video/mp4",
        relativePath: "source-capture.mp4",
      });
      expect(timeline.events[1]!.payload).toMatchObject({
        nativeCapture: true,
        captureBackend: "screencapture",
      });
      const nativeState = JSON.parse(await readFile(path.join(runsRoot, runId, "native-capture.json"), "utf8"));
      expect(nativeState).toMatchObject({ region: bounds, backgroundId: "hypha-dark" });
      expect(nativeState.captureArgs).toContain("-R0,0,320,240");
    } catch (error) {
      if (stderr.length > 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nsporesd stderr:\n${stderr}`);
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);

  it("returns structured permission errors before starting a recording", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const client = new Client({ name: "spores-permission-e2e-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: bunCommand(),
      args: ["run", "--silent", "mcp"],
      cwd: repoRoot(),
      env: childEnv({
        SPORES_RUNS_ROOT: runsRoot,
        SPORES_PERMISSION_SCREEN_RECORDING: "missing",
      }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await client.connect(transport);

      const permissions = PermissionBrokerStatusSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_permissions_status",
            arguments: {},
          }),
        ),
      );
      expect(permissions).toMatchObject({
        requiresUserAction: true,
        snapshot: {
          screenRecording: "missing",
          requiresUserAction: true,
        },
      });

      const start = await client.callTool({
        name: "session_recording_start",
        arguments: {
          runId: "run_missing_permission_e2e_001",
          purpose: "permission failure e2e",
        },
      });
      const error = SporesErrorSchema.parse(expectError(start));
      expect(error).toMatchObject({
        error: "missing_permission",
        retriable: true,
        requiresUserAction: true,
      });
      expect(error.message).toContain("Screen Recording");
      await expect(stat(path.join(runsRoot, "run_missing_permission_e2e_001", "manifest.json"))).rejects.toThrow();
    } catch (error) {
      if (stderr.length > 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nsporesd stderr:\n${stderr}`);
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);

  it("reports helper launch failures through permission tools and recording start", async () => {
    const runsRoot = path.join(tempDir, "runs");
    const client = new Client({ name: "spores-helper-unavailable-e2e-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: bunCommand(),
      args: ["run", "--silent", "mcp"],
      cwd: repoRoot(),
      env: childEnv({
        SPORES_RUNS_ROOT: runsRoot,
        SPORES_RECORDER_HELPER_COMMAND: path.join(tempDir, "missing-helper"),
      }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await client.connect(transport);

      const permissions = PermissionBrokerStatusSchema.parse(
        expectOk(
          await client.callTool({
            name: "recorder_permissions_status",
            arguments: {},
          }),
        ),
      );
      expect(permissions).toMatchObject({
        requiresUserAction: true,
        error: {
          code: "helper_unavailable",
          retriable: true,
          requiresUserAction: false,
          details: {
            command: path.join(tempDir, "missing-helper"),
            cwd: repoRoot(),
            cwdPackageJsonPresent: true,
            executablePresent: false,
            suggestedCommands: expect.arrayContaining([
              "bun install",
              "bun run --silent mcp:doctor -- --json",
            ]),
          },
        },
      });

      const start = await client.callTool({
        name: "session_recording_start",
        arguments: {
          runId: "run_helper_unavailable_e2e_001",
          purpose: "helper unavailable e2e",
        },
      });
      const error = SporesErrorSchema.parse(expectError(start));
      expect(error).toMatchObject({
        error: "helper_unavailable",
        retriable: true,
        requiresUserAction: false,
        details: {
          command: path.join(tempDir, "missing-helper"),
          cwdPackageJsonPresent: true,
          executablePresent: false,
        },
      });
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
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const textContent = result.content.find((entry) => entry.type === "text");
  expect(textContent).toBeDefined();
  return JSON.parse(textContent!.text);
}

function expectToolContract(
  tools: Map<string, ListedTool>,
  name: string,
  expectation: {
    title: string;
    role: string;
    readOnly: boolean;
    idempotent: boolean;
    properties: string[];
  },
): void {
  const tool = tools.get(name);
  expect(tool).toBeDefined();
  expect(tool).toMatchObject({
    title: expectation.title,
    annotations: {
      title: expectation.title,
      readOnlyHint: expectation.readOnly,
      destructiveHint: false,
      idempotentHint: expectation.idempotent,
      openWorldHint: false,
    },
    _meta: {
      "spores/role": expectation.role,
    },
  });
  expect(Object.keys(tool!.outputSchema?.properties ?? {})).toEqual(expect.arrayContaining(expectation.properties));
}

function resourceText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  expect(first?.text).toEqual(expect.any(String));
  return first!.text as string;
}

function promptText(result: Awaited<ReturnType<Client["getPrompt"]>>): string {
  const content = result.messages[0]?.content as { type?: string; text?: unknown } | undefined;
  expect(content).toMatchObject({ type: "text" });
  expect(content?.text).toEqual(expect.any(String));
  return content!.text as string;
}

function repoRoot(): string {
  return process.cwd();
}

function bunCommand(): string {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function expectedHelperTargetSource() {
  return process.env.SPORES_TARGET_DISCOVERY_MODE === "deterministic"
    ? "deterministic_fallback"
    : expect.stringMatching(/^(macos|deterministic_fallback|unknown)$/);
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "SHELL",
    "SPORES_TARGET_DISCOVERY_MODE",
  ]) {
    const value = process.env[key];
    if (value) {
      inherited[key] = value;
    }
  }
  return { ...inherited, FORCE_COLOR: "0", SPORES_PERMISSION_NATIVE_PROBE: "skip", ...overrides };
}
