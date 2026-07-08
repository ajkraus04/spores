#!/usr/bin/env bun
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "packages", "npm", "dist");

const entries = [
  ["spores.js", "apps/sporesd/src/cli.ts"],
  ["sporesd.js", "apps/sporesd/src/index.ts"],
  ["spores-recorder-helper.js", "apps/recorder-helper/src/index.ts"],
];
const compositorSource = path.join(rootDir, "apps", "video-compositor-macos", "Sources", "main.swift");
const compositorOutput = path.join(outputDir, "spores-video-compositor-macos");

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });

for (const [fileName, entrypoint] of entries) {
  const outputPath = path.join(outputDir, fileName);
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      path.join(rootDir, entrypoint),
      "--outfile",
      outputPath,
      "--target=node",
      "--format=esm",
      "--sourcemap=none",
    ],
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    process.stdout.write(proc.stdout.toString());
    process.stderr.write(proc.stderr.toString());
    process.exit(proc.exitCode);
  }

  await chmod(outputPath, 0o755);
}

if (process.platform === "darwin") {
  const arm64Output = path.join(outputDir, "spores-video-compositor-macos-arm64");
  const x64Output = path.join(outputDir, "spores-video-compositor-macos-x64");
  runOrExit([
    "xcrun",
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    "arm64-apple-macos13.0",
    compositorSource,
    "-o",
    arm64Output,
  ]);
  runOrExit([
    "xcrun",
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    "x86_64-apple-macos13.0",
    compositorSource,
    "-o",
    x64Output,
  ]);
  runOrExit(["lipo", "-create", "-output", compositorOutput, arm64Output, x64Output]);
  await rm(arm64Output, { force: true });
  await rm(x64Output, { force: true });
  await chmod(compositorOutput, 0o755);
}

function runOrExit(cmd) {
  const proc = Bun.spawnSync({
    cmd,
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    process.stdout.write(proc.stdout.toString());
    process.stderr.write(proc.stderr.toString());
    process.exit(proc.exitCode);
  }
}
