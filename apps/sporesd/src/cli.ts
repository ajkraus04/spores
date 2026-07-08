#!/usr/bin/env node
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createSporesService, SporesServiceError } from "./service.js";

type CliIo = {
  stdout: Writable;
  stderr: Writable;
};

type ParsedArgs = {
  command: string;
  subcommand?: string;
  json: boolean;
  runId?: string;
};

const VERSION = "0.1.0";

const HELP = `Spores CLI

Usage:
  spores setup doctor [--json]
  spores doctor [--json]
  spores status [--json] [--run-id <run-id>]
  spores targets [--json]
  spores permissions status [--json]
  spores permissions probe [--json]
  spores permissions request [--json]
  spores mcp
  spores help

Environment:
  SPORES_RUNS_ROOT  Override the local run bundle directory.
`;

export async function runCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const rootDir = env.SPORES_RUNS_ROOT;
    const service = createSporesService({ rootDir });

    switch (parsed.command) {
      case "":
      case "help":
      case "--help":
      case "-h":
        write(io.stdout, HELP);
        return 0;
      case "--version":
      case "version":
        write(io.stdout, `${VERSION}\n`);
        return 0;
      case "setup":
        switch (parsed.subcommand ?? "doctor") {
          case "doctor":
            writeValue(io.stdout, parsed.json, await service.ready(), formatSetupDoctor);
            return 0;
          default:
            throw new Error(`unknown setup command: ${parsed.subcommand}`);
        }
      case "doctor":
        writeValue(io.stdout, parsed.json, await service.doctor(), formatDoctor);
        return 0;
      case "status":
        writeValue(io.stdout, parsed.json, await service.status({ runId: parsed.runId }), formatStatus);
        return 0;
      case "targets":
        writeValue(io.stdout, parsed.json, await service.listTargets(), formatTargets);
        return 0;
      case "permissions":
        switch (parsed.subcommand ?? "status") {
          case "status":
            writeValue(io.stdout, parsed.json, await service.permissionsStatus(), formatPermissionsStatus);
            return 0;
          case "probe":
            writeValue(io.stdout, parsed.json, await service.permissionsProbe(), formatPermissionsStatus);
            return 0;
          case "request":
            writeValue(io.stdout, parsed.json, await service.requestPermissions(), formatPermissionsRequest);
            return 0;
          default:
            throw new Error(`unknown permissions command: ${parsed.subcommand}`);
        }
      case "mcp":
        await import("./index.js");
        return 0;
      default:
        throw new Error(`unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const json = argv.includes("--json");
    const value = formatError(error);
    write(json ? io.stdout : io.stderr, json ? `${JSON.stringify(value, null, 2)}\n` : `${value.message}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const parsed: ParsedArgs = {
    command,
    json: false,
  };
  const args = [...rest];

  if ((command === "permissions" || command === "setup") && args[0] && !args[0].startsWith("-")) {
    parsed.subcommand = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--run-id") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--run-id requires a value");
      }
      parsed.runId = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--run-id=")) {
      parsed.runId = arg.slice("--run-id=".length);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return parsed;
}

function writeValue<T>(stream: Writable, json: boolean, value: T, format: (value: T) => string): void {
  write(stream, json ? `${JSON.stringify(value, null, 2)}\n` : format(value));
}

function formatSetupDoctor(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["ready"]>>): string {
  const missing = value.missingRequiredPermissions.map((capability) => capability.permission);
  return [
    "Spores setup doctor",
    `ready: ${value.ready}`,
    `readiness_level: ${value.readinessLevel}`,
    `native_recording_ready: ${value.nativeRecordingReady}`,
    `backend: ${value.backend}`,
    `helper_available: ${value.helper.available}`,
    `permissions_mode: ${value.permissions.mode}`,
    `requires_user_action: ${value.permissions.requiresUserAction}`,
    `target_count: ${value.targetCount}`,
    `reason_codes: ${value.reasonCodes.length > 0 ? value.reasonCodes.join(",") : "-"}`,
    `missing_required_permissions: ${missing.length > 0 ? missing.join(",") : "-"}`,
    `recommended_tools: ${value.recommendedTools.join(",")}`,
    "",
  ].join("\n");
}

function formatDoctor(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["doctor"]>>): string {
  return [
    "Spores doctor",
    `ok: ${value.ok}`,
    `recorder: ${value.recorder}`,
    `native_capture: ${value.nativeCapture}`,
    `runs_root: ${value.rootDir}`,
    `helper_available: ${value.helper.available}`,
    `helper_command: ${value.helper.command} ${value.helper.args.join(" ")}`,
    `helper_targets: ${value.helper.targetCount ?? 0}`,
    value.helper.error ? `helper_error: ${value.helper.error.message}` : undefined,
    "",
  ].filter((line) => line !== undefined).join("\n");
}

function formatStatus(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["status"]>>): string {
  if (value.status === "idle") {
    return "status: idle\n";
  }
  return [
    `status: ${value.status}`,
    `run_id: ${value.runId}`,
    `session_id: ${value.sessionId}`,
    `run_dir: ${value.paths.runDir}`,
    `events_path: ${value.paths.events}`,
    `frames_path: ${value.paths.frames}`,
    `event_count: ${value.eventCount}`,
    `frame_count: ${value.frameCount}`,
    "",
  ].join("\n");
}

function formatTargets(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["listTargets"]>>): string {
  const lines = [
    `helper_available: ${value.status.available}`,
    `target_count: ${value.targets.length}`,
    ...value.targets.map((target) => {
      const label = target.window?.title ?? target.app?.name ?? target.displayId ?? target.targetId;
      const bounds = target.bounds ?? target.window?.bounds;
      const rect = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "-";
      return `${target.targetId}\t${target.kind}\t${label}\t${rect}`;
    }),
  ];
  if (value.status.error) {
    lines.push(`helper_error: ${value.status.error.message}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatPermissionsStatus(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["permissionsStatus"]>>): string {
  const lines = [
    "Spores permissions",
    `platform: ${value.platform}`,
    `requires_user_action: ${value.requiresUserAction}`,
    ...value.capabilities.map((capability) => (
      `${capability.permission}: ${capability.status}${capability.required ? " (required)" : ""}`
    )),
    "",
  ];
  return lines.join("\n");
}

function formatPermissionsRequest(value: Awaited<ReturnType<ReturnType<typeof createSporesService>["requestPermissions"]>>): string {
  const lines = [
    "Spores permission request",
    `opened: ${value.opened}`,
    value.message,
    ...value.actions.map((action) => `${action.permission}: ${action.settingsUrl ?? "manual action required"}`),
    "",
  ];
  return lines.join("\n");
}

function formatError(error: unknown) {
  if (error instanceof SporesServiceError) {
    return {
      error: error.code,
      message: error.message,
      retriable: error.retriable,
      requiresUserAction: error.requiresUserAction,
      details: error.details,
    };
  }
  return {
    error: "cli_error",
    message: error instanceof Error ? error.message : String(error),
    retriable: false,
    requiresUserAction: false,
  };
}

function write(stream: Writable, value: string): void {
  stream.write(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
