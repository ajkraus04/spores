#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })),
});

const REQUIRED_TOOLS = [
  "spores_doctor",
  "recorder_ready",
  "recorder_context_snapshot",
  "recorder_target_select",
  "recorder_target_validate",
  "recorder_permissions_status",
  "recorder_permissions_probe",
  "session_recording_capture",
  "session_recording_append_agent_step",
  "session_recording_query_timeline",
  "session_recording_result",
  "session_recording_read_artifact",
];

type DoctorArgs = {
  json: boolean;
  configPath: string;
  serverName: string;
};

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const configPath = path.resolve(args.configPath);
  const config = McpConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const serverConfig = config.mcpServers[args.serverName];
  if (!serverConfig) {
    throw new Error(`MCP server "${args.serverName}" was not found in ${configPath}`);
  }

  const cwd = path.resolve(path.dirname(configPath), serverConfig.cwd ?? ".");
  const client = new Client({ name: "spores-mcp-doctor", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    cwd,
    env: childEnv(serverConfig.env ?? {}),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    const missingTools = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    const doctor = expectStructured(await client.callTool({ name: "spores_doctor", arguments: {} }));
    const ready = expectStructured(await client.callTool({ name: "recorder_ready", arguments: {} }));
    const result = {
      ok: missingTools.length === 0,
      configPath,
      serverName: args.serverName,
      command: serverConfig.command,
      args: serverConfig.args,
      cwd,
      serverVersion: client.getServerVersion(),
      toolCount: tools.length,
      tools,
      missingTools,
      doctor,
      ready,
      stderr: stderr.trim() || undefined,
    };
    writeResult(args.json, result);
    return result.ok ? 0 : 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): DoctorArgs {
  const parsed: DoctorArgs = {
    json: false,
    configPath: ".mcp.json",
    serverName: "spores",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      parsed.configPath = value;
      index += 1;
      continue;
    }
    if (arg === "--server") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--server requires a name");
      }
      parsed.serverName = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

function expectStructured(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  if (result.isError) {
    throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  }
  if (!result.structuredContent) {
    throw new Error("MCP tool returned no structuredContent");
  }
  return result.structuredContent;
}

function writeResult(json: boolean, result: {
  ok: boolean;
  serverName: string;
  command: string;
  args: string[];
  cwd: string;
  toolCount: number;
  missingTools: string[];
}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `ok: ${result.ok}`,
    `server: ${result.serverName}`,
    `command: ${result.command} ${result.args.join(" ")}`,
    `cwd: ${result.cwd}`,
    `tool_count: ${result.toolCount}`,
    result.missingTools.length > 0 ? `missing_tools: ${result.missingTools.join(", ")}` : "missing_tools: none",
    "",
  ].join("\n"));
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return { ...inherited, FORCE_COLOR: "0", ...overrides };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
