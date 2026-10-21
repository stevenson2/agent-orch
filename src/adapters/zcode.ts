import type { AgentMode, ZCodeExecuteMode } from "../types.js";
import type { Spawner } from "../spawn.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { toRunResult } from "./output.js";

const ZCODE_MODE: Record<AgentMode, string> = {
  plan: "plan",
  execute: "edit",
  review: "plan",
};

export interface ZCodeAdapterOptions {
  vendor: string;
  harness?: string;
  command: string;
  commandArgs?: string[];
  spawner: Spawner;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputFormat?: "json" | "stream-json";
  executeMode?: ZCodeExecuteMode;
}

/**
 * Native ZCode headless prompt.
 * `zcode -p <task> --output-format json|stream-json --mode plan|edit|yolo|build --cwd <dir>`
 * Execute defaults to `edit` (auto-edit). `yolo` is opt-in. Review and plan stay read-only `plan`.
 */
export class ZCodeAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;

  constructor(private readonly options: ZCodeAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness ?? "zcode";
    this.id = `${this.vendor}:zcode`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const mode =
      request.mode === "execute"
        ? (this.options.executeMode ?? "edit")
        : ZCODE_MODE[request.mode];
    const args = [
      ...(this.options.commandArgs ?? []),
      "-p",
      request.task,
      "--output-format",
      this.options.outputFormat ?? "json",
      "--mode",
      mode,
      "--cwd",
      request.cwd,
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
