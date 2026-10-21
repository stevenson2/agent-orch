import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../src/jsonl.js";
import { runPipeline } from "../src/pipeline.js";
import { getRun, getTask, listEvents } from "../src/query.js";
import type { Config, OrchEvent } from "../src/types.js";
import { PLAN_MD, baseConfig, fakeVendors, initRepo, makeTempDir } from "./helpers.js";

async function listen(): Promise<{ url: string; events: OrchEvent[]; close: () => Promise<void> }> {
  const events: OrchEvent[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OrchEvent);
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    events,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function setup(options?: {
  rounds?: number;
  exhaust?: "human" | "planner";
  env?: Record<string, string>;
  vendors?: "default" | "same-vendor";
}): Promise<{ repo: string; artifacts: string; config: Config; stateFile: string }> {
  const root = await makeTempDir("orch-e2e-");
  const repo = path.join(root, "repo");
  const artifacts = path.join(repo, ".orch");
  const stateFile = path.join(root, "fake-state.json");
  await initRepo(repo);
  const vendors = fakeVendors(stateFile, options?.env);
  const selected = options?.vendors === "same-vendor"
    ? vendors
        .filter((vendor) => vendor.id === "anthropic" || vendor.id === "zhipu")
        .map((vendor) =>
          vendor.id === "zhipu" ? { ...vendor, roles: ["executor" as const, "reviewer" as const] } : vendor,
        )
    : vendors;
  const config = baseConfig(repo, artifacts, selected);
  config.maxReviewRounds = options?.rounds ?? 2;
  config.onExhaust = options?.exhaust ?? "human";
  return { repo, artifacts, config, stateFile };
}

describe("plan execute review dry run", () => {
  it("rejects once, retries, then passes with a different reviewer vendor", async () => {
    const hook = await listen();
    const { repo, artifacts, config } = await setup();
    config.webhook = { url: hook.url, timeoutMs: 2000 };
    try {
      const result = await runPipeline({
        planText: PLAN_MD,
        planPath: path.join(repo, "plan.md"),
        config,
      });
      expect(result.status).toBe("passed");
      const task = result.state.tasks[0];
      expect(task?.status).toBe("passed");
      expect(task?.round).toBe(2);
      expect(task?.verdict).toBe("pass");
      expect(task?.executor?.vendor).toBe("zhipu");
      expect(task?.executor?.harness).toBe("zcode");
      expect(task?.reviewer?.vendor).toBe("deepseek");
      expect(task?.reviewer?.vendor).not.toBe(task?.executor?.vendor);
      expect(task?.reasons).toContain("acceptance met");
      for (const round of task?.rounds ?? []) {
        if (round.executor && round.reviewer) {
          expect(round.reviewer.vendor).not.toBe(round.executor.vendor);
        }
      }
      const hello = await fs.readFile(path.join(task!.worktree!, "hello.txt"), "utf8");
      expect(hello.trim()).toBe("hello");
      await expect(fs.access(path.join(repo, "hello.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(repo, "planner-touched.txt"))).rejects.toThrow();

      const snapshots = await readJsonl<{ state: { status: string } }>(
        path.join(artifacts, "runs", result.runId, "state.jsonl"),
      );
      expect(snapshots[0]?.state.status).toBe("planning");
      expect(snapshots.at(-1)?.state.status).toBe("passed");
      expect(snapshots.length).toBeGreaterThan(2);

      const runEvents = await readJsonl<{ type: string }>(path.join(artifacts, "runs", result.runId, "events.jsonl"));
      const types = runEvents.map((event) => event.type);
      expect(types).toContain("task_rejected");
      expect(types.indexOf("task_rejected")).toBeLessThan(types.indexOf("task_passed"));
      expect(types.at(-1)).toBe("run_finished");

      const notable = await listEvents(artifacts);
      expect(notable.map((event) => event.type)).toEqual(
        expect.arrayContaining(["task_rejected", "run_finished"]),
      );
      expect(hook.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["task_rejected", "run_finished"]),
      );
      expect(hook.events.some((event) => event.type === "executor_assigned")).toBe(false);

      const queried = await getTask(artifacts, result.runId, "hello");
      expect(queried?.status).toBe("passed");
      expect((await getRun(artifacts, result.runId))?.planner?.vendor).toBe("anthropic");
      expect(result.state.usage.totalTokens).toBeGreaterThan(0);
      expect(result.state.quota.vendors.find((vendor) => vendor.vendor === "zhipu")?.windows[0]?.usedTokens).toBeGreaterThan(0);
    } finally {
      await hook.close();
    }
  });

  it("fails over after a 429 and still uses a different reviewer", async () => {
    const { repo, artifacts, config } = await setup({
      env: { ORCH_FAKE_429_VENDORS: "zhipu" },
    });
    const result = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config });
    expect(result.status).toBe("passed");
    const task = result.state.tasks[0];
    expect(task?.executor?.vendor).toBe("deepseek");
    expect(task?.reviewer?.vendor).toBe("google");
    expect(task?.reviewer?.vendor).not.toBe(task?.executor?.vendor);
    const events = await listEvents(artifacts);
    expect(events.some((event) => event.type === "quota_failover" && event.data?.from === "zhipu")).toBe(true);
    const zhipu = result.state.quota.vendors.find((vendor) => vendor.vendor === "zhipu");
    expect(zhipu?.cooling).toBe(true);
  });

  it("exhausts quota when every executor is rate limited", async () => {
    const { repo, config, artifacts } = await setup({
      env: { ORCH_FAKE_429_VENDORS: "zhipu,deepseek" },
    });
    const result = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config });
    expect(result.status).toBe("failed");
    expect(result.state.tasks[0]?.error).toMatch(/quota exhausted/);
    const events = await listEvents(artifacts);
    expect(events.some((event) => event.type === "quota_exhausted")).toBe(true);
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(events.at(-1)?.data?.status).toBe("failed");
  });

  it("escalates to a human when the reviewer keeps rejecting", async () => {
    const hook = await listen();
    const { repo, config, artifacts } = await setup({
      rounds: 1,
      env: { ORCH_FAKE_ALWAYS_REJECT: "1" },
    });
    config.webhook = { url: hook.url, timeoutMs: 2000 };
    try {
      const result = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config });
      expect(result.status).toBe("escalated");
      expect(result.state.tasks[0]?.status).toBe("escalated");
      expect(result.state.tasks[0]?.error).toBe("review_rounds_exhausted");
      const escalation = JSON.parse(
        await fs.readFile(path.join(artifacts, "runs", result.runId, "escalations", "hello.json"), "utf8"),
      ) as { reason: string };
      expect(escalation.reason).toBe("review_rounds_exhausted");
      expect(hook.events.some((event) => event.type === "escalated_to_human")).toBe(true);
    } finally {
      await hook.close();
    }
  });

  it("sends the task back to the planner once, then accepts the revision", async () => {
    const { repo, config } = await setup({
      rounds: 1,
      exhaust: "planner",
      env: { ORCH_FAKE_ALWAYS_REJECT: "1", ORCH_FAKE_PASS_ON_REPLAN: "1" },
    });
    const result = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config });
    expect(result.status).toBe("passed");
    const types = result.state.tasks[0]?.rounds.map((round) => round.verdict);
    expect(types).toEqual(["reject", "pass"]);
    const events = await listEvents(config.artifactsDir);
    expect(events.some((event) => event.type === "escalated_to_planner")).toBe(true);
    expect(events.some((event) => event.type === "escalated_to_human")).toBe(false);
  });

  it("refuses a same-vendor review and a planner that edits the tree", async () => {
    const same = await setup({ vendors: "same-vendor" });
    const blocked = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config: same.config });
    expect(blocked.status).toBe("escalated");
    expect(blocked.state.tasks[0]?.error).toBe("no_cross_vendor_reviewer");
    expect(blocked.state.tasks[0]?.reviewer).toBeUndefined();

    const dirty = await setup({ env: { ORCH_FAKE_PLANNER_TOUCHES: "1" } });
    const errored = await runPipeline({ planText: PLAN_MD, planPath: "plan.md", config: dirty.config });
    expect(errored.status).toBe("error");
    expect(errored.state.error).toMatch(/planner edited/);
    expect(errored.state.tasks).toHaveLength(0);
  });
});
