import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.js";
import type { Role } from "./types.js";

export interface QuotaLedgerEvent {
  ts: string;
  vendor: string;
  kind: "consume" | "cooldown";
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  listCostUsd?: number;
  effectiveCostUsd?: number;
  runId?: string;
  taskId?: string;
  role?: Role;
  until?: string;
  reason?: string;
}

export interface ConsumeInput {
  vendor: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  listCostUsd: number;
  effectiveCostUsd: number;
  runId: string;
  taskId?: string;
  role: Role;
  at: Date;
}

export class QuotaStore {
  readonly file: string;

  constructor(
    artifactsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(artifactsDir, "quota.jsonl");
  }

  async recordConsume(input: ConsumeInput): Promise<void> {
    const event: QuotaLedgerEvent = {
      ts: input.at.toISOString(),
      vendor: input.vendor,
      kind: "consume",
      tokens: input.tokens,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      listCostUsd: input.listCostUsd,
      effectiveCostUsd: input.effectiveCostUsd,
      runId: input.runId,
      taskId: input.taskId,
      role: input.role,
    };
    await appendJsonl(this.file, event);
  }

  async cooldown(vendor: string, until: Date, reason: string, runId?: string): Promise<void> {
    const event: QuotaLedgerEvent = {
      ts: this.now().toISOString(),
      vendor,
      kind: "cooldown",
      until: until.toISOString(),
      reason,
      runId,
    };
    await appendJsonl(this.file, event);
  }

  async events(): Promise<QuotaLedgerEvent[]> {
    return readJsonl<QuotaLedgerEvent>(this.file);
  }

  async usedTokens(vendor: string, windowSeconds: number, at: Date): Promise<number> {
    const start = at.getTime() - windowSeconds * 1000;
    const events = await this.events();
    let total = 0;
    for (const event of events) {
      if (event.kind !== "consume" || event.vendor !== vendor) continue;
      const ts = Date.parse(event.ts);
      if (Number.isNaN(ts) || ts < start || ts > at.getTime()) continue;
      total += event.tokens ?? 0;
    }
    return total;
  }

  async cooling(vendor: string, at: Date): Promise<{ cooling: boolean; until?: string; reason?: string }> {
    const events = await this.events();
    let until: string | undefined;
    let reason: string | undefined;
    for (const event of events) {
      if (event.kind !== "cooldown" || event.vendor !== vendor || !event.until) continue;
      if (Date.parse(event.until) > at.getTime()) {
        until = event.until;
        reason = event.reason;
      }
    }
    return until ? { cooling: true, until, reason } : { cooling: false };
  }
}
