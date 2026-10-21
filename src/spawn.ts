import { spawn } from "node:child_process";

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Spawner = (request: SpawnRequest) => Promise<SpawnResult>;

export function spawnProcess(request: SpawnRequest): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
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
            child.kill("SIGKILL");
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
