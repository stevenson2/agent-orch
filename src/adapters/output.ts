import { detectRateLimit, type SpawnResult } from "../spawn.js";
import { parseAgentOutput } from "../parse.js";
import type { RunResult } from "./types.js";

const NETWORK_ERROR =
  /chatgpt\.com|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|certificate verify|tls handshake|stream disconnected|error sending request|fetch failed|connect(?:ion)? (?:refused|error|timed out)|socket hang up/i;

/**
 * Failure text for a non-zero CLI. Network lines are lifted out of the
 * surrounding log so a chatgpt.com refusal is visible without reading the
 * whole stderr stream.
 */
export function describeRunFailure(result: Pick<RunResult, "exitCode" | "stdout" | "stderr" | "result">): string {
  const lines = `${result.stderr}\n${result.stdout}\n${result.result}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const network = [...new Set(lines.filter((line) => NETWORK_ERROR.test(line)))];
  if (network.length > 0) {
    return `network error (exit ${result.exitCode}):\n${network.slice(0, 8).join("\n")}`;
  }
  return (result.stderr || result.result || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 4000);
}

export function toRunResult(spawned: SpawnResult): RunResult {
  const parsed = parseAgentOutput(spawned.stdout);
  return {
    result: parsed.result,
    diff: parsed.diff,
    usage: parsed.usage,
    exitCode: spawned.exitCode,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    rateLimited: detectRateLimit(spawned.exitCode, spawned.stdout, spawned.stderr),
    timedOut: spawned.timedOut,
    raw: parsed.raw,
  };
}
