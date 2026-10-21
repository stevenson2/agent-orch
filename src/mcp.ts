import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { runPipeline } from "./pipeline.js";
import { getRun, getTask, listEvents, listRuns } from "./query.js";
import type { Config } from "./types.js";

export interface McpContext {
  artifactsDir: string;
  config?: Config;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "run_plan",
    description:
      "Run plan → worktree execute → test → cross-vendor review. The caller stays the brain; orch drives the other headless CLIs.",
    inputSchema: {
      type: "object",
      properties: {
        planPath: { type: "string", description: "Path to a markdown plan." },
        planText: { type: "string", description: "Plan markdown. Used when planPath is omitted." },
      },
    },
  },
  {
    name: "list_runs",
    description: "List orchestrator runs, newest first, including status, vendors, rounds, verdicts, and usage.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum runs to return. Omit for all." },
      },
    },
  },
  {
    name: "get_run",
    description: "Return the latest snapshot of one run, including tasks, quota, and usage.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, run_id: { type: "string" } },
    },
  },
  {
    name: "get_task",
    description: "Return one task inside a run: assignee vendors, round, verdict, reasons, usage, and errors.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        run_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["runId", "taskId"],
    },
  },
  {
    name: "list_events",
    description: "Return notable append-only events (reject, escalation, quota failover/exhaustion, run finished).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
];

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function stringArg(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export async function handleMcpMessage(
  context: McpContext,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const request = message as JsonRpcRequest;
  const id = request.id ?? null;
  if (request.id === undefined) {
    return null;
  }
  try {
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-orch", version: "0.1.0" },
        },
      };
    }
    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (request.method === "tools/call") {
      const params = request.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      return { jsonrpc: "2.0", id, result: await callTool(context, name, args) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${request.method ?? ""}` } };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function callTool(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const artifactsDir = context.artifactsDir;
  if (name === "run_plan") {
    if (!context.config) return toolResult({ error: "MCP server has no orchestrator config loaded" }, true);
    const planPath = stringArg(args, "planPath", "plan_path");
    let planText = stringArg(args, "planText", "plan_text");
    let resolved = planPath ?? "mcp-plan.md";
    if (!planText) {
      if (!planPath) return toolResult({ error: "planPath or planText is required" }, true);
      resolved = path.resolve(planPath);
      planText = await fs.readFile(resolved, "utf8");
    }
    const result = await runPipeline({
      planText,
      planPath: resolved,
      config: context.config,
    });
    return toolResult({
      runId: result.runId,
      status: result.status,
      error: result.state.error ?? null,
      artifactsDir,
    });
  }
  if (name === "list_runs") {
    const runs = await listRuns(artifactsDir);
    const limit = typeof args.limit === "number" ? args.limit : runs.length;
    return toolResult(runs.slice(0, limit));
  }
  if (name === "get_run") {
    const runId = stringArg(args, "runId", "run_id");
    if (!runId) return toolResult({ error: "runId is required" }, true);
    const run = await getRun(artifactsDir, runId);
    if (!run) return toolResult({ error: `run not found: ${runId}` }, true);
    return toolResult(run);
  }
  if (name === "get_task") {
    const runId = stringArg(args, "runId", "run_id");
    const taskId = stringArg(args, "taskId", "task_id");
    if (!runId || !taskId) return toolResult({ error: "runId and taskId are required" }, true);
    const task = await getTask(artifactsDir, runId, taskId);
    if (!task) return toolResult({ error: `task not found: ${runId}/${taskId}` }, true);
    return toolResult(task);
  }
  if (name === "list_events") {
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return toolResult(await listEvents(artifactsDir, limit));
  }
  return toolResult({ error: `unknown tool ${name}` }, true);
}

export async function serveMcp(
  context: McpContext,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      continue;
    }
    const response = await handleMcpMessage(context, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
