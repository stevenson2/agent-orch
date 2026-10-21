import fs from "node:fs/promises";
import path from "node:path";
import { createAdapters } from "./adapters/factory.js";
import type { Adapter, RunResult } from "./adapters/types.js";
import { addWorktree, assertGitRepo, captureDiff, excludeArtifacts, porcelain } from "./git.js";
import { appendJsonl, atomicWriteJson } from "./jsonl.js";
import { parsePlan, parseReview } from "./parse.js";
import { executorPrompt, plannerPrompt, replanPrompt, reviewerPrompt } from "./prompts.js";
import { QuotaStore } from "./quota.js";
import { Router } from "./router.js";
import { spawnProcess, type Spawner } from "./spawn.js";
import { RunStore } from "./store.js";
import {
  addUsage,
  createRunId,
  emptyUsage,
  NOTABLE_EVENTS,
  type Assignment,
  type Config,
  type EventType,
  type OrchEvent,
  type PlannedTask,
  type Role,
  type RoundState,
  type RunState,
  type RunStatus,
  type TaskState,
  type VendorConfig,
} from "./types.js";
import { deliverWebhook } from "./webhook.js";

export interface PipelineInput {
  planText: string;
  planPath: string;
  config: Config;
  spawner?: Spawner;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runId?: string;
}

export interface PipelineResult {
  runId: string;
  status: RunStatus;
  state: RunState;
}

type RoleOutcome =
  | { kind: "ok"; vendor: VendorConfig; result: RunResult }
  | { kind: "failed"; vendor: VendorConfig; result: RunResult }
  | { kind: "exhausted" }
  | { kind: "no-cross-vendor" };

interface AttemptOutcome {
  pass: boolean;
  stop: boolean;
  feedback: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assignOf(vendor: VendorConfig): Assignment {
  return { vendor: vendor.id, harness: vendor.harness, adapter: vendor.adapter };
}

export class Pipeline {
  private readonly spawner: Spawner;
  private readonly now: () => Date;
  private readonly quota: QuotaStore;
  private readonly router: Router;
  private readonly adapters: Map<string, Adapter>;
  private readonly store: RunStore;
  private readonly run: RunState;
  private finished = false;

  constructor(private readonly input: PipelineInput) {
    this.spawner = input.spawner ?? spawnProcess;
    this.now = input.now ?? (() => new Date());
    this.quota = new QuotaStore(input.config.artifactsDir, this.now);
    this.router = new Router(input.config, this.quota);
    this.adapters = createAdapters(input.config.vendors, this.spawner);
    this.store = new RunStore(input.config.artifactsDir);
    const createdAt = this.now().toISOString();
    this.run = {
      schemaVersion: 1,
      id: input.runId ?? createRunId(this.now()),
      status: "planning",
      createdAt,
      updatedAt: createdAt,
      planPath: input.planPath,
      workspace: input.config.workspace,
      artifactsDir: input.config.artifactsDir,
      onExhaust: input.config.onExhaust,
      maxReviewRounds: input.config.maxReviewRounds,
      tasks: [],
      usage: emptyUsage(),
      listCostUsd: 0,
      quota: { vendors: [] },
    };
  }

  async start(): Promise<PipelineResult> {
    const { config } = this.input;
    await assertGitRepo(config.workspace, this.spawner);
    await excludeArtifacts(config.workspace, config.artifactsDir);
    await fs.mkdir(this.store.runDir(this.run.id), { recursive: true });
    await fs.writeFile(path.join(this.store.runDir(this.run.id), "plan.md"), this.input.planText, "utf8");
    await this.commit();
    await this.emit("run_started", "run started", { data: { planPath: this.input.planPath } });
    try {
      const tasks = await this.plan(this.input.planText);
      this.run.status = "running";
      this.run.tasks = tasks.map((task) => this.blankTask(task));
      await this.commit();
      await this.emit("plan_ready", `${tasks.length} tasks`, {
        data: { taskIds: tasks.map((task) => task.id) },
      });
      for (const task of this.run.tasks) {
        await this.executeTask(task);
      }
      await this.finish(this.summarize());
    } catch (error) {
      this.run.error = messageOf(error);
      await this.finish("error");
    }
    return { runId: this.run.id, status: this.run.status, state: this.run };
  }

  private blankTask(task: PlannedTask): TaskState {
    return {
      id: task.id,
      title: task.title,
      status: "pending",
      instructions: task.instructions,
      acceptance: task.acceptance,
      testCommand: task.testCommand,
      round: 0,
      maxRounds: this.input.config.maxReviewRounds,
      reasons: [],
      usage: emptyUsage(),
      listCostUsd: 0,
      rounds: [],
    };
  }

  private async plan(planText: string): Promise<PlannedTask[]> {
    const before = await porcelain(this.input.config.workspace, this.spawner);
    const outcome = await this.runRole({
      role: "planner",
      exclude: [],
      mode: "plan",
      prompt: plannerPrompt(planText),
      cwd: this.input.config.workspace,
    });
    if (outcome.kind === "exhausted") {
      throw new Error("no planner vendor has remaining quota");
    }
    if (outcome.kind === "no-cross-vendor") {
      throw new Error("no planner vendor is configured");
    }
    const after = await porcelain(this.input.config.workspace, this.spawner);
    if (before !== after) {
      throw new Error(`planner edited the workspace:\n${after}`);
    }
    if (outcome.kind === "failed") {
      throw new Error(`planner failed (${outcome.result.exitCode}): ${outcome.result.stderr || outcome.result.result}`);
    }
    this.run.planner = assignOf(outcome.vendor);
    await this.commit();
    await this.emit("planner_assigned", `planner ${outcome.vendor.id}`, {
      data: { vendor: outcome.vendor.id, harness: outcome.vendor.harness },
    });
    const tasks = parsePlan(outcome.result.result);
    await fs.writeFile(
      path.join(this.store.runDir(this.run.id), "plan.json"),
      `${JSON.stringify({ tasks }, null, 2)}\n`,
      "utf8",
    );
    return tasks;
  }

  private async executeTask(task: TaskState): Promise<void> {
    task.worktree = path.join(this.store.runDir(this.run.id), "worktrees", task.id);
    task.branch = `orch/${this.run.id}/${task.id}`;
    await addWorktree(this.input.config.workspace, task.worktree, task.branch, this.spawner);
    task.status = "running";
    task.startedAt = this.now().toISOString();
    await this.commit();
    await this.emit("task_started", `task ${task.id} started`, { taskId: task.id });

    let feedback = "";
    let replanned = false;
    let budget = this.input.config.maxReviewRounds;
    for (let round = 1; round <= budget; round += 1) {
      const outcome = await this.attemptRound(task, round, replanned, feedback);
      feedback = outcome.feedback;
      if (outcome.stop || outcome.pass) return;
      if (round === budget && !replanned && this.input.config.onExhaust === "planner") {
        const revised = await this.replan(task, feedback);
        if (!revised) {
          await this.escalateHuman(task, "replan_failed", feedback);
          return;
        }
        task.title = revised.title;
        task.instructions = revised.instructions;
        task.acceptance = revised.acceptance;
        task.testCommand = revised.testCommand;
        replanned = true;
        budget += this.input.config.maxReviewRounds;
        await this.commit();
        await this.emit("escalated_to_planner", `task ${task.id} returned to the planner`, {
          taskId: task.id,
          data: { feedback },
        });
      }
    }
    await this.escalateHuman(task, "review_rounds_exhausted", feedback);
  }

  private async attemptRound(
    task: TaskState,
    round: number,
    replanned: boolean,
    feedback: string,
  ): Promise<AttemptOutcome> {
    const planned = this.toPlanned(task);
    const roundState: RoundState = {
      round,
      phase: "execute",
      startedAt: this.now().toISOString(),
      reasons: [],
      usage: emptyUsage(),
      failovers: [],
    };
    task.round = round;
    task.rounds.push(roundState);
    await this.commit();

    const prompt = executorPrompt(planned, round, feedback, replanned);
    const executed = await this.runRole({
      role: "executor",
      exclude: [],
      mode: "execute",
      prompt,
      cwd: task.worktree!,
      task,
      roundState,
    });
    if (executed.kind === "exhausted" || executed.kind === "no-cross-vendor") {
      task.status = "failed";
      task.error = "executor quota exhausted";
      task.finishedAt = this.now().toISOString();
      roundState.error = task.error;
      roundState.finishedAt = task.finishedAt;
      await this.commit();
      return { pass: false, stop: true, feedback };
    }
    task.executor = assignOf(executed.vendor);
    roundState.executor = task.executor;
    await this.writeRoundFile(task, round, "executor.txt", executed.result.stdout);
    await this.emit("executor_finished", `executor ${executed.vendor.id} finished`, {
      taskId: task.id,
      data: { vendor: executed.vendor.id, exitCode: executed.result.exitCode, round },
    });
    if (executed.kind === "failed") {
      const note = executed.result.stderr || executed.result.result || `exit ${executed.result.exitCode}`;
      return this.rejectRound(task, roundState, ["executor failed"], note);
    }

    const diff = await captureDiff(task.worktree!, this.spawner);
    await this.writeRoundFile(task, round, "diff.patch", diff);
    roundState.phase = "test";
    const testCommand = task.testCommand ?? this.input.config.testCommand;
    let testsOk = true;
    let testSummary = "no test command";
    if (testCommand) {
      const testResult = await this.spawner({
        command: "sh",
        args: ["-c", testCommand],
        cwd: task.worktree!,
        timeoutMs: 120_000,
      });
      roundState.testExitCode = testResult.timedOut ? 124 : testResult.exitCode;
      testsOk = testResult.exitCode === 0 && !testResult.timedOut;
      testSummary = [
        `exit ${roundState.testExitCode}`,
        testResult.stdout.trim(),
        testResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000);
      await this.writeRoundFile(task, round, "test.txt", testSummary);
    }
    await this.commit();
    await this.emit("tests_finished", testsOk ? "tests passed" : "tests failed", {
      taskId: task.id,
      data: { round, exitCode: roundState.testExitCode ?? null },
    });
    if (!testsOk) {
      return this.rejectRound(task, roundState, ["tests failed"], `Tests failed.\n${testSummary}`);
    }

    roundState.phase = "review";
    await this.commit();
    const reviewed = await this.runRole({
      role: "reviewer",
      exclude: [executed.vendor.id],
      mode: "review",
      prompt: reviewerPrompt(planned, diff, testSummary, replanned),
      cwd: task.worktree!,
      task,
      roundState,
    });
    if (reviewed.kind === "no-cross-vendor") {
      await this.escalateHuman(task, "no_cross_vendor_reviewer", feedback);
      roundState.finishedAt = this.now().toISOString();
      roundState.phase = "done";
      await this.commit();
      return { pass: false, stop: true, feedback };
    }
    if (reviewed.kind === "exhausted") {
      task.status = "failed";
      task.error = "reviewer quota exhausted";
      task.finishedAt = this.now().toISOString();
      roundState.error = task.error;
      roundState.finishedAt = task.finishedAt;
      await this.commit();
      return { pass: false, stop: true, feedback };
    }
    if (reviewed.vendor.id === executed.vendor.id) {
      throw new Error(`cross-vendor invariant broken: ${reviewed.vendor.id} reviewed its own execution`);
    }
    task.reviewer = assignOf(reviewed.vendor);
    roundState.reviewer = task.reviewer;
    await this.writeRoundFile(task, round, "review.txt", reviewed.result.stdout);
    if (reviewed.kind === "failed") {
      const note = reviewed.result.stderr || reviewed.result.result || `exit ${reviewed.result.exitCode}`;
      return this.rejectRound(task, roundState, ["reviewer failed"], note);
    }
    let verdict;
    try {
      verdict = parseReview(reviewed.result.result);
    } catch (error) {
      verdict = {
        verdict: "reject" as const,
        reasons: ["unparseable review"],
        feedback: `${messageOf(error)}\n${reviewed.result.result}`.slice(0, 2000),
      };
    }
    roundState.verdict = verdict.verdict;
    roundState.reasons = verdict.reasons;
    roundState.feedback = verdict.feedback;
    roundState.phase = "done";
    roundState.finishedAt = this.now().toISOString();
    task.verdict = verdict.verdict;
    task.reasons = verdict.reasons;
    task.feedback = verdict.feedback;
    await this.commit();
    if (verdict.verdict === "pass") {
      task.status = "passed";
      task.finishedAt = this.now().toISOString();
      await this.commit();
      await this.emit("task_passed", `task ${task.id} passed`, {
        taskId: task.id,
        data: { round, reviewer: reviewed.vendor.id, reasons: verdict.reasons },
      });
      return { pass: true, stop: true, feedback: "" };
    }
    const nextFeedback = verdict.feedback || verdict.reasons.join("\n");
    await this.emit("task_rejected", `task ${task.id} rejected`, {
      taskId: task.id,
      data: {
        round,
        reviewer: reviewed.vendor.id,
        executor: executed.vendor.id,
        reasons: verdict.reasons,
        feedback: nextFeedback,
      },
    });
    return { pass: false, stop: false, feedback: nextFeedback };
  }

  private async rejectRound(
    task: TaskState,
    roundState: RoundState,
    reasons: string[],
    feedback: string,
  ): Promise<AttemptOutcome> {
    roundState.verdict = "reject";
    roundState.reasons = reasons;
    roundState.feedback = feedback;
    roundState.phase = "done";
    roundState.finishedAt = this.now().toISOString();
    task.verdict = "reject";
    task.reasons = reasons;
    task.feedback = feedback;
    await this.commit();
    await this.emit("task_rejected", `task ${task.id} rejected`, {
      taskId: task.id,
      data: { round: roundState.round, reasons, feedback },
    });
    return { pass: false, stop: false, feedback };
  }

  private async replan(task: TaskState, feedback: string): Promise<PlannedTask | undefined> {
    const before = await porcelain(this.input.config.workspace, this.spawner);
    let outcome: RoleOutcome;
    try {
      outcome = await this.runRole({
        role: "planner",
        exclude: [],
        mode: "plan",
        prompt: replanPrompt(this.toPlanned(task), feedback),
        cwd: this.input.config.workspace,
        task,
      });
    } catch (error) {
      task.error = messageOf(error);
      return undefined;
    }
    const after = await porcelain(this.input.config.workspace, this.spawner);
    if (before !== after) return undefined;
    if (outcome.kind !== "ok") return undefined;
    try {
      const parsed = parsePlan(outcome.result.result);
      if (parsed.length !== 1) return undefined;
      return { ...parsed[0], id: task.id };
    } catch {
      return undefined;
    }
  }

  private async escalateHuman(task: TaskState, reason: string, feedback: string): Promise<void> {
    task.status = "escalated";
    task.error = reason;
    task.feedback = feedback;
    task.finishedAt = this.now().toISOString();
    const file = path.join(this.store.runDir(this.run.id), "escalations", `${task.id}.json`);
    await atomicWriteJson(file, {
      ts: task.finishedAt,
      runId: this.run.id,
      taskId: task.id,
      reason,
      feedback,
      rounds: task.rounds.length,
      executor: task.executor ?? null,
      reviewer: task.reviewer ?? null,
      reasons: task.reasons,
    });
    await this.commit();
    await this.emit("escalated_to_human", `task ${task.id} needs a human`, {
      taskId: task.id,
      data: { reason, feedback, rounds: task.rounds.length },
    });
  }

  private async runRole(input: {
    role: Role;
    exclude: string[];
    mode: "plan" | "execute" | "review";
    prompt: string;
    cwd: string;
    task?: TaskState;
    roundState?: RoundState;
  }): Promise<RoleOutcome> {
    const tried = new Set(input.exclude);
    const prefer = this.input.config.roles[input.role].prefer;
    let announcedPrefer = false;
    for (let attempt = 0; attempt < this.input.config.vendors.length; attempt += 1) {
      const selection = await this.router.select(input.role, {
        excludeVendors: [...tried],
        at: this.now(),
      });
      if (!selection) {
        const configured = this.input.config.vendors.filter((vendor) => vendor.roles.includes(input.role));
        const crossVendor = configured.filter((vendor) => !input.exclude.includes(vendor.id));
        if (input.role === "reviewer" && crossVendor.length === 0) {
          return { kind: "no-cross-vendor" };
        }
        await this.emit("quota_exhausted", `no ${input.role} vendor available`, {
          taskId: input.task?.id,
          data: { role: input.role, excluded: [...tried] },
        });
        return { kind: "exhausted" };
      }
      const vendor = selection.vendor;
      if (!announcedPrefer && prefer.length > 0 && !prefer.includes(vendor.id)) {
        announcedPrefer = true;
        const record = { from: prefer.join(","), role: input.role, reason: "preferred_unavailable" };
        input.roundState?.failovers.push(record);
        await this.emit("quota_failover", `preferred ${input.role} unavailable, using ${vendor.id}`, {
          taskId: input.task?.id,
          data: { from: prefer, to: vendor.id, role: input.role, reason: "preferred_unavailable" },
        });
      }
      if (input.role === "executor") {
        await this.emit("executor_assigned", `executor ${vendor.id}`, {
          taskId: input.task?.id,
          data: { vendor: vendor.id, harness: vendor.harness, round: input.roundState?.round },
        });
      }
      if (input.role === "reviewer") {
        await this.emit("reviewer_assigned", `reviewer ${vendor.id}`, {
          taskId: input.task?.id,
          data: { vendor: vendor.id, harness: vendor.harness, round: input.roundState?.round },
        });
      }
      const adapter = this.adapters.get(vendor.id);
      if (!adapter) throw new Error(`missing adapter for ${vendor.id}`);
      if (input.task && input.roundState) {
        const name = input.role === "reviewer" ? "review-prompt.md" : input.role === "executor" ? "executor-prompt.md" : "planner-prompt.md";
        await this.writeRoundFile(input.task, input.roundState.round, name, input.prompt);
      }
      const result = await adapter.run({
        task: input.prompt,
        cwd: input.cwd,
        mode: input.mode,
        timeoutMs: vendor.timeoutMs,
      });
      if (result.rateLimited) {
        const until = new Date(this.now().getTime() + vendor.cooldownSeconds * 1000);
        await this.quota.cooldown(vendor.id, until, "rate_limit", this.run.id);
        const record = { from: vendor.id, role: input.role, reason: "rate_limit" };
        input.roundState?.failovers.push(record);
        tried.add(vendor.id);
        await this.commit();
        await this.emit("quota_failover", `${vendor.id} rate-limited during ${input.role}`, {
          taskId: input.task?.id,
          data: { from: vendor.id, role: input.role, reason: "rate_limit", until: until.toISOString() },
        });
        continue;
      }
      await this.noteUsage(vendor, input.role, result, input.task, input.roundState);
      if (result.exitCode !== 0 || result.timedOut) {
        return { kind: "failed", vendor, result };
      }
      return { kind: "ok", vendor, result };
    }
    await this.emit("quota_exhausted", `no ${input.role} vendor available`, {
      taskId: input.task?.id,
      data: { role: input.role, excluded: [...tried] },
    });
    return { kind: "exhausted" };
  }

  private async noteUsage(
    vendor: VendorConfig,
    role: Role,
    result: RunResult,
    task?: TaskState,
    roundState?: RoundState,
  ): Promise<void> {
    const usage = result.usage;
    const listCostUsd = (usage.totalTokens / 1000) * vendor.listCostPer1kTokens;
    const effectiveCostUsd = listCostUsd / vendor.subscriptionMultiplier;
    this.run.usage = addUsage(this.run.usage, usage);
    this.run.listCostUsd += listCostUsd;
    if (task) {
      task.usage = addUsage(task.usage, usage);
      task.listCostUsd += listCostUsd;
    }
    if (roundState) roundState.usage = addUsage(roundState.usage, usage);
    await this.quota.recordConsume({
      vendor: vendor.id,
      tokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      listCostUsd,
      effectiveCostUsd,
      runId: this.run.id,
      taskId: task?.id,
      role,
      at: this.now(),
    });
    await appendJsonl(path.join(this.store.runDir(this.run.id), "usage.jsonl"), {
      ts: this.now().toISOString(),
      runId: this.run.id,
      taskId: task?.id ?? null,
      role,
      vendor: vendor.id,
      harness: vendor.harness,
      usage,
      listCostUsd,
      effectiveCostUsd,
    });
  }

  private async writeRoundFile(task: TaskState, round: number, name: string, body: string): Promise<void> {
    const file = path.join(this.store.runDir(this.run.id), "tasks", task.id, `round-${round}-${name}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
  }

  private toPlanned(task: TaskState): PlannedTask {
    return {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      acceptance: task.acceptance,
      testCommand: task.testCommand,
    };
  }

  private summarize(): RunStatus {
    if (this.run.tasks.some((task) => task.status === "failed")) return "failed";
    if (this.run.tasks.some((task) => task.status === "escalated")) return "escalated";
    if (this.run.tasks.length > 0 && this.run.tasks.every((task) => task.status === "passed")) return "passed";
    return "failed";
  }

  private async finish(status: RunStatus): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.run.status = status;
    this.run.finishedAt = this.now().toISOString();
    await this.commit();
    await this.emit("run_finished", `run ${status}`, { data: { status } });
  }

  private async quotaView(): Promise<RunState["quota"]> {
    const at = this.now();
    const vendors = [];
    for (const vendor of this.input.config.vendors) {
      const cool = await this.quota.cooling(vendor.id, at);
      const windows = [];
      for (const window of vendor.quotas) {
        const usedTokens = await this.quota.usedTokens(vendor.id, window.windowSeconds, at);
        windows.push({
          name: window.name,
          windowSeconds: window.windowSeconds,
          usedTokens,
          limitTokens: window.limitTokens,
          remainingTokens: Math.max(0, window.limitTokens - usedTokens),
        });
      }
      vendors.push({
        vendor: vendor.id,
        cooling: cool.cooling,
        cooldownUntil: cool.until,
        windows,
      });
    }
    return { vendors };
  }

  private async commit(): Promise<void> {
    this.run.updatedAt = this.now().toISOString();
    this.run.quota = await this.quotaView();
    await this.store.appendSnapshot(this.run);
  }

  private async emit(
    type: EventType,
    message: string,
    extra?: { taskId?: string; data?: Record<string, unknown> },
  ): Promise<void> {
    const event: OrchEvent = {
      ts: this.now().toISOString(),
      runId: this.run.id,
      taskId: extra?.taskId,
      type,
      message,
      data: extra?.data,
    };
    await this.store.appendEvent(event);
    if (!NOTABLE_EVENTS.has(type) || !this.input.config.webhook?.url) return;
    try {
      await deliverWebhook(
        this.input.config.webhook.url,
        event,
        this.input.config.webhook.timeoutMs,
        this.input.fetchImpl,
      );
    } catch (error) {
      await this.store.appendEvent({
        ts: this.now().toISOString(),
        runId: this.run.id,
        taskId: extra?.taskId,
        type: "webhook_error",
        message: messageOf(error),
        data: { event: type },
      });
    }
  }
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  return new Pipeline(input).start();
}
