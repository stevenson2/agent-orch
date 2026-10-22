import { readNotableEvents, listRunStates, readRunState } from "./store.js";
import type { OrchEvent, RunState, TaskState } from "./types.js";

export async function listRuns(artifactsDir: string): Promise<RunState[]> {
  return listRunStates(artifactsDir);
}

export async function getRun(artifactsDir: string, runId: string): Promise<RunState | null> {
  return readRunState(artifactsDir, runId);
}

export async function getTask(
  artifactsDir: string,
  runId: string,
  taskId: string,
): Promise<TaskState | null> {
  const run = await readRunState(artifactsDir, runId);
  if (!run) return null;
  return run.tasks.find((task) => task.id === taskId) ?? null;
}

export async function listEvents(artifactsDir: string, limit?: number): Promise<OrchEvent[]> {
  const events = await readNotableEvents(artifactsDir);
  if (limit === undefined) return events;
  return events.slice(Math.max(0, events.length - limit));
}

export function summarizeRun(run: RunState): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
    planner: run.planner ?? null,
    usage: run.usage,
    listCostUsd: run.listCostUsd,
    error: run.error ?? null,
    tasks: run.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      round: task.round,
      maxRounds: task.maxRounds,
      executor: task.executor ?? null,
      reviewer: task.reviewer ?? null,
      verdict: task.verdict ?? null,
      reasons: task.reasons,
      usage: task.usage,
      listCostUsd: task.listCostUsd,
      error: task.error ?? null,
    })),
  };
}

export function formatStatusText(runs: RunState[]): string {
  if (runs.length === 0) return "暂无运行记录。\n";
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(
      `运行 ${run.id}  状态 ${run.status}  更新 ${run.updatedAt}` +
        (run.planner ? `  规划 ${run.planner.vendor}/${run.planner.harness}` : ""),
    );
    if (run.error) lines.push(`  错误 ${run.error}`);
    lines.push(
      `  用量 in ${run.usage.inputTokens} / out ${run.usage.outputTokens} / 标价 $${run.listCostUsd.toFixed(4)}`,
    );
    for (const task of run.tasks) {
      const exec = task.executor ? `${task.executor.vendor}` : "-";
      const rev = task.reviewer ? `${task.reviewer.vendor}` : "-";
      lines.push(
        `  任务 ${task.id}  状态 ${task.status}  轮次 ${task.round}/${task.maxRounds}  执行 ${exec}  审查 ${rev}  结论 ${task.verdict ?? "-"}`,
      );
      if (task.reasons.length > 0) lines.push(`    原因 ${task.reasons.join("；")}`);
      if (task.error) lines.push(`    错误 ${task.error}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
