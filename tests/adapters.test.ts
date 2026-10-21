import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpxAdapter } from "../src/adapters/acpx.js";
import { CommandAdapter } from "../src/adapters/command.js";
import { DshAdapter } from "../src/adapters/dsh.js";
import { decryptCredentialValue, selectCodingPlanKey } from "../src/adapters/zcode-desktop-credentials.js";
import { resolveDesktopLaunch } from "../src/adapters/zcode-desktop-launch.js";
import { runDesktopProtocol } from "../src/adapters/zcode-desktop-protocol.js";
import { ZCodeDesktopAdapter } from "../src/adapters/zcode-desktop.js";
import { ZCodeAdapter } from "../src/adapters/zcode.js";
import {
  detectRateLimit,
  resolveSpawnCommand,
  shellCommand,
  spawnProcess,
  unwrapCmdShim,
  type SpawnRequest,
} from "../src/spawn.js";
import { fakeAgent, fakeDesktop } from "./helpers.js";

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

  it("launches the desktop bundle the way the GUI host does", () => {
    const exe = "C:\\Users\\cai\\AppData\\Local\\Programs\\ZCode\\ZCode.exe";
    const bundle = "C:\\Users\\cai\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    const launch = resolveDesktopLaunch({
      command: "ZCode",
      commandArgs: [],
      cwd: "D:\\work",
      platform: "win32",
      home: "C:\\Users\\cai",
      env: { LOCALAPPDATA: "C:\\Users\\cai\\AppData\\Local" },
      exists: (file) => file === exe || file === bundle,
    });
    expect("error" in launch).toBe(false);
    if ("error" in launch) return;
    expect(launch.command).toBe(exe);
    expect(launch.args.slice(0, 3)).toEqual([bundle, "app-server", "--stdio"]);
    expect(launch.args).toContain("--surface");
    expect(launch.args).toContain("desktop");
    expect(launch.args.at(-1)).toBe("D:\\work");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("unwraps an npm cmd shim and runs test scripts without sh", () => {
    const shim = "C:\\Users\\cai\\AppData\\Roaming\\npm\\codex.cmd";
    const script = "C:\\Users\\cai\\AppData\\Roaming\\npm\\node_modules\\codex\\bin\\codex.js";
    const body = `@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\codex\\bin\\codex.js" %*\r\n`;
    const unwrapped = unwrapCmdShim(shim, {
      readFile: () => body,
      exists: (file) => file === script,
    });
    expect(unwrapped?.script).toBe(script);
    const resolved = resolveSpawnCommand("codex", ["exec", "line\n2"], {
      platform: "win32",
      env: { PATH: "C:\\Users\\cai\\AppData\\Roaming\\npm", PATHEXT: ".CMD;.EXE" },
      exists: (file) => file === shim || file === script,
      readFile: () => body,
    });
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toBe(script);
    expect(resolved.args.slice(1)).toEqual(["exec", "line\n2"]);
    expect(shellCommand("node -e \"process.exit(0)\"", "D:\\repo", undefined, "win32").args).toEqual([
      "/d",
      "/s",
      "/c",
      "node -e \"process.exit(0)\"",
    ]);
  });

  it("drives a desktop protocol session and refuses browser tools", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    toAgent.setEncoding("utf8");
    let pending = "";
    toAgent.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        lines.push(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    });
    const run = runDesktopProtocol(
      { stdin: toAgent, stdout: fromAgent, stderr },
      { task: "Create hello.txt", cwd: "/repo", mode: "edit", planEnabled: false, timeoutMs: 5_000 },
    );
    const read = async () => {
      const start = Date.now();
      while (lines.length === 0) {
        if (Date.now() - start > 2000) throw new Error("no protocol request");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return JSON.parse(lines.shift() ?? "{}") as { id?: string; method?: string; params?: { type?: string } };
    };
    fromAgent.write(
      `${JSON.stringify({
        method: "startup/storageState",
        params: { schemaVersion: 1, attemptId: "a", sequence: 1, databaseId: "db", databaseKind: "session", phase: "ready", elapsedMs: 1 },
      })}\n`,
    );
    const created = await read();
    expect(created.method).toBe("v4/command");
    expect(created.params?.type).toBe("createSession");
    fromAgent.write(
      `${JSON.stringify({
        id: created.id,
        result: {
          commandId: "c1",
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "createSession", sessionId: "sess" },
        },
      })}\n`,
    );
    const subscribed = await read();
    expect(subscribed.method).toBe("v4/conversation/subscribe");
    fromAgent.write(
      `${JSON.stringify({ id: subscribed.id, result: { ack: { subscriptionId: "sub", mode: "snapshot", logEpoch: "e" } } })}\n`,
    );
    fromAgent.write(
      `${JSON.stringify({
        id: "browser-1",
        method: "interaction/requestPermission",
        params: { toolName: "browser_navigate", options: [{ response: { decision: "allow" } }] },
      })}\n`,
    );
    const denied = await read();
    expect(denied.id).toBe("browser-1");
    expect(JSON.parse(JSON.stringify(denied)).result?.decision ?? (denied as { result?: { decision?: string } }).result?.decision).toBe(
      "deny",
    );
    fromAgent.write(
      `${JSON.stringify({
        method: "v4/conversation/frame",
        params: {
          wireVersion: 3,
          kind: "complete",
          deliveryKind: "online",
          logicalFrameId: "f",
          logicalFrameOrdinal: 1,
          topic: "conversation/sess",
          subscriptionId: "sub",
          frame: {
            topic: "conversation/sess",
            subscriptionId: "sub",
            fromSeq: 0,
            toSeq: 1,
            sentAt: 1,
            payload: {
              kind: "snapshot",
              snapshot: {
                control: { phase: "completedSuccess", lastError: null },
                rows: [{ rowId: 1, kind: "assistantText", text: "done" }],
                usage: { cumulative: { inputTokens: 3, outputTokens: 4 } },
              },
            },
          },
        },
      })}\n`,
    );
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.result).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });

  it("runs the fake desktop agent over stdio", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orch-desktop-"));
    const adapter = new ZCodeDesktopAdapter({
      vendor: "zhipu",
      command: process.execPath,
      commandArgs: [fakeDesktop],
      env: { ORCH_FAKE_VENDOR: "zhipu" },
    });
    const result = await adapter.run({ task: "Create hello.txt containing exactly hello", cwd, mode: "execute" });
    expect(result.exitCode).toBe(0);
    expect(result.result).toContain("hello.txt");
    expect(await fs.readFile(path.join(cwd, "hello.txt"), "utf8")).toContain("hello");
    expect(result.usage.totalTokens).toBe(18);
  });

  it("decrypts a ZCode enc:v1 credential", () => {
    const secret = "test-secret";
    const key = createHash("sha256").update(secret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("sk-test", "utf8"), cipher.final()]);
    const packed = `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
    expect(decryptCredentialValue(packed, secret)).toBe("sk-test");
    expect(selectCodingPlanKey([{ providerId: "account:zai-individual-coding-plan", apiKey: "sk-test" }], "other")).toBeUndefined();
    expect(
      selectCodingPlanKey([{ providerId: "account:zai-individual-coding-plan", apiKey: "sk-test" }], undefined)?.apiKey,
    ).toBe("sk-test");
  });
});
