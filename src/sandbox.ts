import { runCommand } from "./exec.js";
import type { ValidationReport } from "./types.js";

export interface SandboxBuildOptions {
  dockerfile: string;
  /** Named BuildKit build contexts, e.g. { target: "/path/to/app", sentinel: "/path/to/orchestrator/sandbox" }. */
  contexts: Record<string, string>;
  tag: string;
}

const REPORT_MARKER = "SENTINEL_REPORT_JSON:";

/** Builds the sandbox image. Requires BuildKit (default on Docker 23+) for named `--build-context` support. */
export async function buildSandboxImage(options: SandboxBuildOptions): Promise<void> {
  const args = ["build", "-f", options.dockerfile, "-t", options.tag];
  for (const [name, path] of Object.entries(options.contexts)) {
    args.push("--build-context", `${name}=${path}`);
  }
  // BuildKit needs *some* build context even though every input comes from
  // named contexts; the dockerfile's own directory is an inert choice.
  args.push(options.dockerfile.replace(/\/[^/]+$/, ""));

  const result = await runCommand("docker", args, {
    cwd: process.cwd(),
    env: { ...process.env, DOCKER_BUILDKIT: "1" },
    timeoutMs: 10 * 60 * 1000,
  });

  if (result.code !== 0) {
    throw new Error(`docker build failed (exit ${result.code}):\n${result.stderr}\n${result.stdout}`);
  }
}

/** Runs one validation pass inside the network-isolated sandbox and returns the parsed report. */
export async function runValidationInSandbox(
  tag: string,
  iteration: number,
  extraEnv: Record<string, string> = {},
  onLine?: (line: string) => void,
): Promise<ValidationReport> {
  const envArgs: string[] = ["-e", `SENTINEL_ITERATION=${iteration}`];
  for (const [key, value] of Object.entries(extraEnv)) {
    envArgs.push("-e", `${key}=${value}`);
  }

  // The container has no network of its own (--network=none) — it can only
  // signal progress by writing marker lines to stdout. Buffer partial lines
  // across chunks so onLine always sees whole lines.
  let pending = "";
  const onStdout = onLine
    ? (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
    : undefined;

  const result = await runCommand(
    "docker",
    // --init runs a minimal PID-1 init process so orphaned children (mongod
    // instances StrykerJS's test runner spins up per mutant, in particular)
    // get reaped instead of accumulating as zombies for the container's life.
    ["run", "--rm", "--init", "--memory=512m", "--cpus=1", "--network=none", ...envArgs, tag],
    { cwd: process.cwd(), timeoutMs: 15 * 60 * 1000, onStdout },
  );
  if (onLine && pending) onLine(pending);

  const line = result.stdout.split("\n").find((l) => l.startsWith(REPORT_MARKER));
  if (!line) {
    throw new Error(
      `Sandbox run did not produce a report (exit ${result.code}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return JSON.parse(line.slice(REPORT_MARKER.length)) as ValidationReport;
}
