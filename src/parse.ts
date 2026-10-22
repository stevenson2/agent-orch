import type { PlannedTask, TokenUsage } from "./types.js";
import { emptyUsage } from "./types.js";

export interface ReviewVerdict {
  verdict: "pass" | "reject";
  reasons: string[];
  feedback: string;
}

function balancedObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function firstJsonObject(source: string): unknown | undefined {
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf("{", searchFrom);
    if (start < 0) return undefined;
    const end = balancedObjectEnd(source, start);
    if (end < 0) return undefined;
    try {
      return JSON.parse(source.slice(start, end + 1)) as unknown;
    } catch {
      searchFrom = start + 1;
    }
  }
  return undefined;
}

/** Fenced ```json block, otherwise the first balanced JSON object in the text. */
export function extractJsonObject(text: string): unknown {
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = firstJsonObject(fence[1] ?? "");
    if (parsed !== undefined) return parsed;
  }
  const parsed = firstJsonObject(text);
  if (parsed !== undefined) return parsed;
  throw new Error("response did not contain a JSON object");
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function readUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") return emptyUsage();
  const record = value as Record<string, unknown>;
  const source =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens);
  const outputTokens = asNumber(
    source.output_tokens ?? source.outputTokens ?? source.completion_tokens,
  );
  const totalRaw = asNumber(source.total_tokens ?? source.totalTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalRaw || inputTokens + outputTokens,
  };
}

function textField(record: Record<string, unknown>): string | undefined {
  for (const key of ["response", "result", "text", "message", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export interface ParsedOutput {
  result: string;
  diff: string;
  usage: TokenUsage;
  raw: unknown;
}

function fromRecord(record: Record<string, unknown>, raw: unknown): ParsedOutput {
  return {
    result: textField(record) ?? "",
    diff: typeof record.diff === "string" ? record.diff : "",
    usage: readUsage(record),
    raw,
  };
}

function parseEventStream(events: Record<string, unknown>[]): ParsedOutput {
  let usage = emptyUsage();
  let result = "";
  let diff = "";
  for (const event of events) {
    const type = String(event.type ?? "");
    if (event.usage && typeof event.usage === "object") usage = readUsage(event);
    if (typeof event.diff === "string" && event.diff) diff = event.diff;
    if (type === "thinking" || type === "tool_call" || type === "tool_result" || type === "session") {
      continue;
    }
    const text = textField(event);
    if (text) result = text;
  }
  return { result, diff, usage, raw: events };
}

export function parseAgentOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { result: "", diff: "", usage: emptyUsage(), raw: null };

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => line.startsWith("{") || line.startsWith("["))) {
    try {
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      return parseEventStream(events);
    } catch {
      // Fall through to a single JSON value or plain text.
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return fromRecord(parsed as Record<string, unknown>, parsed);
    }
  } catch {
    // Plain text answer.
  }
  return { result: trimmed, diff: "", usage: emptyUsage(), raw: trimmed };
}

export function parseReview(text: string): ReviewVerdict {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object") {
    throw new Error("review payload was not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.verdict !== "pass" && record.verdict !== "reject") {
    throw new Error("review verdict must be pass or reject");
  }
  const reasons = Array.isArray(record.reasons) ? record.reasons.map((item) => String(item)) : [];
  const feedback = typeof record.feedback === "string" ? record.feedback : "";
  return { verdict: record.verdict, reasons, feedback };
}

export function parsePlan(text: string): PlannedTask[] {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object") {
    throw new Error("planner payload was not an object");
  }
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("planner returned no tasks");
  }
  return tasks.map((task, index) => {
    if (!task || typeof task !== "object") {
      throw new Error(`task ${index} is not an object`);
    }
    const record = task as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const title = String(record.title ?? "").trim();
    const instructions = String(record.instructions ?? "").trim();
    if (!id || !title || !instructions) {
      throw new Error(`task ${index} is missing id, title, or instructions`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`task id ${id} must match [A-Za-z0-9._-]+`);
    }
    const acceptance = Array.isArray(record.acceptance) ? record.acceptance.map((item) => String(item)) : [];
    const testRaw = record.test_command ?? record.testCommand;
    const testCommand = typeof testRaw === "string" && testRaw.trim() ? testRaw.trim() : undefined;
    return { id, title, instructions, acceptance, testCommand };
  });
}
