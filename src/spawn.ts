import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Windows: pass args to the child exactly, without Node's extra quoting. */
  windowsVerbatimArguments?: boolean;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Spawner = (request: SpawnRequest) => Promise<SpawnResult>;

export interface SpawnResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** cmd.exe metacharacter escape. Adapted from node-cross-spawn (MIT). */
export function escapeCmdArgument(value: string, doubleEscape = false): string {
  let arg = `${value}`;
  arg = arg.replace(/(\\*)"/g, "$1$1\\\"");
  arg = arg.replace(/(\\*)$/, "$1$1");
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META, "^$1");
  if (doubleEscape) arg = arg.replace(CMD_META, "^$1");
  return arg;
}

function defaultExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path;
}

/** Windows PATHEXT is uppercase; the filesystem and npm shims are not. */
function windowsNames(base: string, exts: string[]): string[] {
  const names: string[] = [];
  for (const ext of exts) {
    const raw = base + ext;
    const lower = base + ext.toLowerCase();
    names.push(raw);
    if (lower !== raw) names.push(lower);
  }
  return names;
}

export function findOnPath(
  command: string,
  options: SpawnResolveOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const p = pathApi(platform);
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;
  const exts =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const hasDir = p.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const pathKey = platform === "win32" ? (env.PATH ?? env.Path ?? "") : (env.PATH ?? "");
  const dirs = hasDir ? [p.dirname(command)] : pathKey.split(p.delimiter).filter(Boolean);
  const base = hasDir ? p.basename(command) : command;
  const baseHasExt = p.extname(base) !== "";
  for (const dir of dirs) {
    const names = baseHasExt ? [base] : platform === "win32" ? windowsNames(base, exts) : [base, ...exts.map((ext) => base + ext)];
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * npm's cmd-shim ends with `"%_prog%" ... "%dp0%\...\file.js" %*`.
 * Spawn node + the script so prompts that contain newlines never pass through cmd.exe.
 */
export function unwrapCmdShim(
  cmdPath: string,
  options: SpawnResolveOptions = {},
): { node: string; script: string } | undefined {
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const exists = options.exists ?? defaultExists;
  let text: string;
  try {
    text = readFile(cmdPath);
  } catch {
    return undefined;
  }
  const win = path.win32;
  const dir = win.dirname(cmdPath);
  const dp0 = dir.endsWith("\\") ? dir : `${dir}\\`;
  const relative = text.match(/"((?:%dp0%|%~dp0%?)[^"]+\.(?:js|mjs|cjs))"/i);
  const absolute = text.match(/"([A-Za-z]:\\[^"]+\.(?:js|mjs|cjs))"/);
  const raw = relative?.[1] ?? absolute?.[1];
  if (!raw) return undefined;
  const script = win.normalize(raw.replace(/%~?dp0%/i, dp0));
  if (!exists(script)) return undefined;
  const localNode = win.join(dir, "node.exe");
  const node = exists(localNode) ? localNode : process.execPath;
  return { node, script };
}

export function resolveSpawnCommand(
  command: string,
  args: string[],
  options: SpawnResolveOptions = {},
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };
  const found = findOnPath(command, options) ?? command;
  const ext = path.win32.extname(found).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const unwrapped = unwrapCmdShim(found, options);
    if (unwrapped) {
      return { command: unwrapped.node, args: [unwrapped.script, ...args] };
    }
    const env = options.env ?? process.env;
    const comspec = env.ComSpec?.trim() || "cmd.exe";
    const line = [found, ...args].map((arg) => escapeCmdArgument(arg)).join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", line],
      windowsVerbatimArguments: true,
    };
  }
  return { command: found, args };
}

export function shellCommand(
  script: string,
  cwd: string,
  timeoutMs?: number,
  platform: NodeJS.Platform = process.platform,
): SpawnRequest {
  if (platform === "win32") {
    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", script],
      cwd,
      timeoutMs,
      windowsVerbatimArguments: true,
    };
  }
  return { command: "sh", args: ["-c", script], cwd, timeoutMs };
}

function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

export function spawnProcess(request: SpawnRequest): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const resolved = request.windowsVerbatimArguments
      ? { command: request.command, args: request.args, windowsVerbatimArguments: true }
      : resolveSpawnCommand(request.command, request.args);

    let child: ChildProcess;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments ?? request.windowsVerbatimArguments,
      });
    } catch (error) {
      finish({
        exitCode: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      request.timeoutMs && request.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, request.timeoutMs)
        : undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      finish({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

const RATE_PHRASE =
  /rate limit|too many requests|quota exceeded|insufficient_quota|usage limit exceeded|resource_exhausted/i;

/**
 * A bare "429" inside a token count must not count. Require a limit phrase,
 * or the number 429 together with a limit word.
 */
export function detectRateLimit(exitCode: number, stdout: string, stderr: string): boolean {
  if (exitCode === 429) return true;
  const blob = `${stdout}\n${stderr}`;
  if (RATE_PHRASE.test(blob)) return true;
  if (/\b429\b/.test(blob) && /rate|quota|limit|too many/i.test(blob)) return true;
  return false;
}
