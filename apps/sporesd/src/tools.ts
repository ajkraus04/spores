import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AppendEventInputSchema,
  ArtifactInputSchema,
  HelperTargetsInputSchema,
  PermissionsRequestInputSchema,
  PermissionsStatusInputSchema,
  SporesServiceError,
  SporesService,
  StartRecordingInputSchema,
  StatusInputSchema,
  StopInputSchema,
  TimelineInputSchema,
} from "./service.js";

type JsonObject = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: never): Promise<unknown>;
  readOnly?: boolean;
};

export function createToolDefinitions(service: SporesService) {
  return [
    {
      name: "spores_doctor",
      description: "Return local Spores health, recorder backend status, and recorder-helper status.",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => service.doctor(),
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
      name: "recorder_permissions_status",
      description: "Return required and optional local recording permission state.",
      inputSchema: PermissionsStatusInputSchema,
      readOnly: true,
      execute: async (input) => service.permissionsStatus(input),
    },
    {
      name: "recorder_permissions_request",
      description: "Return user-action instructions for granting missing recording permissions.",
      inputSchema: PermissionsRequestInputSchema,
      execute: async (input) => service.requestPermissions(input),
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
      name: "session_recording_get_timeline",
      description: "Read the normalized timeline for a run bundle.",
      inputSchema: TimelineInputSchema,
      readOnly: true,
      execute: async (input) => service.timeline(input),
    },
    {
      name: "session_recording_get_artifact",
      description: "Return artifact metadata and small text artifact content.",
      inputSchema: ArtifactInputSchema,
      readOnly: true,
      execute: async (input) => service.artifact(input),
    },
  ] satisfies ToolDefinition[];
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
