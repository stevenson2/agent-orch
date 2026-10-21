import type { AgentMode } from "../types.js";
import type { Spawner } from "../spawn.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { toRunResult } from "./output.js";

export interface CommandAdapterOptions {
  vendor: string;
  harness: string;
  command: string;
  commandArgs?: string[];
  args: string[];
  modeArgs?: Partial<Record<AgentMode, string[]>>;
  spawner: Spawner;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Generic argv adapter for harnesses that already have a headless print/exec
 * mode (`claude -p`, `codex exec`, `gemini -p`, `opencode run`, ...).
 * `{prompt}`, `{cwd}`, and `{mode}` are replaced as single argv elements.
 * The prompt is never passed through a shell.
 */
export class CommandAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;

  constructor(private readonly options: CommandAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness;
    this.id = `${options.vendor}:command:${options.harness}`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const replace = (token: string): string[] => {
      if (token === "{prompt}") return [request.task];
      if (token === "{cwd}") return [request.cwd];
      if (token === "{mode}") return [request.mode];
      return [token];
    };
    let sawPrompt = false;
    const expanded: string[] = [];
    for (const token of this.options.args) {
      if (token === "{prompt}") sawPrompt = true;
      expanded.push(...replace(token));
    }
    const args = [
      ...(this.options.commandArgs ?? []),
      ...expanded,
      ...(this.options.modeArgs?.[request.mode] ?? []),
    ];
    if (!sawPrompt) args.push(request.task);
    const spawned = await this.options.spawner({
      command: this.options.command,
      args,
      cwd: request.cwd,
      env: this.options.env,
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs,
      // `codex exec` waits forever if stdin stays open ("Reading additional input from stdin...").
      stdin: "ignore",
    });
    return toRunResult(spawned);
  }
}
