import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AppendAgentStepInputSchema,
  AppendEventInputSchema,
  ArtifactReadInputSchema,
  ArtifactInputSchema,
  BeginRecordingInputSchema,
  ContextSnapshotInputSchema,
  HelperTargetsInputSchema,
  PermissionsRequestInputSchema,
  PermissionsStatusInputSchema,
  ReadyInputSchema,
  RecordActiveWindowInputSchema,
  RecordAppInputSchema,
  RecordCaptureInputSchema,
  RecordRegionInputSchema,
  RecordTargetInputSchema,
  RecordWindowInputSchema,
  RecordingResultInputSchema,
  ResolveTargetInputSchema,
  SporesServiceError,
  SporesService,
  StartRecordingInputSchema,
  StatusInputSchema,
  StopInputSchema,
  TargetSelectInputSchema,
  TargetValidateInputSchema,
  TimelineInputSchema,
  TimelineQueryInputSchema,
} from "./service.js";

type JsonObject = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  execute(input: never): Promise<unknown>;
  readOnly?: boolean;
};

const LooseOutputSchema = z.object({}).passthrough();

export function createToolDefinitions(service: SporesService) {
  return withDefaultOutputSchemas([
    {
      name: "spores_doctor",
      description: "Return local Spores health, recorder backend status, and recorder-helper status.",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => service.doctor(),
    },
    {
      name: "recorder_ready",
      description: "Return whether the local recorder is ready for agents, including permissions, targets, and timing limitations.",
      inputSchema: ReadyInputSchema,
      readOnly: true,
      execute: async (input) => service.ready(input),
    },
    {
      name: "recorder_helper_status",
      description: "Launch the recorder helper and return its availability and capability status.",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => service.helper.status(),
    },
    {
      name: "recorder_helper_list_targets",
      description: "Launch the recorder helper and return captureable displays, apps, and windows.",
      inputSchema: HelperTargetsInputSchema,
      readOnly: true,
      execute: async (input) => service.listTargets(input),
    },
    {
      name: "recorder_context_snapshot",
      description: "Return a bounded snapshot of capturable displays, apps, windows, active window, and coordinate space.",
      inputSchema: ContextSnapshotInputSchema,
      readOnly: true,
      execute: async (input) => service.contextSnapshot(input),
    },
    {
      name: "recorder_target_resolve",
      description: "Resolve a fuzzy agent target selector into one capture target with scored alternatives.",
      inputSchema: ResolveTargetInputSchema,
      readOnly: true,
      execute: async (input) => service.resolveTarget(input),
    },
    {
      name: "recorder_target_select",
      description: "Resolve a target selector using an agent policy for confidence and ambiguity.",
      inputSchema: TargetSelectInputSchema,
      readOnly: true,
      execute: async (input) => service.selectTarget(input),
    },
    {
      name: "recorder_target_validate",
      description: "Validate that a previously selected target still exists and return its capture plan.",
      inputSchema: TargetValidateInputSchema,
      readOnly: true,
      execute: async (input) => service.validateTarget(input),
    },
    {
      name: "recorder_permissions_status",
      description: "Return required and optional local recording permission state.",
      inputSchema: PermissionsStatusInputSchema,
      readOnly: true,
      execute: async (input) => service.permissionsStatus(input),
    },
    {
      name: "recorder_permissions_probe",
      description: "Run a native permission probe and return whether the current launcher can actually capture pixels.",
      inputSchema: PermissionsStatusInputSchema,
      readOnly: true,
      execute: async (input) => service.permissionsProbe(input),
    },
    {
      name: "recorder_permissions_request",
      description: "Return user-action instructions for granting missing recording permissions.",
      inputSchema: PermissionsRequestInputSchema,
      execute: async (input) => service.requestPermissions(input),
    },
    {
      name: "session_recording_begin",
      description: "Resolve a target selector and start a recording for unknown-duration tasks using a safety cap.",
      inputSchema: BeginRecordingInputSchema,
      execute: async (input) => service.begin(input),
    },
    {
      name: "session_recording_capture",
      description: "Preferred one-shot agent capture: select a target, record for a bounded duration, stop, and return result summary.",
      inputSchema: RecordCaptureInputSchema,
      execute: async (input) => service.recordCapture(input),
    },
    {
      name: "session_recording_record_target",
      description: "Resolve a target selector, record it for a fixed number of seconds, stop, and return the artifact summary.",
      inputSchema: RecordTargetInputSchema,
      execute: async (input) => service.recordTarget(input),
    },
    {
      name: "session_recording_record_window",
      description: "Record a matching window for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordWindowInputSchema,
      execute: async (input) => service.recordWindow(input),
    },
    {
      name: "session_recording_record_app",
      description: "Record a matching app's visible bounds for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordAppInputSchema,
      execute: async (input) => service.recordApp(input),
    },
    {
      name: "session_recording_record_region",
      description: "Record explicit screen coordinates for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordRegionInputSchema,
      execute: async (input) => service.recordRegion(input),
    },
    {
      name: "session_recording_record_active_window",
      description: "Record the frontmost helper-listed window for a fixed number of seconds and return the artifact summary.",
      inputSchema: RecordActiveWindowInputSchema,
      execute: async (input) => service.recordActiveWindow(input),
    },
    {
      name: "session_recording_start",
      description: "Start a helper-backed recording session and create a run bundle.",
      inputSchema: StartRecordingInputSchema,
      execute: async (input) => service.start(input),
    },
    {
      name: "session_recording_status",
      description: "Return the active or requested recording status.",
      inputSchema: StatusInputSchema,
      readOnly: true,
      execute: async (input) => service.status(input),
    },
    {
      name: "session_recording_stop",
      description: "Stop the active or requested recording session.",
      inputSchema: StopInputSchema,
      execute: async (input) => service.stop(input),
    },
    {
      name: "session_recording_append_event",
      description: "Append an agent event to the active run's event stream.",
      inputSchema: AppendEventInputSchema,
      execute: async (input) => service.appendEvent(input),
    },
    {
      name: "session_recording_append_agent_step",
      description: "Append a structured agent decision, action, observation, or assertion event to a run.",
      inputSchema: AppendAgentStepInputSchema,
      execute: async (input) => service.appendAgentStep(input),
    },
    {
      name: "session_recording_get_timeline",
      description: "Read the normalized timeline for a run bundle.",
      inputSchema: TimelineInputSchema,
      readOnly: true,
      execute: async (input) => service.timeline(input),
    },
    {
      name: "session_recording_query_timeline",
      description: "Page and search a run timeline with compact event summaries and optional payloads/frames.",
      inputSchema: TimelineQueryInputSchema,
      readOnly: true,
      execute: async (input) => service.queryTimeline(input),
    },
    {
      name: "session_recording_result",
      description: "Return a bounded run result with artifact verification and optional timeline details.",
      inputSchema: RecordingResultInputSchema,
      readOnly: true,
      execute: async (input) => service.recordingResult(input),
    },
    {
      name: "session_recording_get_artifact",
      description: "Return artifact metadata and small text artifact content.",
      inputSchema: ArtifactInputSchema,
      readOnly: true,
      execute: async (input) => service.artifact(input),
    },
    {
      name: "session_recording_read_artifact",
      description: "Read an artifact as metadata, bounded text, or bounded base64 content.",
      inputSchema: ArtifactReadInputSchema,
      readOnly: true,
      execute: async (input) => service.readArtifact(input),
    },
  ] satisfies ToolDefinition[]);
}

export function mcpOk(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: toStructuredContent(value),
  };
}

export function mcpError(error: unknown): CallToolResult {
  const value = error instanceof SporesServiceError
    ? {
        error: error.code,
        message: error.message,
        retriable: error.retriable,
        requiresUserAction: error.requiresUserAction,
        details: error.details,
      }
    : error instanceof z.ZodError
    ? {
        error: "invalid_input",
        message: z.prettifyError(error),
        retriable: false,
        requiresUserAction: false,
        details: { issues: error.issues },
      }
    : error instanceof Error
    ? { error: "internal_error", message: error.message, retriable: false, requiresUserAction: false }
    : { error: "internal_error", message: String(error), retriable: false, requiresUserAction: false };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function toStructuredContent(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return { value };
}

function withDefaultOutputSchemas(definitions: ToolDefinition[]): ToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    outputSchema: definition.outputSchema ?? LooseOutputSchema,
  }));
}
