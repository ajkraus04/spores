import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createSporesService, SporesServiceOptions } from "./service.js";
import { createToolDefinitions, mcpError, mcpOk } from "./tools.js";

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
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.readOnly ? { readOnlyHint: true, openWorldHint: false } : { openWorldHint: false },
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

  return server;
}
