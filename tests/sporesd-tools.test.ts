import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSporesService } from "../apps/sporesd/src/service.js";
import { createToolDefinitions } from "../apps/sporesd/src/tools.js";

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
  });
});
