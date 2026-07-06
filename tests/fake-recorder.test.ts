import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRecorder } from "@spores/fake-recorder";
import { RunStore } from "@spores/store";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "spores-test-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("FakeRecorder", () => {
  it("creates a queryable run bundle", async () => {
    const store = new RunStore(path.join(tempDir, "runs"));
    const recorder = new FakeRecorder(store);

    const started = await recorder.start({
      purpose: "test fake recorder",
      runId: "run_test_001",
    });
    await recorder.appendEvent({
      runId: started.runId,
      type: "agent.decision",
      payload: { intent: "exercise test path" },
    });
    const stopped = await recorder.stop(started.runId);
    const timeline = await store.readTimeline(started.runId);

    expect(stopped.status).toBe("complete");
    expect(stopped.permissionSnapshot).toMatchObject({
      screenRecording: "granted",
      accessibility: "granted",
    });
    expect(timeline.events.map((event) => event.type)).toEqual([
      "permission.snapshot",
      "recording.started",
      "target.selected",
      "app.focused",
      "window.changed",
      "accessibility.tree",
      "screen.frame",
      "agent.decision",
      "screen.frame",
      "recording.stopped",
    ]);
    expect(timeline.frames).toHaveLength(2);
    expect(timeline.artifacts).toHaveLength(1);
    expect(timeline.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns existing active run on duplicate start", async () => {
    const store = new RunStore(path.join(tempDir, "runs"));
    const recorder = new FakeRecorder(store);

    const first = await recorder.start({ runId: "run_test_002" });
    const second = await recorder.start();

    expect(second.runId).toBe(first.runId);
  });
});
