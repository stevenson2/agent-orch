export type Role = "planner" | "executor" | "reviewer";
export type AgentMode = "plan" | "execute" | "review";
export type AdapterKind = "zcode" | "dsh" | "acpx" | "command";
export type ExhaustPolicy = "planner" | "human";
export type ZCodeExecuteMode = "edit" | "yolo" | "build";

export type RunStatus = "planning" | "running" | "passed" | "failed" | "escalated" | "error";
export type TaskStatus = "pending" | "running" | "passed" | "escalated" | "failed";

export const EVENT_TYPES = [
  "run_started",
  "planner_assigned",
  "plan_ready",
  "task_started",
  "executor_assigned",
  "executor_finished",
  "tests_finished",
  "reviewer_assigned",
  "task_rejected",
  "task_passed",
  "escalated_to_planner",
  "escalated_to_human",
  "quota_exhausted",
  "quota_failover",
  "run_finished",
  "webhook_error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Events a remote assistant should push. */
export const NOTABLE_EVENTS = new Set<EventType>([
  "task_rejected",
  "escalated_to_human",
  "escalated_to_planner",
  "quota_exhausted",
  "quota_failover",
  "run_finished",
]);

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface QuotaWindowConfig {
  name: string;
  windowSeconds: number;
  limitTokens: number;
}

export interface VendorConfig {
  id: string;
  harness: string;
  adapter: AdapterKind;
  command: string;
  commandArgs: string[];
  args: string[];
  modeArgs: Partial<Record<AgentMode, string[]>>;
  acpxAgent?: string;
  outputFormat: "json" | "stream-json";
  zcodeExecuteMode: ZCodeExecuteMode;
  subscriptionMultiplier: number;
  listCostPer1kTokens: number;
  roles: Role[];
  quotas: QuotaWindowConfig[];
  cooldownSeconds: number;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface RolePreference {
  prefer: string[];
}

export interface WebhookConfig {
  url?: string;
  timeoutMs: number;
}

export interface Config {
  version: 1;
  workspace: string;
  artifactsDir: string;
  maxReviewRounds: number;
  onExhaust: ExhaustPolicy;
  testCommand?: string;
  webhook?: WebhookConfig;
  roles: Record<Role, RolePreference>;
  vendors: VendorConfig[];
}

export interface Assignment {
  vendor: string;
  harness: string;
  adapter: string;
}

export interface FailoverRecord {
  from: string;
  role: Role;
  reason: string;
}

export interface RoundState {
  round: number;
  phase: "execute" | "test" | "review" | "done";
  executor?: Assignment;
  reviewer?: Assignment;
  startedAt: string;
  finishedAt?: string;
  testExitCode?: number | null;
  verdict?: "pass" | "reject";
  reasons: string[];
  feedback?: string;
  usage: TokenUsage;
  failovers: FailoverRecord[];
  error?: string;
}

export interface QuotaWindowView {
  name: string;
  windowSeconds: number;
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
}

export interface VendorQuotaView {
  vendor: string;
  cooling: boolean;
  cooldownUntil?: string;
  windows: QuotaWindowView[];
}

export interface TaskState {
  id: string;
  title: string;
  status: TaskStatus;
  instructions: string;
  acceptance: string[];
  testCommand?: string;
  executor?: Assignment;
  reviewer?: Assignment;
  round: number;
  maxRounds: number;
  verdict?: "pass" | "reject";
  reasons: string[];
  feedback?: string;
  worktree?: string;
  branch?: string;
  usage: TokenUsage;
  listCostUsd: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  rounds: RoundState[];
}

export interface RunState {
  schemaVersion: 1;
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  planPath: string;
  workspace: string;
  artifactsDir: string;
  planner?: Assignment;
  onExhaust: ExhaustPolicy;
  maxReviewRounds: number;
  tasks: TaskState[];
  usage: TokenUsage;
  listCostUsd: number;
  quota: { vendors: VendorQuotaView[] };
  error?: string;
}

export interface OrchEvent {
  ts: string;
  runId: string;
  taskId?: string;
  type: EventType | string;
  message: string;
  data?: Record<string, unknown>;
}

export interface PlannedTask {
  id: string;
  title: string;
  instructions: string;
  acceptance: string[];
  testCommand?: string;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${rand}`;
}
