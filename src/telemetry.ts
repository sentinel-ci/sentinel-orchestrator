import type { SentinelConfig } from "./config.js";

/**
 * Best-effort client for a sentinel-dashboard deployment. Every function here
 * swallows its own errors — the dashboard is an observability enhancement,
 * never a dependency the validation/repair pipeline can fail because of.
 * All calls are no-ops when `config.dashboardUrl` is unset.
 */

export type DashboardPhase = "build" | "tests" | "static_analysis" | "mutation" | "aggregate" | "repair";

export interface DashboardRun {
  runId: string;
  url: string;
}

function headers(config: SentinelConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (config.dashboardToken) h.Authorization = `Bearer ${config.dashboardToken}`;
  return h;
}

export async function createDashboardRun(
  config: SentinelConfig,
  input: { repo: string; prNumber: number; prTitle?: string; prUrl?: string },
): Promise<DashboardRun | null> {
  if (!config.dashboardUrl) return null;
  try {
    const response = await fetch(`${config.dashboardUrl}/api/runs`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        ...input,
        maxIterations: config.maxIterations,
        threshold: config.promotionThreshold,
      }),
    });
    if (!response.ok) {
      console.warn(`[telemetry] createDashboardRun failed: ${response.status}`);
      return null;
    }
    const body = (await response.json()) as { run: { id: string }; url: string };
    return { runId: body.run.id, url: body.url };
  } catch (err) {
    console.warn(`[telemetry] createDashboardRun failed: ${(err as Error).message}`);
    return null;
  }
}

export interface DashboardEventInput {
  type:
    | "run_started"
    | "phase_start"
    | "phase_end"
    | "log_line"
    | "iteration_complete"
    | "repair_start"
    | "repair_end"
    | "run_finished";
  iteration: number;
  phase?: DashboardPhase;
  message?: string;
  data?: unknown;
}

export async function postDashboardEvent(
  config: SentinelConfig,
  runId: string | undefined,
  input: DashboardEventInput,
): Promise<void> {
  if (!config.dashboardUrl || !runId) return;
  try {
    const response = await fetch(`${config.dashboardUrl}/api/runs/${runId}/events`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(input),
    });
    if (!response.ok) console.warn(`[telemetry] postDashboardEvent failed: ${response.status}`);
  } catch (err) {
    console.warn(`[telemetry] postDashboardEvent failed: ${(err as Error).message}`);
  }
}

export async function finishDashboardRun(
  config: SentinelConfig,
  runId: string | undefined,
  status: "passed" | "blocked" | "error",
): Promise<void> {
  if (!config.dashboardUrl || !runId) return;
  try {
    const response = await fetch(`${config.dashboardUrl}/api/runs/${runId}/finish`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) console.warn(`[telemetry] finishDashboardRun failed: ${response.status}`);
  } catch (err) {
    console.warn(`[telemetry] finishDashboardRun failed: ${(err as Error).message}`);
  }
}

const EVENT_MARKER = "SENTINEL_EVENT:";

/** Parses a `SENTINEL_EVENT:{...}` line (written by validate.ts inside the sandbox) back into structured data. */
export function parseEventLine(line: string): { phase: DashboardPhase; kind: "start" | "end"; data?: unknown } | null {
  if (!line.startsWith(EVENT_MARKER)) return null;
  try {
    return JSON.parse(line.slice(EVENT_MARKER.length)) as { phase: DashboardPhase; kind: "start" | "end"; data?: unknown };
  } catch {
    return null;
  }
}

/** Writes a `SENTINEL_EVENT:` marker line to stdout — called from inside the sandboxed validate.ts process, which has no network of its own; the host tails this container's stdout and relays it. */
export function emitEventLine(phase: DashboardPhase, kind: "start" | "end", data?: unknown): void {
  process.stdout.write(`${EVENT_MARKER}${JSON.stringify({ phase, kind, data })}\n`);
}
