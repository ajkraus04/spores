#!/usr/bin/env node
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createSporesService } from "./service.js";

type CliIo = {
  stdout: Writable;
  stderr: Writable;
};

type ParsedArgs = {
  command: string;
  json: boolean;
  runId?: string;
};

const VERSION = "0.1.0";

const HELP = `Spores CLI

Usage:
  spores doctor [--json]
  spores status [--json] [--run-id <run-id>]
  spores targets [--json]
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
      case "doctor":
        writeValue(io.stdout, parsed.json, await service.doctor(), formatDoctor);
        return 0;
      case "status":
        writeValue(io.stdout, parsed.json, await service.status({ runId: parsed.runId }), formatStatus);
        return 0;
      case "targets":
        writeValue(io.stdout, parsed.json, await service.listTargets(), formatTargets);
        return 0;
      case "mcp":
        await import("./index.js");
        return 0;
      default:
        throw new Error(`unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const json = argv.includes("--json");
    const value = {
      error: "cli_error",
      message: error instanceof Error ? error.message : String(error),
      retriable: false,
      requiresUserAction: false,
    };
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

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--run-id") {
      const value = rest[index + 1];
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
      return `${target.targetId}\t${target.kind}\t${label}`;
    }),
  ];
  if (value.status.error) {
    lines.push(`helper_error: ${value.status.error.message}`);
  }
  lines.push("");
  return lines.join("\n");
}

function write(stream: Writable, value: string): void {
  stream.write(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
