import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import type { AgentMode, ZCodeExecuteMode } from "../types.js";
import { resolveSpawnCommand } from "../spawn.js";
import type { Adapter, RunRequest, RunResult } from "./types.js";
import { resolveDesktopLaunch } from "./zcode-desktop-launch.js";
import { runDesktopProtocol } from "./zcode-desktop-protocol.js";

export interface ZCodeDesktopAdapterOptions {
  vendor: string;
  harness?: string;
  command: string;
  commandArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  executeMode?: ZCodeExecuteMode;
}

const MODE: Record<AgentMode, "plan" | "edit" | "yolo" | "build"> = {
  plan: "plan",
  execute: "edit",
  review: "plan",
};

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

/**
 * Drives the official desktop bundle's agent the way the GUI Host does:
 * ELECTRON_RUN_AS_NODE=1 resources/glm/zcode.cjs app-server --stdio --surface desktop
 * The desktop window itself only exposes an Electron MessagePort, so this attaches
 * to that agent protocol instead of clicking the GUI.
 */
export class ZCodeDesktopAdapter implements Adapter {
  readonly id: string;
  readonly vendor: string;
  readonly harness: string;

  private bundleText: { path: string; text: Promise<string> } | undefined;

  constructor(private readonly options: ZCodeDesktopAdapterOptions) {
    this.vendor = options.vendor;
    this.harness = options.harness ?? "zcode-desktop";
    this.id = `${this.vendor}:zcode-desktop`;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const launch = resolveDesktopLaunch({
      command: this.options.command,
      commandArgs: this.options.commandArgs ?? [],
      cwd: request.cwd,
      env: { ...process.env, ...this.options.env },
    });
    if ("error" in launch) {
      return {
        result: "",
        diff: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        exitCode: 127,
        stdout: "",
        stderr: launch.error,
        rateLimited: false,
        timedOut: false,
        raw: null,
      };
    }
    const resolved = resolveSpawnCommand(launch.command, launch.args);
    const mode = request.mode === "execute" ? (this.options.executeMode ?? "edit") : MODE[request.mode];
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      env: { ...process.env, ...launch.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 600_000;
    const timer = setTimeout(() => killTree(child), timeoutMs);
    try {
      if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error("failed to open the ZCode agent pipes");
      }
      const result = await runDesktopProtocol(
        { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr },
        {
          task: request.task,
          cwd: request.cwd,
          mode,
          planEnabled: request.mode !== "execute",
          timeoutMs,
          env: { ...process.env, ...this.options.env },
          bundleText: await this.readBundle(launch.bundle),
        },
      );
      return result;
    } finally {
      clearTimeout(timer);
      child.stdin?.end();
      killTree(child);
    }
  }

  private readBundle(bundle: string | undefined): Promise<string> {
    if (!bundle) return Promise.resolve("");
    if (this.bundleText?.path === bundle) return this.bundleText.text;
    const text = fs.readFile(bundle, "utf8").catch(() => "");
    this.bundleText = { path: bundle, text };
    return text;
  }
}
