import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  PermissionBrokerStatus,
  PermissionBrokerStatusSchema,
  PermissionRequestResult,
  PermissionRequestResultSchema,
  RecorderHelperStatus,
  RecorderHelperSession,
  RecorderHelperSessionSchema,
  RecorderHelperStatusSchema,
  RecorderHelperTargets,
  RecorderHelperTargetsSchema,
} from "@spores/schema";

export type RecorderHelperConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type RecorderHelperSessionInput = {
  runId: string;
  sessionId: string;
  target: unknown;
  paths: {
    runDir: string;
    manifest: string;
    events: string;
    frames: string;
    artifactsDir: string;
  };
  purpose?: string;
  capture?: {
    mode?: "synthetic" | "native";
    maxDurationSeconds?: number;
  };
  eventCount: number;
  frameCount: number;
};

const HelperResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retriable: z.boolean(),
      requiresUserAction: z.boolean(),
    }),
  }),
]);

export class RecorderHelperClient {
  readonly config: RecorderHelperConfig;

  constructor(config: Partial<RecorderHelperConfig> = {}, env: NodeJS.ProcessEnv = process.env) {
    this.config = {
      command: config.command ?? env.SPORES_RECORDER_HELPER_COMMAND ?? env.SPORES_RECORDER_HELPER_CMD ?? "bun",
      args: config.args ?? parseArgList(env.SPORES_RECORDER_HELPER_ARGS) ?? [
        "run",
        "--silent",
        "recorder-helper",
        "--",
        "--stdio",
      ],
      cwd: config.cwd ?? process.cwd(),
      env: config.env ?? env,
      timeoutMs: config.timeoutMs ?? Number(env.SPORES_RECORDER_HELPER_TIMEOUT_MS ?? 45_000),
    };
  }

  async status(): Promise<RecorderHelperStatus> {
    try {
      return this.normalizeStatus(RecorderHelperStatusSchema.parse(await this.request("doctor")));
    } catch (error) {
      return this.unavailableStatus(error);
    }
  }

  async listTargets(): Promise<RecorderHelperTargets> {
    try {
      const response = RecorderHelperTargetsSchema.parse(await this.request("list_targets"));
      return RecorderHelperTargetsSchema.parse({
        ...response,
        status: this.normalizeStatus(response.status),
      });
    } catch (error) {
      return RecorderHelperTargetsSchema.parse({
        status: this.unavailableStatus(error),
        targets: [],
      });
    }
  }

  async permissionsStatus(): Promise<PermissionBrokerStatus> {
    try {
      return PermissionBrokerStatusSchema.parse(await this.request("permissions_status"));
    } catch (error) {
      return this.unavailablePermissionStatus(error);
    }
  }

  async requestPermissions(): Promise<PermissionRequestResult> {
    try {
      return PermissionRequestResultSchema.parse(await this.request("permissions_request"));
    } catch (error) {
      const status = this.unavailablePermissionStatus(error);
      return PermissionRequestResultSchema.parse({
        status,
        opened: false,
        message: "Recorder helper is unavailable; permissions cannot be requested until the helper launches.",
        actions: [],
      });
    }
  }

  async startSession(input: RecorderHelperSessionInput): Promise<RecorderHelperSession> {
    return RecorderHelperSessionSchema.parse(await this.request("start_session", input));
  }

  async getSessionStatus(input: RecorderHelperSessionInput): Promise<RecorderHelperSession> {
    return RecorderHelperSessionSchema.parse(await this.request("get_status", input));
  }

  async stopSession(input: RecorderHelperSessionInput): Promise<RecorderHelperSession> {
    return RecorderHelperSessionSchema.parse(await this.request("stop_session", input));
  }

  private normalizeStatus(status: RecorderHelperStatus): RecorderHelperStatus {
    return RecorderHelperStatusSchema.parse({
      ...status,
      command: this.config.command,
      args: this.config.args,
    });
  }

  private unavailableStatus(error: unknown): RecorderHelperStatus {
    return RecorderHelperStatusSchema.parse({
      configured: true,
      available: false,
      mode: "stdio",
      command: this.config.command,
      args: this.config.args,
      error: {
        code: "helper_unavailable",
        message: error instanceof Error ? error.message : String(error),
        retriable: true,
        requiresUserAction: false,
      },
    });
  }

  private unavailablePermissionStatus(error: unknown): PermissionBrokerStatus {
    const message = error instanceof Error ? error.message : String(error);
    const requiredReason = `Recorder helper is unavailable: ${message}`;
    return PermissionBrokerStatusSchema.parse({
      platform: process.platform,
      mode: "deterministic",
      snapshot: {
        platform: process.platform,
        screenRecording: "degraded",
        accessibility: "degraded",
        inputMonitoring: "not_requested",
        microphone: "not_requested",
        systemAudio: "not_requested",
        requiresUserAction: true,
      },
      capabilities: [
        {
          permission: "screenRecording",
          label: "Screen Recording",
          status: "degraded",
          required: true,
          canRequest: false,
          reason: requiredReason,
        },
        {
          permission: "accessibility",
          label: "Accessibility",
          status: "degraded",
          required: true,
          canRequest: false,
          reason: requiredReason,
        },
        {
          permission: "inputMonitoring",
          label: "Input Monitoring",
          status: "not_requested",
          required: false,
          canRequest: false,
          reason: "Optional richer keyboard metadata for future native capture.",
        },
        {
          permission: "microphone",
          label: "Microphone",
          status: "not_requested",
          required: false,
          canRequest: false,
          reason: "Optional narration capture; not used by the current helper-backed lifecycle.",
        },
        {
          permission: "systemAudio",
          label: "System Audio",
          status: "not_requested",
          required: false,
          canRequest: false,
          reason: "Optional future system-audio capture.",
        },
      ],
      requiresUserAction: true,
      error: {
        code: "helper_unavailable",
        message,
        retriable: true,
        requiresUserAction: false,
      },
    });
  }

  private async request(
    method:
      | "doctor"
      | "list_targets"
      | "permissions_status"
      | "permissions_request"
      | "start_session"
      | "get_status"
      | "stop_session",
    params?: unknown,
  ): Promise<unknown> {
    const id = `helper_${randomUUID().replaceAll("-", "")}`;
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env,
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const close = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`recorder helper timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`recorder helper exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
    });

    child.stdin.end(`${JSON.stringify({ id, method, params })}\n`);
    await close;

    const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
    if (!firstLine) {
      throw new Error("recorder helper produced no response");
    }

    const response = HelperResponseSchema.parse(JSON.parse(firstLine));
    if (response.id !== id) {
      throw new Error(`recorder helper response id mismatch: expected ${id}, got ${response.id}`);
    }
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.result;
  }
}

export function createRecorderHelperClient(env: NodeJS.ProcessEnv = process.env) {
  return new RecorderHelperClient({}, env);
}

function parseArgList(value: string | undefined): string[] | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return z.array(z.string()).parse(JSON.parse(trimmed));
  }
  return trimmed.split(/\s+/);
}
