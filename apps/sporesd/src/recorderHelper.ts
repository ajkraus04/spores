import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

type HelperMethod =
  | "doctor"
  | "list_targets"
  | "permissions_status"
  | "permissions_probe"
  | "permissions_request"
  | "start_session"
  | "get_status"
  | "stop_session"
  | "shutdown";

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
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export class RecorderHelperClient {
  readonly config: RecorderHelperConfig;
  private readonly sessionHelpers = new Map<string, RecorderHelperProcess>();

  constructor(config: Partial<RecorderHelperConfig> = {}, env: NodeJS.ProcessEnv = process.env) {
    const defaultLaunch = resolveDefaultHelperLaunch();
    this.config = {
      command: config.command ?? env.SPORES_RECORDER_HELPER_COMMAND ?? env.SPORES_RECORDER_HELPER_CMD ?? defaultLaunch.command,
      args: config.args ?? parseArgList(env.SPORES_RECORDER_HELPER_ARGS) ?? defaultLaunch.args,
      cwd: config.cwd ?? env.SPORES_RECORDER_HELPER_CWD ?? defaultLaunch.cwd,
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

  async permissionsProbe(): Promise<PermissionBrokerStatus> {
    try {
      return PermissionBrokerStatusSchema.parse(await this.request("permissions_probe"));
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
    const helper = this.createProcess();
    this.sessionHelpers.set(input.runId, helper);
    try {
      return RecorderHelperSessionSchema.parse(await helper.request("start_session", input));
    } catch (error) {
      this.sessionHelpers.delete(input.runId);
      await helper.close();
      throw error;
    }
  }

  async getSessionStatus(input: RecorderHelperSessionInput): Promise<RecorderHelperSession> {
    const helper = this.sessionHelpers.get(input.runId);
    return RecorderHelperSessionSchema.parse(
      await (helper ? helper.request("get_status", input) : this.request("get_status", input)),
    );
  }

  async stopSession(input: RecorderHelperSessionInput): Promise<RecorderHelperSession> {
    const helper = this.sessionHelpers.get(input.runId);
    if (!helper) {
      return RecorderHelperSessionSchema.parse(await this.request("stop_session", input));
    }

    try {
      return RecorderHelperSessionSchema.parse(await helper.request("stop_session", input));
    } finally {
      this.sessionHelpers.delete(input.runId);
      await helper.close();
    }
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
        details: this.helperErrorDetails(),
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
        details: this.helperErrorDetails(),
      },
    });
  }

  private helperErrorDetails(): Record<string, unknown> {
    return {
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd,
      timeoutMs: this.config.timeoutMs,
      executablePresent: executablePresent(this.config.command, this.config.env),
      cwdPackageJsonPresent: existsSync(path.join(this.config.cwd, "package.json")),
      suggestedCommands: this.suggestedCommands(),
    };
  }

  private suggestedCommands(): string[] {
    if (this.config.command === process.execPath && this.config.args.some((arg) => arg.endsWith("spores-recorder-helper.js"))) {
      return [
        `${this.config.command} ${this.config.args.join(" ")}`,
        "npx spores setup --json",
        "bunx spores setup --json",
      ];
    }
    return [
      `cd ${this.config.cwd}`,
      "bun install",
      "bun run --silent recorder-helper -- --stdio",
      "bun run --silent mcp:doctor -- --json",
    ];
  }

  private createProcess(): RecorderHelperProcess {
    return new RecorderHelperProcess(this.config);
  }

  private async request(method: Exclude<HelperMethod, "shutdown">, params?: unknown): Promise<unknown> {
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
      throw new Error(`recorder helper response id mismatch: expected ${id}, got ${response.id}${stderr ? `; stderr: ${stderr.trim()}` : ""}`);
    }
    if (!response.ok) {
      throw helperResponseError(response.error);
    }
    return response.result;
  }
}

class RecorderHelperProcess {
  private readonly child;
  private stdout = "";
  private stderr = "";
  private closed = false;
  private closeCode: number | null | undefined;
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(private readonly config: RecorderHelperConfig) {
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdout += chunk;
      this.drainResponses();
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => {
      this.rejectPending(error);
    });
    this.child.on("close", (code) => {
      this.closed = true;
      this.closeCode = code;
      if (this.pending.size > 0) {
        this.rejectPending(new Error(`recorder helper exited with code ${code ?? "unknown"}${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
      }
    });
  }

  request(method: HelperMethod, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`recorder helper is already closed with code ${this.closeCode ?? "unknown"}`));
    }

    const id = `helper_${randomUUID().replaceAll("-", "")}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`recorder helper timed out after ${this.config.timeoutMs}ms waiting for ${method}`));
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(payload, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.request("shutdown").catch(() => undefined);
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1_000);
      this.child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private drainResponses(): void {
    let newlineIndex = this.stdout.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdout.slice(0, newlineIndex).trim();
      this.stdout = this.stdout.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleResponseLine(line);
      }
      newlineIndex = this.stdout.indexOf("\n");
    }
  }

  private handleResponseLine(line: string): void {
    let response: z.infer<typeof HelperResponseSchema>;
    try {
      response = HelperResponseSchema.parse(JSON.parse(line));
    } catch (error) {
      this.rejectPending(new Error(`recorder helper returned malformed response: ${line}; ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      this.rejectPending(new Error(`recorder helper response id mismatch: no pending request for ${response.id}`));
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(helperResponseError(response.error));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function helperResponseError(error: {
  code: string;
  message: string;
  retriable: boolean;
  requiresUserAction: boolean;
  details?: Record<string, unknown>;
}): Error {
  return new Error(`recorder helper ${error.code}: ${error.message}`);
}

export function createRecorderHelperClient(env: NodeJS.ProcessEnv = process.env) {
  return new RecorderHelperClient({}, env);
}

function resolveDefaultHelperLaunch(): Pick<RecorderHelperConfig, "command" | "args" | "cwd"> {
  const packagedHelper = findPackagedHelperEntrypoint();
  if (packagedHelper) {
    return {
      command: process.execPath,
      args: [packagedHelper, "--stdio"],
      cwd: path.dirname(packagedHelper),
    };
  }

  return {
    command: "bun",
    args: ["run", "--silent", "recorder-helper", "--", "--stdio"],
    cwd: findDefaultHelperCwd() ?? process.cwd(),
  };
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

function findDefaultHelperCwd(): string | undefined {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath) && packageHasRecorderHelperScript(packageJsonPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function findPackagedHelperEntrypoint(): string | undefined {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidates = [
    path.join(currentDir, "spores-recorder-helper.js"),
  ];

  for (const candidate of candidates) {
    if (candidate !== currentFile && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function packageHasRecorderHelperScript(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
      workspaces?: unknown;
    };
    return typeof parsed.scripts?.["recorder-helper"] === "string";
  } catch {
    return false;
  }
}

function executablePresent(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes(path.sep) || (process.platform === "win32" && command.includes("\\"))) {
    return existsSync(command);
  }
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const pathExts = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of pathExts) {
      if (existsSync(path.join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}
