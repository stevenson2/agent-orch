import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { main } from "../src/cli.js";
import { handleMcpMessage } from "../src/mcp.js";
import { PLAN_MD, baseConfig, fakeVendors, initRepo, makeTempDir, repoRoot } from "./helpers.js";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "src", "cli.ts"), ...args], {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("status CLI and MCP", () => {
  it("answers list_runs, get_run, and get_task from the artifact log", async () => {
    const root = await makeTempDir("orch-mcp-");
    const repo = path.join(root, "repo");
    const artifacts = path.join(repo, ".orch");
    await initRepo(repo);
    const config = baseConfig(repo, artifacts, fakeVendors(path.join(root, "state.json")));
    const context = { artifactsDir: artifacts, config };
    const started = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_plan", arguments: { planText: PLAN_MD, planPath: "plan.md" } },
    });
    const startedPayload = JSON.parse(
      (started?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}",
    ) as { runId: string; status: string };
    expect(startedPayload.status).toBe("passed");

    const listed = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(tools).toEqual(["run_plan", "list_runs", "get_run", "get_task", "list_events"]);

    const runs = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_runs", arguments: {} },
    });
    const runsText = (runs?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(runsText).toContain(startedPayload.runId);

    const one = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_run", arguments: { runId: startedPayload.runId } },
    });
    expect((one?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('"status": "passed"');

    const task = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_task", arguments: { run_id: startedPayload.runId, task_id: "hello" } },
    });
    expect((task?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('"verdict": "pass"');

    const missing = await handleMcpMessage(context, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_task", arguments: { runId: startedPayload.runId, taskId: "missing" } },
    });
    expect((missing?.result as { isError: boolean }).isError).toBe(true);

    const yaml = stringify({
      version: 1,
      workspace: repo,
      artifacts_dir: artifacts,
      max_review_rounds: 2,
      on_exhaust: "human",
      roles: { planner: { prefer: [] }, executor: { prefer: [] }, reviewer: { prefer: [] } },
      vendors: {
        anthropic: {
          harness: "claude",
          adapter: "command",
          command: "claude",
          args: ["-p", "{prompt}"],
          roles: ["planner"],
        },
      },
    });
    const configPath = path.join(root, "orch.yaml");
    await fs.writeFile(configPath, yaml);

    const previous = process.argv;
    process.argv = ["node", path.join(repoRoot, "src", "cli.ts"), "status", "--config", configPath, "--json"];
    let code = 1;
    let stdout = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      code = await main(["status", "--config", configPath, "--json"]);
    } finally {
      process.stdout.write = write;
      process.argv = previous;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Array<{ id: string; status: string }>;
    expect(parsed[0]?.id).toBe(startedPayload.runId);
    expect(parsed[0]?.status).toBe("passed");

    const cli = await runCli(["status", "--config", configPath, "--run", startedPayload.runId, "--task", "hello"]);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain('"id": "hello"');

    const mcp = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "src", "cli.ts"), "mcp", "--config", configPath], {
        cwd: repoRoot,
        env: process.env,
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.trim().length > 0) child.kill();
      });
      child.on("error", reject);
      child.on("close", () => resolve({ stdout: out }));
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        })}\n`,
      );
    });
    const init = JSON.parse(mcp.stdout.trim().split("\n")[0] ?? "{}") as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(init.result?.serverInfo?.name).toBe("agent-orch");
  });
});
