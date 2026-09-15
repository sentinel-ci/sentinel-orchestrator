import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "reports",
  ".stryker-tmp",
  "sentinel-runs",
]);

/** Recursively lists source file paths (relative to targetDir), skipping tooling/output dirs. */
export async function listSourceFiles(targetDir: string, maxFiles = 200): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (!/\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) continue;
        results.push(relative(targetDir, join(dir, entry.name)));
      }
    }
  }

  await walk(targetDir);
  return results;
}

export async function readFileSafe(path: string, maxChars = 4000): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n...[truncated]...`;
  } catch {
    return null;
  }
}

export function isTestFile(relativePath: string, testDirs: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (testDirs.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) return true;
  return /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(normalized);
}
