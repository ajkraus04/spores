import { rm } from "node:fs/promises";
import path from "node:path";

import { createSporesService } from "./service.js";

const rootDir = path.resolve(".tmp/spores-smoke/runs");
await rm(path.resolve(".tmp/spores-smoke"), { force: true, recursive: true });

const service = createSporesService({ rootDir });
const doctor = await service.doctor();
const started = await service.start({
  purpose: "Milestone 1 smoke recording",
  runId: "run_smoke_001",
});

await service.appendEvent({
  runId: started.runId,
  type: "agent.decision",
  payload: {
    intent: "Verify the milestone 1 run bundle can be queried.",
    confidence: "high",
  },
});
await service.appendEvent({
  runId: started.runId,
  type: "agent.action",
  payload: {
    tool: "spores.smoke",
    selectedAction: "append deterministic fake event",
  },
});
await service.appendEvent({
  runId: started.runId,
  type: "agent.assertion",
  payload: {
    expected: "run bundle exists",
    actual: "run bundle exists",
    status: "passed",
  },
});

const stopped = await service.stop({ runId: started.runId });
const timeline = await service.timeline({ runId: started.runId });

console.log(`doctor=${JSON.stringify(doctor)}`);
console.log(`run_id=${stopped.runId}`);
console.log(`session_id=${stopped.sessionId}`);
console.log(`run_dir=${stopped.paths.runDir}`);
console.log(`manifest_path=${stopped.paths.manifest}`);
console.log(`events_path=${stopped.paths.events}`);
console.log(`frames_path=${stopped.paths.frames}`);
console.log(`event_count=${timeline.events.length}`);
console.log(`frame_count=${timeline.frames.length}`);
