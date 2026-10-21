import { detectRateLimit, type SpawnResult } from "../spawn.js";
import { parseAgentOutput } from "../parse.js";
import type { RunResult } from "./types.js";

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
