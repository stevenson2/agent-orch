import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AcpxAdapter } from "../src/adapters/acpx.js";
import { CommandAdapter } from "../src/adapters/command.js";
import { DshAdapter } from "../src/adapters/dsh.js";
import { ZCodeAdapter } from "../src/adapters/zcode.js";
import { detectRateLimit, spawnProcess, type SpawnRequest } from "../src/spawn.js";
import { fakeAgent } from "./helpers.js";

function capture() {
  const calls: SpawnRequest[] = [];
  return {
    calls,
    spawner: async (request: SpawnRequest) => {
      calls.push(request);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
}

describe("headless adapters", () => {
  it("builds the ZCode -p json invocation and parses the summary", async () => {
    const seen: SpawnRequest[] = [];
    const adapter = new ZCodeAdapter({
      vendor: "zhipu",
      command: "zcode",
      spawner: async (request) => {
        seen.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: "done",
            sessionId: "s",
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    const result = await adapter.run({ task: "plan the change", cwd: "/repo", mode: "plan" });
    expect(seen[0]?.command).toBe("zcode");
    expect(seen[0]?.args).toEqual([
      "-p",
      "plan the change",
      "--output-format",
      "json",
      "--mode",
      "plan",
      "--cwd",
      "/repo",
    ]);
    expect(seen[0]?.cwd).toBe("/repo");
    expect(result.result).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(result.exitCode).toBe(0);
    expect(result.rateLimited).toBe(false);
  });

  it("uses edit for ZCode execution and stream-json when configured", async () => {
    const bag = capture();
    const adapter = new ZCodeAdapter({
      vendor: "zhipu",
      command: "zcode",
      commandArgs: ["--kind", "zcode"],
      outputFormat: "stream-json",
      spawner: bag.spawner,
    });
    await adapter.run({ task: "implement", cwd: "/work", mode: "execute" });
    expect(bag.calls[0]?.args).toContain("--mode");
    expect(bag.calls[0]?.args).toContain("edit");
    expect(bag.calls[0]?.args).toContain("stream-json");
    const review = new ZCodeAdapter({
      vendor: "zhipu",
      command: "zcode",
      executeMode: "yolo",
      spawner: bag.spawner,
    });
    await review.run({ task: "review", cwd: "/work", mode: "review" });
    expect(bag.calls[1]?.args).toContain("plan");
    await review.run({ task: "ship", cwd: "/work", mode: "execute" });
    expect(bag.calls[2]?.args).toContain("yolo");
  });

  it("parses a ZCode stream-json result and a 429", async () => {
    const adapter = new ZCodeAdapter({
      vendor: "zhipu",
      command: "zcode",
      outputFormat: "stream-json",
      spawner: async () => ({
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", text: "partial" }),
          JSON.stringify({ type: "result", response: "final answer", usage: { input_tokens: 1, output_tokens: 2 } }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
      }),
    });
    const ok = await adapter.run({ task: "t", cwd: "/w", mode: "execute" });
    expect(ok.result).toBe("final answer");
    expect(ok.usage.totalTokens).toBe(3);

    const limited = new ZCodeAdapter({
      vendor: "zhipu",
      command: "zcode",
      spawner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "429 rate limit exceeded",
        timedOut: false,
      }),
    });
    const blocked = await limited.run({ task: "t", cwd: "/w", mode: "execute" });
    expect(blocked.rateLimited).toBe(true);
    expect(blocked.exitCode).toBe(1);
  });

  it("invokes dsh --profile headless --json in the worktree cwd", async () => {
    const seen: SpawnRequest[] = [];
    const adapter = new DshAdapter({
      vendor: "deepseek",
      command: "dsh",
      spawner: async (request) => {
        seen.push(request);
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "session", sessionId: "s" }),
            JSON.stringify({ type: "thinking", text: "hidden" }),
            JSON.stringify({ type: "text", text: "hello from dsh" }),
            JSON.stringify({ type: "final", text: "hello from dsh", reason: "completed", usage: { input_tokens: 8, output_tokens: 2 } }),
          ].join("\n"),
          stderr: "",
          timedOut: false,
        };
      },
    });
    const result = await adapter.run({ task: "run the tests", cwd: "/tree", mode: "execute" });
    expect(seen[0]?.args).toEqual(["--profile", "headless", "--json", "run the tests"]);
    expect(seen[0]?.cwd).toBe("/tree");
    expect(result.result).toBe("hello from dsh");
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  });

  it("drives acpx exec with read approval for review and approve-all for execute", async () => {
    const bag = capture();
    const adapter = new AcpxAdapter({
      vendor: "google",
      command: "acpx",
      acpxAgent: "gemini",
      spawner: bag.spawner,
    });
    await adapter.run({ task: "review diff", cwd: "/tree", mode: "review" });
    expect(bag.calls[0]?.args).toEqual([
      "gemini",
      "exec",
      "--format",
      "json",
      "--cwd",
      "/tree",
      "--approve-reads",
      "review diff",
    ]);
    await adapter.run({ task: "edit code", cwd: "/tree", mode: "execute" });
    expect(bag.calls[1]?.args.at(-2)).toBe("--approve-all");
    await adapter.run({ task: "plan only", cwd: "/tree", mode: "plan" });
    expect(bag.calls[2]?.args).toContain("--approve-reads");
  });

  it("keeps a generic command prompt as one argv element", async () => {
    const bag = capture();
    const adapter = new CommandAdapter({
      vendor: "anthropic",
      harness: "claude",
      command: "claude",
      args: ["-p", "{prompt}", "--output-format", "json"],
      modeArgs: { plan: ["--permission-mode", "plan"] },
      spawner: bag.spawner,
    });
    const prompt = "hello; rm -rf /";
    await adapter.run({ task: prompt, cwd: "/repo", mode: "plan" });
    expect(bag.calls[0]?.command).toBe("claude");
    expect(bag.calls[0]?.args).toEqual([
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
    ]);
  });

  it("does not treat a token count of 4290 as a rate limit", () => {
    expect(detectRateLimit(0, '{"usage":{"total_tokens":4290}}', "")).toBe(false);
    expect(detectRateLimit(1, "", "quota exceeded")).toBe(true);
    expect(detectRateLimit(429, "", "")).toBe(true);
  });

  it("round-trips the fake CLI through each native adapter", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orch-adapter-"));
    const zcode = new ZCodeAdapter({
      vendor: "zhipu",
      command: process.execPath,
      commandArgs: [fakeAgent, "--kind", "zcode"],
      env: { ORCH_FAKE_VENDOR: "zhipu" },
      spawner: spawnProcess,
    });
    const planned = await zcode.run({
      task: "ORCH_ROLE: planner\nORCH_REPLAN: 0\n\nUSER_PLAN_BEGIN\n# plan\nUSER_PLAN_END\n",
      cwd,
      mode: "plan",
    });
    expect(planned.exitCode).toBe(0);
    expect(planned.result).toContain('"tasks"');
    expect(planned.usage.totalTokens).toBe(18);

    const dsh = new DshAdapter({
      vendor: "deepseek",
      command: process.execPath,
      commandArgs: [fakeAgent, "--kind", "dsh"],
      env: { ORCH_FAKE_VENDOR: "deepseek" },
      spawner: spawnProcess,
    });
    const executed = await dsh.run({
      task: "ORCH_ROLE: executor\nORCH_TASK_ID: other\nCreate notes.txt",
      cwd,
      mode: "execute",
    });
    expect(executed.result).toContain("deepseek");

    const acpx = new AcpxAdapter({
      vendor: "google",
      command: process.execPath,
      commandArgs: [fakeAgent, "--kind", "acpx"],
      acpxAgent: "gemini",
      env: { ORCH_FAKE_VENDOR: "google", ORCH_FAKE_ALWAYS_REJECT: "1" },
      spawner: spawnProcess,
    });
    const reviewed = await acpx.run({
      task: "ORCH_ROLE: reviewer\nORCH_TASK_ID: other\nORCH_REPLAN: 0\n",
      cwd,
      mode: "review",
    });
    expect(reviewed.result).toContain('"verdict":"reject"');
  });
});
