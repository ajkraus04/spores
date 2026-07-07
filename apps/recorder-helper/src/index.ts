#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { RecorderHelperTargetsSchema, TargetRef, TargetRefSchema } from "@spores/schema";

const VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;

const HelperRequestSchema = z.object({
  id: z.string(),
  method: z.enum(["doctor", "list_targets", "shutdown"]),
});

type HelperRequest = z.infer<typeof HelperRequestSchema>;

export function createHelperStatus(targetCount: number) {
  return {
    configured: true,
    available: true,
    mode: "stdio" as const,
    command: "spores-recorder-helper",
    args: ["--stdio"],
    pid: process.pid,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    targetCount,
    capabilities: {
      listTargets: true,
      startSession: false,
      stopSession: false,
    },
  };
}

export function listTargets(): TargetRef[] {
  return [
    TargetRefSchema.parse({
      targetId: "display:main",
      kind: "display",
      displayId: "main",
      app: {
        name: "Desktop",
        bundleId: platformDesktopBundleId(),
      },
      window: {
        id: "desktop",
        title: "Main Display",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      },
      safeToPersist: true,
    }),
    TargetRefSchema.parse({
      targetId: "app:spores-recorder-helper",
      kind: "app",
      app: {
        name: "Spores Recorder Helper",
        bundleId: "dev.spores.recorder-helper",
        processId: process.pid,
      },
      safeToPersist: true,
    }),
    TargetRefSchema.parse({
      targetId: "window:spores-recorder-helper:status",
      kind: "window",
      displayId: "main",
      app: {
        name: "Spores Recorder Helper",
        bundleId: "dev.spores.recorder-helper",
        processId: process.pid,
      },
      window: {
        id: "spores-recorder-helper:status",
        title: "Spores Recorder Helper",
        bounds: { x: 80, y: 80, width: 1024, height: 640 },
      },
      safeToPersist: true,
    }),
  ];
}

export async function runStdio(): Promise<number> {
  const readline = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of readline) {
    if (line.trim().length === 0) {
      continue;
    }
    const response = await handleRequest(line);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (isShutdownResult(response.result)) {
      break;
    }
  }

  return 0;
}

async function handleRequest(line: string) {
  try {
    const request = HelperRequestSchema.parse(JSON.parse(line));
    return {
      id: request.id,
      ok: true as const,
      result: await handleParsedRequest(request),
    };
  } catch (error) {
    return {
      id: "unknown",
      ok: false as const,
      error: {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        retriable: false,
        requiresUserAction: false,
      },
    };
  }
}

async function handleParsedRequest(request: HelperRequest) {
  const targets = listTargets();
  switch (request.method) {
    case "doctor":
      return createHelperStatus(targets.length);
    case "list_targets":
      return RecorderHelperTargetsSchema.parse({
        status: createHelperStatus(targets.length),
        targets,
      });
    case "shutdown":
      return { shutdown: true };
  }
}

function isShutdownResult(value: unknown): value is { shutdown: true } {
  return Boolean(value && typeof value === "object" && "shutdown" in value && value.shutdown === true);
}

function platformDesktopBundleId(): string {
  switch (process.platform) {
    case "darwin":
      return "com.apple.WindowServer";
    case "win32":
      return "explorer.exe";
    default:
      return "desktop";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--stdio")) {
    process.exitCode = await runStdio();
  } else if (process.argv.includes("--list-targets")) {
    const targets = listTargets();
    process.stdout.write(`${JSON.stringify({ status: createHelperStatus(targets.length), targets }, null, 2)}\n`);
  } else {
    const targets = listTargets();
    process.stdout.write(`${JSON.stringify(createHelperStatus(targets.length), null, 2)}\n`);
  }
}
