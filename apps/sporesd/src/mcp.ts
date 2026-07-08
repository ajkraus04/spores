import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createSporesService, SporesServiceOptions } from "./service.js";
import { createToolDefinitions, mcpError, mcpOk } from "./tools.js";

const McpErrorFieldsSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    }).passthrough(),
  ]).optional(),
  message: z.string().optional(),
  retriable: z.boolean().optional(),
  requiresUserAction: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const RECORDING_GUIDE = `# Spores Recording Guide

1. Call recorder_ready.
2. Call recorder_context_snapshot to inspect displays, apps, windows, and coordinates.
3. Call recorder_target_select with a target hint or explicit bounds.
4. Call recorder_target_validate immediately before recording.
5. Use session_recording_capture for known-duration recordings.
6. Use session_recording_begin and session_recording_stop when the end time is unknown.
7. Use session_recording_append_agent_step to record decisions, actions, observations, and assertions.
8. Use session_recording_result and session_recording_read_artifact for bounded review.
`;

export function createSporesMcpServer(options: SporesServiceOptions = {}) {
  const server = new McpServer({
    name: "sporesd",
    version: "0.1.0",
  });
  const service = createSporesService(options);

  for (const tool of createToolDefinitions(service)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: outputSchemaForMcp(tool.outputSchema),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly === true,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? tool.readOnly === true,
          openWorldHint: false,
        },
        _meta: {
          "spores/role": tool.role,
        },
      },
      async (input: unknown) => {
        try {
          const parsed = tool.inputSchema.parse(input);
          return mcpOk(await tool.execute(parsed as never));
        } catch (error) {
          return mcpError(error);
        }
      },
    );
  }

  server.registerResource(
    "spores_recording_guide",
    "spores://recording/guide",
    {
      title: "Spores Recording Guide",
      description: "Agent workflow for explicit Spores recording.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: RECORDING_GUIDE }],
    }),
  );

  server.registerResource(
    "spores_run_result",
    new ResourceTemplate("spores://runs/{runId}/result", {
      list: async () => ({
        resources: (await service.store.listManifests())
          .slice(0, 100)
          .map((run) => ({
            uri: `spores://runs/${encodeURIComponent(run.runId)}/result`,
            name: `run-result-${run.runId}`,
            title: `Spores run ${run.runId}`,
            description: `${run.status}; ${run.eventCount} events; ${run.artifacts.length} artifacts`,
            mimeType: "application/json",
          })),
      }),
      complete: {
        runId: async (value) => (await service.store.listRunIds())
          .filter((runId) => runId.startsWith(value))
          .slice(0, 50),
      },
    }),
    {
      title: "Spores Run Result",
      description: "Bounded JSON summary for a recorded run.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawRunId = Array.isArray(variables.runId) ? variables.runId[0] : variables.runId;
      const runId = decodeURIComponent(String(rawRunId));
      const result = await service.recordingResult({
        runId,
        includeTimeline: "summary",
        limit: 100,
        includePayloads: false,
        verifyArtifacts: true,
        includeSmallTextArtifacts: false,
      });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerPrompt(
    "spores_recording_workflow",
    {
      title: "Spores Recording Workflow",
      description: "Plan an explicit bounded desktop recording through Spores.",
      argsSchema: {
        objective: z.string().describe("What the agent needs to record."),
        targetHint: z.string().optional().describe("Optional app, window, display, or region hint."),
        durationMode: z.enum(["known", "unknown"]).optional().describe("Use known for capture; unknown for begin/stop."),
      },
    },
    async ({ objective, targetHint, durationMode }) => ({
      description: "Spores recording workflow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildRecordingPrompt(objective, targetHint, durationMode),
          },
        },
      ],
    }),
  );

  return server;
}

function outputSchemaForMcp(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return schema.partial().passthrough().extend(McpErrorFieldsSchema.shape);
  }
  return McpErrorFieldsSchema.passthrough();
}

function buildRecordingPrompt(
  objective: string,
  targetHint: string | undefined,
  durationMode: "known" | "unknown" | undefined,
): string {
  const target = targetHint ? ` Target hint: ${targetHint}.` : "";
  const timing = durationMode === "unknown"
    ? "Use session_recording_begin, perform the task, append agent steps, then call session_recording_stop."
    : "Use session_recording_capture for a bounded known-duration recording.";
  return [
    `Record this desktop task with Spores: ${objective}.${target}`,
    "Start with recorder_ready. If ready, call recorder_context_snapshot, then recorder_target_select, then recorder_target_validate.",
    timing,
    "After recording, call session_recording_result and use session_recording_read_artifact only for bounded metadata or content reads.",
  ].join("\n");
}
