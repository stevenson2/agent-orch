import type { Spawner } from "../spawn.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { toRunResult } from "./output.js";

export interface DshAdapterOptions {
  vendor: string;
  harness?: string;
  command: string;
  commandArgs?: string[];
  spawner: Spawner;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Native DeepSeek harness one-shot.
 * `dsh --profile headless --json <task>` with the child cwd set to the worktree.
 * Upstream has no --cwd flag; the process working directory is the workspace.
 */
export class DshAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;

  constructor(private readonly options: DshAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness ?? "dsh";
    this.id = `${this.vendor}:dsh`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const args = [
      ...(this.options.commandArgs ?? []),
      "--profile",
      "headless",
      "--json",
      request.task,
    ];
    const spawned = await this.options.spawner({
      command: this.options.command,
      args,
      cwd: request.cwd,
      env: this.options.env,
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs,
    });
    return toRunResult(spawned);
  }
}
