import type { AgentMode } from "../types.js";
import { emptyUsage } from "../types.js";
import { detectRateLimit, type SpawnResult, type Spawner } from "../spawn.js";
import { extractJsonObject } from "../parse.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { toRunResult } from "./output.js";

export interface DshAdapterOptions {
  vendor: string;
  harness?: string;
  command: string;
  commandArgs?: string[];
  /**
   * Extra argv after commandArgs. When non-empty, replaces the default
   * `--profile headless` prefix. The task text is still the last argument.
   */
  args?: string[];
  spawner: Spawner;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DshHelpFlags {
  json: boolean;
  sessionId: boolean;
}

/**
 * Flags actually printed by `dsh --profile headless --help`.
 * dsh 0.1.5-rc.2 only documents `[task...]` and `-h`.
 */
export function parseDshHelp(text: string): DshHelpFlags {
  const flags = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s,])(--[a-z0-9][a-z0-9-]*)\b/gi)) {
    flags.add((match[1] ?? "").toLowerCase());
  }
  return {
    json: flags.has("--json"),
    sessionId: flags.has("--session-id"),
  };
}

/**
 * Native DeepSeek harness one-shot. The process cwd is the worktree.
 * Extra flags (`--json`, and a future `--session-id`) are added only when
 * `--help` lists them. Otherwise stdout is the final assistant message and
 * stderr is reasoning.
 */
export class DshAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;
  private flags: DshHelpFlags | undefined;

  constructor(private readonly options: DshAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness ?? "dsh";
    this.id = `${this.vendor}:dsh`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const flags = await this.helpFlags(request);
    const args = [...this.prefix(), ...(flags.json ? ["--json"] : []), request.task];
    const spawned = await this.options.spawner({
      command: this.options.command,
      args,
      cwd: request.cwd,
      env: this.options.env,
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs,
      stdin: "ignore",
    });
    if (flags.json) return toRunResult(spawned);
    return plainTextResult(spawned, request.mode);
  }

  /** Default published CLI is `dsh --profile headless`. A non-empty `args` list replaces that prefix. */
  private prefix(): string[] {
    const configured = this.options.args ?? [];
    return [...(this.options.commandArgs ?? []), ...(configured.length > 0 ? configured : ["--profile", "headless"])];
  }

  private async helpFlags(request: RunRequest): Promise<DshHelpFlags> {
    if (this.flags) return this.flags;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const help = await this.options.spawner({
      command: this.options.command,
      args: [...this.prefix(), "--help"],
      cwd: request.cwd,
      env: this.options.env,
      timeoutMs: Math.min(timeoutMs ?? 20_000, 20_000),
      stdin: "ignore",
    });
    this.flags = help.timedOut ? { json: false, sessionId: false } : parseDshHelp(`${help.stdout}\n${help.stderr}`);
    return this.flags;
  }
}

function plainTextResult(spawned: SpawnResult, mode: AgentMode): RunResult {
  const message = spawned.stdout.replace(/\r\n/g, "\n").trim();
  let result = message;
  if (mode === "plan" || mode === "review") {
    try {
      result = JSON.stringify(extractJsonObject(message));
    } catch {
      result = message;
    }
  }
  return {
    result,
    diff: "",
    usage: emptyUsage(),
    exitCode: spawned.exitCode,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    rateLimited: detectRateLimit(spawned.exitCode, spawned.stdout, spawned.stderr),
    timedOut: spawned.timedOut,
    raw: message,
  };
}
