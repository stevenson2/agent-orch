#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveDesktopLaunch } from "./adapters/zcode-desktop-launch.js";
import { loadConfig } from "./config.js";
import { serveMcp } from "./mcp.js";
import { runPipeline } from "./pipeline.js";
import { formatStatusText, getRun, getTask, listEvents, listRuns, summarizeRun } from "./query.js";
import { findOnPath } from "./spawn.js";

function printHelp(): void {
  process.stdout.write(`agent-orch 0.1.0

用法
  orch run <plan.md> [--config orch.yaml] [--cwd <dir>]
  orch status [--config orch.yaml] [--run <id>] [--task <id>] [--events] [--json]
  orch mcp [--config orch.yaml]
  orch doctor [--config orch.yaml]

说明
  run      规划 → 分工作树执行 → 测试 → 跨厂商审查
  status   读取磁盘上的运行快照，供本机或远程助手查询
  mcp      stdio MCP：run_plan / list_runs / get_run / get_task / list_events
  doctor   检查配置，并报告各 harness 命令是否在 PATH 上
`);
}

function commandExists(command: string): boolean {
  return Boolean(findOnPath(command));
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string" },
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
      run: { type: "string" },
      task: { type: "string" },
      events: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const configPath = parsed.values.config
    ? path.resolve(parsed.values.config)
    : path.resolve("orch.yaml");

  if (command === "doctor") {
    const config = await loadConfig(configPath, parsed.values.cwd);
    process.stdout.write(`配置 ${configPath}\n工作区 ${config.workspace}\n产物 ${config.artifactsDir}\n`);
    for (const vendor of config.vendors) {
      if (!vendor.enabled) {
        process.stdout.write(
          `关闭  ${vendor.id}  adapter=${vendor.adapter}  command=${vendor.command}  roles=${vendor.roles.join(",")}\n`,
        );
        continue;
      }
      const found =
        vendor.adapter === "zcode-desktop"
          ? !("error" in
              resolveDesktopLaunch({
                command: vendor.command,
                commandArgs: vendor.commandArgs,
                cwd: config.workspace,
              }))
          : commandExists(vendor.command);
      process.stdout.write(
        `${found ? "OK" : "缺失"}  ${vendor.id}  adapter=${vendor.adapter}  command=${vendor.command}  roles=${vendor.roles.join(",")}\n`,
      );
    }
    process.stdout.write("未安装的命令只影响真实运行；测试使用注入的假 CLI。\n");
    return 0;
  }

  if (command === "mcp") {
    const config = await loadConfig(configPath, parsed.values.cwd);
    await serveMcp({ artifactsDir: config.artifactsDir, config });
    return 0;
  }

  if (command === "status") {
    const config = await loadConfig(configPath, parsed.values.cwd);
    if (parsed.values.events) {
      const events = await listEvents(config.artifactsDir);
      process.stdout.write(`${JSON.stringify(events, null, parsed.values.json ? 2 : 2)}\n`);
      return 0;
    }
    if (parsed.values.run && parsed.values.task) {
      const task = await getTask(config.artifactsDir, parsed.values.run, parsed.values.task);
      if (!task) {
        process.stderr.write(`未找到任务 ${parsed.values.run}/${parsed.values.task}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
      return 0;
    }
    if (parsed.values.run) {
      const run = await getRun(config.artifactsDir, parsed.values.run);
      if (!run) {
        process.stderr.write(`未找到运行 ${parsed.values.run}\n`);
        return 1;
      }
      process.stdout.write(
        parsed.values.json ? `${JSON.stringify(run, null, 2)}\n` : formatStatusText([run]),
      );
      return 0;
    }
    const runs = await listRuns(config.artifactsDir);
    process.stdout.write(
      parsed.values.json
        ? `${JSON.stringify(runs.map(summarizeRun), null, 2)}\n`
        : formatStatusText(runs),
    );
    return 0;
  }

  if (command === "run") {
    const planPath = parsed.positionals[0];
    if (!planPath) {
      process.stderr.write("缺少计划文件。用法：orch run <plan.md> [--config orch.yaml]\n");
      return 1;
    }
    const absPlan = path.resolve(planPath);
    const config = await loadConfig(configPath, parsed.values.cwd);
    const planText = await fs.readFile(absPlan, "utf8");
    const result = await runPipeline({ planText, planPath: absPlan, config });
    const summary = {
      runId: result.runId,
      status: result.status,
      artifacts: config.artifactsDir,
      error: result.state.error ?? null,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (result.status === "passed") return 0;
    if (result.status === "escalated") return 2;
    return 1;
  }

  process.stderr.write(`未知命令 ${command}\n`);
  printHelp();
  return 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(fileURLToPath(import.meta.url));
const isDirect = entry !== "" && entry === self;

if (isDirect) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

export { main };
