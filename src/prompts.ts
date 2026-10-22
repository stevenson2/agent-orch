import type { PlannedTask } from "./types.js";

export function plannerPrompt(planText: string): string {
  return [
    "ORCH_ROLE: planner",
    "ORCH_REPLAN: 0",
    "You are the planning agent for a coding orchestrator.",
    "Do not edit files. Do not run commands that change the workspace. Do not emit a diff.",
    "Return ONLY a JSON object with this shape:",
    '{"tasks":[{"id":"slug","title":"...","instructions":"...","acceptance":["..."],"test_command":"optional shell command"}]}',
    "Rules:",
    "- id must match [A-Za-z0-9._-]+",
    "- instructions must be concrete enough for a coding agent working in a fresh git worktree",
    "- acceptance lists observable checks",
    "- test_command, when present, must exit 0 only if acceptance holds",
    "- if the user plan already contains a JSON task list, return that list unchanged",
    "",
    "USER_PLAN_BEGIN",
    planText,
    "USER_PLAN_END",
  ].join("\n");
}

export function replanPrompt(task: PlannedTask, feedback: string): string {
  return [
    "ORCH_ROLE: planner",
    "ORCH_REPLAN: 1",
    `ORCH_TASK_ID: ${task.id}`,
    "The executor and cross-vendor reviewer did not finish this task within the round cap.",
    "Revise ONLY this task. Do not edit files. Return ONLY JSON with a tasks array of one object.",
    "Keep the same id.",
    "",
    "FEEDBACK:",
    feedback || "(none)",
    "",
    "CURRENT_TASK:",
    JSON.stringify(
      {
        id: task.id,
        title: task.title,
        instructions: task.instructions,
        acceptance: task.acceptance,
        test_command: task.testCommand ?? "",
      },
      null,
      2,
    ),
  ].join("\n");
}

export function executorPrompt(
  task: PlannedTask,
  round: number,
  feedback: string | undefined,
  replanned: boolean,
): string {
  return [
    "ORCH_ROLE: executor",
    `ORCH_TASK_ID: ${task.id}`,
    `ORCH_ROUND: ${round}`,
    `ORCH_REPLAN: ${replanned ? "1" : "0"}`,
    "You are the executor. Implement the task in the current git worktree.",
    "Do not ask follow-up questions. The orchestrator will run tests and a reviewer from another vendor.",
    "",
    `TITLE: ${task.title}`,
    "INSTRUCTIONS:",
    task.instructions,
    "ACCEPTANCE:",
    ...(task.acceptance.length > 0 ? task.acceptance.map((item) => `- ${item}`) : ["- (none)"]),
    feedback ? `PREVIOUS_FEEDBACK:\n${feedback}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function reviewerPrompt(
  task: PlannedTask,
  diff: string,
  testSummary: string,
  replanned: boolean,
): string {
  return [
    "ORCH_ROLE: reviewer",
    `ORCH_TASK_ID: ${task.id}`,
    `ORCH_REPLAN: ${replanned ? "1" : "0"}`,
    "You review work produced by a different vendor. Do not edit files.",
    'Return ONLY JSON: {"verdict":"pass"|"reject","reasons":["..."],"feedback":"what the executor should change"}',
    "Pass only when the diff and tests satisfy every acceptance criterion. Otherwise reject.",
    "",
    `TITLE: ${task.title}`,
    "INSTRUCTIONS:",
    task.instructions,
    "ACCEPTANCE:",
    ...(task.acceptance.length > 0 ? task.acceptance.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "TESTS:",
    testSummary,
    "",
    "DIFF:",
    diff.trim() ? diff : "(empty)",
  ].join("\n");
}
