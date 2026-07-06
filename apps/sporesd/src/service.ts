import { z } from "zod";

import { FakeRecorder } from "@spores/fake-recorder";
import { SporesEventSchema, TargetRefSchema } from "@spores/schema";
import { RunStore } from "@spores/store";

const TargetInputSchema = TargetRefSchema.partial().extend({
  mode: z.enum(["fake", "picker"]).default("fake"),
});

export const StartRecordingInputSchema = z.object({
  purpose: z.string().optional(),
  runId: z.string().optional(),
  target: TargetInputSchema.optional(),
});

export const StatusInputSchema = z.object({
  runId: z.string().optional(),
});

export const StopInputSchema = z.object({
  runId: z.string().optional(),
});

export const AppendEventInputSchema = z.object({
  runId: z.string(),
  type: SporesEventSchema.shape.type,
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const TimelineInputSchema = z.object({
  runId: z.string(),
});

export const ArtifactInputSchema = z.object({
  runId: z.string(),
  artifactId: z.string(),
});

export type SporesServiceOptions = {
  rootDir?: string;
};

export class SporesService {
  readonly store: RunStore;
  readonly recorder: FakeRecorder;

  constructor(options: SporesServiceOptions = {}) {
    this.store = new RunStore(options.rootDir);
    this.recorder = new FakeRecorder(this.store);
  }

  doctor() {
    return this.recorder.doctor();
  }

  start(input: z.infer<typeof StartRecordingInputSchema>) {
    return this.recorder.start(input);
  }

  async status(input: z.infer<typeof StatusInputSchema>) {
    if (input.runId) {
      return this.store.readManifest(input.runId);
    }

    const active = await this.recorder.status();
    if (active.status !== "idle") {
      return active;
    }

    return (await this.store.readLatestManifest()) ?? active;
  }

  stop(input: z.infer<typeof StopInputSchema>) {
    return this.recorder.stop(input.runId);
  }

  appendEvent(input: z.infer<typeof AppendEventInputSchema>) {
    return this.recorder.appendEvent(input);
  }

  timeline(input: z.infer<typeof TimelineInputSchema>) {
    return this.store.readTimeline(input.runId);
  }

  artifact(input: z.infer<typeof ArtifactInputSchema>) {
    return this.store.readArtifact(input.runId, input.artifactId);
  }
}

export function createSporesService(options: SporesServiceOptions = {}) {
  return new SporesService(options);
}
