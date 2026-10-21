import type { Spawner } from "../spawn.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { toRunResult } from "./output.js";

export interface AcpxAdapterOptions {
  vendor: string;
  harness?: string;
  command: string;
  commandArgs?: string[];
  acpxAgent: string;
  spawner: Spawner;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * acpx one-shot. Plan and review stay on --approve-reads so the model can
 * inspect the tree without a GUI permission prompt. Execute uses --approve-all
 * because a headless run cannot click an approval dialog.
 */
export class AcpxAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;

  constructor(private readonly options: AcpxAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness ?? "acpx";
    this.id = `${this.vendor}:acpx:${options.acpxAgent}`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const permission = request.mode === "execute" ? "--approve-all" : "--approve-reads";
    const args = [
      ...(this.options.commandArgs ?? []),
      this.options.acpxAgent,
      "exec",
      "--format",
      "json",
      "--cwd",
      request.cwd,
      permission,
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
