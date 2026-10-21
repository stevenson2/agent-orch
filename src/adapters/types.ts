import type { TokenUsage } from "../types.js";
import type { AgentMode } from "../types.js";

export interface RunRequest {
  task: string;
  cwd: string;
  mode: AgentMode;
  timeoutMs?: number;
}

export interface RunResult {
  result: string;
  diff: string;
  usage: TokenUsage;
  exitCode: number;
  stdout: string;
  stderr: string;
  rateLimited: boolean;
  timedOut: boolean;
  raw: unknown;
}

export interface Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;
  run(request: RunRequest): Promise<RunResult>;
}
