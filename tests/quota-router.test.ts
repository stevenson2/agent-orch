import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { parsePlan, parseReview } from "../src/parse.js";
import { QuotaStore } from "../src/quota.js";
import { Router } from "../src/router.js";
import { readJsonl } from "../src/jsonl.js";
import { RunStore } from "../src/store.js";
import { deliverWebhook } from "../src/webhook.js";
import type { RunState } from "../src/types.js";
import { emptyUsage } from "../src/types.js";
import { baseConfig, baseVendor, makeTempDir, repoRoot } from "./helpers.js";

const at = new Date("2026-10-21T00:00:00.000Z");

describe("quota and routing", () => {
  it("counts tokens inside the window and ignores older usage", async () => {
    const dir = await makeTempDir("orch-quota-");
    const store = new QuotaStore(dir, () => at);
    await store.recordConsume({
      vendor: "zhipu",
      tokens: 40,
      inputTokens: 10,
      outputTokens: 30,
      listCostUsd: 0.04,
      effectiveCostUsd: 0.02,
      runId: "run-a",
      role: "executor",
      at: new Date(at.getTime() - 20_000 * 1000),
    });
    await store.recordConsume({
      vendor: "zhipu",
      tokens: 25,
      inputTokens: 5,
      outputTokens: 20,
      listCostUsd: 0.025,
      effectiveCostUsd: 0.01,
      runId: "run-b",
      role: "executor",
      at,
    });
    expect(await store.usedTokens("zhipu", 18_000, at)).toBe(25);
    expect(await store.usedTokens("zhipu", 604_800, at)).toBe(65);
    const lines = await readJsonl(path.join(dir, "quota.jsonl"));
    expect(lines).toHaveLength(2);
  });

  it("cools down a vendor until the deadline", async () => {
    const dir = await makeTempDir("orch-cool-");
    const store = new QuotaStore(dir, () => at);
    await store.cooldown("zhipu", new Date(at.getTime() + 60_000), "rate_limit", "run-a");
    expect((await store.cooling("zhipu", at)).cooling).toBe(true);
    expect((await store.cooling("zhipu", new Date(at.getTime() + 120_000))).cooling).toBe(false);
    expect((await store.cooling("deepseek", at)).cooling).toBe(false);
  });

  it("ranks a higher subscription multiplier ahead of the same list price", async () => {
    const dir = await makeTempDir("orch-route-");
    const store = new QuotaStore(dir, () => at);
    const config = baseConfig("/tmp/ws", dir, [
      baseVendor({
        id: "zhipu",
        adapter: "zcode",
        roles: ["executor"],
        listCostPer1kTokens: 1,
        subscriptionMultiplier: 1.5,
      }),
      baseVendor({
        id: "deepseek",
        adapter: "dsh",
        roles: ["executor", "reviewer"],
        listCostPer1kTokens: 1,
        subscriptionMultiplier: 1,
      }),
      baseVendor({
        id: "google",
        adapter: "acpx",
        acpxAgent: "gemini",
        roles: ["reviewer"],
        listCostPer1kTokens: 3,
      }),
    ]);
    const router = new Router(config, store);
    const executor = await router.select("executor", { at });
    expect(executor?.vendor.id).toBe("zhipu");
    expect(executor?.effectiveCostPer1k).toBeCloseTo(1 / 1.5);

    const reviewer = await router.select("reviewer", { excludeVendors: ["zhipu"], at });
    expect(reviewer?.vendor.id).toBe("deepseek");

    config.vendors[0]!.enabled = false;
    expect((await router.select("executor", { at }))?.vendor.id).toBe("deepseek");
    expect(reviewer?.vendor.id).not.toBe(executor?.vendor.id);
  });

  it("skips a preferred vendor that is out of quota and a cooled vendor", async () => {
    const dir = await makeTempDir("orch-skip-");
    const store = new QuotaStore(dir, () => at);
    await store.recordConsume({
      vendor: "anthropic",
      tokens: 100,
      inputTokens: 100,
      outputTokens: 0,
      listCostUsd: 1,
      effectiveCostUsd: 1,
      runId: "run",
      role: "planner",
      at,
    });
    await store.cooldown("zhipu", new Date(at.getTime() + 60_000), "rate_limit");
    const config = baseConfig("/tmp/ws", dir, [
      baseVendor({
        id: "anthropic",
        adapter: "command",
        roles: ["planner", "executor"],
        quotas: [{ name: "five_hour", windowSeconds: 18_000, limitTokens: 100 }],
      }),
      baseVendor({ id: "zhipu", adapter: "zcode", roles: ["executor"], subscriptionMultiplier: 1.5 }),
      baseVendor({ id: "deepseek", adapter: "dsh", roles: ["executor", "planner"] }),
    ]);
    config.roles.planner.prefer = ["anthropic"];
    const router = new Router(config, store);
    expect((await router.select("planner", { at }))?.vendor.id).toBe("deepseek");
    expect((await router.select("executor", { at }))?.vendor.id).toBe("deepseek");
    expect(await router.select("reviewer", { at })).toBeUndefined();
  });

  it("penalizes a nearly empty window so a fuller vendor wins", async () => {
    const dir = await makeTempDir("orch-ratio-");
    const store = new QuotaStore(dir, () => at);
    await store.recordConsume({
      vendor: "zhipu",
      tokens: 990,
      inputTokens: 990,
      outputTokens: 0,
      listCostUsd: 1,
      effectiveCostUsd: 1,
      runId: "run",
      role: "executor",
      at,
    });
    const config = baseConfig("/tmp/ws", dir, [
      baseVendor({
        id: "zhipu",
        adapter: "zcode",
        roles: ["executor"],
        listCostPer1kTokens: 1,
        subscriptionMultiplier: 1.5,
        quotas: [{ name: "five_hour", windowSeconds: 18_000, limitTokens: 1000 }],
      }),
      baseVendor({
        id: "deepseek",
        adapter: "dsh",
        roles: ["executor"],
        listCostPer1kTokens: 1,
        quotas: [{ name: "five_hour", windowSeconds: 18_000, limitTokens: 1000 }],
      }),
    ]);
    const router = new Router(config, store);
    expect((await router.select("executor", { at }))?.vendor.id).toBe("deepseek");
  });
});

describe("structured output parsers", () => {
  it("parses a fenced plan and a review verdict", () => {
    const tasks = parsePlan('noise\n```json\n{"tasks":[{"id":"hello","title":"T","instructions":"Do it","acceptance":["ok"],"test_command":"npm test"}]}\n```');
    expect(tasks[0]).toMatchObject({ id: "hello", testCommand: "npm test", acceptance: ["ok"] });
    expect(parseReview('{"verdict":"reject","reasons":["missing test"],"feedback":"add it"}')).toEqual({
      verdict: "reject",
      reasons: ["missing test"],
      feedback: "add it",
    });
    expect(() => parseReview('{"verdict":"maybe"}')).toThrow(/pass or reject/);
    expect(() => parsePlan('{"tasks":[{"id":"bad id","title":"T","instructions":"x"}]}')).toThrow(/task id/);
  });

  it("loads the example-shaped YAML", () => {
    const config = normalizeConfig(
      {
        version: 1,
        workspace: "repo",
        artifacts_dir: ".orch",
        max_review_rounds: 2,
        on_exhaust: "planner",
        webhook: { url: "https://example.invalid/hook", timeout_ms: 1500 },
        roles: { planner: { prefer: ["anthropic"] }, executor: { prefer: [] }, reviewer: { prefer: [] } },
        vendors: {
          zhipu: {
            harness: "zcode",
            adapter: "zcode",
            command: "zcode",
            subscription_multiplier: 1,
            list_cost_per_1k_tokens: 1,
            roles: ["executor"],
            quotas: [{ name: "weekly", window_seconds: 604800, limit_tokens: 10 }],
          },
        },
      },
      "/cfg",
    );
    expect(config.workspace).toBe(path.resolve("/cfg", "repo"));
    expect(config.artifactsDir).toBe(path.resolve(path.resolve("/cfg", "repo"), ".orch"));
    expect(config.onExhaust).toBe("planner");
    expect(config.vendors[0]?.enabled).toBe(false);
    expect(config.vendors[0]?.subscriptionMultiplier).toBe(1);
    expect(config.webhook?.url).toBe("https://example.invalid/hook");
  });

  it("loads the shipped example config", async () => {
    const config = await loadConfig(path.join(repoRoot, "orch.example.yaml"));
    expect(config.vendors.map((vendor) => vendor.id)).toEqual([
      "anthropic",
      "openai",
      "zhipu",
      "zcode-cli",
      "deepseek",
      "google",
    ]);
    expect(config.vendors.find((vendor) => vendor.id === "zhipu")?.adapter).toBe("zcode-desktop");
    expect(config.vendors.find((vendor) => vendor.id === "zhipu")?.subscriptionMultiplier).toBe(1.5);
    expect(config.vendors.find((vendor) => vendor.id === "zcode-cli")?.enabled).toBe(false);
    expect(config.vendors.find((vendor) => vendor.id === "zcode-cli")?.subscriptionMultiplier).toBe(1);
    expect(config.vendors.find((vendor) => vendor.id === "deepseek")?.adapter).toBe("dsh");
    expect(config.vendors.find((vendor) => vendor.id === "google")?.acpxAgent).toBe("gemini");
    expect(config.webhook?.url).toBeUndefined();
    expect(config.maxReviewRounds).toBe(2);
  });
});

describe("run store and webhook", () => {
  it("appends snapshots and keeps the first record", async () => {
    const dir = await makeTempDir("orch-store-");
    const store = new RunStore(dir);
    const state = (status: RunState["status"]): RunState => ({
      schemaVersion: 1,
      id: "run-1",
      status,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      planPath: "plan.md",
      workspace: "/ws",
      artifactsDir: dir,
      onExhaust: "human",
      maxReviewRounds: 2,
      tasks: [],
      usage: emptyUsage(),
      listCostUsd: 0,
      quota: { vendors: [] },
    });
    await store.appendSnapshot(state("planning"));
    await store.appendSnapshot({ ...state("running"), updatedAt: "2026-10-21T00:01:00.000Z" });
    const lines = await readJsonl<{ state: RunState }>(path.join(dir, "runs", "run-1", "state.jsonl"));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.state.status).toBe("planning");
    expect(lines[1]?.state.status).toBe("running");
    const latest = JSON.parse(await fs.readFile(path.join(dir, "runs", "run-1", "state.json"), "utf8")) as RunState;
    expect(latest.status).toBe("running");
  });

  it("posts notable events and skips an empty webhook", async () => {
    const seen: unknown[] = [];
    await deliverWebhook(undefined, { ts: at.toISOString(), runId: "r", type: "run_finished", message: "x" }, 1000);
    await deliverWebhook(
      "http://127.0.0.1/hook",
      { ts: at.toISOString(), runId: "r", type: "task_rejected", message: "no" },
      1000,
      (async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    );
    expect(seen).toHaveLength(1);
    expect((seen[0] as { type: string }).type).toBe("task_rejected");
  });
});
