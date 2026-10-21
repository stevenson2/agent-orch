import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess } from "../src/spawn.js";
import type { Config, VendorConfig } from "../src/types.js";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fakeAgent = path.join(repoRoot, "tests", "fixtures", "fake-agent.mjs");
export const fakeDesktop = path.join(repoRoot, "tests", "fixtures", "zcode-desktop-fake.mjs");

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const git = async (args: string[]) => {
    const result = await spawnProcess({ command: "git", args, cwd: dir });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
    }
  };
  await git(["init"]);
  await git(["config", "user.email", "orch@example.com"]);
  await git(["config", "user.name", "orch"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(dir, "README.md"), "base\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "init"]);
}

export function baseVendor(overrides: Partial<VendorConfig> & Pick<VendorConfig, "id" | "adapter" | "roles">): VendorConfig {
  return {
    harness: overrides.harness ?? overrides.id,
    command: overrides.command ?? "fake",
    commandArgs: overrides.commandArgs ?? [],
    args: overrides.args ?? [],
    modeArgs: overrides.modeArgs ?? {},
    acpxAgent: overrides.acpxAgent,
    enabled: overrides.enabled ?? true,
    outputFormat: overrides.outputFormat ?? "json",
    zcodeExecuteMode: overrides.zcodeExecuteMode ?? "edit",
    subscriptionMultiplier: overrides.subscriptionMultiplier ?? 1,
    listCostPer1kTokens: overrides.listCostPer1kTokens ?? 1,
    quotas: overrides.quotas ?? [],
    cooldownSeconds: overrides.cooldownSeconds ?? 900,
    timeoutMs: overrides.timeoutMs ?? 20_000,
    env: overrides.env ?? {},
    id: overrides.id,
    adapter: overrides.adapter,
    roles: overrides.roles,
  };
}

export function baseConfig(workspace: string, artifactsDir: string, vendors: VendorConfig[]): Config {
  return {
    version: 1,
    workspace,
    artifactsDir,
    maxReviewRounds: 2,
    onExhaust: "human",
    webhook: undefined,
    roles: {
      planner: { prefer: ["anthropic"] },
      executor: { prefer: [] },
      reviewer: { prefer: [] },
    },
    vendors,
  };
}

export const PLAN_MD = `# 写 hello 文件

\`\`\`json
{
  "tasks": [
    {
      "id": "hello",
      "title": "Write hello",
      "instructions": "Create hello.txt containing exactly hello",
      "acceptance": ["hello.txt equals hello"],
      "test_command": "node -e \\"const fs=require('fs'); if (fs.readFileSync('hello.txt','utf8').trim()!=='hello') process.exit(1)\\""
    }
  ]
}
\`\`\`
`;

export function fakeVendors(stateFile: string, extraEnv: Record<string, string> = {}): VendorConfig[] {
  const shared = {
    command: process.execPath,
    timeoutMs: 20_000,
    quotas: [
      { name: "five_hour", windowSeconds: 18_000, limitTokens: 100_000 },
      { name: "weekly", windowSeconds: 604_800, limitTokens: 500_000 },
    ],
  };
  const envFor = (vendor: string, more: Record<string, string> = {}) => ({
    ORCH_FAKE_VENDOR: vendor,
    ORCH_FAKE_STATE: stateFile,
    ...extraEnv,
    ...more,
  });
  return [
    baseVendor({
      ...shared,
      id: "anthropic",
      harness: "claude",
      adapter: "command",
      commandArgs: [fakeAgent, "--kind", "generic"],
      args: ["-p", "{prompt}"],
      modeArgs: { plan: ["--permission-mode", "plan"] },
      roles: ["planner"],
      listCostPer1kTokens: 15,
      subscriptionMultiplier: 1,
      env: envFor("anthropic"),
    }),
    baseVendor({
      ...shared,
      id: "zhipu",
      harness: "zcode-desktop",
      adapter: "zcode-desktop",
      commandArgs: [fakeDesktop],
      roles: ["executor"],
      listCostPer1kTokens: 0.5,
      subscriptionMultiplier: 1,
      env: envFor("zhipu"),
    }),
    baseVendor({
      ...shared,
      id: "deepseek",
      harness: "dsh",
      adapter: "dsh",
      commandArgs: [fakeAgent, "--kind", "dsh"],
      roles: ["executor", "reviewer"],
      listCostPer1kTokens: 1,
      subscriptionMultiplier: 1,
      env: envFor("deepseek"),
    }),
    baseVendor({
      ...shared,
      id: "google",
      harness: "gemini",
      adapter: "acpx",
      acpxAgent: "gemini",
      commandArgs: [fakeAgent, "--kind", "acpx"],
      roles: ["reviewer"],
      listCostPer1kTokens: 3,
      subscriptionMultiplier: 1,
      env: envFor("google"),
    }),
  ];
}
