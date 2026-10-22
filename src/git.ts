import fs from "node:fs/promises";
import path from "node:path";
import { spawnProcess, type Spawner } from "./spawn.js";

async function git(cwd: string, args: string[], spawner: Spawner = spawnProcess): Promise<string> {
  const result = await spawner({ command: "git", args, cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function assertGitRepo(cwd: string, spawner?: Spawner): Promise<void> {
  await git(cwd, ["rev-parse", "--is-inside-work-tree"], spawner);
}

export async function porcelain(cwd: string, spawner?: Spawner): Promise<string> {
  return (await git(cwd, ["status", "--porcelain"], spawner)).trim();
}

export async function addWorktree(
  repo: string,
  dest: string,
  branch: string,
  spawner?: Spawner,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, dest, "HEAD"], spawner);
}

/** Staged diff including previously untracked files. Leaves the worktree unstaged. */
export async function captureDiff(cwd: string, spawner?: Spawner): Promise<string> {
  await git(cwd, ["add", "-A"], spawner);
  const diff = await git(cwd, ["diff", "--cached", "--binary"], spawner);
  await git(cwd, ["reset"], spawner);
  return diff;
}

/**
 * Keep orchestrator bookkeeping out of the planner's dirty check.
 * Appends to .git/info/exclude when artifacts live inside the repo.
 */
export async function excludeArtifacts(workspace: string, artifactsDir: string): Promise<void> {
  const relative = path.relative(workspace, artifactsDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  const exclude = path.join(workspace, ".git", "info", "exclude");
  const line = `/${relative.split(path.sep).join("/")}/`;
  let current = "";
  try {
    current = await fs.readFile(exclude, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.includes(line)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `\n# agent-orch artifacts\n${line}\n`, "utf8");
}
