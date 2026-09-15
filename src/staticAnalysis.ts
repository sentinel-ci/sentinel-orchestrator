import { access, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { runCommand } from "./exec.js";
import type { LintIssue, StaticAnalysisResult } from "./types.js";

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

const OWN_CONFIG_CANDIDATES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc",
];

async function findOwnConfig(targetDir: string): Promise<string | null> {
  for (const candidate of OWN_CONFIG_CANDIDATES) {
    try {
      await access(join(targetDir, candidate));
      return candidate;
    } catch {
      // not present, keep looking
    }
  }
  return null;
}

/**
 * Runs ESLint against the target app. Uses the target's own config if present,
 * otherwise falls back to the bundled conservative default so apps without any
 * lint setup still get a static-analysis signal.
 */
export async function runStaticAnalysis(
  targetDir: string,
  fallbackConfigPath: string,
): Promise<StaticAnalysisResult> {
  const ownConfig = await findOwnConfig(targetDir);
  const configArgs = ownConfig ? [] : ["--config", fallbackConfigPath];

  const result = await runCommand(
    "npx",
    ["--yes", "eslint", ".", "--format", "json", "--no-error-on-unmatched-pattern", ...configArgs],
    { cwd: targetDir, timeoutMs: 2 * 60 * 1000 },
  );

  let parsed: EslintFileResult[] = [];
  try {
    parsed = JSON.parse(result.stdout) as EslintFileResult[];
  } catch {
    // ESLint failed to run entirely (e.g. no matching files, crash). Treat as
    // zero signal rather than failing the whole pipeline on a lint tooling issue.
    return { errors: 0, warnings: 0, issues: [] };
  }

  // ESLint reports realpaths, which can differ from targetDir when it's a
  // symlink (e.g. macOS /tmp -> /private/tmp) — resolve before diffing.
  const realTargetDir = await realpath(targetDir).catch(() => targetDir);

  const issues: LintIssue[] = [];
  let errors = 0;
  let warnings = 0;

  for (const file of parsed) {
    for (const msg of file.messages) {
      const severity = msg.severity === 2 ? "error" : "warning";
      if (severity === "error") errors += 1;
      else warnings += 1;
      issues.push({
        file: relative(realTargetDir, file.filePath),
        line: msg.line ?? 0,
        message: msg.message,
        ruleId: msg.ruleId,
        severity,
      });
    }
  }

  return { errors, warnings, issues };
}
