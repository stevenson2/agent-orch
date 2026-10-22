import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { detectRateLimit } from "../spawn.js";
import type { TokenUsage } from "../types.js";
import { emptyUsage } from "../types.js";
import {
  credentialFilePath,
  credentialSecret,
  loadCodingPlanKeys,
  selectCodingPlanKey,
} from "./zcode-desktop-credentials.js";
import type { RunResult } from "./types.js";

export interface ProtocolIo {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export interface ProtocolRunInput {
  task: string;
  cwd: string;
  mode: "plan" | "edit" | "yolo" | "build";
  planEnabled: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Text of the agent bundle (zcode.cjs). Optional preference keys are sent
   * only when this text contains their names. Empty means the oldest shape.
   */
  bundleText?: string;
}

interface RowState {
  kind: string;
  text: string;
}

interface SessionView {
  phase: string;
  rows: Map<number, RowState>;
  usage: TokenUsage;
  lastError: string;
}

const COMPUTER_USE = /browser|computer[-_ ]?use|\bcua\b/i;
const TERMINAL = new Set(["completedSuccess", "completedInterrupted", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeLine(stdin: Writable, value: unknown): void {
  stdin.write(`${JSON.stringify(value)}\n`);
}

export async function runDesktopProtocol(io: ProtocolIo, input: ProtocolRunInput): Promise<RunResult> {
  const view: SessionView = { phase: "", rows: new Map(), usage: emptyUsage(), lastError: "" };
  let stderr = "";
  io.stderr.setEncoding?.("utf8");
  io.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const tolerated = { bundleText: input.bundleText ?? "", omitted: new Set<string>() };
  let buffer = "";
  let failed = "";
  const storageGate: { phase: "pending" | "ready" | "failed"; error: string } = {
    phase: "pending",
    error: "",
  };
  const storageWaiters: Array<() => void> = [];
  const phaseWaiters: Array<() => void> = [];

  const wake = (list: Array<() => void>) => {
    const copy = list.splice(0, list.length);
    for (const fn of copy) fn();
  };

  const onLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      failed = failed || `non-json protocol line: ${line.slice(0, 200)}`;
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "string" && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        const err = isRecord(message.error) ? String(message.error.message ?? message.error.code) : String(message.error);
        waiter.reject(new Error(err));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === "string" && typeof message.method === "string") {
      const result = answerReverse(message.method, message.params, input, tolerated);
      if (result.ok) writeLine(io.stdin, { id: message.id, result: result.value });
      else writeLine(io.stdin, { id: message.id, error: { code: result.code, message: result.message } });
      return;
    }
    if (message.method === "startup/storageState" && isRecord(message.params)) {
      const phase = String(message.params.phase ?? "");
      if (phase === "ready") storageGate.phase = "ready";
      if (phase === "failed") {
        storageGate.phase = "failed";
        storageGate.error = String(message.params.errorCode ?? "storage failed");
      }
      wake(storageWaiters);
      return;
    }
    if (message.method === "v4/conversation/frame") {
      applyWire(view, message.params, fragments);
      wake(phaseWaiters);
    }
  };

  const fragments = new Map<string, { count: number; parts: string[] }>();
  io.stdout.on("end", () => {
    if (!failed) failed = "agent stdout closed";
    if (storageGate.phase === "pending") {
      storageGate.phase = "failed";
      storageGate.error = storageGate.error || "agent stdout closed";
    }
    for (const waiter of pending.values()) waiter.reject(new Error(failed));
    pending.clear();
    wake(storageWaiters);
    wake(phaseWaiters);
  });
  io.stdout.setEncoding?.("utf8");
  io.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
      nl = buffer.indexOf("\n");
    }
  });

  const request = (method: string, params: unknown) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        writeLine(io.stdin, { id, method, params });
      }),
      remaining(),
      method,
    );

  const deadline = Date.now() + input.timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  try {
    await waitUntil(() => storageGate.phase !== "pending" || failed !== "", remaining(), storageWaiters, 8_000);
    if (failed) throw new Error(failed);
    if (storageGate.phase === "failed") {
      throw new Error(`ZCode storage startup failed: ${storageGate.error}`);
    }

    const clientId = `orch-${randomUUID()}`;
    let sessionId: string | undefined;
    for (let attempt = 0; attempt < 2 && !sessionId; attempt++) {
      let ack: unknown;
      try {
        ack = await request("v4/command", {
          commandId: randomUUID(),
          clientId,
          sessionId: null,
          type: "createSession",
          payload: createSessionPayload(input, tolerated.omitted),
          issuedAt: Date.now(),
        });
      } catch (error) {
        const extra = unrecognizedKeysIn(error instanceof Error ? error.message : String(error));
        if (attempt === 1 || extra.length === 0) throw error;
        for (const key of extra) tolerated.omitted.add(key);
        continue;
      }
      sessionId = readSessionId(ack);
      if (sessionId) break;
      const extra = unrecognizedKeysIn(ack);
      if (attempt === 1 || extra.length === 0) {
        throw new Error(`createSession was not accepted: ${JSON.stringify(ack).slice(0, 500)}`);
      }
      for (const key of extra) tolerated.omitted.add(key);
    }
    if (!sessionId) throw new Error("createSession was not accepted");

    await request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: clientId,
      clientMode: "desktop-continuous",
      visibility: "foreground",
    });

    await waitUntil(() => TERMINAL.has(view.phase) || failed !== "", remaining(), phaseWaiters, remaining());
    if (failed) throw new Error(failed);
    if (!TERMINAL.has(view.phase)) throw new Error("timed out waiting for the ZCode session to finish");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out/i.test(message);
    return finish(view, stderr, message, timedOut ? 124 : 1, timedOut);
  }

  const text = assistantText(view);
  const blob = `${text}\n${view.lastError}\n${stderr}`;
  const rateLimited = detectRateLimit(0, blob, stderr);
  const ok = view.phase === "completedSuccess" && !rateLimited;
  return finish(view, stderr, ok ? "" : view.lastError || view.phase, ok ? 0 : 1, false);
}

function finish(view: SessionView, stderr: string, error: string, exitCode: number, timedOut: boolean): RunResult {
  const text = assistantText(view);
  const blob = `${text}\n${error}\n${stderr}`;
  return {
    result: text || error,
    diff: "",
    usage: view.usage,
    exitCode,
    stdout: text,
    stderr: error ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${error}` : stderr,
    rateLimited: detectRateLimit(exitCode, blob, stderr),
    timedOut,
    raw: { phase: view.phase, lastError: view.lastError },
  };
}

function assistantText(view: SessionView): string {
  return [...view.rows.entries()]
    .filter(([, row]) => row.kind === "assistantText")
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Required createSession fields only, plus planEnabled when this run is a plan.
 * Older app-server builds use a strict object and reject keys they do not know.
 */
export function createSessionPayload(input: ProtocolRunInput, omitted: ReadonlySet<string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (!omitted.has("mode")) config.mode = input.mode;
  if (input.planEnabled && !omitted.has("planEnabled")) config.planEnabled = true;
  const firstInput: Record<string, unknown> = {};
  if (!omitted.has("text")) firstInput.text = input.task;
  if (input.planEnabled && !omitted.has("planEnabled")) firstInput.planEnabled = true;
  const payload: Record<string, unknown> = {};
  if (!omitted.has("workspaceId")) payload.workspaceId = input.cwd;
  if (!omitted.has("config") && Object.keys(config).length > 0) payload.config = config;
  if (!omitted.has("firstInput") && Object.keys(firstInput).length > 0) payload.firstInput = firstInput;
  return payload;
}

/**
 * Keys the current main schema defaults, sent only when zcode.cjs still mentions them.
 * nativeSearchEnhancementsEnabled has no default and is always sent unless a retry drops it.
 */
export function runtimePreferences(bundleText: string, omitted: ReadonlySet<string>): Record<string, unknown> {
  const value: Record<string, unknown> = {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
  };
  if (bundleText.includes("toolSearchMode")) value.toolSearchMode = "off";
  if (bundleText.includes("modelContextBudgetStrategy")) value.modelContextBudgetStrategy = "preflight-v1";
  for (const key of omitted) delete value[key];
  return value;
}

/** Zod strict() reports `unrecognized_keys` inside the command failure message. */
export function unrecognizedKeysIn(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      const start = node.indexOf("[");
      const end = node.lastIndexOf("]");
      if (start < 0 || end <= start) return;
      try {
        visit(JSON.parse(node.slice(start, end + 1)));
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.code === "unrecognized_keys" && Array.isArray(node.keys)) {
      for (const key of node.keys) {
        if (typeof key === "string" && key) found.push(key);
      }
    }
    if (typeof node.message === "string") visit(node.message);
  };
  visit(value);
  return found;
}

function readSessionId(ack: unknown): string | undefined {
  if (!isRecord(ack)) return undefined;
  const status = String(ack.status ?? "");
  if (status !== "accepted" && status !== "duplicate") return undefined;
  const result = ack.result;
  if (!isRecord(result)) return undefined;
  return typeof result.sessionId === "string" ? result.sessionId : undefined;
}

function withTimeout<T>(promise: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), Math.max(1, budgetMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitUntil(
  ready: () => boolean,
  budgetMs: number,
  waiters: Array<() => void>,
  capMs: number,
): Promise<void> {
  const limit = Math.min(budgetMs, capMs);
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start >= limit) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(done);
        if (index >= 0) waiters.splice(index, 1);
        resolve();
      }, Math.max(1, limit - (Date.now() - start)));
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(done);
    });
  }
}

function applyWire(
  view: SessionView,
  params: unknown,
  fragments: Map<string, { count: number; parts: string[] }>,
): void {
  if (isRecord(params) && params.kind === "fragment" && typeof params.dataBase64 === "string") {
    const id = String(params.logicalFrameId ?? "");
    const index = Number(params.fragmentIndex);
    const count = Number(params.fragmentCount);
    if (!id || !Number.isInteger(index) || !Number.isInteger(count) || count < 1) return;
    const bucket = fragments.get(id) ?? { count, parts: [] };
    bucket.parts[index] = Buffer.from(params.dataBase64, "base64").toString("utf8");
    fragments.set(id, bucket);
    if (bucket.parts.filter((part) => part !== undefined).length !== bucket.count) return;
    try {
      applyFrame(view, JSON.parse(bucket.parts.join("")));
    } catch {
      return;
    }
    return;
  }
  applyFrame(view, params);
}

function applyFrame(view: SessionView, params: unknown): void {
  const logical = unwrapFrame(params);
  if (!logical) return;
  const payload = isRecord(logical.payload) ? logical.payload : logical;
  if (!isRecord(payload)) return;
  if (payload.kind === "snapshot" && isRecord(payload.snapshot)) {
    applySnapshot(view, payload.snapshot);
    return;
  }
  if (payload.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const delta of payload.deltas) applyDelta(view, delta);
  }
}

function unwrapFrame(params: unknown): Record<string, unknown> | undefined {
  if (!isRecord(params)) return undefined;
  if (params.kind === "complete" && isRecord(params.frame)) return params.frame;
  if (params.kind === "fragment") return undefined;
  return params;
}

function applySnapshot(view: SessionView, snapshot: Record<string, unknown>): void {
  const control = isRecord(snapshot.control) ? snapshot.control : undefined;
  if (control && typeof control.phase === "string") view.phase = control.phase;
  if (control && isRecord(control.lastError) && typeof control.lastError.message === "string") {
    view.lastError = control.lastError.message;
  }
  applyUsage(view, snapshot.usage);
  if (Array.isArray(snapshot.rows)) {
    view.rows.clear();
    for (const row of snapshot.rows) rememberRow(view, row);
  }
}

function applyDelta(view: SessionView, delta: unknown): void {
  if (!isRecord(delta) || typeof delta.op !== "string") return;
  if (delta.op === "row.appended" || delta.op === "row.upserted") rememberRow(view, delta.row);
  if (delta.op === "row.removed" && typeof delta.fromRowId === "number") {
    for (const id of [...view.rows.keys()]) {
      if (id >= delta.fromRowId) view.rows.delete(id);
    }
  }
  if (delta.op === "row.delta" && typeof delta.rowId === "number" && typeof delta.append === "string") {
    const row = view.rows.get(delta.rowId);
    if (row && (delta.path === "text" || delta.path === undefined)) row.text += delta.append;
  }
  if (delta.op === "state.updated" && isRecord(delta.patch)) {
    const control = isRecord(delta.patch.control) ? delta.patch.control : undefined;
    if (control && typeof control.phase === "string") view.phase = control.phase;
    if (control && isRecord(control.lastError) && typeof control.lastError.message === "string") {
      view.lastError = control.lastError.message;
    }
    applyUsage(view, delta.patch.usage);
  }
}

function rememberRow(view: SessionView, row: unknown): void {
  if (!isRecord(row) || typeof row.rowId !== "number" || typeof row.kind !== "string") return;
  view.rows.set(row.rowId, { kind: row.kind, text: typeof row.text === "string" ? row.text : "" });
}

function applyUsage(view: SessionView, usage: unknown): void {
  if (!isRecord(usage) || !isRecord(usage.cumulative)) return;
  const cumulative = usage.cumulative;
  const inputTokens = numberOf(cumulative.inputTokens);
  const outputTokens = numberOf(cumulative.outputTokens);
  view.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function answerReverse(
  method: string,
  params: unknown,
  input: ProtocolRunInput,
  tolerated: { bundleText: string; omitted: ReadonlySet<string> },
): { ok: true; value: unknown } | { ok: false; code: number; message: string } {
  if (method === "session/requestRuntimePreferences") {
    return { ok: true, value: runtimePreferences(tolerated.bundleText, tolerated.omitted) };
  }
  if (method === "interaction/requestPermission") {
    return { ok: true, value: permissionResponse(params, input.planEnabled) };
  }
  if (method === "interaction/requestUserInput") {
    return { ok: true, value: { action: "decline", reason: "headless orchestrator does not answer questions" } };
  }
  if (method === "interaction/requestProviderRuntimeHeaders") {
    return { ok: true, value: providerHeaders(params, input.env) };
  }
  if (method === "interaction/requestOfficialMcpAuthHeaders") {
    return { ok: true, value: { ok: false, reason: "official_auth_unavailable" } };
  }
  if (method === "interaction/browserList" || method === "interaction/browserExecute") {
    return { ok: false, code: -32603, message: "browser use and computer use are disabled" };
  }
  return { ok: false, code: -32601, message: `orch zcode-desktop does not implement ${method}` };
}

function permissionResponse(params: unknown, planEnabled: boolean): { decision: "allow" | "deny"; reason?: string } {
  const toolName = isRecord(params) && typeof params.toolName === "string" ? params.toolName : "";
  if (COMPUTER_USE.test(toolName)) {
    return { decision: "deny", reason: "browser use and computer use are disabled" };
  }
  if (planEnabled && !/read|glob|grep|search/i.test(toolName)) {
    return { decision: "deny", reason: "plan mode refuses tools that are not read-only" };
  }
  const options = isRecord(params) && Array.isArray(params.options) ? params.options : [];
  for (const option of options) {
    if (!isRecord(option) || !isRecord(option.response)) continue;
    if (option.response.decision === "allow") {
      return { decision: "allow" };
    }
  }
  return { decision: "allow" };
}

function providerHeaders(params: unknown, env: NodeJS.ProcessEnv | undefined): unknown {
  const providerId = isRecord(params) && typeof params.providerId === "string" ? params.providerId : undefined;
  const runtimeEnv = env ?? process.env;
  const keys = loadCodingPlanKeys(credentialFilePath(runtimeEnv), credentialSecret(runtimeEnv));
  const selected = selectCodingPlanKey(keys, providerId);
  if (!selected) {
    return {
      headersApplied: false,
      errorMessage:
        "no individual Coding Plan api key in the shared ZCode credential file; team and start plans stay on the desktop host",
    };
  }
  return { headersApplied: true, requestAuth: { apiKey: selected.apiKey } };
}
