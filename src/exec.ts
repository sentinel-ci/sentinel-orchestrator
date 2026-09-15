import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command, capturing stdout/stderr fully rather than streaming, so callers can parse JSON output. */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command} ${args.join(" ")}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Tail of a string, used to keep raw command output in reports bounded. */
export function tail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `...[truncated]...\n${text.slice(-maxChars)}`;
}
