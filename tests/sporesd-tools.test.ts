import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AppendAgentStepInputSchema,
  createSporesService,
} from "../apps/sporesd/src/service.js";
import { createToolDefinitions } from "../apps/sporesd/src/tools.js";
import type { RecorderHelperClient, RecorderHelperSessionInput } from "../apps/sporesd/src/recorderHelper.js";
import {
  PermissionBrokerStatusSchema,
  PermissionRequestResultSchema,
  RecorderHelperSessionSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargetsSchema,
  TargetRef,
  TargetRefSchema,
} from "@spores/schema";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-tools-test-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("sporesd tool handlers", () => {
  it("runs start, append, stop, and timeline without an MCP transport", async () => {
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const tools = new Map(createToolDefinitions(service).map((tool) => [tool.name, tool]));

    const start = tools.get("session_recording_start");
    const append = tools.get("session_recording_append_event");
    const stop = tools.get("session_recording_stop");
    const timeline = tools.get("session_recording_get_timeline");

    expect(start).toBeDefined();
    expect(append).toBeDefined();
    expect(stop).toBeDefined();
    expect(timeline).toBeDefined();

    const started = await start!.execute({
      runId: "run_tools_001",
      purpose: "test tools",
    } as never);

    expect(started).toMatchObject({ runId: "run_tools_001", status: "recording" });

    await append!.execute({
      runId: "run_tools_001",
      type: "agent.assertion",
      payload: { expected: "tools work", actual: "tools work", status: "passed" },
    } as never);

    const stopped = await stop!.execute({ runId: "run_tools_001" } as never);
    expect(stopped).toMatchObject({ runId: "run_tools_001", status: "complete" });

    const result = await timeline!.execute({ runId: "run_tools_001" } as never);
    expect(result).toMatchObject({
      runId: "run_tools_001",
      status: "complete",
    });
    expect((result as { events: unknown[] }).events).toHaveLength(10);
  }, 20_000);

  it("exposes agent-friendly readiness, target resolution, and begin tools", async () => {
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const tools = new Map(createToolDefinitions(service).map((tool) => [tool.name, tool]));

    for (const tool of tools.values()) {
      expect(tool.outputSchema).toBeDefined();
    }

    const ready = await tools.get("recorder_ready")!.execute({} as never);
    expect(ready).toMatchObject({
      ready: true,
      timing: {
        unknownDurationMode: "start_with_safety_cap_then_stop",
        maxDurationSeconds: 30,
      },
    });

    const resolved = await tools.get("recorder_target_resolve")!.execute({
      targetId: "display:main",
    } as never);
    expect(resolved).toMatchObject({
      selected: { targetId: "display:main", kind: "display" },
      confidence: "high",
    });

    const begun = await tools.get("session_recording_begin")!.execute({
      runId: "run_tools_begin_001",
      purpose: "unknown duration tool e2e",
      target: { targetId: "display:main" },
      captureMode: "synthetic",
      safetyCapSeconds: 1,
    } as never);
    expect(begun).toMatchObject({
      runId: "run_tools_begin_001",
      status: "recording",
      selection: { selected: { targetId: "display:main" } },
      timing: {
        durationKnown: false,
        safetyCapSeconds: 1,
      },
    });

    const stopped = await tools.get("session_recording_stop")!.execute({ runId: "run_tools_begin_001" } as never);
    expect(stopped).toMatchObject({ runId: "run_tools_begin_001", status: "complete" });
  }, 20_000);

  it("supports the preferred agent capture, result, query, and bounded artifact tools", async () => {
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const tools = new Map(createToolDefinitions(service).map((tool) => [tool.name, tool]));

    const snapshot = await tools.get("recorder_context_snapshot")!.execute({} as never);
    expect(snapshot).toMatchObject({
      coordinateSpace: {
        unit: "screen_points",
        origin: "global_display_space",
      },
      counts: {
        targets: expect.any(Number),
      },
    });

    const selected = await tools.get("recorder_target_select")!.execute({
      selector: { targetId: "display:main" },
    } as never);
    expect(selected).toMatchObject({
      selected: { targetId: "display:main", kind: "display" },
      confidence: "high",
      ambiguous: false,
      recommendedRecordingArguments: { target: { targetId: "display:main" } },
    });

    const validated = await tools.get("recorder_target_validate")!.execute({
      targetId: "display:main",
    } as never);
    expect(validated).toMatchObject({
      valid: true,
      target: { targetId: "display:main" },
      capturePlan: { outputFormat: "mp4" },
    });

    const captured = await tools.get("session_recording_capture")!.execute({
      runId: "run_agent_capture_tools_001",
      purpose: "preferred agent capture",
      target: { targetId: "display:main" },
      captureMode: "synthetic",
      seconds: 1,
      result: {
        includeTimeline: "summary",
        verifyArtifacts: true,
      },
    } as never);
    expect(captured).toMatchObject({
      runId: "run_agent_capture_tools_001",
      status: "complete",
      result: {
        status: "complete",
        timeline: {
          eventCount: 9,
          artifactCount: 1,
        },
        artifacts: [
          {
            verified: true,
            checks: {
              exists: true,
              bytesMatch: true,
              sha256Match: true,
              nonEmpty: true,
            },
          },
        ],
      },
    });

    await tools.get("session_recording_append_agent_step")!.execute({
      runId: "run_agent_capture_tools_001",
      stepId: "step-post-capture",
      kind: "observation",
      summary: "post capture annotation",
      details: { visibleState: "complete" },
    } as never);

    const query = await tools.get("session_recording_query_timeline")!.execute({
      runId: "run_agent_capture_tools_001",
      query: "post capture",
      includePayloads: true,
      limit: 10,
    } as never);
    expect(query).toMatchObject({
      runId: "run_agent_capture_tools_001",
      events: [
        {
          type: "agent.observation",
          lane: "agent",
          summary: "post capture annotation",
          payload: {
            stepId: "step-post-capture",
            visibleState: "complete",
          },
        },
      ],
    });

    const result = await tools.get("session_recording_result")!.execute({
      runId: "run_agent_capture_tools_001",
      includeTimeline: "events",
      includeSmallTextArtifacts: true,
    } as never);
    expect(result).toMatchObject({
      runId: "run_agent_capture_tools_001",
      timeline: {
        eventCount: 10,
        events: expect.arrayContaining([
          expect.objectContaining({ type: "agent.observation", summary: "post capture annotation" }),
        ]),
      },
      smallTextArtifacts: [
        {
          content: "Spores helper synthetic capture for run_agent_capture_tools_001\n",
        },
      ],
    });

    const artifactId = (captured as { artifact: { artifactId: string } }).artifact.artifactId;
    const metadata = await tools.get("session_recording_read_artifact")!.execute({
      runId: "run_agent_capture_tools_001",
      artifactId,
      contentMode: "metadata",
    } as never);
    expect(metadata).toMatchObject({ artifact: { artifactId } });

    const text = await tools.get("session_recording_read_artifact")!.execute({
      runId: "run_agent_capture_tools_001",
      artifactId,
      contentMode: "text",
    } as never);
    expect(text).toMatchObject({
      content: "Spores helper synthetic capture for run_agent_capture_tools_001\n",
      encoding: "utf8",
    });

    const base64 = await tools.get("session_recording_read_artifact")!.execute({
      runId: "run_agent_capture_tools_001",
      artifactId,
      contentMode: "base64",
    } as never);
    expect(base64).toMatchObject({
      contentBase64: Buffer.from("Spores helper synthetic capture for run_agent_capture_tools_001\n").toString("base64"),
      encoding: "base64",
    });
  }, 20_000);

  it("fails target selection when the policy requires higher confidence", async () => {
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });
    const tools = new Map(createToolDefinitions(service).map((tool) => [tool.name, tool]));

    await expect(tools.get("recorder_target_select")!.execute({
      selector: {},
      targetPolicy: {
        minConfidence: "high",
        failOnAmbiguous: false,
        ambiguityMargin: 10,
        maxAlternatives: 5,
      },
    } as never)).rejects.toMatchObject({
      code: "target_confidence_too_low",
      retriable: true,
      requiresUserAction: false,
    });
  }, 20_000);

  it("uses snapshot-bound targets for selection and validation", async () => {
    const firstWindow = windowTarget("window:first", 0, "First Window");
    const secondWindow = windowTarget("window:second", 0, "Second Window");
    const helper = createStubHelper([[firstWindow], [secondWindow]]);
    const service = createSporesService({ rootDir: path.join(tempDir, "runs"), helper });

    const snapshot = await service.contextSnapshot();
    const selectedFromSnapshot = await service.selectTarget({
      snapshotId: snapshot.snapshotId,
      selector: { kind: "window", prefer: "frontmost" },
    });
    expect(selectedFromSnapshot).toMatchObject({
      snapshotId: snapshot.snapshotId,
      selected: { targetId: "window:first" },
    });

    const selectedLive = await service.selectTarget({
      selector: { kind: "window", prefer: "frontmost" },
    });
    expect(selectedLive).toMatchObject({ selected: { targetId: "window:second" } });

    await expect(service.validateTarget({
      snapshotId: "snap_missing",
      targetId: "window:first",
    })).rejects.toMatchObject({
      code: "stale_target_snapshot",
      retriable: true,
    });
  });

  it("enforces ambiguous target policy with bounded alternatives", async () => {
    const service = createSporesService({
      rootDir: path.join(tempDir, "runs"),
      helper: createStubHelper([
        [
          windowTarget("window:chrome:1", 0, "Chrome Alpha"),
          windowTarget("window:chrome:2", 1, "Chrome Beta"),
          windowTarget("window:chrome:3", 2, "Chrome Gamma"),
        ],
      ]),
    });

    await service.selectTarget({
      selector: { kind: "window", app: "Chrome", prefer: "frontmost" },
      targetPolicy: { failOnAmbiguous: true, minConfidence: "medium", ambiguityMargin: 10, maxAlternatives: 1 },
    }).then(
      () => {
        throw new Error("expected ambiguous target selection to fail");
      },
      (error: unknown) => {
        expect(error).toMatchObject({ code: "ambiguous_target" });
        const details = (error as { details: { alternatives: Array<{ target: TargetRef }>; requiredDisambiguators: string[] } }).details;
        expect(details.requiredDisambiguators).toContain("targetId");
        expect(details.alternatives[0]!.target.targetId).toBe("window:chrome:2");
      },
    );

    const selected = await service.selectTarget({
      selector: { kind: "window", app: "Chrome", prefer: "frontmost" },
      targetPolicy: { failOnAmbiguous: false, minConfidence: "medium", ambiguityMargin: 10, maxAlternatives: 1 },
    });
    expect(selected.ambiguous).toBe(true);
    expect(selected.alternatives[0]!.target.targetId).toBe("window:chrome:2");
    expect(selected.recommendedRecordingArguments).toEqual({ target: { targetId: "window:chrome:1" } });
    expect(selected.alternatives).toHaveLength(1);
  });

  it("rejects native capture targets that cannot be addressed safely", async () => {
    const service = createSporesService({
      rootDir: path.join(tempDir, "runs"),
      helper: createStubHelper([
        [
          TargetRefSchema.parse({
            targetId: "app:no-bounds",
            kind: "app",
            app: { name: "No Bounds", bundleId: "dev.spores.no-bounds" },
            safeToPersist: true,
          }),
        ],
      ]),
    });

    const validation = await service.validateTarget({ targetId: "app:no-bounds" });
    expect(validation).toMatchObject({
      valid: false,
      invalidations: ["missing_bounds"],
    });

    await expect(service.start({
      runId: "run_invalid_native_target_001",
      target: { targetId: "app:no-bounds" },
      capture: { mode: "native", maxDurationSeconds: 1 },
    })).rejects.toMatchObject({
      code: "invalid_capture_target",
      details: {
        blockers: ["missing_bounds"],
      },
    });
  });

  it("bounds recording result event output and hides payloads by default", async () => {
    const service = createSporesService({ rootDir: path.join(tempDir, "runs") });

    await service.start({
      runId: "run_bounded_result_001",
      purpose: "bounded result regression",
      target: { mode: "fake", targetId: "target_bounded_result" },
    });
    for (let index = 0; index < 12; index += 1) {
      await service.appendAgentStep({
        runId: "run_bounded_result_001",
        stepId: `step-${index}`,
        kind: "observation",
        summary: `observation ${index}`,
        details: { hiddenPayload: `payload-${index}` },
      });
    }
    await service.stop({ runId: "run_bounded_result_001" });

    const result = await service.recordingResult({
      runId: "run_bounded_result_001",
      includeTimeline: "events",
      limit: 5,
      includePayloads: false,
      verifyArtifacts: true,
      includeSmallTextArtifacts: false,
    });
    expect(result.timeline).toMatchObject({
      eventCount: 21,
      nextAfterSequence: 4,
    });
    const events = (result.timeline as { events: Array<{ payload?: unknown }> }).events;
    expect(events).toHaveLength(5);
    expect(events.every((event) => event.payload === undefined)).toBe(true);
  });

  it("validates structured agent step bounds and reserved keys", () => {
    expect(() => AppendAgentStepInputSchema.parse({
      runId: "run_schema_001",
      stepId: "step-1",
      kind: "assertion",
      summary: "missing assertion payload",
    })).toThrow(/assertion is required/);

    expect(() => AppendAgentStepInputSchema.parse({
      runId: "run_schema_001",
      stepId: "step-1",
      kind: "observation",
      summary: "reserved key",
      details: { stepId: "override" },
    })).toThrow(/details.stepId is reserved/);

    expect(() => AppendAgentStepInputSchema.parse({
      runId: "run_schema_001",
      stepId: "step-1",
      kind: "observation",
      summary: "x".repeat(4_001),
    })).toThrow();
  });

  it("uses fake recorder only when explicitly configured", async () => {
    const service = createSporesService({
      rootDir: path.join(tempDir, "runs"),
      backend: "fake",
    });

    await expect(service.doctor()).resolves.toMatchObject({ recorder: "fake" });

    const started = await service.start({
      runId: "run_tools_fake_001",
      purpose: "explicit fake fallback",
    });
    const stopped = await service.stop({ runId: started.runId });
    const artifact = stopped.artifacts[0];

    expect(stopped).toMatchObject({ runId: "run_tools_fake_001", status: "complete" });
    expect(artifact).toBeDefined();
    expect(await readFile(artifact!.path, "utf8")).toBe("Spores fake capture for run_tools_fake_001\n");
  });
});

function createStubHelper(targetBatches: TargetRef[][]): RecorderHelperClient {
  let listCallCount = 0;
  const currentTargets = () => targetBatches[Math.min(listCallCount, targetBatches.length - 1)] ?? [];
  const permissionStatus = () => PermissionBrokerStatusSchema.parse({
    platform: process.platform,
    mode: "native_probe",
    snapshot: {
      platform: process.platform,
      screenRecording: "granted",
      accessibility: "granted",
      inputMonitoring: "not_requested",
      microphone: "not_requested",
      systemAudio: "not_requested",
      requiresUserAction: false,
    },
    capabilities: [
      {
        permission: "screenRecording",
        label: "Screen Recording",
        status: "granted",
        required: true,
        canRequest: false,
        reason: "test",
      },
      {
        permission: "accessibility",
        label: "Accessibility",
        status: "granted",
        required: true,
        canRequest: false,
        reason: "test",
      },
    ],
    requiresUserAction: false,
  });
  return {
    status: async () => RecorderHelperStatusSchema.parse({
      configured: true,
      available: true,
      mode: "stdio",
      command: "stub-helper",
      args: [],
      targetCount: currentTargets().length,
      capabilities: {
        listTargets: true,
        startSession: true,
        stopSession: true,
        permissions: true,
        permissionsProbe: true,
      },
    }),
    listTargets: async () => {
      const targets = currentTargets();
      listCallCount += 1;
      return RecorderHelperTargetsSchema.parse({
        status: {
          configured: true,
          available: true,
          mode: "stdio",
          command: "stub-helper",
          args: [],
          targetCount: targets.length,
        },
        targets,
      });
    },
    permissionsStatus: async () => permissionStatus(),
    permissionsProbe: async () => permissionStatus(),
    requestPermissions: async () => PermissionRequestResultSchema.parse({
      status: permissionStatus(),
      opened: false,
      message: "All required permissions are already granted.",
      actions: [],
    }),
    startSession: async () => {
      throw new Error("stub helper should not start sessions in this test");
    },
    getSessionStatus: async (input: RecorderHelperSessionInput) => RecorderHelperSessionSchema.parse({
      runId: input.runId,
      sessionId: input.sessionId,
      status: "recording",
      eventCount: input.eventCount,
      frameCount: input.frameCount,
      artifacts: [],
    }),
    stopSession: async (input: RecorderHelperSessionInput) => RecorderHelperSessionSchema.parse({
      runId: input.runId,
      sessionId: input.sessionId,
      status: "complete",
      eventCount: input.eventCount,
      frameCount: input.frameCount,
      artifacts: [],
    }),
  } as unknown as RecorderHelperClient;
}

function windowTarget(targetId: string, zOrder: number, title: string): TargetRef {
  return TargetRefSchema.parse({
    targetId,
    kind: "window",
    displayId: "main",
    bounds: { x: 10 + zOrder, y: 20 + zOrder, width: 800, height: 600 },
    zOrder,
    app: { name: "Chrome", bundleId: "com.google.Chrome", processId: 100 + zOrder },
    window: {
      id: String(1000 + zOrder),
      title,
      bounds: { x: 10 + zOrder, y: 20 + zOrder, width: 800, height: 600 },
    },
    safeToPersist: true,
  });
}
